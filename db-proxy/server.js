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
