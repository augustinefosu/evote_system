# UNIVERSITY E-VOTING SYSTEM

Secure, responsive online university election platform. Students verify, view candidates and
manifestos, and cast **one secret ballot** per election with a confirmation reference.
Administrators manage elections, positions, candidates and the electoral roll; super-administrators
manage accounts, roles, audit logs and platform settings.

## Quick start

```powershell
cd university-evoting-system
npm install
Copy-Item .env.example .env      # then edit the secrets
npm run seed                     # demo data -> the Postgres in SUPABASE_DB_URL
npm start                        # http://localhost:3000
npm test                         # 77 tests, isolated temp Postgres databases
```

Node.js 22.5+ is required (global `fetch`/`WebSocket` for the API and browser test suites). The
application talks to Postgres through the pure-JavaScript `pg` driver — no native module to compile
— and the frontend has no build step. Only the legacy SQLite backup path needs the built-in
`node:sqlite`.

## Demo accounts (seeded)

| Role | Email / ID | Password |
|---|---|---|
| Super admin | superadmin@university.edu | SuperAdmin@2026 |
| Admin | admin@university.edu | Admin@2026 |
| Student (verified) | ama.serwaa@student.university.edu / UEN0012023 | Student@2026 |

## Key security properties

- **One Student = One Vote**: `UNIQUE(election_id, voter_id)` on `vote_receipts` plus a
  transactional insert, so a concurrent double submission cannot produce two ballots. The server
  re-validates the election window, eligibility, verification, candidate↔position binding and the
  min/max selection rules. Frontend disabling is cosmetic only.
- **Secret ballot**: `vote_receipts` (who voted, plus the reference) is stored **separately** from
  `ballots` (anonymous choices, with no voter foreign key). Results endpoints return aggregates
  only, and no endpoint ever returns a submitted ballot's choices — not even to an administrator.
- **Authentication**: bcryptjs (cost 12), JWT in an httpOnly cookie (`evs_token`), role middleware
  (`voter`/`admin`/`superadmin`), per-account lockout after repeated failures, per-IP rate limits,
  generic forgot-password responses, and SHA-256 hashed reset tokens with expiry.
- **CSRF**: double-submit cookie (`evs_csrf`) enforced on every cookie-authenticated write.
  Bearer-token and unauthenticated requests are exempt, since they are not forgeable by a browser.
- **Transport headers**: a strict Content-Security-Policy with `script-src 'self'` (no inline
  scripts, no inline event handlers), plus `nosniff`, `X-Frame-Options` and a restrictive
  `Permissions-Policy`.
- **Uploads**: 3 MB limit, declared-MIME allowlist *and* magic-byte verification, so a script
  announced as `image/png` is rejected. Stored filenames are generated server-side, never taken from
  the client, and uploads are served inert (`Content-Security-Policy: sandbox`, `nosniff`).
- **Audit log**: authentication, voting and administrative actions are recorded with actor, IP and
  target, viewable by super-administrators.
- **Production guards**: the server refuses to boot in production with an unset or still-placeholder
  `JWT_SECRET`, or one shorter than 32 characters.

## Structure

```
src/server.js       Express API, security middleware and static frontend
src/db-pg.js        Postgres adapter: prepare().get/.all/.run, ?→$n, transactions
src/env.js          Shared .env loader (no dependency)
src/supabase.js     Supabase Postgres pool + query/transaction helpers, Supabase Auth client
src/auth.js         Supabase Auth middleware (authRequired, requireRole) — scaffolded, not yet wired in
supabase/schema.sql Postgres schema, cast_vote() and the auth-to-profile triggers
src/seed.js         Demo election, positions, candidates and users
src/mailer.js       SMTP transport with an in-app/log fallback
src/backup.js       pg_dump backup (SQLite fallback kept for legacy databases)
public/             Responsive HTML/CSS/JS, no build step and no CDN dependencies
uploads/            Candidate photos (served inertly)
tests/              node:test suites: API, security, mailer, browser
tests/helpers/      One disposable Postgres database per test run
```

Every page loads its behaviour from a file under `/js`. No inline `<script>` or `on*=` handler
exists anywhere in `public/`, which is what allows the strict CSP to stay strict.

## Supabase backend

The application runs on **Postgres** (Supabase). `src/db-pg.js` presents the same
`prepare().get/.all/.run` surface the routes were originally written against, but asynchronous and
against Postgres: `?` placeholders are rewritten to `$1..$n`, and `db.transaction()` binds every
statement in its callback to a single pooled connection via `AsyncLocalStorage`, so nested
`db.prepare()` calls join the transaction.

Authentication still uses the app's own `users` table and its JWT sessions. Supabase Auth is
scaffolded (`src/auth.js`, the `auth.users` link, and the sync triggers) but not yet switched on.

Setup:

1. Copy the connection URI from **Database → Connection string** into `SUPABASE_DB_URL` in `.env`,
   along with `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from **Settings → API**. Percent-encode
   the database password; prefer the Supavisor pooler hostname over the direct one, which is
   IPv6-only. See `.env.example` for the details.
2. Apply the schema once, in the SQL Editor:
   ```sh
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/schema.sql
   ```

Two things carry over deliberately and should not be "cleaned up":

- **Vote atomicity.** Casting a ballot runs inside one Postgres transaction (`db.transaction()` in
  `src/db-pg.js`) that holds a single pooled connection for the receipt and every ballot it writes.
  The `vote_receipts_election_voter_key` unique constraint — not application code — is what prevents
  a double vote; the schema also ships an equivalent server-side `cast_vote()` function.
- **Ballot secrecy.** `ballots` has no voter column and `vote_receipts` stores no choices, so the
  two tables can never be joined to reveal how anyone voted. Row Level Security is enabled with no
  policies: `anon` and `authenticated` get nothing, and the API server connects with the service
  role key. Requests only ever arrive through the audited Express layer.

The service role key bypasses RLS entirely. It must stay server-side; no Supabase credential is
ever sent to the browser.

## Main API

- `POST /api/auth/register|verify|login|logout|forgot|reset|change-password`, `GET /api/auth/me`
- `GET /api/elections`, `GET /api/elections/:id`, `POST /api/elections/:id/vote`,
  `GET /api/elections/:id/results`
- `GET /api/admin/stats` (includes `recent` audit entries for the admin activity pane), CRUD
  `/api/admin/elections`, `/positions`, `/candidates` (multipart photo), voters and eligibility
- `GET /api/admin/voters` (search/filter + facet dropdowns), `GET /api/admin/voters/export.csv`
- `GET /api/admin/elections/:id/roll` — participation per student, never choices
- `POST /api/admin/elections/:id/eligibility` (add), `DELETE .../eligibility/:uid` (remove),
  `GET .../eligibility` (list), `POST .../eligibility/import` (CSV), `GET /api/admin/eligibility-template`
- `GET /api/admin/elections/:id/results.csv`
- `GET/POST/PUT/DELETE /api/super/users`, `GET /api/super/logs`, `GET/PUT /api/super/settings`
- `GET /api/health` — unauthenticated liveness probe, reports database status
- `POST /api/setup/superadmin` (first-time bootstrap, requires `ADMIN_SETUP_KEY`)

### Division of responsibility

Election administrators control **roll membership** — which registered students may vote in a given
election — plus candidates, positions and elections. Creating, verifying, disabling or deleting a
student **account** is deliberately a super-administrator action, so no single election administrator
can alter accounts across unrelated elections.

### Results visibility

The `results_visibility` setting controls who may read results before they are published:

| Mode | Behaviour |
|---|---|
| `published_only` (default) | Results appear only after the election is published. |
| `all_authenticated` | Any signed-in user may view results once the election has closed. |
| `admins_only` | Results are restricted to administrators. |

## Tests

```powershell
# Requires a local or disposable Postgres. Each test file creates and drops its
# own database. Point TEST_PG_ADMIN_URL at it in .env.local (see .env.example).
npm test
```

77 tests across four suites, each against a throwaway **Postgres database** and its own port
(3211–3213), so a running development server is never disturbed:

- `tests/evoting.test.js` — registration, verification, the one-ballot guarantee under concurrency,
  election lifecycle transitions, results, CSV import/export, the scheduler and audit logging.
- `tests/security.test.js` — CSP and transport headers, CSRF enforcement and its exemptions, login
  lockout, upload content sniffing, lifecycle guards, results visibility, ballot secrecy and
  super-administrator safeguards.
- `tests/mailer.test.js` — SMTP configuration detection and the in-app fallback.
- `tests/browser.test.js` — runtime smoke tests that drive a real headless Edge/Chrome over the
  DevTools Protocol (using Node's built-in `WebSocket`, so there is no puppeteer dependency). Every
  page is loaded for real and checked for uncaught exceptions, console errors, failed subresource
  requests and CSP violations, and each admin/super-admin tab is exercised by clicking it. This is
  what catches broken page controllers, which the API suites cannot see. The suite skips itself if
  no Chromium-based browser is installed; set `BROWSER_BIN` to point at a specific one, or
  `BROWSER_TEST=0` to skip it explicitly (useful on a CI image with no browser).

If a stale server is holding a test port, the API suites now fail fast with that server's output
instead of silently testing it.

## Deployment

Supabase runs the database and authentication. It does not run the Express API, so that process
still needs a host of its own — any Node host that can reach Supabase over the network and forward
a port (Railway, Render, Fly.io, a VM behind Caddy/Nginx, or `node src/server.js` on a machine).
There is no container definition in this repository; run the app directly or add a host-specific
one.

> **Not a static site.** Netlify, GitHub Pages and similar static-only hosts cannot run this app.
> The API, authentication and voting execute inside `src/server.js`, and the frontend calls
> `/api/...` same-origin (`public/js/api.js`), so the API and pages must be served from one origin.

### Render

`render.yaml` is a ready-made blueprint: one Node web service that runs the API and serves the
static pages on one origin.

1. Render Dashboard → **New → Blueprint** → select this repo → **Apply**.
2. Fill in the values Render prompts for: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `SUPABASE_DB_URL` and `ADMIN_SETUP_KEY`. `JWT_SECRET` is generated for you.
3. The start command runs `npm run db:migrate` before `npm start`, so the schema is applied on
   every boot (the free plan has no pre-deploy command; on a paid plan move it to
   `preDeployCommand`).
4. After the first deploy, call `POST /api/setup/superadmin` with `ADMIN_SETUP_KEY` to create the
   first administrator, then delete that variable.

Free instances sleep after ~15 minutes idle, so the first request after a pause wakes the service.
Render injects `RENDER_EXTERNAL_URL`, which `src/mailer.js` uses for email links — set `APP_URL`
only if you attach a custom domain.

```powershell
npm ci --omit=dev      # install
npm run db:migrate     # apply supabase/schema.sql (idempotent) — run before first start
npm start              # node src/server.js
npm run backup         # pg_dump -> backups/evoting-<timestamp>.sql
```

`npm run db:migrate` is safe to re-run: every statement is `CREATE ... IF NOT EXISTS` or
`CREATE OR REPLACE`, so it converges on the same schema rather than failing or dropping data.
Run it as a deploy step and let the API start only after it exits 0, so the server never boots
against a missing schema.

Put the app behind an HTTPS reverse proxy (Caddy/Nginx), forward only 443, and set `APP_URL` to the
public URL so emailed links are correct. Set `NODE_ENV=production`. Health probe: `GET /api/health`,
which reports `backend` and returns 503 if Supabase is unreachable. Send `SIGTERM` to stop, so
in-flight votes drain and the connection pool closes cleanly.

`npm run backup` needs the PostgreSQL client tools on the host, because `pg_dump` is not bundled
with Node:

```powershell
# Debian/Ubuntu
sudo apt-get install postgresql-client
# macOS
brew install libpq
```

## Production checklist

- [ ] `SUPABASE_DB_URL` set with a **percent-encoded** password, using the Supavisor pooler
      hostname (the direct `db.<ref>` host is IPv6-only and fails on IPv4-only networks).
- [ ] `SUPABASE_DB_SSL=true` in production. `no-verify` is a developer-machine convenience for
      Supabase's certificate not being in the local CA bundle; keep it strictly `true` on the host.
- [ ] Service role key supplied through the host's secret store only, never in a committed file and
      never in the browser. It bypasses Row Level Security entirely.
- [ ] Strong random `JWT_SECRET` and a fresh `ADMIN_SETUP_KEY`, then delete the setup key once the
      first super-administrator exists (the server refuses to start on a placeholder secret).
- [ ] SMTP configured via `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` + `MAIL_FROM`. When set,
      verification and reset tokens are emailed and no longer returned in API responses. Without it
      they are logged, so the system works but tokens are visible in server logs.
- [ ] `CORS_ORIGINS` left unset unless a genuinely separate frontend needs access.
- [ ] Regular `npm run backup` copies, stored off-server and restore-tested. Restoring is
      `psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f backups/evoting-<stamp>.sql`. Supabase's own
      automated backups and point-in-time recovery cover the provider side; these are off-site.
- [ ] Object storage (Supabase Storage) for `uploads/` if running more than one replica — each
      replica otherwise has its own local copy of the candidate photos.
- [ ] Consider `allow_registration=0` with a CSV-imported, vetted electoral roll.
- [ ] Publish results only after the election has closed.
