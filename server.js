const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database setup ---
const db = new Database(path.join(__dirname, 'lunch-voter.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

  CREATE TABLE IF NOT EXISTS voting_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_key TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    closed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    voter_name TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    voted_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (session_id) REFERENCES voting_sessions(id),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
    UNIQUE(session_id, voter_name)
  );

  CREATE TABLE IF NOT EXISTS past_winners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_key TEXT NOT NULL,
    restaurant_id TEXT NOT NULL,
    restaurant_name TEXT NOT NULL,
    vote_count INTEGER,
    decided_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );
`);

// --- Helpers ---

// Get the Thursday week key (YYYY-Www) for a given date
function getThursdayWeekKey(date = new Date()) {
  // Find the Thursday of the current week
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun, 4=Thu
  // Calculate the Thursday of this week
  const diff = 4 - day;
  const thursday = new Date(d);
  thursday.setDate(d.getDate() + diff);
  const year = thursday.getFullYear();
  // ISO week number
  const startOfYear = new Date(year, 0, 1);
  const days = Math.floor((thursday - startOfYear) / 86400000);
  const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

// Check if today is voting day (Thursday) or if voting is open (Mon-Thu)
function getVotingStatus() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 4=Thu
  const hours = now.getHours();
  const isThursday = day === 4;
  // Voting is open Mon-Thu until Thursday 11:00
  const votingOpen = day >= 1 && day <= 4 && !(isThursday && hours >= 11);
  // Results shown Thursday 11:00+
  const resultsReady = isThursday && hours >= 11;
  return { votingOpen, resultsReady, isThursday, day, hours };
}

function getOrCreateSession() {
  const weekKey = getThursdayWeekKey();
  let session = db.prepare('SELECT * FROM voting_sessions WHERE week_key = ?').get(weekKey);
  if (!session) {
    db.prepare('INSERT INTO voting_sessions (week_key) VALUES (?)').run(weekKey);
    session = db.prepare('SELECT * FROM voting_sessions WHERE week_key = ?').get(weekKey);
  }
  return session;
}

// --- Fetch restaurants from Thuisbezorgd ---
// The Thuisbezorgd website embeds restaurant data as Next.js server-side props.
// We use curl to fetch the page (node-fetch gets blocked with 403).
const { execSync } = require('child_process');

function fetchRestaurantsSync() {
  const html = execSync(
    'curl -s -L "https://www.thuisbezorgd.nl/bestellen/eten/1812" ' +
    '-H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" ' +
    '-H "Accept: text/html,application/xhtml+xml" ' +
    '-H "Accept-Language: nl-NL,nl;q=0.9"',
    { maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8', timeout: 30000 }
  );

  const match = html.match(/<script[^>]*>(\{"props"[\s\S]*?\})<\/script>/);
  if (!match) {
    throw new Error('Could not find restaurant data in page HTML. The page structure may have changed.');
  }

  const data = JSON.parse(match[1]);
  const restaurantData = data.props?.appProps?.preloadedState?.discovery?.restaurantList?.restaurantData;

  if (!restaurantData) {
    throw new Error('Restaurant data structure not found in page data');
  }

  return restaurantData;
}

function parseRestaurants(restaurantData) {
  const restaurants = [];

  for (const [id, r] of Object.entries(restaurantData)) {
    if (!r || !r.name) continue;

    // Filter: only restaurants that support delivery
    if (r.isDelivery === false && r.isOpenNowForDelivery === false) continue;

    // Filter: only restaurants that deliver by 13:30
    // deliveryOpeningTimeLocal shows when delivery starts
    const deliveryTime = r.deliveryOpeningTimeLocal;
    if (deliveryTime) {
      const timePart = deliveryTime.split('T')[1]; // e.g. "11:00:00"
      if (timePart) {
        const [hours, minutes] = timePart.split(':').map(Number);
        const deliveryStart = hours * 60 + minutes;
        // Restaurant must start delivering by 13:30 (810 minutes) to be useful for lunch
        if (deliveryStart > 810) continue;
      }
    }

    const cuisines = Array.isArray(r.cuisines)
      ? r.cuisines.map(c => c.name).join(', ')
      : '';

    restaurants.push({
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
  }

  return restaurants;
}

function upsertRestaurants(restaurants) {
  const stmt = db.prepare(`
    INSERT INTO restaurants (id, name, slug, cuisine, logo_url, rating, rating_count, delivery_fee, min_order, is_open, last_fetched)
    VALUES (@id, @name, @slug, @cuisine, @logo_url, @rating, @rating_count, @delivery_fee, @min_order, @is_open, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name=@name, slug=@slug, cuisine=@cuisine, logo_url=@logo_url, rating=@rating,
      rating_count=@rating_count, delivery_fee=@delivery_fee, min_order=@min_order,
      is_open=@is_open, last_fetched=datetime('now')
  `);

  const tx = db.transaction((items) => {
    for (const r of items) stmt.run(r);
  });
  tx(restaurants);
}

// --- Seed from JSON if DB is empty ---
const count = db.prepare('SELECT COUNT(*) as n FROM restaurants').get().n;
if (count === 0) {
  const seedPath = path.join(__dirname, 'seed-data.json');
  if (require('fs').existsSync(seedPath)) {
    const seedData = JSON.parse(require('fs').readFileSync(seedPath, 'utf-8'));
    upsertRestaurants(seedData);
    console.log(`Seeded ${seedData.length} restaurants from seed-data.json`);
  }
}

// --- API Routes ---

// Get all restaurants (with optional sorting)
app.get('/api/restaurants', (req, res) => {
  const allowedSort = { name: 'name', rating: 'rating', rating_count: 'rating_count' };
  const sortCol = allowedSort[req.query.sort] || 'rating';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const restaurants = db.prepare(`SELECT * FROM restaurants ORDER BY ${sortCol} ${order}`).all();
  res.json(restaurants);
});

// Get unique cuisines for filtering
app.get('/api/cuisines', (req, res) => {
  const rows = db.prepare("SELECT DISTINCT cuisine FROM restaurants WHERE cuisine != ''").all();
  const cuisineSet = new Set();
  for (const row of rows) {
    row.cuisine.split(',').forEach(c => {
      const trimmed = c.trim();
      if (trimmed) cuisineSet.add(trimmed);
    });
  }
  res.json([...cuisineSet].sort());
});

// Refresh restaurants from Thuisbezorgd
app.post('/api/restaurants/refresh', (req, res) => {
  try {
    const restaurantData = fetchRestaurantsSync();
    const restaurants = parseRestaurants(restaurantData);
    if (restaurants.length === 0) {
      return res.status(400).json({ error: 'Geen restaurants gevonden. De paginastructuur is mogelijk gewijzigd.' });
    }
    upsertRestaurants(restaurants);
    res.json({ message: `${restaurants.length} restaurants opgehaald en opgeslagen`, count: restaurants.length });
  } catch (err) {
    console.error('Failed to fetch restaurants:', err);
    res.status(500).json({
      error: `Restaurants ophalen mislukt: ${err.message}`,
      hint: 'Je kunt ook uitvoeren: node seed.js'
    });
  }
});

// Manually add a restaurant
app.post('/api/restaurants', (req, res) => {
  const { name, cuisine } = req.body;
  if (!name) return res.status(400).json({ error: 'Naam is verplicht' });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  db.prepare(`
    INSERT INTO restaurants (id, name, slug, cuisine, logo_url, rating, rating_count, delivery_fee, min_order, is_open, last_fetched)
    VALUES (?, ?, ?, ?, '', 0, 0, '', '', 1, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name=?, cuisine=?
  `).run(id, name, id, cuisine || '', name, cuisine || '');
  res.json({ message: 'Restaurant toegevoegd', id });
});

// Delete a restaurant
app.delete('/api/restaurants/:id', (req, res) => {
  db.prepare('DELETE FROM restaurants WHERE id = ?').run(req.params.id);
  res.json({ message: 'Verwijderd' });
});

// Get voting status and current session
app.get('/api/voting/status', (req, res) => {
  const status = getVotingStatus();
  const session = getOrCreateSession();
  const weekKey = getThursdayWeekKey();

  // Get all votes for this session
  const votes = db.prepare(`
    SELECT v.voter_name, v.restaurant_id, r.name as restaurant_name
    FROM votes v JOIN restaurants r ON v.restaurant_id = r.id
    WHERE v.session_id = ?
  `).all(session.id);

  // Get vote tallies
  const tallies = db.prepare(`
    SELECT v.restaurant_id, r.name as restaurant_name, COUNT(*) as vote_count
    FROM votes v JOIN restaurants r ON v.restaurant_id = r.id
    WHERE v.session_id = ?
    GROUP BY v.restaurant_id
    ORDER BY vote_count DESC
  `).all(session.id);

  // Get past winners for fairness info
  const pastWinners = db.prepare(`
    SELECT * FROM past_winners ORDER BY decided_at DESC LIMIT 12
  `).all();

  // Count how many times each restaurant has won
  const winCounts = {};
  for (const w of pastWinners) {
    winCounts[w.restaurant_id] = (winCounts[w.restaurant_id] || 0) + 1;
  }

  res.json({
    ...status,
    weekKey,
    session,
    votes,
    tallies,
    totalVoters: votes.length,
    pastWinners,
    winCounts,
  });
});

// Cast a vote
app.post('/api/voting/vote', (req, res) => {
  const { voterName, restaurantId } = req.body;
  if (!voterName || !restaurantId) {
    return res.status(400).json({ error: 'voterName and restaurantId are required' });
  }

  // Check restaurant exists
  const restaurant = db.prepare('SELECT id FROM restaurants WHERE id = ?').get(restaurantId);
  if (!restaurant) {
    return res.status(400).json({ error: 'Restaurant niet gevonden' });
  }

  const session = getOrCreateSession();
  const normalizedName = voterName.trim().toLowerCase();

  // Check if this person already voted
  const existing = db.prepare(
    'SELECT * FROM votes WHERE session_id = ? AND voter_name = ?'
  ).get(session.id, normalizedName);

  if (existing) {
    // Update their vote
    db.prepare(
      'UPDATE votes SET restaurant_id = ?, voted_at = datetime(\'now\') WHERE id = ?'
    ).run(restaurantId, existing.id);
    return res.json({ message: 'Stem gewijzigd!' });
  }

  db.prepare(
    'INSERT INTO votes (session_id, voter_name, restaurant_id) VALUES (?, ?, ?)'
  ).run(session.id, normalizedName, restaurantId);

  res.json({ message: 'Stem uitgebracht!' });
});

// Finalize the vote (pick a winner)
app.post('/api/voting/finalize', (req, res) => {
  const session = getOrCreateSession();
  const weekKey = getThursdayWeekKey();

  // Check if already finalized
  const existing = db.prepare('SELECT * FROM past_winners WHERE week_key = ?').get(weekKey);
  if (existing) {
    return res.json({ message: 'Al afgerond', winner: existing });
  }

  // Get top voted restaurant(s)
  const tallies = db.prepare(`
    SELECT v.restaurant_id, r.name as restaurant_name, COUNT(*) as vote_count
    FROM votes v JOIN restaurants r ON v.restaurant_id = r.id
    WHERE v.session_id = ?
    GROUP BY v.restaurant_id
    ORDER BY vote_count DESC
  `).all(session.id);

  if (tallies.length === 0) {
    return res.status(400).json({ error: 'Er zijn nog geen stemmen!' });
  }

  // In case of a tie, pick randomly among tied leaders
  const maxVotes = tallies[0].vote_count;
  const leaders = tallies.filter(t => t.vote_count === maxVotes);
  const winner = leaders[Math.floor(Math.random() * leaders.length)];

  db.prepare(`
    INSERT INTO past_winners (week_key, restaurant_id, restaurant_name, vote_count)
    VALUES (?, ?, ?, ?)
  `).run(weekKey, winner.restaurant_id, winner.restaurant_name, winner.vote_count);

  res.json({ message: 'Winnaar gekozen!', winner });
});

// Get history
app.get('/api/history', (req, res) => {
  const winners = db.prepare('SELECT * FROM past_winners ORDER BY decided_at DESC LIMIT 52').all();
  res.json(winners);
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lunch Voter running at http://localhost:${PORT}`);
});
