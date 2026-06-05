/**
 * MusicLearn Backend — server.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Single-file Express application.
 * Run:  node server.js
 * Deps: express, better-sqlite3 / node-sqlite3-wasm, bcryptjs, jsonwebtoken, cors
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// Load environment variables from .env (if present)
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const path       = require('path');
const fs         = require('fs');
const { Database } = require('node-sqlite3-wasm');

/* ═══════════════════════════════════════════════════════════════
   1. ENVIRONMENT CONFIG
═══════════════════════════════════════════════════════════════ */

const PORT        = process.env.PORT        || 5000;
const JWT_SECRET  = process.env.JWT_SECRET  || 'ml_jwt_secret_change_in_production_2025';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';
const DB_PATH     = process.env.DB_PATH     || path.join(__dirname, 'musiclearn.db');
const BCRYPT_ROUNDS = 10;

if (process.env.NODE_ENV === 'production' &&
    (!process.env.JWT_SECRET || JWT_SECRET.includes('change'))) {
  throw new Error('[FATAL] JWT_SECRET must be set to a strong value in production.');
}

/* ═══════════════════════════════════════════════════════════════
   2. DATABASE INITIALISATION
═══════════════════════════════════════════════════════════════ */

const db = new Database(DB_PATH);

/**
 * Initialise schema + indexes.
 * Uses CREATE TABLE/INDEX IF NOT EXISTS — safe to call on every startup.
 */
function initDatabase() {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA cache_size = -8000;');

  db.exec(`
    /* ── users ──────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_username
      ON users(username COLLATE NOCASE);

    CREATE INDEX IF NOT EXISTS idx_users_email
      ON users(email COLLATE NOCASE);

    /* ── scores ──────────────────────────────────────────── */
    CREATE TABLE IF NOT EXISTS scores (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_mode  TEXT    NOT NULL CHECK(game_mode IN ('quiz','ear-training','melody-builder')),
      high_score INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, game_mode)
    );

    /*
     * Composite index optimised for the leaderboard query:
     *   SELECT ... WHERE game_mode = ? ORDER BY high_score DESC LIMIT 20
     * SQLite stores DESC internally as ASC on a separate index — we create
     * a covering index on (game_mode, high_score) which the planner will use
     * with a reverse scan, giving O(log n) leaderboard retrieval.
     */
    CREATE INDEX IF NOT EXISTS idx_scores_leaderboard
      ON scores(game_mode, high_score DESC);

    /* ── user_achievements ───────────────────────────────── */
    CREATE TABLE IF NOT EXISTS user_achievements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id    TEXT    NOT NULL,
      unlocked_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, badge_id)
    );

    CREATE INDEX IF NOT EXISTS idx_achievements_user
      ON user_achievements(user_id);
  `);

  console.log('[DB] Schema ready —', DB_PATH);
}

initDatabase();

/**
 * Retry synchronous DB ops when SQLite reports a busy/locked database.
 * Critical for ~1800 concurrent score submissions on Render free tier.
 */
function isSqliteBusyError(err) {
  const msg = String(err?.message || err || '');
  return err?.code === 'SQLITE_BUSY' || msg.includes('SQLITE_BUSY') || msg.includes('database is locked');
}

function withBusyRetry(fn, { maxAttempts = 5, delayMs = 25 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (!isSqliteBusyError(err) || attempt === maxAttempts) throw err;
      const end = Date.now() + delayMs * attempt;
      while (Date.now() < end) { /* spin-wait */ }
    }
  }
}

function dbExec(sql) {
  return withBusyRetry(() => db.exec(sql));
}

function dbRun(stmtObj, params) {
  return withBusyRetry(() => stmtObj.run(params));
}

function dbGet(stmtObj, params) {
  return withBusyRetry(() => stmtObj.get(params));
}

function dbAll(stmtObj, params) {
  return withBusyRetry(() => stmtObj.all(params));
}

/* ═══════════════════════════════════════════════════════════════
   3. PREPARED STATEMENTS
   Compiled once at startup — dramatically faster for hot paths
═══════════════════════════════════════════════════════════════ */

const stmt = {
  // auth
  insertUser: db.prepare(
    `INSERT INTO users (username, email, password_hash)
     VALUES (?, ?, ?)`
  ),
  findUserByUsername: db.prepare(
    `SELECT id, username, email, password_hash, created_at
     FROM users WHERE username = ? COLLATE NOCASE`
  ),
  findUserByEmail: db.prepare(
    `SELECT id FROM users WHERE email = ? COLLATE NOCASE`
  ),
  findUserById: db.prepare(
    `SELECT id, username, email, created_at FROM users WHERE id = ?`
  ),

  // scores
  upsertScore: db.prepare(
    `INSERT INTO scores (user_id, game_mode, high_score, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, game_mode)
     DO UPDATE SET
       high_score = CASE WHEN excluded.high_score > high_score
                         THEN excluded.high_score ELSE high_score END,
       updated_at = CASE WHEN excluded.high_score > high_score
                         THEN datetime('now') ELSE updated_at END`
  ),
  getScore: db.prepare(
    `SELECT high_score FROM scores WHERE user_id = ? AND game_mode = ?`
  ),

  // leaderboard — uses idx_scores_leaderboard, sub-millisecond for 1800 users
  leaderboard: db.prepare(
    `SELECT u.id, u.username, s.high_score, s.updated_at
     FROM scores s
     JOIN users u ON u.id = s.user_id
     WHERE s.game_mode = ?
     ORDER BY s.high_score DESC
     LIMIT ?`
  ),

  // achievements
  insertBadge: db.prepare(
    `INSERT OR IGNORE INTO user_achievements (user_id, badge_id)
     VALUES (?, ?)`
  ),
  hasBadge: db.prepare(
    `SELECT 1 FROM user_achievements WHERE user_id = ? AND badge_id = ?`
  ),
  userBadges: db.prepare(
    `SELECT badge_id, unlocked_at
     FROM user_achievements
     WHERE user_id = ?
     ORDER BY unlocked_at ASC`
  ),
  scoresByUser: db.prepare(
    `SELECT game_mode, high_score, updated_at
     FROM scores WHERE user_id = ?
     ORDER BY game_mode`
  ),
};

/* ═══════════════════════════════════════════════════════════════
   4. BADGE RULES
═══════════════════════════════════════════════════════════════ */

/**
 * Evaluate which badges a user earns after a score submission.
 * Returns array of badge_id strings that are NEWLY unlocked.
 *
 * @param {number} userId
 * @param {string} gameMode
 * @param {number} score
 * @returns {string[]}
 */
function evaluateBadges(userId, gameMode, score) {
  const candidates = [];

  // 'badge-entry' — awarded for completing any game, any mode
  candidates.push('badge-entry');

  // Mode-specific score badges
  if (score >= 50)  candidates.push('badge-bronze');
  if (score >= 80)  candidates.push('badge-silver');
  if (score >= 100) candidates.push('badge-gold');

  // 'badge-perfect' — score == 100 in quiz specifically
  if (gameMode === 'quiz' && score === 100) {
    candidates.push('badge-quiz-perfect');
  }

  // 'badge-melody' — completed melody-builder
  if (gameMode === 'melody-builder') {
    candidates.push('badge-melody');
  }

  // Insert only badges not already held; OR IGNORE handles the unique constraint
  const newBadges = [];
  for (const badgeId of candidates) {
    const result = stmt.insertBadge.run([userId, badgeId]);
    if (result.changes > 0) newBadges.push(badgeId);
  }

  return newBadges;
}

/* ═══════════════════════════════════════════════════════════════
   5. JWT HELPERS
═══════════════════════════════════════════════════════════════ */

/**
 * Sign a JWT for a user record.
 * @param {{ id: number, username: string }} user
 * @returns {string}
 */
function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES, issuer: 'musiclearn-api' }
  );
}

/* ═══════════════════════════════════════════════════════════════
   6. MIDDLEWARE
═══════════════════════════════════════════════════════════════ */

const app = express();

// ── CORS — allow frontend dev ports and production origin
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8080',
    'https://musiclearn-vn.netlify.app',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ── Body parsers
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

// ── Request logger (dev)
app.use((req, _res, next) => {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${req.method} ${req.path}`);
  next();
});

/**
 * authenticateToken middleware.
 * Verifies `Authorization: Bearer <token>` header.
 * Attaches decoded payload to `req.user = { sub, username }`.
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authorization header missing or malformed.' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      issuer: 'musiclearn-api',
      algorithms: ['HS256'],
    });
    const user = dbGet(stmt.findUserById, payload.sub);
    if (!user) {
      return res.status(401).json({ message: 'User not found. Please log in again.' });
    }
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Token expired. Please log in again.' });
    }
    if (err.name === 'NotBeforeError') {
      return res.status(401).json({ message: 'Token not yet valid.' });
    }
    return res.status(401).json({ message: 'Invalid or malformed token.' });
  }
}

/* ═══════════════════════════════════════════════════════════════
   7. INPUT VALIDATION HELPERS
═══════════════════════════════════════════════════════════════ */

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateRegisterInput({ username, email, password }) {
  const errors = [];
  if (!username || !USERNAME_RE.test(username)) {
    errors.push('Username must be 3–30 characters: letters, numbers, underscores only.');
  }
  if (!email || !EMAIL_RE.test(email)) {
    errors.push('A valid email address is required.');
  }
  if (!password || password.length < 6) {
    errors.push('Password must be at least 6 characters.');
  }
  if (password && password.length > 128) {
    errors.push('Password must be at most 128 characters.');
  }
  return errors;
}

const VALID_MODES = new Set(['quiz', 'ear-training', 'melody-builder']);

/* ═══════════════════════════════════════════════════════════════
   8. ROUTES
═══════════════════════════════════════════════════════════════ */

/* ── Health check ──────────────────────────────────────────── */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* ────────────────────────────────────────────────────────────
   POST /api/auth/register
   Body: { username, email, password }
   Returns: 201 { token, user }
──────────────────────────────────────────────────────────── */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validate inputs
    const errors = validateRegisterInput({ username, email, password });
    if (errors.length > 0) {
      return res.status(400).json({ message: errors[0], errors });
    }

    // Check for existing username
    const existingUsername = dbGet(stmt.findUserByUsername, username);
    if (existingUsername) {
      return res.status(409).json({ message: 'Username is already taken.' });
    }

    const existingEmail = dbGet(stmt.findUserByEmail, email.toLowerCase());
    if (existingEmail) {
      return res.status(409).json({ message: 'An account with that email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = dbRun(stmt.insertUser, [
      username.trim(),
      email.trim().toLowerCase(),
      passwordHash
    ]);

    const userId = result.lastInsertRowid;
    const user   = dbGet(stmt.findUserById, userId);

    const token = signToken(user);

    return res.status(201).json({
      token,
      user: {
        id:         user.id,
        username:   user.username,
        email:      user.email,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ message: 'Username or email already exists.' });
    }
    console.error('[POST /api/auth/register]', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

/* ────────────────────────────────────────────────────────────
   POST /api/auth/login
   Body: { username, password }
   Returns: 200 { token, user }
──────────────────────────────────────────────────────────── */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || typeof username !== 'string' || username.trim() === '') {
      return res.status(400).json({ message: 'Username is required.' });
    }
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ message: 'Password is required.' });
    }

    // Lookup user — case-insensitive via COLLATE NOCASE index
    const user = dbGet(stmt.findUserByUsername, username.trim());

    if (!user) {
      // Perform a dummy bcrypt compare to prevent timing attacks
      await bcrypt.compare(password, '$2a$10$dummyhashthatsalwaysfails000000000000000000000000000');
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ message: 'Invalid username or password.' });
    }

    const token = signToken(user);

    return res.status(200).json({
      token,
      user: {
        id:         user.id,
        username:   user.username,
        email:      user.email,
        created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error('[POST /api/auth/login]', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/leaderboard?mode=quiz&limit=20
   Public — returns top N players for a given game mode.
   Uses idx_scores_leaderboard for O(log n) retrieval.
──────────────────────────────────────────────────────────── */
app.get('/api/leaderboard', (req, res) => {
  try {
    const mode  = req.query.mode  || 'quiz';
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

    if (!VALID_MODES.has(mode)) {
      return res.status(400).json({
        message: `Invalid game_mode. Must be one of: ${[...VALID_MODES].join(', ')}.`,
      });
    }

    const rows = dbAll(stmt.leaderboard, [mode, limit]);

    return res.json({
      mode,
      limit,
      total:       rows.length,
      leaderboard: rows.map((row, idx) => ({
        rank:       idx + 1,
        userId:     row.id,
        username:   row.username,
        high_score: row.high_score,
        updated_at: row.updated_at,
      })),
    });
  } catch (err) {
    console.error('[GET /api/leaderboard]', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/achievements/my-badges        [PROTECTED]
   Returns all badge IDs unlocked by the authenticated user.
──────────────────────────────────────────────────────────── */
app.get('/api/achievements/my-badges', authenticateToken, (req, res) => {
  try {
    const userId = req.user.sub;
    const rows = dbAll(stmt.userBadges, userId);

    return res.json({
      userId,
      badges: rows.map(r => ({
        badge_id:    r.badge_id,
        unlocked_at: r.unlocked_at,
      })),
    });
  } catch (err) {
    console.error('[GET /api/achievements/my-badges]', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

/* ────────────────────────────────────────────────────────────
   POST /api/scores/submit                [PROTECTED]
   Body: { game_mode: string, score: number }

   Logic:
   1. Validate inputs.
   2. Upsert score — only updates if new score is strictly higher.
   3. Evaluate badge rules on the new score.
   4. Insert any newly earned badges (OR IGNORE duplicates).
   5. Return updated high score + any new badges.
──────────────────────────────────────────────────────────── */
app.post('/api/scores/submit', authenticateToken, (req, res) => {
  try {
    const userId   = req.user.sub;
    const { game_mode, score } = req.body;

    // ── Validate
    if (!game_mode || !VALID_MODES.has(game_mode)) {
      return res.status(400).json({
        message: `game_mode must be one of: ${[...VALID_MODES].join(', ')}.`,
      });
    }
    if (score === undefined || score === null) {
      return res.status(400).json({ message: 'score is required.' });
    }
    const numericScore = parseInt(score, 10);
    if (!Number.isInteger(numericScore) || numericScore < 0) {
      return res.status(400).json({ message: 'score must be a non-negative integer.' });
    }
    if (numericScore > 100000) {
      return res.status(400).json({ message: 'score value is out of range.' });
    }

    const beforeRow = dbGet(stmt.getScore, [userId, game_mode]);
    const previousHigh = beforeRow ? beforeRow.high_score : 0;

    dbExec('BEGIN IMMEDIATE;');
    try {
      dbRun(stmt.upsertScore, [userId, game_mode, numericScore]);
      const scoreRow  = dbGet(stmt.getScore, [userId, game_mode]);
      const highScore = scoreRow ? scoreRow.high_score : numericScore;
      const newBadges = evaluateBadges(userId, game_mode, numericScore);
      dbExec('COMMIT;');

      return res.json({
        message:     'Score submitted successfully.',
        game_mode,
        score_submitted: numericScore,
        high_score:  highScore,
        new_badges:  newBadges,
        is_new_high: numericScore > previousHigh,
      });
    } catch (txErr) {
      try { dbExec('ROLLBACK;'); } catch (_) {}
      throw txErr;
    }
  } catch (err) {
    console.error('[POST /api/scores/submit]', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/scores/me                     [PROTECTED]
   Returns all scores for the authenticated user across all modes.
──────────────────────────────────────────────────────────── */
app.get('/api/scores/me', authenticateToken, (req, res) => {
  try {
    const userId = req.user.sub;
    const rows = dbAll(stmt.scoresByUser, userId);

    return res.json({ userId, scores: rows });
  } catch (err) {
    console.error('[GET /api/scores/me]', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/users/me                      [PROTECTED]
   Returns authenticated user's profile.
──────────────────────────────────────────────────────────── */
app.get('/api/users/me', authenticateToken, (req, res) => {
  try {
    const user = dbGet(stmt.findUserById, req.user.sub);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    return res.json({
      id:         user.id,
      username:   user.username,
      email:      user.email,
      created_at: user.created_at,
    });
  } catch (err) {
    console.error('[GET /api/users/me]', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

/* ────────────────────────────────────────────────────────────
   GET /api/badges/all
   Public — lists every badge definition in the system.
──────────────────────────────────────────────────────────── */
const ALL_BADGES = [
  { id: 'badge-entry',        name: 'First Step',     description: 'Complete your first game.',               icon: '🎵' },
  { id: 'badge-bronze',       name: 'Bronze Ear',     description: 'Score ≥ 50 points.',                      icon: '🥉' },
  { id: 'badge-silver',       name: 'Silver Ear',     description: 'Score ≥ 80 points.',                      icon: '🥈' },
  { id: 'badge-gold',         name: 'Gold Ear',       description: 'Score ≥ 100 points.',                     icon: '🥇' },
  { id: 'badge-quiz-perfect', name: 'Perfect Quiz',   description: 'Score 100 in Quiz mode.',                 icon: '🏆' },
  { id: 'badge-melody',       name: 'Composer',       description: 'Complete a Melody Builder session.',      icon: '🎼' },
];

app.get('/api/badges/all', (_req, res) => {
  res.json({ badges: ALL_BADGES });
});

/* ═══════════════════════════════════════════════════════════════
   9. 404 & GLOBAL ERROR HANDLER
═══════════════════════════════════════════════════════════════ */

app.use((_req, res) => {
  res.status(404).json({ message: 'Endpoint not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ message: 'An unexpected error occurred.' });
});

/* ═══════════════════════════════════════════════════════════════
   10. GRACEFUL SHUTDOWN
═══════════════════════════════════════════════════════════════ */

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
  shutdown('uncaughtException');
});

function shutdown(signal) {
  console.log(`\n[Server] ${signal} received — closing database and exiting.`);
  try { db.close(); } catch (_) {}
  process.exit(0);
}

/* ═══════════════════════════════════════════════════════════════
   11. START
═══════════════════════════════════════════════════════════════ */

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  MusicLearn API — listening on :${PORT}    ║`);
  console.log(`╠══════════════════════════════════════════╣`);
  console.log(`║  POST /api/auth/register                 ║`);
  console.log(`║  POST /api/auth/login                    ║`);
  console.log(`║  GET  /api/leaderboard?mode=quiz         ║`);
  console.log(`║  POST /api/scores/submit        [auth]   ║`);
  console.log(`║  GET  /api/scores/me            [auth]   ║`);
  console.log(`║  GET  /api/achievements/my-badges[auth]  ║`);
  console.log(`║  GET  /api/users/me             [auth]   ║`);
  console.log(`║  GET  /api/badges/all                    ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
