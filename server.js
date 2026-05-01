const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (() => { console.warn('WARNING: JWT_SECRET not set, using random secret (sessions will not persist across restarts)'); return require('crypto').randomBytes(32).toString('hex'); })();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new Database(path.join(__dirname, 'chess_analysis.db'));
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    pgn TEXT,
    white_name TEXT,
    black_name TEXT,
    white_accuracy REAL,
    black_accuracy REAL,
    result TEXT,
    opening_name TEXT,
    opening_eco TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS user_stats (
    user_id TEXT PRIMARY KEY,
    total_analyses INTEGER DEFAULT 0,
    avg_accuracy REAL DEFAULT 0,
    best_accuracy REAL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth middleware (doesn't reject, just attaches user if present)
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      // Token invalid, continue without user
    }
  }
  next();
}

// ── AUTH ROUTES ──

// Register
app.post('/api/register', (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required' });
  }
  if (username.length < 3 || username.length > 30) {
    return res.status(400).json({ error: 'Username must be 3-30 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // Check if username or email already exists
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) {
    return res.status(409).json({ error: 'Username or email already taken' });
  }

  const id = uuidv4();
  const passwordHash = bcrypt.hashSync(password, 10);

  db.prepare('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)').run(id, username, email, passwordHash);
  db.prepare('INSERT INTO user_stats (user_id) VALUES (?)').run(id);

  const token = jwt.sign({ id, username, email }, JWT_SECRET, { expiresIn: '7d' });

  res.status(201).json({
    token,
    user: { id, username, email }
  });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(username, username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

  res.json({
    token,
    user: { id: user.id, username: user.username, email: user.email }
  });
});

// Get profile
app.get('/api/profile', authenticateToken, (req, res) => {
  const user = db.prepare('SELECT id, username, email, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const stats = db.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(req.user.id);
  const recentAnalyses = db.prepare(
    'SELECT id, white_name, black_name, white_accuracy, black_accuracy, result, opening_name, opening_eco, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(req.user.id);

  res.json({
    user,
    stats: stats || { total_analyses: 0, avg_accuracy: 0, best_accuracy: 0 },
    recentAnalyses
  });
});

// ── ANALYSIS ROUTES ──

// Save analysis
app.post('/api/analyses', authenticateToken, (req, res) => {
  const { pgn, whiteName, blackName, whiteAccuracy, blackAccuracy, result, openingName, openingEco } = req.body;

  const id = uuidv4();
  db.prepare(
    'INSERT INTO analyses (id, user_id, pgn, white_name, black_name, white_accuracy, black_accuracy, result, opening_name, opening_eco) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, req.user.id, pgn || null, whiteName || null, blackName || null, whiteAccuracy != null ? whiteAccuracy : null, blackAccuracy != null ? blackAccuracy : null, result || null, openingName || null, openingEco || null);

  // Update user stats
  const allAnalyses = db.prepare('SELECT white_accuracy, black_accuracy FROM analyses WHERE user_id = ?').all(req.user.id);
  const accuracies = allAnalyses
    .flatMap(a => [a.white_accuracy, a.black_accuracy])
    .filter(a => a !== null && a !== undefined);
  const avgAccuracy = accuracies.length > 0 ? accuracies.reduce((s, v) => s + v, 0) / accuracies.length : 0;
  const bestAccuracy = accuracies.length > 0 ? Math.max(...accuracies) : 0;

  db.prepare(
    "UPDATE user_stats SET total_analyses = ?, avg_accuracy = ?, best_accuracy = ?, updated_at = datetime('now') WHERE user_id = ?"
  ).run(allAnalyses.length, Math.round(avgAccuracy * 100) / 100, Math.round(bestAccuracy * 100) / 100, req.user.id);

  res.status(201).json({ id, message: 'Analysis saved' });
});

// Get user analyses
app.get('/api/analyses', authenticateToken, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = parseInt(req.query.offset) || 0;

  const analyses = db.prepare(
    'SELECT id, white_name, black_name, white_accuracy, black_accuracy, result, opening_name, opening_eco, created_at FROM analyses WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(req.user.id, limit, offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM analyses WHERE user_id = ?').get(req.user.id);

  res.json({ analyses, total: total.count });
});

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Chess Analysis server running on http://localhost:${PORT}`);
});
