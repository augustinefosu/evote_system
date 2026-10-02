// Applies supabase/schema.sql to the configured Supabase project.
//
//   npm run db:migrate
//
// Safe to re-run: every statement in the schema file is CREATE ... IF NOT
// EXISTS, CREATE OR REPLACE or INSERT ... ON CONFLICT DO NOTHING, so applying
// it repeatedly converges on the same schema instead of erroring or dropping
// data. Intended to run as a one-shot container step before the API starts.
require('./env');
const fs = require('fs');
const path = require('path');
const { getPool, isConfigured, shutdown } = require('./supabase');

const SCHEMA_PATH = path.join(__dirname, '..', 'supabase', 'schema.sql');

// Tables the application expects to exist. Verified after applying so a
// half-applied schema is reported as a failure rather than discovered later as
// a missing-table error on the first request.
const REQUIRED_TABLES = [
  'users',
  'elections',
  'positions',
  'candidates',
  'voter_eligibility',
  'vote_receipts',
  'ballots',
  'audit_logs',
  'settings',
  'notifications',
  'login_attempts',
];

async function main() {
  if (!isConfigured()) {
    console.error(
      'Cannot migrate: Supabase is not configured.\n' +
        'Set SUPABASE_DB_URL (or the SUPABASE_DB_* parts) in .env — see .env.example.'
    );
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(SCHEMA_PATH)) {
    console.error(`Cannot migrate: schema file missing at ${SCHEMA_PATH}`);
    process.exitCode = 1;
    return;
  }

  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const pool = getPool();

  // The schema file opens and commits its own transaction, so it is sent as a
  // single batch rather than nested inside one here. In the simple query
  // protocol a failure aborts the batch, so a broken statement cannot leave the
  // schema half-applied.
  console.log('[migrate] applying supabase/schema.sql ...');
  await pool.query(sql);

  const { rows } = await pool.query(
    `select table_name from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
      order by table_name`,
    [REQUIRED_TABLES]
  );
  const found = rows.map((r) => r.table_name);
  const missing = REQUIRED_TABLES.filter((t) => !found.includes(t));

  const { rows: fnRows } = await pool.query(
    `select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and proname = 'cast_vote'`
  );

  if (missing.length || !fnRows.length) {
    console.error(
      `[migrate] FAILED after applying the schema.\n` +
        (missing.length ? `  missing tables: ${missing.join(', ')}\n` : '') +
        (fnRows.length ? '' : '  missing function: public.cast_vote()\n')
    );
    process.exitCode = 1;
    return;
  }

  console.log(`[migrate] schema up to date (${found.length} tables, cast_vote() present)`);
}

main()
  .catch((err) => {
    console.error('[migrate] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdown().catch(() => {});
  });