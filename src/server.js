const fs = require('fs');
const path = require('path');
try { require('dotenv'); } catch {}
// Minimal .env loader (no dependency), shared with src/supabase.js so every
// entry point resolves environment variables the same way.
require('./env');

const express = require('express');
// Express 4 does not forward rejections from `async` route handlers to the error
// middleware. Without this, a failed database call inside (for example)
// registration becomes an unhandled rejection, and on Netlify Functions that
// kills the invocation and surfaces as an opaque 502 with no JSON body. This
// patch routes those rejections to the JSON error handler further down.
require('express-async-errors');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const uuidv4 = () => crypto.randomUUID();

const db = require('./db-pg');
const mailer = require('./mailer');
const supabase = require('./supabase');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
// Netlify Function (and Lambda) entry points set APP_RUNTIME=function before
// requiring this module. A config error there must fail the request instead of
// killing a warm container with process.exit().
const IN_FUNCTION = process.env.APP_RUNTIME === 'function';
// Every supported host (Netlify Functions, Render, Nginx) terminates TLS in
// front of the app, so the socket peer is the proxy. Without this, req.ip is
// the proxy and express-rate-limit becomes one global bucket (a handful of
// logins would lock out the whole site). Default to one trusted hop; set
// TRUST_PROXY to a number, or an Express proxy-addr expression, to match a
// deployment with a different topology.
const TRUST_PROXY = process.env.TRUST_PROXY;
app.set('trust proxy', TRUST_PROXY
  ? (/^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY)
  : 1);
function fatalConfig(message) {
  console.error('[security] ' + message);
  CONFIG_ERRORS.push(message);
  // A long-lived server refuses to boot. In a serverless function, throwing at
  // import time would make Netlify answer every request with an opaque 502, so
  // the problem is recorded and reported per request by the middleware below.
  if (!IN_FUNCTION) process.exit(1);
}

// Configuration problems that must stop auth/database work. Populated at import
// time and surfaced to operators via /api/health and to clients as a 503.
const CONFIG_ERRORS = [];

// Secrets come from the environment only. A development fallback keeps `npm
// start` frictionless, but production refuses to run on a default secret rather
// than silently signing tokens with a publicly known key.
const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me-0123456789abcdef';
const JWT_SECRET = process.env.JWT_SECRET || DEV_JWT_SECRET;
// Values that are published in .env.example, the README, or the source itself.
// They are long enough to pass a length check, so length alone is not enough to
// keep a real deployment from signing tokens with a publicly known key.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  DEV_JWT_SECRET,
  'change-me-to-a-long-random-secret-in-production-min-32-chars',
]);
if (IS_PROD && KNOWN_PLACEHOLDER_SECRETS.has(JWT_SECRET)) {
  fatalConfig('JWT_SECRET is unset or still the documented placeholder. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
}
if (JWT_SECRET.length < 32) {
  fatalConfig('JWT_SECRET must be at least 32 characters.');
}
const ADMIN_SETUP_KEY = process.env.ADMIN_SETUP_KEY || '';

// When required configuration is missing, fail every API call with an explicit
// 503 instead of letting a route crash the function. /api/health stays
// reachable so the operator can see exactly what is wrong.
if (CONFIG_ERRORS.length) {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();
    res.status(503).json({ error: 'Server configuration error: ' + CONFIG_ERRORS.join('; ') });
  });
}

// One-line configuration summary for the logs. On Netlify it appears under
// Functions -> api -> logs and shows at a glance which variables a deployment
// is missing. Presence flags only; never the values.
console.log('[config] ' + JSON.stringify({
  node_env: process.env.NODE_ENV || '(unset)',
  supabase_url: Boolean(process.env.SUPABASE_URL),
  supabase_service_role_key: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
  supabase_db_url: Boolean(process.env.SUPABASE_DB_URL),
  supabase_db_ssl: process.env.SUPABASE_DB_SSL || 'true (default)',
  supabase_storage_bucket: Boolean(process.env.SUPABASE_STORAGE_BUCKET),
  admin_setup_key: Boolean(process.env.ADMIN_SETUP_KEY),
  jwt_secret: KNOWN_PLACEHOLDER_SECRETS.has(JWT_SECRET) ? 'placeholder' : 'ok',
  config_errors: CONFIG_ERRORS,
}));

// Last-resort safety net: a rejection that escapes a route is logged rather
// than terminating a warm function container outright. Route rejections are
// already handled by express-async-errors above; this only catches stray work.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '12h';

// Content-Security-Policy is enabled deliberately. Every page loads its
// JavaScript from a file under /js (no inline <script>, no inline event
// handlers), so a strict script-src is achievable and blocks script injection.
// 'unsafe-inline' is granted to styles only, because layout utilities use style
// attributes; it is not a script execution vector.
// Candidate photos uploaded to Supabase Storage are served from the project
// origin, so the strict img-src has to allow exactly that host and nothing else.
const SUPABASE_ORIGIN = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:', ...(SUPABASE_ORIGIN ? [SUPABASE_ORIGIN] : [])],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': [],
    },
  },
  crossOriginEmbedderPolicy: false,
  // Candidate photos are user-supplied; never let a browser sniff or embed them.
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' },
}));

// CORS is off by default: the SPA is served from the same origin as the API, so
// reflecting arbitrary origins would only widen the CSRF/XSS surface. Multiple
// trusted origins can be opted into with CORS_ORIGINS (comma-separated).
const CORS_ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (CORS_ORIGINS.length) {
  app.use(cors({ origin: CORS_ORIGINS, credentials: true, methods: ['GET', 'POST', 'PUT', 'DELETE'] }));
}
app.use(morgan(IS_PROD ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// Coarse per-IP limits plus the per-account lockout enforced in the login
// handler. Limits are tighter on auth endpoints than on ordinary API reads.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 10 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
const tokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PROD ? 10 : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
});
app.use('/api/auth/verify', tokenLimiter);
app.use('/api/auth/reset', tokenLimiter);
app.use('/api/auth/forgot', tokenLimiter);
app.use('/api/auth/change-password', authLimiter);
// Vote submission is rate limited per IP as a second layer; the authoritative
// one-vote-per-election rule is enforced by a unique constraint in the database.
const voteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many vote submissions. Please wait a minute.' },
});
app.use('/api/elections/:id/vote', voteLimiter);

// ---------- Uploads ----------
// Candidate photos only. The stored extension is derived from an allow-list
// keyed on the declared MIME type, never from the client-supplied filename, so
// an attacker cannot land an .html/.svg payload that the browser would execute
// when served back from our own origin.
//
// Files are held in memory rather than on disk: on Netlify (and any serverless
// host) the filesystem is ephemeral and read-only. When Supabase Storage is
// configured the bytes go to a public bucket; otherwise (local dev and the test
// suites) they are written to uploads/ and served by the static handler below.
const uploadDir = path.join(__dirname, '..', 'uploads');
// On serverless hosts the bundle filesystem is read-only, so this must never
// throw at import time. When Supabase Storage is configured nothing is written
// here; local dev and the test suites still get a real directory.
try { if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true }); }
catch { /* read-only filesystem: rely on Supabase Storage */ }
const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const MIME_BY_EXT = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime]),
);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 1 },
  fileFilter: (req, f, cb) => {
    if (EXT_BY_MIME[f.mimetype]) return cb(null, true);
    const err = new Error('Only JPEG, PNG, WebP or GIF images are allowed');
    err.status = 400;
    cb(err);
  },
});

// The declared MIME type is only a claim. Magic-byte sniffing confirms the
// bytes really are an image before anything is kept, so a script or HTML
// payload announced as image/png is rejected instead of stored. The stored
// name is still derived from the allowlist, never from the client's filename.
function sniffImageBuffer(buffer) {
  if (!buffer || buffer.length < 3) return null;
  const head = buffer.subarray(0, 16);
  // JPEG: FF D8 FF
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  // GIF: "GIF87a" or "GIF89a"
  if (head.length >= 6 && head.subarray(0, 3).toString('latin1') === 'GIF') return '.gif';
  // WebP: "RIFF" ....  "WEBP"
  if (head.length >= 12
    && head.subarray(0, 4).toString('latin1') === 'RIFF'
    && head.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  return null;
}

// Wraps the multer middleware: on success the buffer is verified and any file
// that fails sniffing is rejected before the route handler can store it.
function verifiedUpload(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) return next();
    const sniffed = sniffImageBuffer(req.file.buffer);
    if (!sniffed) {
      const e = new Error('File content is not a valid JPEG, PNG, WebP or GIF image');
      e.status = 400;
      return next(e);
    }
    // Record the type we actually verified, not the one the client claimed.
    req.file.sniffedExt = sniffed;
    req.file.mimetype = MIME_BY_EXT[sniffed] || req.file.mimetype;
    return next();
  });
}

// Persists a verified upload and returns the URL stored in candidates.photo_url:
// Supabase Storage in production, local disk as the development/test fallback.
async function persistCandidatePhoto(file) {
  const ext = file.sniffedExt || '.img';
  if (supabase.isStorageConfigured()) {
    return supabase.uploadCandidatePhoto(file.buffer, ext, file.mimetype);
  }
  const filename = 'candidate-' + Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext;
  fs.writeFileSync(path.join(uploadDir, filename), file.buffer);
  return '/uploads/' + filename;
}
// Serve uploads inertly: never sniffed, never executed, never framed. Only the
// local-disk fallback writes here; Supabase Storage URLs bypass it entirely.
app.use('/uploads', express.static(uploadDir, {
  index: false,
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline');
  },
}));

// ---------- CSRF (double-submit cookie) ----------
// The API accepts two kinds of credentials: an httpOnly cookie (browser SPA)
// and an `Authorization: Bearer` token (scripts, mobile clients, tests).
// Only cookie-authenticated requests are vulnerable to cross-site forgery, so
// the CSRF check is applied to exactly those. A readable `evs_csrf` cookie is
// issued to every client and must be echoed back in the X-CSRF-Token header.
const CSRF_COOKIE = 'evs_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
app.use((req, res, next) => {
  if (!req.cookies[CSRF_COOKIE]) {
    res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString('hex'), {
      httpOnly: false, sameSite: 'lax', path: '/',
    });
  }
  next();
});
app.use((req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  // The threat this defends against is a third-party site making the browser
  // send a state-changing request with the victim's ambient session cookie.
  // That requires a session cookie to be present, so unauthenticated endpoints
  // (login, register, verify, forgot, reset) and Bearer-authenticated clients
  // are not subject to the check.
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) return next();
  if (!req.cookies || !req.cookies.evs_token) return next();
  const sent = req.get('x-csrf-token') || (req.body && req.body._csrf);
  const expected = req.cookies[CSRF_COOKIE];
  if (!expected || !sent || sent !== expected) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token. Reload the page and try again.' });
  }
  next();
});


// ---------- helpers ----------
// Audit, setting reads and auth lookups all go through the Postgres adapter, so
// every helper below is async and its call sites await it. audit() is the one
// exception callers leave un-awaited: it is a fire-and-forget logger, and its
// own try/catch swallows failures (including a rejected await) so a logging
// problem can never surface as an unhandled rejection.
async function audit(actorId, action, details, req) {
  try {
    await db.prepare('INSERT INTO audit_logs(actor_id, action, details, ip) VALUES(?,?,?,?)')
      .run(actorId || null, action, details || '', (req && (req.ip || '')) || '');
  } catch {}
}
async function getSetting(key, fallback) {
  const row = await db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : fallback;
}
function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}
function getTokenFromReq(req) {
  if (req.cookies && req.cookies.evs_token) return req.cookies.evs_token;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}
async function authRequired(req, res, next) {
  const token = getTokenFromReq(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Role is always re-read from the database so a demoted or disabled account
    // loses access immediately instead of when its token happens to expire.
    const user = await db.prepare('SELECT id, student_id, name, email, role, faculty, department, level, verified, is_active FROM users WHERE id=?').get(payload.id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'Account disabled or not found' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
    next();
  };
}
function withComputed(e) {
  if (!e) return e;
  const now = Date.now();
  let display = e.status;
  // An election whose window has passed reads as closed even before the
  // scheduler has persisted the change, so the UI never offers a stale ballot.
  if (e.status === 'open' && new Date(e.ends_at).getTime() < now) display = 'closed';
  return { ...e, display_status: display };
}
function makeReference(electionId) {
  const year = new Date().getFullYear();
  return `EVS-${year}-${electionId}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
// Instants are stored as UTC ISO-8601. The election's IANA zone is retained so
// the schedule can be displayed and audited in the university's local time
// rather than the server's, and validated through Intl rather than trusted.
function normaliseTimezone(tz) {
  if (tz === undefined || tz === null || tz === '') return 'UTC';
  const value = String(tz).trim();
  if (value.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return null;
  }
}

// ---------- brute-force protection ----------
const LOCK_WINDOW_MS = 15 * 60 * 1000;
async function recordLoginAttempt(identifier, ip, ok) {
  try {
    // created_at is written explicitly as ISO-8601. The column is text and the
    // lockout query below compares it as a string, so the default must keep the
    // 'T' separator: ' ' sorts before 'T', and rows stamped with a space would
    // never compare as newer than the ISO cutoff — which would silently disable
    // the lockout entirely.
    await db.prepare('INSERT INTO login_attempts(identifier, ip, ok, created_at) VALUES(?,?,?,?)')
      .run(String(identifier).slice(0, 120), ip || '', ok ? 1 : 0, new Date().toISOString());
  } catch {}
}
async function recentFailures(identifier) {
  const since = new Date(Date.now() - LOCK_WINDOW_MS).toISOString();
  const row = await db.prepare('SELECT COUNT(*) c FROM login_attempts WHERE identifier=? AND ok=0 AND created_at > ?')
    .get(String(identifier).slice(0, 120), since);
  return row.c;
}
async function clearLoginFailures(identifier) {
  try { await db.prepare('DELETE FROM login_attempts WHERE identifier=? AND ok=0').run(String(identifier).slice(0, 120)); } catch {}
}

// ---------- notifications ----------
// Every important event is written to the notifications table first (durable,
// queryable, shown in-app) and then handed to the mailer. If SMTP is not
// configured the mailer logs instead of sending, so no code path needs to know
// whether a provider is present.
async function notify(userId, { type, title, body, electionId = null, email = null }) {
  let notificationId = null;
  // The notifications.status column is constrained to pending/sent/failed, so
  // an in-app-only notice is recorded as already 'sent'. When SMTP is not
  // configured the notice degrades to in-app rather than being lost.
  const willEmail = Boolean(email) && mailer.isConfigured();
  const now = new Date().toISOString();
  try {
    // RETURNING id is required: the Postgres adapter can only report the
    // generated key when the statement asks for it.
    notificationId = (await db.prepare(
      `INSERT INTO notifications(user_id, election_id, type, title, body, channel, status, sent_at)
       VALUES(?,?,?,?,?,?,?,?) RETURNING id`
    ).run(userId, electionId, type, title, body || '', willEmail ? 'email' : 'inapp',
      willEmail ? 'pending' : 'sent', willEmail ? null : now)).lastInsertRowid;
  } catch { /* a notification must never break the request that triggered it */ }

  if (!willEmail) return notificationId;
  const finish = async (status) => {
    if (notificationId === null) return;
    try {
      await db.prepare('UPDATE notifications SET status=?, sent_at=? WHERE id=?')
        .run(status, new Date().toISOString(), notificationId);
    } catch { /* ignore */ }
  };
  mailer.sendMail(email, title, body || '')
    .then((r) => finish(r.sent ? 'sent' : 'failed'))
    .catch(() => finish('failed'));
  return notificationId;
}
// Broadcast to every voter eligible for an election. Eligible means the explicit
// roll when one exists, otherwise all active verified students.
async function eligibleVoterIds(electionId) {
  const roll = (await db.prepare('SELECT COUNT(*) c FROM voter_eligibility WHERE election_id=?').get(electionId)).c;
  if (roll > 0) {
    return await db.prepare(
      'SELECT u.id, u.email FROM users u JOIN voter_eligibility e ON e.user_id = u.id WHERE e.election_id=? AND u.is_active=1'
    ).all(electionId);
  }
  return await db.prepare("SELECT id, email FROM users WHERE role='voter' AND is_active=1 AND verified=1").all();
}
async function notifyEligibleVoters(electionId, { type, title, body }) {
  let sent = 0;
  for (const v of await eligibleVoterIds(electionId)) {
    await notify(v.id, { type, title, body, electionId, email: v.email });
    sent++;
  }
  return sent;
}

// ---------- AUTH ----------
// Unauthenticated liveness probe for containers / reverse proxies. Reports the
// backend actually in use, so a Supabase outage surfaces as 503 rather than a
// green container that cannot serve a single request.
app.get('/api/health', async (req, res) => {
  let dbOk = true;
  const backend = 'supabase';
  try {
    // The application now runs entirely on Postgres, so there is a single probe:
    // one awaited round-trip through the same pool every route uses.
    await db.prepare('SELECT 1 AS ok').get();
  } catch (err) {
    dbOk = false;
    console.error('[health] backend check failed:', err.message);
  }
  // Presence, not values: safe to expose publicly and it tells an operator at a
  // glance which environment variable a broken deployment is missing.
  const config = {
    node_env: process.env.NODE_ENV || '(unset)',
    supabase_url: Boolean(process.env.SUPABASE_URL),
    supabase_service_role_key: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    supabase_db_url: Boolean(process.env.SUPABASE_DB_URL),
    supabase_db_ssl: process.env.SUPABASE_DB_SSL || 'true (default)',
    supabase_storage_bucket: Boolean(process.env.SUPABASE_STORAGE_BUCKET),
    admin_setup_key: Boolean(process.env.ADMIN_SETUP_KEY),
    jwt_secret: KNOWN_PLACEHOLDER_SECRETS.has(JWT_SECRET) ? 'placeholder' : 'ok',
    config_errors: CONFIG_ERRORS,
  };
  const healthy = dbOk && CONFIG_ERRORS.length === 0;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    time: new Date().toISOString(),
    db: dbOk ? 'up' : 'down',
    backend,
    config,
  });
});
app.post('/api/auth/register', async (req, res) => {
  const allow = await db.prepare("SELECT value FROM settings WHERE key='allow_registration'").get();
  if (allow && allow.value === '0') return res.status(403).json({ error: 'Registration is currently disabled' });
  let { name, student_id, email, password, faculty, department, level } = req.body || {};
  name = (name || '').trim(); student_id = (student_id || '').trim().toUpperCase();
  email = (email || '').trim().toLowerCase();
  faculty = (faculty || '').trim(); department = (department || '').trim(); level = (level || '').trim();
  if (!name || !student_id || !email || !password) return res.status(400).json({ error: 'Name, Student ID, email and password are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!/^[A-Z0-9\-\/]{3,30}$/i.test(student_id)) return res.status(400).json({ error: 'Invalid Student ID format' });
  const exists = await db.prepare('SELECT id FROM users WHERE email=? OR student_id=?').get(email, student_id);
  if (exists) return res.status(409).json({ error: 'Email or Student ID already registered' });
  const hash = bcrypt.hashSync(password, 12);
  const info = await db.prepare('INSERT INTO users(name, student_id, email, password_hash, role, faculty, department, level, verified) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id')
    .run(name, student_id, email, hash, 'voter', faculty, department, level, 0);
  const token = uuidv4();
  const exp = new Date(Date.now() + 24*3600*1000).toISOString();
  await db.prepare('INSERT INTO email_verifications(user_id, token, expires_at) VALUES(?,?,?)').run(info.lastInsertRowid, token, exp);
  audit(info.lastInsertRowid, 'user.register', `Registered ${email}`, req);
  const vm = mailer.verificationMail(name, token);
  const mail = await mailer.sendMail(email, vm.subject, vm.text, vm.html).catch(() => ({ sent: false }));
  audit(info.lastInsertRowid, 'user.verify_mail', mail.sent ? `sent to ${email}` : 'dev-logged (SMTP unconfigured)', req);
  const out = { message: 'Account created. Please verify your account.', user_id: info.lastInsertRowid };
  // Token is returned only when no SMTP is configured (dev/demo). With SMTP,
  // it travels by email and is never exposed in the API response.
  if (!mailer.isConfigured()) { out.verification_token = token; out.email_preview = vm.text; }
  res.json(out);
});

app.post('/api/auth/verify', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Verification token required' });
  const row = await db.prepare('SELECT * FROM email_verifications WHERE token=? AND used=0').get(token);
  if (!row) return res.status(400).json({ error: 'Invalid or used token' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Token expired' });
  await db.prepare('UPDATE users SET verified=1 WHERE id=?').run(row.user_id);
  await db.prepare('UPDATE email_verifications SET used=1 WHERE id=?').run(row.id);
  const who = await db.prepare('SELECT email FROM users WHERE id=?').get(row.user_id);
  await notify(row.user_id, {
    type: 'account.verified',
    title: 'Your E-Voting account is verified',
    body: 'Your student account has been verified. You can now log in and vote in any election you are eligible for.',
    email: who ? who.email : null,
  });
  audit(row.user_id, 'user.verify', 'Email verified', req);
  res.json({ message: 'Account verified successfully. You can now log in and vote (if eligible).' });
});

app.post('/api/auth/login', async (req, res) => {
  let { identifier, password } = req.body || {};
  identifier = (identifier || '').trim();
  if (!identifier || !password) return res.status(400).json({ error: 'Student ID / Email and password are required' });

  // Per-account lockout, in addition to the per-IP rate limiter. The identifier
  // is normalised the same way as the lookup so "Ama@x.edu" and "ama@x.edu"
  // share one failure counter.
  const norm = identifier.includes('@') ? identifier.toLowerCase() : identifier.toUpperCase();
  const maxAttempts = Math.max(1, Number(await getSetting('max_login_attempts', '5')) || 5);
  if (await recentFailures(norm) >= maxAttempts) {
    await recordLoginAttempt(norm, req.ip, false);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${LOCK_WINDOW_MS / 60000} minutes.` });
  }

  const user = await db.prepare("SELECT * FROM users WHERE email=? OR student_id=?").get(identifier.toLowerCase(), identifier.toUpperCase());
  if (!user) {
    // Uniform failure handling: unknown account and wrong password are
    // indistinguishable, and both cost the same bcrypt work.
    bcrypt.compareSync(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin');
    await recordLoginAttempt(norm, req.ip, false);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (!user.is_active) {
    await recordLoginAttempt(norm, req.ip, false);
    return res.status(403).json({ error: 'Account disabled. Contact administrator.' });
  }
  if (!bcrypt.compareSync(password, user.password_hash)) {
    await recordLoginAttempt(norm, req.ip, false);
    audit(user.id, 'auth.login_failed', identifier, req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  await clearLoginFailures(norm);
  await recordLoginAttempt(norm, req.ip, true);

  const token = signToken(user);
  const sessionHours = Math.max(1, Number(await getSetting('session_hours', '12')) || 12);
  res.cookie('evs_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,          // requires HTTPS in production
    maxAge: sessionHours * 3600 * 1000,
    path: '/',
  });
  audit(user.id, 'auth.login', user.email, req);
  const { password_hash, ...safe } = user;
  res.json({ message: 'Login successful', token, user: safe });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('evs_token', { path: '/' });
  res.json({ message: 'Logged out' });
});

app.post('/api/auth/forgot', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const user = await db.prepare('SELECT * FROM users WHERE email=?').get(String(email).toLowerCase().trim());
  // Always return generic message to avoid enumeration
  if (!user) return res.json({ message: 'If the email exists, a reset link has been generated.' });
  const raw = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const exp = new Date(Date.now() + 3600*1000).toISOString();
  await db.prepare('INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES(?,?,?)').run(user.id, tokenHash, exp);
  audit(user.id, 'auth.forgot', user.email, req);
  const rm = mailer.resetMail(user.name, raw);
  await mailer.sendMail(user.email, rm.subject, rm.text, rm.html).catch(() => ({}));
  const out = { message: 'If the email exists, a reset link has been generated.' };
  // Token returned only when no SMTP is configured (dev/demo).
  if (!mailer.isConfigured()) { out.reset_token = raw; out.note = 'SMTP unconfigured — token returned for demo. Use it on the Reset page.'; }
  res.json(out);
});

app.post('/api/auth/reset', async (req, res) => {
  const { token, new_password } = req.body || {};
  if (!token || !new_password) return res.status(400).json({ error: 'Token and new password required' });
  if (String(new_password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  const h = crypto.createHash('sha256').update(String(token)).digest('hex');
  const row = await db.prepare('SELECT * FROM password_resets WHERE token_hash=? AND used=0').get(h);
  if (!row) return res.status(400).json({ error: 'Invalid or used token' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Token expired' });
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(new_password, 12), row.user_id);
  await db.prepare('UPDATE password_resets SET used=1 WHERE id=?').run(row.id);
  audit(row.user_id, 'auth.reset', 'Password reset', req);
  res.json({ message: 'Password reset successful. Please log in.' });
});

app.get('/api/auth/me', authRequired, (req, res) => res.json({ user: req.user }));

app.post('/api/auth/change-password', authRequired, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new passwords required' });
  if (String(new_password).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const user = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(new_password, 12), user.id);
  audit(user.id, 'auth.change_password', user.email, req);
  res.json({ message: 'Password changed successfully.' });
});

// ---------- PUBLIC / STUDENT ----------
app.get('/api/settings/public', async (req, res) => {
  const rows = await db.prepare("SELECT key,value FROM settings WHERE key IN ('school_name','results_visibility')").all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

app.get('/api/elections', authRequired, async (req, res) => {
  const elections = (await db.prepare('SELECT * FROM elections ORDER BY starts_at DESC').all()).map(withComputed);
  // attach voter state for this user
  const out = [];
  for (const e of elections) {
    const elig = await db.prepare('SELECT 1 FROM voter_eligibility WHERE election_id=? AND user_id=?').get(e.id, req.user.id);
    // if no eligibility rows exist for election, treat as open to all verified students
    const eligCount = (await db.prepare('SELECT COUNT(*) c FROM voter_eligibility WHERE election_id=?').get(e.id)).c;
    const eligible = eligCount === 0 ? true : !!elig;
    const voted = !!await db.prepare('SELECT 1 FROM vote_receipts WHERE election_id=? AND voter_id=?').get(e.id, req.user.id);
    const votesCast = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE election_id=?').get(e.id)).c;
    out.push({ ...e, eligible, voted, votes_cast: votesCast });
  }
  res.json(out);
});

app.get('/api/elections/:id', authRequired, async (req, res) => {
  const e = await db.prepare('SELECT * FROM elections WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Election not found' });
  const positions = await db.prepare('SELECT * FROM positions WHERE election_id=? ORDER BY sort_order, id').all(e.id);
  const candidates = await db.prepare('SELECT * FROM candidates WHERE election_id=? ORDER BY sort_order, id').all(e.id);
  const eligCount = (await db.prepare('SELECT COUNT(*) c FROM voter_eligibility WHERE election_id=?').get(e.id)).c;
  const elig = eligCount === 0 ? true : !!await db.prepare('SELECT 1 FROM voter_eligibility WHERE election_id=? AND user_id=?').get(e.id, req.user.id);
  const voted = !!await db.prepare('SELECT 1 FROM vote_receipts WHERE election_id=? AND voter_id=?').get(e.id, req.user.id);
  res.json({ election: withComputed(e), positions, candidates, eligible: elig, voted });
});

// *** SECURE VOTE SUBMISSION — server-side validation, transaction, one-vote enforcement ***
app.post('/api/elections/:id/vote', authRequired, async (req, res) => {
  const electionId = Number(req.params.id);
  const e = await db.prepare('SELECT * FROM elections WHERE id=?').get(electionId);
  if (!e) return res.status(404).json({ error: 'Election not found' });

  // status check (server authoritative)
  const now = new Date();
  const computed = withComputed(e);
  if (computed.display_status !== 'open') return res.status(403).json({ error: `Election is not open (status: ${computed.display_status})` });
  if (new Date(e.starts_at) > now) return res.status(403).json({ error: 'Election has not started' });
  if (new Date(e.ends_at) < now) return res.status(403).json({ error: 'Election has closed' });

  // verification + eligibility
  const me = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const reqVerify = await db.prepare("SELECT value FROM settings WHERE key='require_verification_to_vote'").get();
  if (reqVerify && reqVerify.value === '1' && !me.verified) return res.status(403).json({ error: 'Account not verified. Verify before voting.' });
  const eligCount = (await db.prepare('SELECT COUNT(*) c FROM voter_eligibility WHERE election_id=?').get(electionId)).c;
  if (eligCount > 0) {
    const ok = await db.prepare('SELECT 1 FROM voter_eligibility WHERE election_id=? AND user_id=?').get(electionId, req.user.id);
    if (!ok) return res.status(403).json({ error: 'You are not eligible for this election' });
  }

  // Expected body: { selections: { positionId: [candidateId] | candidateId, ... }, abstain: [positionId] }
  const { selections } = req.body || {};
  if (!selections || typeof selections !== 'object') return res.status(400).json({ error: 'Invalid ballot format' });

  const positions = await db.prepare('SELECT * FROM positions WHERE election_id=?').all(electionId);
  const candidates = await db.prepare('SELECT * FROM candidates WHERE election_id=?').all(electionId);
  const candById = Object.fromEntries(candidates.map(c => [c.id, c]));

  // Validate each position
  const normalized = {}; // positionId -> array of candidateIds (empty = abstain if allowed)
  for (const p of positions) {
    let val = selections[String(p.id)] ?? selections[p.id];
    let arr = [];
    if (val === undefined || val === null || val === '') arr = [];
    else if (Array.isArray(val)) arr = val.map(Number).filter(Boolean);
    else arr = [Number(val)].filter(Boolean);
    arr = [...new Set(arr)];
    if (arr.length === 0) {
      if (p.is_mandatory && p.min_select > 0) return res.status(400).json({ error: `Position "${p.title}" is mandatory — select at least ${p.min_select} candidate(s) or abstain is not allowed.` });
      normalized[p.id] = [];
      continue;
    }
    if (arr.length < p.min_select) return res.status(400).json({ error: `Position "${p.title}": select at least ${p.min_select}` });
    if (arr.length > p.max_select) return res.status(400).json({ error: `Position "${p.title}": select at most ${p.max_select}` });
    for (const cid of arr) {
      const c = candById[cid];
      if (!c) return res.status(400).json({ error: `Invalid candidate (${cid})` });
      if (c.position_id !== p.id) return res.status(400).json({ error: `Candidate ${c.name} is not contesting ${p.title}` });
    }
    normalized[p.id] = arr;
  }

  // Atomic insert with UNIQUE(election_id, voter_id) guard — prevents double vote even under race conditions.
  // Reference codes are random: on the ~1-in-16M chance of a reference_code
  // collision we regenerate and retry instead of failing the voter.
  const tx = db.transaction(async (reference) => {
    await db.prepare('INSERT INTO vote_receipts(election_id, voter_id, reference_code) VALUES(?,?,?)')
      .run(electionId, req.user.id, reference);
    const insBallot = db.prepare('INSERT INTO ballots(election_id, position_id, candidate_id, is_abstain) VALUES(?,?,?,?)');
    for (const p of positions) {
      const arr = normalized[p.id];
      if (arr.length === 0) await insBallot.run(electionId, p.id, null, 1);
      else for (const cid of arr) await insBallot.run(electionId, p.id, cid, 0);
    }
  });
  let reference = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    reference = makeReference(electionId);
    try {
      await tx(reference);
      break;
    } catch (err) {
      // Postgres reports a unique violation by SQLSTATE and constraint name
      // rather than by prose, so the two outcomes are told apart structurally.
      if (supabase.isUniqueViolation(err, 'vote_receipts_election_voter_key')) {
        return res.status(409).json({ error: 'You have already voted in this election. One student = one vote.' });
      }
      if (supabase.isUniqueViolation(err, 'reference_code') && attempt < 4) continue; // collision: retry with a fresh code
      console.error(err);
      return res.status(500).json({ error: 'Failed to record vote' });
    }
  }
  if (!reference) return res.status(500).json({ error: 'Failed to record vote' });
  audit(req.user.id, 'vote.cast', `Election ${electionId} ref ${reference}`, req);
  // Confirmation deliberately contains the reference and the election only —
  // never the choices, so the receipt cannot compromise ballot secrecy.
  await notify(req.user.id, {
    type: 'vote.cast',
    electionId,
    title: `Vote recorded — ${e.title}`,
    body: `Your vote in "${e.title}" has been recorded.\n\nConfirmation reference: ${reference}\n\nKeep this reference for your records. Your individual choices are secret and are not shown again.`,
    email: me.email,
  });
  // NEVER return choices — only reference (ballot secrecy)
  res.json({ message: 'VOTE SUCCESSFULLY CAST. Your vote has been recorded.', reference_code: reference });
});

app.get('/api/elections/:id/my-receipt', authRequired, async (req, res) => {
  const r = await db.prepare('SELECT reference_code, created_at FROM vote_receipts WHERE election_id=? AND voter_id=?').get(req.params.id, req.user.id);
  if (!r) return res.status(404).json({ error: 'No vote recorded' });
  res.json(r);
});

// Results — access depends on the `results_visibility` institution setting.
//   published_only  (default) students see published results only
//   all_authenticated  students may also see results once voting has closed
//   admins_only     results are restricted to administrators entirely
// Aggregation only: this endpoint has no code path that can return a voter's
// individual selections, because ballots carry no voter foreign key.
app.get('/api/elections/:id/results', authRequired, async (req, res) => {
  const e = await db.prepare('SELECT * FROM elections WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Election not found' });
  const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
  if (!isAdmin) {
    const mode = await getSetting('results_visibility', 'published_only');
    if (mode === 'admins_only') {
      return res.status(403).json({ error: 'Results are restricted to election administrators on this system' });
    }
    if (mode === 'all_authenticated') {
      if (e.status === 'draft' || e.status === 'open') {
        return res.status(403).json({ error: 'Results are not available until this election has closed' });
      }
    } else if (e.status !== 'published') {
      return res.status(403).json({ error: 'Results not yet published' });
    }
    if (Number(e.results_public) === 0) return res.status(403).json({ error: 'Results for this election are not public' });
  }
  const r = await computeResults(Number(req.params.id));
  res.json({ ...r, election: withComputed(r.election) });
});

// ---------- ADMIN ----------
const adminOnly = [authRequired, requireRole('admin', 'superadmin')];

app.get('/api/admin/stats', adminOnly, async (req, res) => {
  const voters = (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='voter'").get()).c;
  const elections = (await db.prepare('SELECT COUNT(*) c FROM elections').get()).c;
  const votes = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts').get()).c;
  const candidates = (await db.prepare('SELECT COUNT(*) c FROM candidates').get()).c;
  const byStatus = {};
  for (const s of ['draft', 'open', 'closed', 'published']) {
    byStatus[s] = (await db.prepare('SELECT COUNT(*) c FROM elections WHERE status=?').get(s)).c;
  }
  const recent = await db.prepare('SELECT a.*, u.email actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 20').all();
  res.json({ voters, elections, votes, candidates, byStatus, recent });
});

// Admin election list with search and status filtering.
app.get('/api/admin/elections', adminOnly, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const status = String(req.query.status || '').trim();
  const where = [];
  const params = [];
  // ILIKE, not LIKE: SQLite's LIKE was case-insensitive for ASCII and Postgres'
  // is not, so a plain LIKE here would silently break title search.
  if (q) { where.push('(title ILIKE ? OR description ILIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (['draft', 'open', 'closed', 'published'].includes(status)) { where.push('status = ?'); params.push(status); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await db.prepare(`SELECT * FROM elections ${clause} ORDER BY starts_at DESC`).all(...params);
  const out = [];
  for (const e of rows) {
    const votes = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE election_id=?').get(e.id)).c;
    const eligible = (await db.prepare('SELECT COUNT(*) c FROM voter_eligibility WHERE election_id=?').get(e.id)).c;
    const positions = (await db.prepare('SELECT COUNT(*) c FROM positions WHERE election_id=?').get(e.id)).c;
    const candidates = (await db.prepare('SELECT COUNT(*) c FROM candidates WHERE election_id=?').get(e.id)).c;
    out.push({ ...withComputed(e), votes_cast: votes, eligible_count: eligible, position_count: positions, candidate_count: candidates });
  }
  res.json(out);
});

// ---------- notifications ----------
app.get('/api/notifications', authRequired, async (req, res) => {
  // status/sent_at are included so a client can tell a delivered notice from
  // one that was queued for email but could not be sent.
  const rows = await db.prepare(
    'SELECT id, election_id, type, title, body, channel, status, read_at, created_at, sent_at'
    + ' FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50'
  ).all(req.user.id);
  res.json(rows);
});
app.post('/api/notifications/read', authRequired, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    // Scoped to the caller's own rows, so one user cannot mark another's.
    await db.prepare(`UPDATE notifications SET read_at=? WHERE user_id=? AND id IN (${marks})`)
      .run(new Date().toISOString(), req.user.id, ...ids);
  }
  res.json({ message: 'Marked as read' });
});

// Legal status transitions. An election cannot jump from draft straight to
// published, and a published result set is final — both matter for the
// integrity of the announced outcome.
const STATUS_FLOW = {
  draft: ['draft', 'open', 'closed'],
  open: ['open', 'closed'],
  closed: ['closed', 'published', 'open'],
  published: ['published'],
};
function assertTransition(from, to) {
  const allowed = STATUS_FLOW[from] || [];
  if (!allowed.includes(to)) {
    return `An election in "${from}" status cannot move to "${to}". Allowed next statuses: ${allowed.join(', ')}.`;
  }
  return null;
}

app.post('/api/admin/elections', adminOnly, async (req, res) => {
  const { title, description, instructions, starts_at, ends_at, status, timezone } = req.body || {};
  if (!title || !starts_at || !ends_at) return res.status(400).json({ error: 'Title, start and end dates required' });
  const start = new Date(starts_at), end = new Date(ends_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return res.status(400).json({ error: 'Invalid start or end date' });
  if (start >= end) return res.status(400).json({ error: 'End date must be after start date' });
  const tz = normaliseTimezone(timezone);
  if (!tz) return res.status(400).json({ error: 'Invalid IANA time zone (e.g. Africa/Accra)' });
  const st = ['draft', 'open', 'closed', 'published'].includes(status) ? status : 'draft';
  const info = await db.prepare('INSERT INTO elections(title,description,instructions,starts_at,ends_at,status,timezone,created_by) VALUES(?,?,?,?,?,?,?,?) RETURNING id')
    .run(String(title).slice(0, 200), description || '', instructions || '', start.toISOString(), end.toISOString(), st, tz, req.user.id);
  audit(req.user.id, 'admin.election_create', `${title} #${info.lastInsertRowid}`, req);
  res.json({ id: info.lastInsertRowid, message: 'Election created' });
});
app.put('/api/admin/elections/:id', adminOnly, async (req, res) => {
  const e = await db.prepare('SELECT * FROM elections WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Not found' });
  const { title, description, instructions, starts_at, ends_at, timezone } = req.body || {};
  // Merge with the stored values so a partial update cannot invert the window.
  const newStart = starts_at ? new Date(starts_at) : new Date(e.starts_at);
  const newEnd = ends_at ? new Date(ends_at) : new Date(e.ends_at);
  if (Number.isNaN(newStart.getTime()) || Number.isNaN(newEnd.getTime())) return res.status(400).json({ error: 'Invalid start or end date' });
  if (newStart >= newEnd) return res.status(400).json({ error: 'End date must be after start date' });
  const tz = timezone === undefined ? null : normaliseTimezone(timezone);
  if (timezone !== undefined && !tz) return res.status(400).json({ error: 'Invalid IANA time zone (e.g. Africa/Accra)' });
  // The voting window is immutable once a ballot exists, otherwise a recorded
  // vote could end up outside the period it was cast in.
  const receipts = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE election_id=?').get(e.id)).c;
  if (receipts > 0 && (newStart.getTime() !== new Date(e.starts_at).getTime() || newEnd.getTime() !== new Date(e.ends_at).getTime())) {
    return res.status(409).json({ error: `The voting window cannot be changed because ${receipts} vote(s) have already been recorded.` });
  }
  await db.prepare('UPDATE elections SET title=COALESCE(?,title), description=COALESCE(?,description), instructions=COALESCE(?,instructions), starts_at=?, ends_at=?, timezone=COALESCE(?,timezone) WHERE id=?')
    .run(title ?? null, description ?? null, instructions ?? null,
      newStart.toISOString(), newEnd.toISOString(), tz, e.id);
  audit(req.user.id, 'admin.election_update', `#${e.id}`, req);
  res.json({ message: 'Election updated' });
});
app.delete('/api/admin/elections/:id', adminOnly, async (req, res) => {
  const e = await db.prepare('SELECT * FROM elections WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Election not found' });
  // Deleting an election with recorded ballots would destroy the evidence of a
  // vote. Closing it is the supported path once voting has happened.
  const receipts = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE election_id=?').get(e.id)).c;
  if (receipts > 0) {
    return res.status(409).json({ error: `This election has ${receipts} recorded vote(s) and cannot be deleted. Close it instead so the ballot record is preserved.` });
  }
  await db.prepare('DELETE FROM elections WHERE id=?').run(e.id);
  audit(req.user.id, 'admin.election_delete', `#${e.id} (${e.title})`, req);
  res.json({ message: 'Election deleted' });
});
app.post('/api/admin/elections/:id/status', adminOnly, async (req, res) => {
  const { status } = req.body || {};
  if (!['draft', 'open', 'closed', 'published'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const e = await db.prepare('SELECT * FROM elections WHERE id=?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Election not found' });
  const problem = assertTransition(e.status, status);
  if (problem) return res.status(409).json({ error: problem });
  if (status === 'open' && new Date(e.starts_at) > new Date()) {
    return res.status(409).json({ error: 'This election cannot be opened before its start date.' });
  }
  await db.prepare('UPDATE elections SET status=? WHERE id=?').run(status, e.id);
  audit(req.user.id, 'admin.election_status', `#${e.id} ${e.status} -> ${status}`, req);

  // Lifecycle notifications for every eligible voter.
  if (status === 'open') {
    await notifyEligibleVoters(e.id, {
      type: 'election.opened',
      title: `Voting is now open — ${e.title}`,
      body: `Voting for "${e.title}" is now open and closes at ${e.ends_at}.\n\nCast your ballot: ${mailer.APP_URL}/dashboard.html`,
    });
  } else if (status === 'closed') {
    await notifyEligibleVoters(e.id, {
      type: 'election.closed',
      title: `Voting has closed — ${e.title}`,
      body: `Voting for "${e.title}" has closed. Results will be published by the Returning Officer.`,
    });
  } else if (status === 'published') {
    await db.prepare('UPDATE elections SET published_at=? WHERE id=?').run(new Date().toISOString(), e.id);
    await notifyEligibleVoters(e.id, {
      type: 'results.published',
      title: `Results published — ${e.title}`,
      body: `Results for "${e.title}" have been published.\n\nView results: ${mailer.APP_URL}/results.html?id=${e.id}`,
    });
  }
  res.json({ message: `Election ${status}` });
});

// Positions
app.post('/api/admin/elections/:id/positions', adminOnly, async (req, res) => {
  const { title, description, max_select, min_select, is_mandatory, sort_order } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Position title required' });
  const mx = Math.max(1, Number(max_select) || 1);
  const mn = Math.min(mx, Math.max(is_mandatory === 0 ? 0 : 1, Number(min_select ?? 1)));
  const info = await db.prepare('INSERT INTO positions(election_id,title,description,max_select,min_select,is_mandatory,sort_order) VALUES(?,?,?,?,?,?,?) RETURNING id')
    .run(req.params.id, title, description||'', mx, mn, is_mandatory===0?0:1, Number(sort_order)||0);
  audit(req.user.id, 'admin.position_create', `${title} election #${req.params.id}`, req);
  res.json({ id: info.lastInsertRowid });
});
app.put('/api/admin/positions/:pid', adminOnly, async (req, res) => {
  const p = await db.prepare('SELECT * FROM positions WHERE id=?').get(req.params.pid);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const { title, description, max_select, min_select, is_mandatory, sort_order } = req.body || {};
  await db.prepare('UPDATE positions SET title=COALESCE(?,title), description=COALESCE(?,description), max_select=COALESCE(?,max_select), min_select=COALESCE(?,min_select), is_mandatory=COALESCE(?,is_mandatory), sort_order=COALESCE(?,sort_order) WHERE id=?')
    .run(title??null, description??null, max_select??null, min_select??null, is_mandatory??null, sort_order??null, p.id);
  audit(req.user.id, 'admin.position_update', `#${p.id}`, req);
  res.json({ message: 'Position updated' });
});
app.delete('/api/admin/positions/:pid', adminOnly, async (req, res) => {
  const p = await db.prepare('SELECT * FROM positions WHERE id=?').get(req.params.pid);
  if (!p) return res.status(404).json({ error: 'Position not found' });
  // Removing a position cascades to its candidates, and ballots reference
  // candidates with ON DELETE SET NULL — so deleting after voting has started
  // would silently erase recorded choices. Refuse instead.
  const votes = (await db.prepare('SELECT COUNT(*) c FROM ballots WHERE position_id=?').get(p.id)).c;
  if (votes > 0) {
    return res.status(409).json({ error: `This position has ${votes} recorded ballot entr(ies) and cannot be deleted. Remove candidates from the ballot before closing the election instead.` });
  }
  await db.prepare('DELETE FROM positions WHERE id=?').run(p.id);
  audit(req.user.id, 'admin.position_delete', `#${p.id} (${p.title})`, req);
  res.json({ message: 'Position deleted' });
});

// Candidates
app.post('/api/admin/candidates', adminOnly, verifiedUpload, async (req, res) => {
  const { election_id, position_id, name, student_id, department, faculty, level, affiliation, bio, manifesto, sort_order } = req.body || {};
  if (!election_id || !position_id || !name) return res.status(400).json({ error: 'Election, position and name required' });
  const pos = await db.prepare('SELECT * FROM positions WHERE id=? AND election_id=?').get(position_id, election_id);
  if (!pos) return res.status(400).json({ error: 'Position does not belong to this election' });
  const photo_url = req.file ? await persistCandidatePhoto(req.file) : '';
  const info = await db.prepare('INSERT INTO candidates(election_id,position_id,name,student_id,department,faculty,level,affiliation,bio,manifesto,photo_url,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id')
    .run(election_id, position_id, name, student_id||'', department||'', faculty||'', level||'', affiliation||'Independent', bio||'', manifesto||'', photo_url, Number(sort_order)||0);
  audit(req.user.id, 'admin.candidate_create', `${name} #${info.lastInsertRowid}`, req);
  res.json({ id: info.lastInsertRowid, photo_url });
});
app.put('/api/admin/candidates/:cid', adminOnly, verifiedUpload, async (req, res) => {
  const c = await db.prepare('SELECT * FROM candidates WHERE id=?').get(req.params.cid);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  // A candidate may only be moved between positions of their own election;
  // otherwise a crafted request could attach them to an unrelated ballot.
  let positionId = c.position_id;
  if (b.position_id !== undefined && b.position_id !== null && b.position_id !== '') {
    const target = await db.prepare('SELECT id FROM positions WHERE id=? AND election_id=?').get(b.position_id, c.election_id);
    if (!target) return res.status(400).json({ error: 'Position does not belong to this election' });
    positionId = target.id;
  }
  const photo_url = req.file ? await persistCandidatePhoto(req.file) : (b.photo_url ?? c.photo_url);
  await db.prepare('UPDATE candidates SET name=COALESCE(?,name), student_id=COALESCE(?,student_id), department=COALESCE(?,department), faculty=COALESCE(?,faculty), level=COALESCE(?,level), affiliation=COALESCE(?,affiliation), bio=COALESCE(?,bio), manifesto=COALESCE(?,manifesto), photo_url=?, sort_order=COALESCE(?,sort_order), position_id=? WHERE id=?')
    .run(b.name??null, b.student_id??null, b.department??null, b.faculty??null, b.level??null, b.affiliation??null, b.bio??null, b.manifesto??null, photo_url, b.sort_order??null, positionId, c.id);
  audit(req.user.id, 'admin.candidate_update', `#${c.id} (${c.name})`, req);
  res.json({ message: 'Candidate updated', photo_url });
});
app.delete('/api/admin/candidates/:cid', adminOnly, async (req, res) => {
  const c = await db.prepare('SELECT * FROM candidates WHERE id=?').get(req.params.cid);
  if (!c) return res.status(404).json({ error: 'Candidate not found' });
  // ballots.candidate_id is ON DELETE SET NULL, so deleting a candidate who has
  // already received votes would quietly rewrite a published result. Block it.
  const votes = (await db.prepare('SELECT COUNT(*) c FROM ballots WHERE candidate_id=?').get(c.id)).c;
  if (votes > 0) {
    return res.status(409).json({ error: `${c.name} has ${votes} recorded vote(s) and cannot be removed. Withdrawing a candidate mid-election is not permitted; publish the result with this candidate included.` });
  }
  const receipts = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE election_id=?').get(c.election_id)).c;
  if (receipts > 0 && c.election_id) {
    return res.status(409).json({ error: 'Voting has already started in this election, so the candidate list is now locked.' });
  }
  await db.prepare('DELETE FROM candidates WHERE id=?').run(c.id);
  audit(req.user.id, 'admin.candidate_delete', `#${c.id} (${c.name})`, req);
  res.json({ message: 'Candidate deleted' });
});

// Voter roll with search + filtering. Every value is bound as a parameter and
// the column set is fixed, so filter input can never alter the query shape.
app.get('/api/admin/voters', adminOnly, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const faculty = String(req.query.faculty || '').trim().slice(0, 80);
  const department = String(req.query.department || '').trim().slice(0, 80);
  const level = String(req.query.level || '').trim().slice(0, 20);
  const verified = String(req.query.verified || '').trim();
  const active = String(req.query.active || '').trim();
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const where = ["role='voter'"];
  const params = [];
  // ILIKE, not LIKE: the roll search is over user text (name, email, student
  // id), which SQLite matched case-insensitively and Postgres LIKE does not.
  if (q) {
    where.push('(name ILIKE ? OR email ILIKE ? OR student_id ILIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (faculty) { where.push('faculty = ?'); params.push(faculty); }
  if (department) { where.push('department = ?'); params.push(department); }
  if (level) { where.push('level = ?'); params.push(level); }
  if (verified === '1' || verified === '0') { where.push('verified = ?'); params.push(Number(verified)); }
  if (active === '1' || active === '0') { where.push('is_active = ?'); params.push(Number(active)); }
  const clause = `WHERE ${where.join(' AND ')}`;
  const rows = await db.prepare(
    `SELECT id,student_id,name,email,role,faculty,department,level,verified,is_active,created_at FROM users ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const total = (await db.prepare(`SELECT COUNT(*) c FROM users ${clause}`).get(...params)).c;
  // Distinct values power the filter dropdowns so they always reflect the roll.
  const facets = {
    faculty: (await db.prepare("SELECT DISTINCT faculty v FROM users WHERE role='voter' AND faculty<>'' ORDER BY v").all()).map((r) => r.v),
    department: (await db.prepare("SELECT DISTINCT department v FROM users WHERE role='voter' AND department<>'' ORDER BY v").all()).map((r) => r.v),
    level: (await db.prepare("SELECT DISTINCT level v FROM users WHERE role='voter' AND level<>'' ORDER BY v").all()).map((r) => r.v),
  };
  res.json({ rows, total, limit, offset, facets });
});

// Candidate search scoped to one election, optionally filtered by position.
app.get('/api/admin/elections/:id/candidates', adminOnly, async (req, res) => {
  const eid = Number(req.params.id);
  if (!await db.prepare('SELECT id FROM elections WHERE id=?').get(eid)) return res.status(404).json({ error: 'Election not found' });
  const q = String(req.query.q || '').trim().slice(0, 80);
  const positionId = String(req.query.position_id || '').trim();
  const where = ['election_id = ?'];
  const params = [eid];
  // ILIKE, not LIKE: this searches user-entered text (candidate name, student
  // id, department, affiliation), which SQLite matched case-insensitively.
  if (q) {
    where.push('(name ILIKE ? OR student_id ILIKE ? OR department ILIKE ? OR affiliation ILIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (positionId) { where.push('position_id = ?'); params.push(Number(positionId)); }
  const rows = await db.prepare(
    `SELECT * FROM candidates WHERE ${where.join(' AND ')} ORDER BY sort_order, id`
  ).all(...params);
  res.json(rows);
});
// Election roll with each eligible voter's participation status.
// Reports WHETHER a student has voted, never what they chose: the receipt
// table holds no selections, so this endpoint cannot leak a ballot.
app.get('/api/admin/elections/:id/roll', adminOnly, async (req, res) => {
  const eid = Number(req.params.id);
  const election = await db.prepare('SELECT * FROM elections WHERE id=?').get(eid);
  if (!election) return res.status(404).json({ error: 'Election not found' });
  const q = String(req.query.q || '').trim().slice(0, 80);
  const hasVoted = String(req.query.has_voted || '').trim();

  const roll = (await db.prepare('SELECT COUNT(*) c FROM voter_eligibility WHERE election_id=?').get(eid)).c;
  // An empty eligibility table means the election is open to all voters, so the
  // roll is derived from the voter role instead. The receipt join is placed in
  // the FROM clause (before any WHERE) and yields participation only.
  const from = roll > 0
    ? 'FROM users u JOIN voter_eligibility e ON e.user_id = u.id'
    : 'FROM users u';
  const fromParams = roll > 0 ? [eid] : [];

  const where = [roll > 0 ? 'e.election_id = ?' : "u.role = 'voter'"];
  const params = [...fromParams, eid];
  // ILIKE, not LIKE: the roll search covers user text (name, email, student id),
  // which SQLite matched case-insensitively and Postgres LIKE does not.
  if (q) {
    where.push('(u.name ILIKE ? OR u.email ILIKE ? OR u.student_id ILIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const rows = await db.prepare(
    `SELECT u.id, u.student_id, u.name, u.email, u.department, u.faculty, u.level, u.verified, u.is_active,
            r.reference_code, r.created_at AS voted_at
     ${from}
     LEFT JOIN vote_receipts r ON r.election_id = ? AND r.voter_id = u.id
     WHERE ${where.join(' AND ')}
     ORDER BY u.name`
  ).all(...params);

  const filtered = hasVoted === '1' ? rows.filter((r) => r.reference_code)
    : hasVoted === '0' ? rows.filter((r) => !r.reference_code)
      : rows;
  res.json({
    rows: filtered.map((r) => ({
      id: r.id, student_id: r.student_id, name: r.name, email: r.email,
      department: r.department, faculty: r.faculty, level: r.level,
      verified: !!r.verified, is_active: !!r.is_active,
      has_voted: !!r.reference_code, voted_at: r.voted_at || null,
    })),
    total: filtered.length,
    explicit_roll: roll > 0,
  });
});

app.get('/api/admin/voters/export.csv', adminOnly, async (req, res) => {
  // Voter roll export — never includes password hashes.
  const rows = await db.prepare("SELECT student_id,name,email,faculty,department,level,verified,is_active FROM users WHERE role='voter' ORDER BY id").all();
  const lines = ['student_id,name,email,faculty,department,level,verified,active'];
  for (const v of rows) lines.push([v.student_id, v.name, v.email, v.faculty, v.department, v.level, v.verified, v.is_active].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="voter-roll.csv"');
  res.send(lines.join('\n'));
});
app.post('/api/admin/elections/:id/eligibility', adminOnly, async (req, res) => {
  // body: { user_ids: [...] } or { all_verified: true }
  const eid = req.params.id;
  const { user_ids, all_verified } = req.body || {};
  if (all_verified) {
    const voters = await db.prepare("SELECT id FROM users WHERE role='voter' AND is_active=1 AND verified=1").all();
    const ins = db.prepare('INSERT INTO voter_eligibility(election_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING');
    const tx = db.transaction(async () => { for (const v of voters) await ins.run(eid, v.id); });
    await tx();
    audit(req.user.id, 'admin.eligibility_bulk', `election #${eid} all verified`, req);
    return res.json({ message: `Added ${voters.length} eligible voters` });
  }
  if (!Array.isArray(user_ids)) return res.status(400).json({ error: 'user_ids array required' });
  const ins = db.prepare('INSERT INTO voter_eligibility(election_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING');
  const tx = db.transaction(async () => { for (const uid of user_ids) await ins.run(eid, Number(uid)); });
  await tx();
  audit(req.user.id, 'admin.eligibility_add', `election #${eid} ${user_ids.length} users`, req);
  res.json({ message: 'Eligibility updated' });
});
app.get('/api/admin/elections/:id/eligibility', adminOnly, async (req, res) => {
  if (!await db.prepare('SELECT id FROM elections WHERE id=?').get(req.params.id)) return res.status(404).json({ error: 'Election not found' });
  const rows = await db.prepare('SELECT u.id, u.student_id, u.name, u.email, u.verified FROM users u JOIN voter_eligibility e ON e.user_id=u.id WHERE e.election_id=? ORDER BY u.name').all(req.params.id);
  res.json({ count: rows.length, voters: rows });
});
app.delete('/api/admin/elections/:id/eligibility/:uid', adminOnly, async (req, res) => {
  await db.prepare('DELETE FROM voter_eligibility WHERE election_id=? AND user_id=?').run(req.params.id, req.params.uid);
  res.json({ message: 'Removed' });
});

// ---------- CSV voter import / results export (no extra dependencies) ----------
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 }, fileFilter: (req, f, cb) => {
  if (/\.csv$/i.test(f.originalname || '') || /csv|text|octet/.test(f.mimetype)) cb(null, true);
  else cb(new Error('Only .csv files allowed'));
}});

function parseCsv(text) {
  // Minimal RFC-4180-ish parser: handles quoted fields, commas, CRLF.
  const rows = [];
  let row = [], field = '', quoted = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') pushField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      pushField(); pushRow();
    } else field += c;
  }
  pushField();
  if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) pushRow();
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== '')).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Bulk eligibility: CSV with a `student_id` and/or `email` column.
// Template: GET /api/admin/eligibility-template
app.get('/api/admin/eligibility-template', adminOnly, (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="eligibility-template.csv"');
  res.send('student_id,email\nUEN0012023,student@university.edu\n');
});
app.post('/api/admin/elections/:id/eligibility/import', adminOnly, csvUpload.single('file'), async (req, res) => {
  const eid = Number(req.params.id);
  if (!await db.prepare('SELECT id FROM elections WHERE id=?').get(eid)) return res.status(404).json({ error: 'Election not found' });
  if (!req.file) return res.status(400).json({ error: 'CSV file required (field name: file)' });
  let rows;
  try { rows = parseCsv(req.file.buffer.toString('utf8')); }
  catch { return res.status(400).json({ error: 'Could not parse CSV' }); }
  if (!rows.length) return res.status(400).json({ error: 'CSV is empty' });
  const hasSid = 'student_id' in rows[0], hasEmail = 'email' in rows[0];
  if (!hasSid && !hasEmail) return res.status(400).json({ error: 'CSV must have a student_id and/or email column' });

  const bySid = db.prepare("SELECT id FROM users WHERE role='voter' AND student_id=?");
  const byEmail = db.prepare("SELECT id FROM users WHERE role='voter' AND email=?");
  const ins = db.prepare('INSERT INTO voter_eligibility(election_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING');
  let added = 0, already = 0;
  const notFound = [];
  const tx = db.transaction(async () => {
    for (const r of rows) {
      let user;
      if (hasSid && r.student_id) user = await bySid.get(r.student_id.toUpperCase());
      if (!user && hasEmail && r.email) user = await byEmail.get(r.email.toLowerCase());
      if (!user) { notFound.push(r.student_id || r.email || '(blank row)'); continue; }
      const info = await ins.run(eid, user.id);
      if (info.changes > 0) added++; else already++;
    }
  });
  await tx();
  audit(req.user.id, 'admin.eligibility_import', `election #${eid}: +${added}, already ${already}, missing ${notFound.length}`, req);
  res.json({ added, already, not_found: notFound.slice(0, 50), not_found_total: notFound.length, message: `Import complete: ${added} added, ${already} already eligible, ${notFound.length} not found.` });
});

// Aggregate results as CSV (admins only; never includes voter identities).
// Shared computation with the JSON results endpoint.
async function computeResults(electionId) {
  const e = await db.prepare('SELECT * FROM elections WHERE id=?').get(electionId);
  if (!e) return null;
  const positions = await db.prepare('SELECT * FROM positions WHERE election_id=? ORDER BY sort_order,id').all(electionId);
  const candidates = await db.prepare('SELECT * FROM candidates WHERE election_id=? ORDER BY sort_order,id').all(electionId);
  let eligibleTotal = (await db.prepare('SELECT COUNT(*) c FROM voter_eligibility WHERE election_id=?').get(electionId)).c;
  if (eligibleTotal === 0) eligibleTotal = (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='voter' AND is_active=1").get()).c;
  const votesCast = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE election_id=?').get(electionId)).c;
  const perCandidate = {};
  for (const c of candidates) perCandidate[c.id] = (await db.prepare('SELECT COUNT(*) c FROM ballots WHERE election_id=? AND candidate_id=?').get(electionId, c.id)).c;
  const perPosition = {};
  for (const p of positions) {
    const positionVotes = (await db.prepare('SELECT COUNT(*) c FROM ballots WHERE election_id=? AND position_id=? AND is_abstain=0').get(electionId, p.id)).c;
    perPosition[p.id] = {
      votes: positionVotes,
      abstentions: (await db.prepare('SELECT COUNT(*) c FROM ballots WHERE election_id=? AND position_id=? AND is_abstain=1').get(electionId, p.id)).c,
    };
    // Leading candidate(s). Reported as aggregate tallies only.
    const inPosition = candidates.filter((c) => c.position_id === p.id);
    let best = 0;
    for (const c of inPosition) best = Math.max(best, perCandidate[c.id] || 0);
    perPosition[p.id].leaders = inPosition.filter((c) => (perCandidate[c.id] || 0) === best && best > 0).map((c) => c.id);
    perPosition[p.id].tied = perPosition[p.id].leaders.length > 1;
  }
  return { election: e, positions, candidates, perCandidate, perPosition, eligibleTotal, votesCast, turnout: eligibleTotal ? +(votesCast * 100 / eligibleTotal).toFixed(2) : 0 };
}
app.get('/api/admin/elections/:id/results.csv', adminOnly, async (req, res) => {
  const r = await computeResults(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Election not found' });
  const lines = ['position,candidate,department,affiliation,votes,percent_of_position'];
  for (const p of r.positions) {
    for (const c of r.candidates.filter((x) => x.position_id === p.id)) {
      const v = r.perCandidate[c.id] || 0;
      const pct = r.perPosition[p.id].votes ? (v * 100 / r.perPosition[p.id].votes).toFixed(2) : '0.00';
      lines.push([p.title, c.name, c.department, c.affiliation, v, pct].map(csvCell).join(','));
    }
  }
  lines.push(['SUMMARY', `Eligible voters: ${r.eligibleTotal}`, '', '', '', ''].map(csvCell).join(','));
  lines.push(['SUMMARY', `Votes cast: ${r.votesCast}`, '', '', '', ''].map(csvCell).join(','));
  lines.push(['SUMMARY', `Turnout: ${r.turnout}%`, '', '', '', ''].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="results-election-${req.params.id}.csv"`);
  res.send(lines.join('\n'));
});
app.get('/api/admin/elections/:id/activity', adminOnly, async (req, res) => {
  // Aggregate activity only — never expose who voted for whom
  const eid = req.params.id;
  const receipts = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE election_id=?').get(eid)).c;
  // to_char(... AT TIME ZONE 'UTC', ...) is the Postgres equivalent of the old
  // SQLite hour-bucketing format: created_at is a timestamptz, so it is bucketed
  // to the hour in UTC to keep the 'YYYY-MM-DD HH:00' label the chart expects.
  const byHour = await db.prepare("SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:00') h, COUNT(*) c FROM vote_receipts WHERE election_id=? GROUP BY h ORDER BY h").all(eid);
  const logs = await db.prepare('SELECT a.*, u.email actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 50').all();
  res.json({ receipts, byHour, logs });
});

// ---------- SUPERADMIN ----------
const superOnly = [authRequired, requireRole('superadmin')];
app.get('/api/super/users', superOnly, async (req, res) => {
  res.json(await db.prepare('SELECT id,student_id,name,email,role,faculty,department,level,verified,is_active,created_at FROM users ORDER BY id DESC LIMIT 500').all());
});
app.post('/api/super/users', superOnly, async (req, res) => {
  let { name, student_id, email, password, role, faculty, department, level } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
  if (!['voter','admin','superadmin'].includes(role)) role = 'voter';
  const hash = bcrypt.hashSync(password, 12);
  try {
    const info = await db.prepare('INSERT INTO users(name,student_id,email,password_hash,role,faculty,department,level,verified) VALUES(?,?,?,?,?,?,?,?,1) RETURNING id')
      .run(name, (student_id||'').toUpperCase()||null, email.toLowerCase(), hash, role, faculty||'', department||'', level||'');
    audit(req.user.id, 'super.user_create', `${email} as ${role}`, req);
    res.json({ id: info.lastInsertRowid });
  } catch (e) { res.status(409).json({ error: 'Email or Student ID already exists' }); }
});
app.put('/api/super/users/:id', superOnly, async (req, res) => {
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Not found' });
  const { name, role, is_active, verified, faculty, department, level, password } = req.body || {};
  if (role && !['voter','admin','superadmin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  // Guard against locking the institution out of its own system: the last
  // active super admin can neither be demoted nor deactivated.
  const losingSuper = (role && role !== 'superadmin') || (is_active !== undefined && Number(is_active) === 0);
  if (u.role === 'superadmin' && losingSuper) {
    const others = (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='superadmin' AND is_active=1 AND id<>?").get(u.id)).c;
    if (others === 0) {
      return res.status(409).json({ error: 'This is the last active super admin. Promote another super admin before changing this account.' });
    }
  }
  await db.prepare('UPDATE users SET name=COALESCE(?,name), role=COALESCE(?,role), is_active=COALESCE(?,is_active), verified=COALESCE(?,verified), faculty=COALESCE(?,faculty), department=COALESCE(?,department), level=COALESCE(?,level) WHERE id=?')
    .run(name??null, role??null, is_active??null, verified??null, faculty??null, department??null, level??null, u.id);
  if (password) {
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(password,12), u.id);
  }
  audit(req.user.id, 'super.user_update', `#${u.id}`, req);
  res.json({ message: 'User updated' });
});
app.delete('/api/super/users/:id', superOnly, async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });
  const target = await db.prepare('SELECT id, role, name FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  if (target.role === 'superadmin') {
    const others = (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='superadmin' AND id<>?").get(target.id)).c;
    if (others === 0) return res.status(409).json({ error: 'Cannot delete the last super admin' });
  }
  // Deleting a voter would cascade away their vote receipts. Their ballots are
  // already anonymous, so deactivating the account is the safe alternative.
  const receipts = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE voter_id=?').get(target.id)).c;
  if (receipts > 0) {
    return res.status(409).json({ error: `${target.name} has ${receipts} recorded vote(s) and cannot be deleted. Deactivate the account instead.` });
  }
  await db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  audit(req.user.id, 'super.user_delete', `#${req.params.id} (${target.name})`, req);
  res.json({ message: 'User deleted' });
});
app.get('/api/super/logs', superOnly, async (req, res) => {
  res.json(await db.prepare('SELECT a.*, u.email actor FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200').all());
});
app.get('/api/super/settings', superOnly, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM settings').all());
});
app.put('/api/super/settings', superOnly, async (req, res) => {
  const { key, value } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  audit(req.user.id, 'super.settings', `${key}=${value}`, req);
  res.json({ message: 'Setting saved' });
});
// Bootstrap first superadmin (protected by setup key, only if none exists)
app.post('/api/setup/superadmin', async (req, res) => {
  const count = (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='superadmin'").get()).c;
  if (count > 0) return res.status(403).json({ error: 'Super admin already exists. Ask an existing super admin.' });
  if (!ADMIN_SETUP_KEY) {
    return res.status(503).json({ error: 'Super admin bootstrap is disabled because ADMIN_SETUP_KEY is not configured on the server.' });
  }
  const { name, email, password, setup_key, student_id } = req.body || {};
  const given = Buffer.from(String(setup_key || ''));
  const want = Buffer.from(String(ADMIN_SETUP_KEY));
  // Constant-time compare so the setup key cannot be recovered by timing.
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(403).json({ error: 'Invalid setup key' });
  }
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });
  const info = await db.prepare("INSERT INTO users(name,student_id,email,password_hash,role,verified) VALUES(?,?,?,?,?,1) RETURNING id")
    .run(name, (student_id||'SUPERADMIN').toUpperCase(), email.toLowerCase(), bcrypt.hashSync(password,12), 'superadmin');
  audit(info.lastInsertRowid, 'setup.superadmin', email, req);
  res.json({ message: 'Super admin created. Please log in.' });
});

// ---------- static frontend ----------
// JSON error responses for API routes (e.g. multer upload rejections), so
// clients never receive an HTML error page from /api/*. Together with
// express-async-errors this also catches rejections from async handlers, which
// is what keeps a failed database call from becoming a platform-level 502.
//
// Internal detail is logged, never returned; the client gets an actionable but
// non-sensitive message.
function describeDbError(err) {
  const m = String((err && err.message) || '');
  if (/self-signed certificate|certificate chain|unable to verify|certificate/i.test(m)) {
    return 'TLS certificate for the database could not be verified; set SUPABASE_DB_SSL=no-verify (or pin SUPABASE_DB_CA) on the host';
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timeout expired|Connection terminated|server closed the connection/i.test(m)) {
    return 'cannot reach Postgres; check SUPABASE_DB_URL and the Supabase pooler host/port';
  }
  if (/password authentication failed|role .* does not exist/i.test(m)) {
    return 'database authentication failed; check the percent-encoded password in SUPABASE_DB_URL';
  }
  if (/does not exist|undefined column|undefined table/i.test(m)) {
    return 'schema mismatch; run npm run db:migrate against the live database';
  }
  return null;
}

app.use((err, req, res, next) => {
  if (!req.path.startsWith('/api/')) return next(err);
  console.error('[api-error]', err && (err.stack || err.message));

  // Missing/invalid server configuration, recorded at import time.
  if (err.code === 'CONFIG') {
    return res.status(503).json({ error: 'Server configuration error: ' + err.message });
  }

  // Unique-constraint races: the friendly pre-check usually catches duplicates,
  // but two simultaneous registrations can slip past it. Postgres reports 23505.
  if (err.code === '23505') {
    const target = String(err.constraint || err.detail || '');
    if (/email/i.test(target)) return res.status(409).json({ error: 'Email already registered' });
    if (/student_id|student/i.test(target)) return res.status(409).json({ error: 'Student ID already registered' });
    return res.status(409).json({ error: 'That record already exists' });
  }

  // Only classify driver-level failures. A route that set `err.status` has
  // already decided what the client should see, so never override it.
  const hint = err.status ? null : describeDbError(err);
  if (hint) {
    console.error('[api-error] operator hint: ' + hint);
    return res.status(503).json({ error: 'Database connection failed. Please try again shortly.' });
  }

  const status = err.status || (/LIMIT_|Only .* allowed/.test(err.message) ? 400 : 500);
  if (status < 500) return res.status(status).json({ error: err.message });
  const generic = req.path.endsWith('/auth/register')
    ? 'Registration service temporarily unavailable. Please try again shortly.'
    : 'Service temporarily unavailable. Please try again shortly.';
  res.status(500).json({ error: generic });
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Background job: auto-close elections whose end date has passed. Runs on an
// interval in the long-lived server, and once per invocation from the Netlify
// scheduled function (netlify/functions/scheduler.js).
async function autoCloseElections() {
  try {
    // Compared in JS so the whole batch shares a single `now` and ends_at (a
    // timestamptz, read back as ISO-8601) is evaluated against the server clock
    // rather than folded into SQL string ordering.
    const now = Date.now();
    const open = await db.prepare("SELECT id, title, ends_at FROM elections WHERE status='open'").all();
    for (const e of open) {
      if (new Date(e.ends_at).getTime() > now) continue;
      await db.prepare("UPDATE elections SET status='closed' WHERE id=? AND status='open'").run(e.id);
      audit(null, 'system.auto_close', `Election #${e.id} (${e.title}) closed automatically`, null);
      console.log(`[scheduler] auto-closed election #${e.id}`);
    }
  } catch (err) { console.error('[scheduler]', err.message); }
}

// The Express app is exported so a serverless wrapper can mount it, and
// autoCloseElections is shared with the scheduled function.
module.exports = { app, autoCloseElections };

// Everything below runs only when this file is the process entry point
// (`node src/server.js`, `npm start`, and the test suites). Under Netlify
// Functions the module is require()d, so no port is opened and no interval is
// scheduled; the function wrapper handles requests instead.
if (require.main === module) {
  // Interval configurable via SCHEDULER_MS (default 60s; tests use ~1s).
  const SCHEDULER_MS = Number(process.env.SCHEDULER_MS || 60000);
  setInterval(() => { autoCloseElections(); }, SCHEDULER_MS).unref();

  const httpServer = app.listen(PORT, () => {
    console.log(`UNIVERSITY E-VOTING SYSTEM running on http://localhost:${PORT}`);
    if (!process.env.JWT_SECRET) console.warn('[security] JWT_SECRET is not set — using an insecure default. Set a long random value in production.');
    console.log(`[db] backend: ${supabase.isConfigured() ? 'Supabase Postgres' : 'not configured'}`);
  });

  // Graceful shutdown. A SIGTERM (from a process manager or a host's deploy
  // pipeline) lands here: in-flight requests finish, then the Postgres pool
  // closes. Without this, a deploy would sever live vote requests and leave the
  // pool leaking sockets until the process was killed.
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining...`);

    // Backstop only. Whatever supervises this process should allow at least
    // this long to drain before escalating to SIGKILL.
    const force = setTimeout(() => {
      console.error('[shutdown] drain timed out after 15s, exiting');
      process.exit(1);
    }, 15000);
    force.unref();

    httpServer.close(async () => {
      try {
        await supabase.shutdown();
      } catch (err) {
        console.error('[shutdown] error closing database pool:', err.message);
      }
      clearTimeout(force);
      console.log('[shutdown] complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
  process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
}
