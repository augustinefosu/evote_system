// Database backup.
//
//   npm run backup   ->  backups/evoting-<timestamp>.sql   (Supabase)
//                       backups/evoting-<timestamp>.db    (legacy SQLite)
//
// With Supabase configured this shells out to pg_dump against
// SUPABASE_DB_URL. Restoring a plain-SQL dump:
//
//   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f backups/evoting-<stamp>.sql
//
// pg_dump must be installed on the host and must be at least as new as the
// server's major version. See the Deployment section of the README. Note that
// Supabase already provides automated backups and point-in-time recovery on
// paid plans — this is an additional off-site copy, most useful before an
// election.
require('./env');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { isConfigured } = require('./supabase');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backups');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// Splits a connection URI into libpq environment variables rather than passing
// the URI as a pg_dump argument. An argument would expose the database password
// in the process list, where any local user can read it.
function libpqEnv() {
  const raw = (process.env.SUPABASE_DB_URL || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    console.error('SUPABASE_DB_URL is not a valid URI. See .env.example for the expected format.');
    process.exit(1);
  }
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return {
    PGHOST: decode(url.hostname),
    PGPORT: url.port || '5432',
    PGDATABASE: decode(url.pathname.replace(/^\//, '')) || 'postgres',
    PGUSER: decode(url.username),
    PGPASSWORD: decode(url.password),
  };
}

function backupSupabase() {
  const dest = path.join(BACKUP_DIR, `evoting-${stamp}.sql`);
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const args = [
    '--no-password',
    // --clean makes the dump restorable over an existing schema; --no-owner and
    // --no-privileges stop it trying to recreate Supabase's own `postgres` role,
    // which would fail on the target project.
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    '--format=plain',
    '--file',
    dest,
  ];

  const result = spawnSync('pg_dump', args, {
    env: { ...process.env, ...libpqEnv() },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (result.error && result.error.code === 'ENOENT') {
    console.error(
      'pg_dump was not found on PATH.\n' +
        'Install the PostgreSQL client tools (Debian/Ubuntu: apt-get install postgresql-client,\n' +
        'macOS: brew install libpq, Windows: pgAdmin or the PostgreSQL installer). See the\n' +
        'Deployment section of the README.'
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`pg_dump exited with status ${result.status}. No usable backup was written.`);
    process.exit(1);
  }

  // A zero-length dump is worse than no dump: it looks like a success and
  // restores nothing. pg_dump can exit 0 while writing nothing.
  const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  if (size === 0) {
    console.error(`pg_dump produced an empty file at ${dest} — treating as a failure.`);
    process.exit(1);
  }

  console.log(`Backup written to ${dest} (${(size / 1024).toFixed(1)} KB)`);
}

// Legacy path, retained while the application still runs on SQLite.
function backupSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'evoting.db');
  if (!fs.existsSync(DB_PATH)) {
    console.error('No database found at ' + DB_PATH + ' — nothing to back up.');
    process.exit(1);
  }
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, `evoting-${stamp}.db`);
  const db = new DatabaseSync(DB_PATH);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  db.close();
  console.log('Backup written to ' + dest + ' (legacy SQLite backend)');
}

if (isConfigured()) backupSupabase();
else backupSqlite();