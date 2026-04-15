// Minimal SQLite REST proxy for running on a NAS.
// Exposes the SQLite database over HTTP with API key authentication.

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json({ limit: '1mb' }));

const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error('API_KEY environment variable is required');
  process.exit(1);
}

// Auth middleware
app.use('/api/db', (req, res, next) => {
  const key = req.headers.authorization?.replace('Bearer ', '');
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Database
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data', 'lunch-voter.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log(`Database: ${dbPath}`);

// --- Routes ---

// Execute raw SQL (CREATE TABLE, etc)
app.post('/api/db/exec', (req, res) => {
  try {
    db.exec(req.body.sql);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Set pragma
app.post('/api/db/pragma', (req, res) => {
  try {
    const result = db.pragma(req.body.pragma);
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// SELECT one row
app.post('/api/db/get', (req, res) => {
  try {
    const { sql, params = [] } = req.body;
    const row = db.prepare(sql).get(...params);
    res.json({ row: row || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// SELECT all rows
app.post('/api/db/all', (req, res) => {
  try {
    const { sql, params = [] } = req.body;
    const rows = db.prepare(sql).all(...params);
    res.json({ rows });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// INSERT/UPDATE/DELETE
app.post('/api/db/run', (req, res) => {
  try {
    const { sql, params = [] } = req.body;
    const result = db.prepare(sql).run(...params);
    res.json({ changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Batch operations (transaction)
app.post('/api/db/batch', (req, res) => {
  try {
    const results = [];
    const tx = db.transaction(() => {
      for (const op of req.body.operations) {
        if (op.type === 'run') {
          const r = db.prepare(op.sql).run(...(op.params || []));
          results.push({ changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) });
        } else if (op.type === 'get') {
          results.push({ row: db.prepare(op.sql).get(...(op.params || [])) || null });
        } else if (op.type === 'all') {
          results.push({ rows: db.prepare(op.sql).all(...(op.params || [])) });
        }
      }
    });
    tx();
    res.json({ results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Thuisbezorgd scraper via Puppeteer ---
const puppeteer = require('puppeteer');

function parseRestaurants(restaurantData) {
  const restaurants = [];
  for (const [id, r] of Object.entries(restaurantData)) {
    if (!r || !r.name) continue;
    if (r.isDelivery === false && r.isOpenNowForDelivery === false) continue;
    const deliveryTime = r.deliveryOpeningTimeLocal;
    if (deliveryTime) {
      const timePart = deliveryTime.split('T')[1];
      if (timePart) {
        const [hours, minutes] = timePart.split(':').map(Number);
        if (hours * 60 + minutes > 810) continue;
      }
    }
    const cuisines = Array.isArray(r.cuisines) ? r.cuisines.map(c => c.name).join(', ') : '';
    restaurants.push({
      id: String(r.id || id), name: r.name, slug: r.uniqueName || '',
      cuisine: cuisines, logo_url: r.logoUrl || '',
      rating: r.rating?.starRating || 0, rating_count: r.rating?.count || 0,
      delivery_fee: '', min_order: '', is_open: r.isTemporarilyOffline ? 0 : 1,
    });
  }
  return restaurants;
}

function upsertRestaurants(restaurants) {
  const stmt = db.prepare(`
    INSERT INTO restaurants (id, name, slug, cuisine, logo_url, rating, rating_count, delivery_fee, min_order, is_open, last_fetched)
    VALUES (@id, @name, @slug, @cuisine, @logo_url, @rating, @rating_count, @delivery_fee, @min_order, @is_open, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=@name, slug=@slug, cuisine=@cuisine, logo_url=@logo_url, rating=@rating,
      rating_count=@rating_count, is_open=@is_open, last_fetched=datetime('now')
  `);
  const tx = db.transaction((items) => { for (const r of items) stmt.run(r); });
  tx(restaurants);
}

app.post('/api/db/scrape-restaurants', async (req, res) => {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-NL,nl;q=0.9' });

    await page.goto('https://www.thuisbezorgd.nl/bestellen/eten/1812', {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Extract restaurant data from the page
    const restaurantData = await page.evaluate(() => {
      // Try __NEXT_DATA__
      const nextDataEl = document.getElementById('__NEXT_DATA__');
      if (nextDataEl) {
        try {
          const data = JSON.parse(nextDataEl.textContent);
          return data.props?.appProps?.preloadedState?.discovery?.restaurantList?.restaurantData || null;
        } catch (e) { /* ignore */ }
      }
      // Try inline script with props
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const text = s.textContent || '';
        if (text.includes('"props"') && text.includes('restaurantData')) {
          try {
            const data = JSON.parse(text);
            return data.props?.appProps?.preloadedState?.discovery?.restaurantList?.restaurantData || null;
          } catch (e) { /* ignore */ }
        }
      }
      return null;
    });

    await browser.close();
    browser = null;

    if (!restaurantData) {
      return res.status(400).json({ error: 'Kon geen restaurantdata vinden op de pagina' });
    }

    const restaurants = parseRestaurants(restaurantData);
    if (restaurants.length === 0) {
      return res.status(400).json({ error: 'Geen restaurants gevonden na filtering' });
    }

    upsertRestaurants(restaurants);
    res.json({ message: `${restaurants.length} restaurants opgehaald en opgeslagen`, count: restaurants.length });
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: `Scraping mislukt: ${err.message}` });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// Scrape a restaurant menu
app.post('/api/db/scrape-menu', async (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug is verplicht' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-NL,nl;q=0.9' });

    await page.goto(`https://www.thuisbezorgd.nl/menu/${slug}`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    const menuData = await page.evaluate(() => {
      const nextDataEl = document.getElementById('__NEXT_DATA__');
      if (nextDataEl) {
        try {
          const data = JSON.parse(nextDataEl.textContent);
          return data.props?.pageProps || data.props?.appProps || null;
        } catch (e) { /* ignore */ }
      }
      return null;
    });

    await browser.close();
    browser = null;

    res.json({ menu: menuData });
  } catch (err) {
    console.error('Menu scrape error:', err.message);
    res.status(500).json({ error: `Menu ophalen mislukt: ${err.message}` });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

// Health check
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`DB proxy running on port ${PORT}`);
});
