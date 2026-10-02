// Supabase connection layer.
//
// Two clients, for two deliberately separate jobs:
//   - pg pool     : all application SQL. Raw Postgres, so the queries in
//                   server.js keep their existing shape and only `?` becomes
//                   `$1..$n`. This also preserves multi-statement transactions,
//                   which PostgREST cannot express.
//   - supabase-js : identity only. Supabase Auth owns passwords and sessions;
//                   roles stay in this app's own `users` table.
//
// SECURITY: the service role key bypasses Row Level Security. It must never
// leave the server. Nothing here is exposed to the browser, and the browser
// receives no database credentials at all — every query goes through the API.
const { Pool, types } = require('pg');
const { createClient } = require('@supabase/supabase-js');

// Postgres and SQLite disagree on two types the existing code depends on.
// Postgres hands back bigint as a string and timestamps as Date objects, while
// SQLite produced numbers and ISO-8601 text. Coerce both back to the shapes the
// application already expects, otherwise `COUNT(*)` arrives as "3" (breaking
// truthiness and comparisons) and date arithmetic fails silently.
types.setTypeParser(types.builtins.INT8, (v) => parseInt(v, 10));
types.setTypeParser(types.builtins.NUMERIC, (v) => parseFloat(v));
types.setTypeParser(types.builtins.TIMESTAMPTZ, (v) => new Date(v).toISOString());
types.setTypeParser(types.builtins.TIMESTAMP, (v) => new Date(`${v}Z`).toISOString());

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim();
const SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const DB_URL = (process.env.SUPABASE_DB_URL || '').trim();

function sslOption() {
  const mode = (process.env.SUPABASE_DB_SSL || 'true').trim().toLowerCase();
  if (['false', '0', 'off', 'disable', 'disabled'].includes(mode)) return false;
  // Supabase presents a certificate that is usually absent from the local CA
  // bundle, so full verification fails on developer machines by default. Set
  // SUPABASE_DB_SSL=true on infrastructure that has the root certificate.
  if (['no-verify', 'insecure', 'skip-verify'].includes(mode)) {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

function buildPoolConfig() {
  const ssl = sslOption();
  if (DB_URL) return { connectionString: DB_URL, ssl };
  const host = (process.env.SUPABASE_DB_HOST || '').trim();
  const user = (process.env.SUPABASE_DB_USER || '').trim();
  if (!host || !user) return null;
  return {
    host,
    port: Number(process.env.SUPABASE_DB_PORT || 5432),
    database: (process.env.SUPABASE_DB_NAME || 'postgres').trim(),
    user,
    password: process.env.SUPABASE_DB_PASSWORD || '',
    ssl,
  };
}

let pool = null;

function getPool() {
  if (pool) return pool;
  const config = buildPoolConfig();
  if (!config) {
    throw new Error(
      'Supabase Postgres is not configured. Set SUPABASE_DB_URL (or SUPABASE_DB_HOST, ' +
        'SUPABASE_DB_USER, SUPABASE_DB_PASSWORD) in .env — see .env.example.'
    );
  }
  pool = new Pool({ ...config, max: Number(process.env.SUPABASE_DB_POOL || 10) });
  // An idle client that dies (Supabase closes idle connections after a few
  // minutes) emits on the pool. Without a listener Node treats it as an
  // unhandled 'error' event and kills the process.
  pool.on('error', (err) => console.error('[supabase] idle client error:', err.message));
  return pool;
}

// Database connectivity. Kept separate from isAuthConfigured() because
// schema migration and the health probe only need Postgres: they must not be
// gated on Auth credentials that a deploy pipeline may not have.
function isConfigured() {
  return Boolean(buildPoolConfig());
}

function isAuthConfigured() {
  return Boolean(SUPABASE_URL && SERVICE_ROLE_KEY);
}

async function query(text, params) {
  return getPool().query(text, params);
}

// Mirrors the better-sqlite3 shape the current routes are written against:
// `.all()` yields an array, `.get()` yields a single row or undefined.
async function rows(text, params) {
  const result = await query(text, params);
  return result.rows;
}

async function row(text, params) {
  const result = await query(text, params);
  return result.rows[0];
}

async function scalar(text, params) {
  const r = await row(text, params);
  if (!r) return undefined;
  return Object.values(r)[0];
}

// Supabase JS has no transaction API, but the pool does: hold one connection
// for the whole unit of work. Required for vote casting, where the receipt and
// its ballots must either all land or none.
async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already unusable; release() below discards it.
    }
    throw err;
  } finally {
    client.release();
  }
}

let authClient = null;

function auth() {
  if (authClient) return authClient;
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error(
      'Supabase Auth is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.'
    );
  }
  authClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: {
      // The API server holds no session of its own; the browser's token is
      // always passed explicitly, so nothing should be cached or auto-refreshed.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return authClient;
}

// Verifies a browser-supplied access token and resolves it to an auth.users
// row. Returns null for every failure mode (expired, revoked, malformed,
// signed with the wrong key) so callers cannot distinguish them.
async function verifyAccessToken(token) {
  if (!token) return null;
  try {
    const { data, error } = await auth().auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  } catch (err) {
    console.error('[supabase] token verification failed:', err.message);
    return null;
  }
}

// Postgres reports constraint violations with SQLSTATE codes, not the prose
// messages SQLite produced. These helpers give call sites a stable way to tell
// "already voted" (23505 on the receipt constraint) apart from a random
// reference-code collision, which is retried rather than surfaced.
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';

function isUniqueViolation(err, constraint) {
  if (!err || err.code !== PG_UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return String(err.constraint || '').includes(constraint);
}

function isForeignKeyViolation(err, constraint) {
  if (!err || err.code !== PG_FOREIGN_KEY_VIOLATION) return false;
  if (!constraint) return true;
  return String(err.constraint || '').includes(constraint);
}

async function shutdown() {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end();
}

module.exports = {
  getPool,
  isConfigured,
  isAuthConfigured,
  query,
  rows,
  row,
  scalar,
  transaction,
  auth,
  verifyAccessToken,
  isUniqueViolation,
  isForeignKeyViolation,
  shutdown,
};