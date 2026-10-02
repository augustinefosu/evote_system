// Postgres backend for the application.
//
// This exposes the same small better-sqlite3-style surface the routes were
// written against — prepare().get/.all/.run — but backed by Postgres and, by
// necessity, asynchronous. Two consequences flow from that:
//
//   1. Every call site must `await`. Forgetting one is silent: `await` on the
//      adapter is what turns a pending promise into a row, so a missing await
//      yields a Promise where the old code expected a value.
//   2. Statements are written with `?` placeholders, exactly as before. The
//      conversion to Postgres `$1..$n` happens here at runtime rather than by
//      editing ~170 queries, which keeps the diff reviewable and avoids
//      miscounting placeholders after a `?` that happens to sit inside a
//      string literal.
//
// Transactions use AsyncLocalStorage rather than handing a transaction object
// to the callback. The existing code (server.js vote casting, seed.js bulk
// inserts) captures `db` itself inside the transaction callback, so a
// passed-in handle would be ignored and every inner statement would quietly run
// on a *different* pooled connection — outside the transaction, and therefore
// not atomic. Routing by async context makes those existing call sites correct
// without rewriting them.
const { AsyncLocalStorage } = require('node:async_hooks');
const supabase = require('./supabase');

const txStore = new AsyncLocalStorage();

// --- ?  ->  $1..$n ---------------------------------------------------------
//
// A straight regex replace would corrupt any `?` that appears inside a string
// literal, a quoted identifier or a comment. Those are rare in this codebase
// but not impossible (an audit detail containing a question mark, say), and a
// corrupted query is far more expensive to debug than this loop is to read.
// Postgres JSON operators (`?`, `?|`, `?&`) are deliberately not treated as
// placeholders: this application never uses them, and supporting both is
// ambiguous.
function convertPlaceholders(sql) {
  let out = '';
  // Highest positional marker seen so far. Application SQL uses only `?`, but
  // tracking existing `$n` means a query that mixes the two styles — easy to
  // introduce by copying from psql — still numbers correctly instead of
  // silently reusing $1 and passing the wrong argument.
  let n = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // An already-positional parameter: $12. Dollar-quoting is handled below and
    // cannot be confused with this, because a tag requires a closing $.
    if (ch === '$' && /[0-9]/.test(sql[i + 1] || '')) {
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j])) j++;
      const num = parseInt(sql.slice(i + 1, j), 10);
      if (num > n) n = num;
      out += sql.slice(i, j);
      i = j;
      continue;
    }

    // Line comment: -- ... end of line
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) { out += sql.slice(i); break; }
      out += sql.slice(i, end);
      i = end;
      continue;
    }

    // Block comment: /* ... */ (no nesting; matches Postgres)
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) { out += sql.slice(i); break; }
      out += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Single-quoted string, with '' as an escaped quote.
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Double-quoted identifier, with "" as an escaped quote.
    if (ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // Dollar-quoted string: $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          const stop = end + tag.length;
          out += sql.slice(i, stop);
          i = stop;
          continue;
        }
      }
    }

    if (ch === '?') {
      n += 1;
      out += '$' + n;
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

// Inside a transaction, statements must run on the transaction's own
// connection; otherwise they execute on an unrelated pooled client and are not
// covered by COMMIT/ROLLBACK.
function run(text, params) {
  const client = txStore.getStore();
  if (client) return client.query(text, params);
  return supabase.query(text, params);
}

function prepare(sql) {
  const text = convertPlaceholders(sql);
  return {
    async get(...params) {
      const result = await run(text, params);
      return result.rows[0];
    },
    async all(...params) {
      const result = await run(text, params);
      return result.rows;
    },
    // better-sqlite3 returned { lastInsertRowid, changes }; callers depend on
    // both. Postgres only knows the generated key if the statement asks for it
    // with RETURNING id, so inserts whose id is used carry that clause. Where
    // it is absent, lastInsertRowid is undefined — honest, and a reminder that
    // the caller does not need it.
    async run(...params) {
      const result = await run(text, params);
      const first = result.rows[0];
      return {
        lastInsertRowid: first && first.id !== undefined ? first.id : undefined,
        changes: result.rowCount,
      };
    },
  };
}

// Runs fn atomically and returns a callable, matching better-sqlite3's
// db.transaction(fn) — the existing code stores the result and invokes it later
// (const tx = db.transaction(fn); tx(args)), so fn receives exactly those
// arguments. Callbacks reference the module-level `db` as before:
// AsyncLocalStorage routes those calls to the transaction's own connection.
function transaction(fn) {
  return (...args) =>
    supabase.transaction(async (client) => {
      return txStore.run(client, async () => fn(...args));
    });
}

module.exports = {
  prepare,
  transaction,
  // Exposed for diagnostics and tests.
  convertPlaceholders,
  // There is no schema bootstrap here: supabase/schema.sql is the single source
  // of truth and is applied by `npm run db:migrate`. Kept so any lingering
  // caller of the SQLite module's init() does not crash.
  init() {},
};
