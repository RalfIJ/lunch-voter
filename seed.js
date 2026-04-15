// Seed script: parses the Thuisbezorgd HTML page and populates the database.
// Usage: node seed.js [path-to-html]
// If no path given, fetches fresh data using curl.

const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'lunch-voter.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS restaurants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT,
    cuisine TEXT,
    logo_url TEXT,
    rating REAL,
    rating_count INTEGER,
    delivery_fee TEXT,
    min_order TEXT,
    is_open INTEGER DEFAULT 1,
    last_fetched TEXT
  );
`);

function getHtml(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    console.log(`Reading from file: ${filePath}`);
    return fs.readFileSync(filePath, 'utf-8');
  }

  console.log('Fetching fresh data from thuisbezorgd.nl using curl...');
  const html = execSync(
    'curl -s -L "https://www.thuisbezorgd.nl/bestellen/eten/1812" ' +
    '-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" ' +
    '-H "Accept: text/html,application/xhtml+xml" ' +
    '-H "Accept-Language: nl-NL,nl;q=0.9"',
    { maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' }
  );
  return html;
}

function parseAndSeed(html) {
  const match = html.match(/<script[^>]*>(\{"props"[\s\S]*?\})<\/script>/);
  if (!match) {
    console.error('Could not find restaurant data in HTML');
    process.exit(1);
  }

  const data = JSON.parse(match[1]);
  const restaurantData = data.props?.appProps?.preloadedState?.discovery?.restaurantList?.restaurantData;

  if (!restaurantData) {
    console.error('Restaurant data structure not found');
    process.exit(1);
  }

  const stmt = db.prepare(`
    INSERT INTO restaurants (id, name, slug, cuisine, logo_url, rating, rating_count, delivery_fee, min_order, is_open, last_fetched)
    VALUES (@id, @name, @slug, @cuisine, @logo_url, @rating, @rating_count, @delivery_fee, @min_order, @is_open, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=@name, slug=@slug, cuisine=@cuisine, logo_url=@logo_url, rating=@rating,
      rating_count=@rating_count, delivery_fee=@delivery_fee, min_order=@min_order,
      is_open=@is_open, last_fetched=datetime('now')
  `);

  let total = 0;
  let included = 0;

  const tx = db.transaction(() => {
    for (const [id, r] of Object.entries(restaurantData)) {
      if (!r || !r.name) continue;
      total++;

      // Filter: only include restaurants that can deliver during lunch (by 13:30)
      const deliveryTime = r.deliveryOpeningTimeLocal;
      if (deliveryTime) {
        const timePart = deliveryTime.split('T')[1];
        if (timePart) {
          const [hours, minutes] = timePart.split(':').map(Number);
          const deliveryStart = hours * 60 + minutes;
          if (deliveryStart > 810) continue; // 13:30 = 810 minutes
        }
      }

      const cuisines = Array.isArray(r.cuisines)
        ? r.cuisines.map(c => c.name).join(', ')
        : '';

      stmt.run({
        id: String(r.id || id),
        name: r.name,
        slug: r.uniqueName || '',
        cuisine: cuisines,
        logo_url: r.logoUrl || '',
        rating: r.rating?.starRating || 0,
        rating_count: r.rating?.count || 0,
        delivery_fee: '',
        min_order: '',
        is_open: r.isTemporarilyOffline ? 0 : 1,
      });
      included++;
    }
  });

  tx();
  console.log(`Done! ${included} restaurants imported (${total - included} filtered out - deliver after 13:30)`);
}

const filePath = process.argv[2] || path.join(path.dirname(__dirname), 'thuisbezorgd.html');
const html = getHtml(fs.existsSync(filePath) ? filePath : null);
parseAndSeed(html);
db.close();
