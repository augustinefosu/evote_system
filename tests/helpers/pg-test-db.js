// Creates a disposable Postgres database for a test run.
//
// The suite used to hand each spawned server a throwaway SQLite file
// (DB_PATH). The application now runs exclusively on Postgres, so each test
// file instead creates its own database, applies the schema, and drops it
// afterwards. Isolation is per-database, so the test files can still run in
// parallel.
//
// Requires TEST_PG_ADMIN_URL, e.g. postgresql://postgres:secret@127.0.0.1:5432/postgres
// The schema depends on Supabase's managed auth.users, so the local fixture
// that stubs it is applied first.
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
// Load .env / .env.local so TEST_PG_ADMIN_URL can live alongside the other
// configuration instead of having to be exported in every shell. Real
// environment variables still win, so CI can override it.
require('../../src/env');

const ROOT = path.join(__dirname, '..', '..');

function adminUrl() {
  const url = process.env.TEST_PG_ADMIN_URL;
  if (!url) {
    throw new Error(
      'TEST_PG_ADMIN_URL is not set. The tests now require a Postgres server, e.g.\n' +
      '  $env:TEST_PG_ADMIN_URL="postgresql://postgres:evstest123@127.0.0.1:5432/postgres"\n' +
      '  npm test'
    );
  }
  return url;
}

async function withClient(url, fn) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

function makeDbName() {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `evs_test_${process.pid}_${Date.now().toString(36)}_${rand}`;
}

// Swap the database component of a connection string, preserving any query
// string (sslmode etc.).
function withDatabase(url, dbName) {
  return url.replace(/\/[^/?]*(\?.*)?$/, '/' + dbName + '$1');
}

async function createTestDatabase() {
  const admin = adminUrl();
  const name = makeDbName();
  // The name is generated, but validate anyway so it is never interpolated into
  // DDL without a guarantee it is a bare identifier.
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('unsafe test database name: ' + name);

  await withClient(admin, (c) => c.query('CREATE DATABASE ' + name));

  const url = withDatabase(admin, name);
  try {
    await withClient(url, async (c) => {
      const stub = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'supabase-auth-stub.sql'), 'utf8');
      const schema = fs.readFileSync(path.join(ROOT, 'supabase', 'schema.sql'), 'utf8');
      await c.query(stub);
      await c.query(schema);
    });
  } catch (err) {
    // Do not leak a half-built database if the schema fails to apply.
    await withClient(admin, (c) => c.query('DROP DATABASE IF EXISTS ' + name)).catch(() => {});
    throw err;
  }

  return {
    url,
    name,
    async drop() {
      await withClient(admin, async (c) => {
        // FORCE terminates any lingering server connection so the drop cannot
        // fail because the child process has not finished exiting.
        await c.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
      });
    },
  };
}

module.exports = { createTestDatabase };
