const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// --- Session setup ---
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 1 week
    sameSite: 'lax',
  },
}));

// Trust proxy for secure cookies behind Render's load balancer
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use(express.static(path.join(__dirname, 'public')));

// --- Google OAuth2 config ---
const IS_DEV = process.env.NODE_ENV !== 'production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/callback';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

function authEnabled() {
  return !IS_DEV || !!GOOGLE_CLIENT_ID;
}

// --- Auth middleware ---
function requireAuth(req, res, next) {
  if (!authEnabled()) return next();
  if (req.session?.user) return next();
  res.status(401).json({ error: 'Niet ingelogd' });
}

function requireAdmin(req, res, next) {
  if (!authEnabled()) return next();
  if (!req.session?.user) return res.status(401).json({ error: 'Niet ingelogd' });
  if (!req.session.user.isAdmin) return res.status(403).json({ error: 'Geen beheerrechten' });
  next();
}

// --- Auth routes ---
app.get('/auth/login', (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.redirect('/');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.authState = state;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.redirect('/');
  const { code, state } = req.query;

  if (!code || state !== req.session.authState) {
    return res.status(400).send('Ongeldige login poging');
  }
  delete req.session.authState;

  try {
    // Exchange code for token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokens = await tokenRes.json();
    if (tokens.error) {
      console.error('Google token error:', tokens);
      return res.status(400).send('Login mislukt');
    }

    // Get user info from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await userRes.json();

    const email = (profile.email || '').toLowerCase();
    const displayName = profile.given_name || profile.name || email.split('@')[0];

    req.session.user = {
      name: displayName,
      email,
      picture: profile.picture || '',
      isAdmin: ADMIN_EMAILS.includes(email),
    };

    res.redirect('/');
  } catch (err) {
    console.error('Auth callback error:', err);
    res.status(500).send('Login mislukt');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

app.get('/api/auth/me', (req, res) => {
  if (!authEnabled()) {
    return res.json({ authEnabled: false });
  }
  if (req.session?.user) {
    return res.json({ authEnabled: true, user: req.session.user });
  }
  res.json({ authEnabled: true, user: null });
});

// --- Database setup ---
const DB_PROXY_URL = process.env.DB_PROXY_URL || '';
const DB_PROXY_KEY = process.env.DB_PROXY_KEY || '';

let db;
if (DB_PROXY_URL) {
  const { RemoteDatabase } = require('./db-client');
  db = new RemoteDatabase(DB_PROXY_URL, DB_PROXY_KEY);
  console.log(`Using remote DB: ${DB_PROXY_URL}`);
} else {
  const Database = require('better-sqlite3');
  db = new Database(path.join(__dirname, 'lunch-voter.db'));
  console.log('Using local SQLite');
}
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
    UNIQUE(session_id, voter_name, restaurant_id)
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

// --- Migrate votes table: allow multiple votes per person ---
const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='votes'").get();
if (tableInfo && tableInfo.sql.includes('UNIQUE(session_id, voter_name)') && !tableInfo.sql.includes('UNIQUE(session_id, voter_name, restaurant_id)')) {
  db.exec(`
    CREATE TABLE votes_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      voter_name TEXT NOT NULL,
      restaurant_id TEXT NOT NULL,
      voted_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES voting_sessions(id),
      FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
      UNIQUE(session_id, voter_name, restaurant_id)
    );
    INSERT INTO votes_new (id, session_id, voter_name, restaurant_id, voted_at)
      SELECT id, session_id, voter_name, restaurant_id, voted_at FROM votes;
    DROP TABLE votes;
    ALTER TABLE votes_new RENAME TO votes;
  `);
  console.log('Migrated votes table: multiple votes per person now allowed');
}

// --- Helpers ---

function getThursdayWeekKey(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = 4 - day;
  const thursday = new Date(d);
  thursday.setDate(d.getDate() + diff);
  const year = thursday.getFullYear();
  const startOfYear = new Date(year, 0, 1);
  const days = Math.floor((thursday - startOfYear) / 86400000);
  const weekNum = Math.ceil((days + startOfYear.getDay() + 1) / 7);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

// Voting open: maandag 09:00 t/m donderdag 10:00
function getVotingStatus() {
  const now = new Date();
  const day = now.getDay();
  const hours = now.getHours();
  const isThursday = day === 4;

  let votingOpen = false;
  if (day === 1 && hours >= 9) votingOpen = true;
  else if (day === 2 || day === 3) votingOpen = true;
  else if (day === 4 && hours < 10) votingOpen = true;

  const resultsReady = isThursday && hours >= 10;
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
  if (!restaurantData) throw new Error('Restaurant data structure not found in page data');
  return restaurantData;
}

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
      rating_count=@rating_count, delivery_fee=@delivery_fee, min_order=@min_order,
      is_open=@is_open, last_fetched=datetime('now')
  `);
  const tx = db.transaction((items) => { for (const r of items) stmt.run(r); });
  tx(restaurants);
}

// --- Seed from JSON if DB is empty (only needed for ephemeral storage like Render) ---
const fs = require('fs');

if (!DB_PROXY_URL) {
  const restaurantCount = db.prepare('SELECT COUNT(*) as n FROM restaurants').get().n;
  if (restaurantCount === 0) {
    const seedPath = path.join(__dirname, 'seed-data.json');
    if (fs.existsSync(seedPath)) {
      const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
      upsertRestaurants(seedData);
      console.log(`Seeded ${seedData.length} restaurants from seed-data.json`);
    }
  }

  const statePath = path.join(__dirname, 'seed-state.json');
  if (fs.existsSync(statePath)) {
    const voteCount = db.prepare('SELECT COUNT(*) as n FROM votes').get().n;
    const winnerCount = db.prepare('SELECT COUNT(*) as n FROM past_winners').get().n;
    if (voteCount === 0 && winnerCount === 0) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const tx = db.transaction(() => {
        for (const s of state.sessions || []) {
          db.prepare('INSERT OR IGNORE INTO voting_sessions (id, week_key, created_at, closed) VALUES (?, ?, ?, ?)').run(s.id, s.week_key, s.created_at, s.closed);
        }
        for (const v of state.votes || []) {
          db.prepare('INSERT OR IGNORE INTO votes (id, session_id, voter_name, restaurant_id, voted_at) VALUES (?, ?, ?, ?, ?)').run(v.id, v.session_id, v.voter_name, v.restaurant_id, v.voted_at);
        }
        for (const w of state.past_winners || []) {
          db.prepare('INSERT OR IGNORE INTO past_winners (id, week_key, restaurant_id, restaurant_name, vote_count, decided_at) VALUES (?, ?, ?, ?, ?, ?)').run(w.id, w.week_key, w.restaurant_id, w.restaurant_name, w.vote_count, w.decided_at);
        }
      });
      tx();
      console.log(`Restored state: ${(state.sessions||[]).length} sessions, ${(state.votes||[]).length} votes, ${(state.past_winners||[]).length} winners`);
    }
  }
}

// --- API Routes ---

app.get('/api/restaurants', (req, res) => {
  const allowedSort = { name: 'name', rating: 'rating', rating_count: 'rating_count' };
  const sortCol = allowedSort[req.query.sort] || 'rating';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const restaurants = db.prepare(`SELECT * FROM restaurants ORDER BY ${sortCol} ${order}`).all();
  res.json(restaurants);
});

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

app.post('/api/restaurants/refresh', requireAdmin, (req, res) => {
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
    res.status(500).json({ error: `Restaurants ophalen mislukt: ${err.message}`, hint: 'Je kunt ook uitvoeren: node seed.js' });
  }
});

app.post('/api/restaurants', requireAdmin, (req, res) => {
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

app.delete('/api/restaurants/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM restaurants WHERE id = ?').run(req.params.id);
  res.json({ message: 'Verwijderd' });
});

app.get('/api/voting/status', (req, res) => {
  const status = getVotingStatus();
  const session = getOrCreateSession();
  const weekKey = getThursdayWeekKey();

  const votes = db.prepare(`
    SELECT v.voter_name, v.restaurant_id, r.name as restaurant_name
    FROM votes v JOIN restaurants r ON v.restaurant_id = r.id
    WHERE v.session_id = ?
  `).all(session.id);

  const tallies = db.prepare(`
    SELECT v.restaurant_id, r.name as restaurant_name, COUNT(*) as vote_count
    FROM votes v JOIN restaurants r ON v.restaurant_id = r.id
    WHERE v.session_id = ?
    GROUP BY v.restaurant_id
    ORDER BY vote_count DESC
  `).all(session.id);

  const pastWinners = db.prepare('SELECT * FROM past_winners ORDER BY decided_at DESC LIMIT 12').all();
  const winCounts = {};
  for (const w of pastWinners) {
    winCounts[w.restaurant_id] = (winCounts[w.restaurant_id] || 0) + 1;
  }

  res.json({
    ...status, weekKey, session, votes, tallies,
    totalVoters: new Set(votes.map(v => v.voter_name)).size,
    totalVotes: votes.length,
    pastWinners, winCounts,
  });
});

// Cast or toggle a vote — requires authentication
app.post('/api/voting/vote', requireAuth, (req, res) => {
  const { restaurantId } = req.body;
  if (!restaurantId) return res.status(400).json({ error: 'restaurantId is verplicht' });

  const restaurant = db.prepare('SELECT id FROM restaurants WHERE id = ?').get(restaurantId);
  if (!restaurant) return res.status(400).json({ error: 'Restaurant niet gevonden' });

  const session = getOrCreateSession();

  // Use authenticated name; fall back to body for when auth is disabled
  const voterName = req.session?.user
    ? req.session.user.name.trim().toLowerCase()
    : (req.body.voterName || '').trim().toLowerCase();

  if (!voterName) return res.status(400).json({ error: 'Naam is verplicht' });

  const existing = db.prepare(
    'SELECT * FROM votes WHERE session_id = ? AND voter_name = ? AND restaurant_id = ?'
  ).get(session.id, voterName, restaurantId);

  if (existing) {
    db.prepare('DELETE FROM votes WHERE id = ?').run(existing.id);
    return res.json({ message: 'Stem ingetrokken', action: 'removed' });
  }

  db.prepare(
    'INSERT INTO votes (session_id, voter_name, restaurant_id) VALUES (?, ?, ?)'
  ).run(session.id, voterName, restaurantId);

  res.json({ message: 'Stem uitgebracht!', action: 'added' });
});

app.post('/api/voting/finalize', requireAdmin, (req, res) => {
  const session = getOrCreateSession();
  const weekKey = getThursdayWeekKey();

  const existing = db.prepare('SELECT * FROM past_winners WHERE week_key = ?').get(weekKey);
  if (existing) return res.json({ message: 'Al afgerond', winner: existing });

  const tallies = db.prepare(`
    SELECT v.restaurant_id, r.name as restaurant_name, COUNT(*) as vote_count
    FROM votes v JOIN restaurants r ON v.restaurant_id = r.id
    WHERE v.session_id = ?
    GROUP BY v.restaurant_id
    ORDER BY vote_count DESC
  `).all(session.id);

  if (tallies.length === 0) return res.status(400).json({ error: 'Er zijn nog geen stemmen!' });

  const maxVotes = tallies[0].vote_count;
  const leaders = tallies.filter(t => t.vote_count === maxVotes);
  const winner = leaders[Math.floor(Math.random() * leaders.length)];

  db.prepare('INSERT INTO past_winners (week_key, restaurant_id, restaurant_name, vote_count) VALUES (?, ?, ?, ?)')
    .run(weekKey, winner.restaurant_id, winner.restaurant_name, winner.vote_count);

  res.json({ message: 'Winnaar gekozen!', winner });
});

app.get('/api/history', (req, res) => {
  const winners = db.prepare('SELECT * FROM past_winners ORDER BY decided_at DESC LIMIT 52').all();
  res.json(winners);
});

app.get('/api/state/export', (req, res) => {
  const sessions = db.prepare('SELECT * FROM voting_sessions').all();
  const votes = db.prepare('SELECT * FROM votes').all();
  const past_winners = db.prepare('SELECT * FROM past_winners').all();
  res.json({ sessions, votes, past_winners });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lunch Voter running at http://localhost:${PORT}`);
  if (authEnabled()) console.log('Google OAuth enabled');
  else console.log('Auth disabled (development mode)');
});
