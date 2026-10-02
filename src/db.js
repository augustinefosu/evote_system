// Uses Node's built-in SQLite (node:sqlite) — no native build step required.
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'evoting.db');
const raw = new DatabaseSync(DB_PATH);

// Compatibility wrapper exposing the small better-sqlite3-style surface
// used by server.js / seed.js: prepare().run/.get/.all, exec, transaction.
function wrapStatement(stmt) {
  return {
    run(...params) {
      const r = stmt.run(...params);
      return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
    get(...params) {
      const row = stmt.get(...params);
      return row === undefined ? undefined : row;
    },
    all(...params) {
      return stmt.all(...params);
    },
  };
}

const db = {
  prepare(sql) {
    return wrapStatement(raw.prepare(sql));
  },
  exec(sql) {
    return raw.exec(sql);
  },
  transaction(fn) {
    // Returns a function that runs fn() atomically, like better-sqlite3.
    return (...args) => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn(...args);
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch {}
        throw err;
      }
    };
  },
};

try { raw.exec('PRAGMA journal_mode = WAL'); } catch {}
try { raw.exec('PRAGMA foreign_keys = ON'); } catch {}

function init() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT UNIQUE,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'voter' CHECK(role IN ('voter','admin','superadmin')),
    faculty TEXT DEFAULT '',
    department TEXT DEFAULT '',
    level TEXT DEFAULT '',
    verified INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS email_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS elections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    instructions TEXT DEFAULT '',
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed','published')),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    max_select INTEGER NOT NULL DEFAULT 1,
    min_select INTEGER NOT NULL DEFAULT 1,
    is_mandatory INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    student_id TEXT DEFAULT '',
    department TEXT DEFAULT '',
    faculty TEXT DEFAULT '',
    level TEXT DEFAULT '',
    affiliation TEXT DEFAULT 'Independent',
    bio TEXT DEFAULT '',
    manifesto TEXT DEFAULT '',
    photo_url TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS voter_eligibility (
    election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (election_id, user_id)
  );
  -- Who voted (NO choices stored here) — enforces One Student = One Vote
  CREATE TABLE IF NOT EXISTS vote_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    voter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reference_code TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(election_id, voter_id)
  );
  -- Anonymous ballots (NO voter link) — secret ballot
  CREATE TABLE IF NOT EXISTS ballots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    election_id INTEGER NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
    position_id INTEGER NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
    candidate_id INTEGER REFERENCES candidates(id) ON DELETE SET NULL,
    is_abstain INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ballots_election ON ballots(election_id);
  CREATE INDEX IF NOT EXISTS idx_ballots_position ON ballots(position_id);
  CREATE INDEX IF NOT EXISTS idx_ballots_candidate ON ballots(candidate_id);
  -- Support admin search / filtering (students by faculty-department-level,
  -- candidates by name, elections by status).
  CREATE INDEX IF NOT EXISTS idx_users_roll ON users(role, department, level);
  CREATE INDEX IF NOT EXISTS idx_candidates_election_pos ON candidates(election_id, position_id);
  CREATE INDEX IF NOT EXISTS idx_elections_status ON elections(status, starts_at);
  CREATE INDEX IF NOT EXISTS idx_vote_receipts_election ON vote_receipts(election_id);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    details TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  -- In-app notification outbox. Rows are written for every important event
  -- (verification, election opened/closed, results published, vote cast) so an
  -- email provider can be attached later without touching call sites.
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    election_id INTEGER REFERENCES elections(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'inapp',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    sent_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
  -- Brute-force protection: one row per login attempt, successful or not.
  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifier TEXT NOT NULL,
    ip TEXT DEFAULT '',
    ok INTEGER NOT NULL DEFAULT 0,
    -- ISO-8601 with 'T', matching the format the lockout query compares
    -- against. SQLite's datetime('now') would store a space separator, which
    -- sorts before 'T' and makes every row look older than the cutoff.
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(identifier, ok, created_at);
  `);

  // Additive migrations for databases created by earlier versions. SQLite has
  // no "ADD COLUMN IF NOT EXISTS", so each column is probed via table_info and
  // only added when genuinely missing. Existing rows are preserved.
  function addColumn(table, column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.some((c) => c.name === column)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    return true;
  }
  addColumn('elections', 'timezone', "timezone TEXT NOT NULL DEFAULT 'UTC'");
  addColumn('elections', 'published_at', 'published_at TEXT');
  addColumn('elections', 'results_public', 'results_public INTEGER NOT NULL DEFAULT 1');
  addColumn('notifications', 'read_at', 'read_at TEXT');

  const defaults = {
    school_name: 'UNIVERSITY E-VOTING SYSTEM',
    allow_registration: '1',
    require_verification_to_vote: '1',
    results_visibility: 'published_only',
    max_login_attempts: '5',
    session_hours: '12'
  };
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  for (const [k, v] of Object.entries(defaults)) ins.run(k, v);
}

init();

module.exports = db;
