// Security, integrity and notification tests.
//
// These cover the defences that a functional test suite would not exercise:
// CSRF on cookie sessions, login lockout, upload type validation, election
// lifecycle rules that protect the ballot record, ballot secrecy, and the
// notification rows that a voter relies on for their confirmation.
//
// Run: npm test
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createTestDatabase } = require('./helpers/pg-test-db');

const PORT = 3212;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let server;
let testDb;
let serverLog = '';

async function waitReady(tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (server.exitCode !== null) {
      throw new Error(`server exited early (code ${server.exitCode}):\n${serverLog}`);
    }
    try {
      const r = await fetch(BASE + '/api/settings/public');
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

// Bearer-token request (no cookies, so no CSRF involvement).
async function api(method, p, { token, data, form } = {}) {
  const headers = {};
  let body;
  if (form) body = form;
  else if (data !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body });
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  return { status: r.status, body: json, headers: r.headers };
}

// Cookie-session request. The cookie jar is a plain object so tests can prove
// exactly which cookies and headers the server issued and demanded.
function makeSession() {
  const jar = {};
  return {
    jar,
    get csrf() { return jar.evs_csrf ? decodeURIComponent(jar.evs_csrf) : null; },
    header() {
      return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(res) {
      for (const raw of res.headers.getSetCookie?.() || []) {
        const [pair] = raw.split(';');
        const idx = pair.indexOf('=');
        const name = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (value === '' ) delete jar[name];
        else jar[name] = value;
      }
      return res;
    },
    async req(method, p, { data, form, csrf, sendCsrf = 'auto' } = {}) {
      const headers = {};
      let body;
      if (form) body = form;
      else if (data !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
      if (Object.keys(jar).length) headers.Cookie = this.header();
      if (csrf !== undefined && sendCsrf !== 'omit') headers['X-CSRF-Token'] = csrf;
      else if (sendCsrf === 'auto' && this.csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        headers['X-CSRF-Token'] = this.csrf;
      }
      const r = await fetch(BASE + p, { method, headers, body });
      this.absorb(r);
      const text = await r.text();
      let json = {};
      try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
      return { status: r.status, body: json, headers: r.headers };
    },
  };
}

const state = {};
let adminToken, superToken;
// Shared across suites: the election the lifecycle suite votes in, read by the
// ballot-secrecy suite to check that the roll discloses no choices.
const lifecycle = {};

before(async () => {
  testDb = await createTestDatabase();
  server = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      SUPABASE_DB_URL: testDb.url,
      SUPABASE_DB_SSL: 'false',
      JWT_SECRET: 'sec-test-secret-min-32-chars-0123456789',
      ADMIN_SETUP_KEY: 'sec-setup-key',
      // Long window so the lockout test, not the rate limiter, is what fails.
      SCHEDULER_MS: '60000',
    },
    stdio: 'pipe',
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await waitReady();

  await api('POST', '/api/setup/superadmin', {
    data: { name: 'Sec Super', email: 'super@sec.edu', password: 'SuperPass@123', setup_key: 'sec-setup-key', student_id: 'SUP1' },
  });
  superToken = (await api('POST', '/api/auth/login', { data: { identifier: 'super@sec.edu', password: 'SuperPass@123' } })).body.token;

  await api('POST', '/api/super/users', { token: superToken, data: { name: 'Sec Admin', email: 'admin@sec.edu', password: 'AdminPass@123', role: 'admin' } });
  adminToken = (await api('POST', '/api/auth/login', { data: { identifier: 'admin@sec.edu', password: 'AdminPass@123' } })).body.token;

  // A verified voter who will cast a ballot in the shared election.
  const reg = await api('POST', '/api/auth/register', {
    data: { name: 'Sec Voter', student_id: 'SEC001', email: 'voter@sec.edu', password: 'VoterPass@123' },
  });
  await api('POST', '/api/auth/verify', { data: { token: reg.body.verification_token } });
  state.voterEmail = 'voter@sec.edu';
  state.voterId = reg.body.user_id;
});

after(async () => {
  if (server && !server.killed) server.kill();
  if (testDb) await testDb.drop();
});

describe('transport & headers', () => {
  it('sends a strict Content-Security-Policy that forbids inline scripts', async () => {
    const r = await fetch(BASE + '/');
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, 'CSP header must be present');
    assert.match(csp, /script-src 'self'/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'inline scripts must not be permitted');
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
  });

  it('sets clickjacking and sniffing protections', async () => {
    const r = await fetch(BASE + '/');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('x-frame-options'), 'X-Frame-Options must be set');
  });

  it('serves no inline scripts or inline event handlers on any page', async () => {
    const pages = ['/', '/login.html', '/register.html', '/verify.html', '/dashboard.html',
      '/election.html', '/ballot.html', '/results.html', '/admin.html', '/superadmin.html'];
    for (const page of pages) {
      const html = await (await fetch(BASE + page)).text();
      const inlineScript = /<script(?![^>]*\bsrc=)/i.test(html);
      const inlineHandler = /\son[a-z]+\s*=/i.test(html);
      assert.ok(!inlineScript, `${page} must not contain an inline <script>`);
      assert.ok(!inlineHandler, `${page} must not contain an inline event handler`);
    }
  });

  it('keeps the session cookie httpOnly and not exposed to scripts', async () => {
    const s = makeSession();
    const r = await s.req('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } });
    assert.equal(r.status, 200);
    const cookies = r.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith('evs_token='));
    assert.ok(session, 'a session cookie must be issued');
    assert.match(session, /HttpOnly/i, 'session cookie must be HttpOnly');
    assert.match(session, /SameSite/i, 'session cookie must set SameSite');
    assert.ok(!/evs_token=[^;]*;[^;]*script/i.test(session));
  });
});

describe('CSRF protection', () => {
  it('issues a readable CSRF token alongside the session cookie', async () => {
    const s = makeSession();
    await s.req('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } });
    assert.ok(s.jar.evs_token, 'session cookie expected');
    assert.ok(s.csrf, 'a readable CSRF cookie expected');
  });

  it('rejects a cookie-authenticated write with no CSRF header', async () => {
    const s = makeSession();
    await s.req('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } });
    const r = await s.req('POST', '/api/notifications/read', { data: { ids: [] }, sendCsrf: 'omit' });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /csrf/i);
  });

  it('rejects a cookie-authenticated write with a wrong CSRF token', async () => {
    const s = makeSession();
    await s.req('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } });
    const r = await s.req('POST', '/api/notifications/read', { data: { ids: [] }, csrf: 'forged-token-value' });
    assert.equal(r.status, 403);
  });

  it('accepts the write when the matching CSRF token is presented', async () => {
    const s = makeSession();
    await s.req('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } });
    const r = await s.req('POST', '/api/notifications/read', { data: { ids: [] } });
    assert.equal(r.status, 200);
  });

  it('leaves unauthenticated endpoints usable without a CSRF token', async () => {
    // Login carries no session cookie, so requiring CSRF there would lock
    // every user out of the application entirely.
    const s = makeSession();
    const r = await s.req('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' }, sendCsrf: 'omit' });
    assert.equal(r.status, 200);
  });

  it('does not require CSRF for bearer-token clients', async () => {
    const r = await api('POST', '/api/notifications/read', { token: (await api('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } })).body.token, data: { ids: [] } });
    assert.equal(r.status, 200);
  });
});

describe('login lockout', () => {
  it('locks the account after the configured number of failures', async () => {
    const r0 = await api('POST', '/api/auth/register', {
      data: { name: 'Lock Target', student_id: 'LOCK01', email: 'lock@sec.edu', password: 'VoterPass@123' },
    });
    await api('POST', '/api/auth/verify', { data: { token: r0.body.verification_token } });

    // Exactly the configured number of wrong passwords, then a correct one.
    for (let i = 0; i < 5; i++) {
      const bad = await api('POST', '/api/auth/login', { data: { identifier: 'lock@sec.edu', password: 'WrongPassword!1' } });
      assert.equal(bad.status, 401, `attempt ${i + 1} should be rejected as a bad password`);
    }
    const correct = await api('POST', '/api/auth/login', { data: { identifier: 'lock@sec.edu', password: 'VoterPass@123' } });
    assert.equal(correct.status, 429, 'the correct password must still be refused while locked out');
    assert.match(correct.body.error, /too many failed attempts/i);

    // A different account on the same IP must not be collateral damage.
    const other = await api('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } });
    assert.equal(other.status, 200, 'lockout must be scoped to the targeted account');
  });

  it('clears the failure counter after a successful login', async () => {
    const r0 = await api('POST', '/api/auth/register', {
      data: { name: 'Counter Test', student_id: 'CNT001', email: 'counter@sec.edu', password: 'VoterPass@123' },
    });
    await api('POST', '/api/auth/verify', { data: { token: r0.body.verification_token } });

    for (let i = 0; i < 3; i++) {
      await api('POST', '/api/auth/login', { data: { identifier: 'counter@sec.edu', password: 'WrongPassword!1' } });
    }
    assert.equal((await api('POST', '/api/auth/login', { data: { identifier: 'counter@sec.edu', password: 'VoterPass@123' } })).status, 200);

    // A fresh failure must start from a clean slate, not from the old count.
    await api('POST', '/api/auth/login', { data: { identifier: 'counter@sec.edu', password: 'WrongPassword!1' } });
    assert.equal((await api('POST', '/api/auth/login', { data: { identifier: 'counter@sec.edu', password: 'VoterPass@123' } })).status, 200,
      'a successful login must reset the counter');
  });
});

describe('uploads', () => {
  it('rejects a file whose extension lies about its content type', async () => {
    const r = await api('POST', '/api/admin/elections', {
      token: adminToken,
      data: { title: 'UPLOAD TEST', starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), status: 'open' },
    });
    const eid = r.body.id;
    const p = await api('POST', `/api/admin/elections/${eid}/positions`, { token: adminToken, data: { title: 'Seat', max_select: 1 } });

    // A script masquerading as an image: the name says PNG, the bytes say HTML.
    const fd = new FormData();
    fd.append('election_id', String(eid));
    fd.append('position_id', String(p.body.id));
    fd.append('name', 'Disguised File');
    fd.append('photo', new Blob(['<script>alert(1)</script>'], { type: 'image/png' }), 'evil.png');
    const res = await api('POST', '/api/admin/candidates', { token: adminToken, form: fd });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /image|allowed|type/i);
  });

  it('accepts a real PNG and serves it inert', async () => {
    const r = await api('POST', '/api/admin/elections', {
      token: adminToken,
      data: { title: 'UPLOAD OK', starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), status: 'open' },
    });
    const eid = r.body.id;
    const p = await api('POST', `/api/admin/elections/${eid}/positions`, { token: adminToken, data: { title: 'Seat', max_select: 1 } });

    // 1x1 transparent PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('election_id', String(eid));
    fd.append('position_id', String(p.body.id));
    fd.append('name', 'Real Photo');
    fd.append('photo', new Blob([png], { type: 'image/png' }), 'ok.png');
    const res = await api('POST', '/api/admin/candidates', { token: adminToken, form: fd });
    assert.equal(res.status, 200);
    assert.ok(res.body.photo_url, 'a stored photo URL is expected');

    const served = await fetch(BASE + res.body.photo_url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.match(served.headers.get('content-security-policy') || '', /sandbox/,
      'uploaded files must be served with a sandbox CSP so an SVG/HTML payload cannot script');
  });
});

describe('election lifecycle integrity', () => {
  let eid, posId, candId;
  before(async () => {
    const r = await api('POST', '/api/admin/elections', {
      token: adminToken,
      data: {
        title: 'LIFECYCLE ELECTION',
        starts_at: new Date(Date.now() - 3600000).toISOString(),
        ends_at: new Date(Date.now() + 86400000).toISOString(),
        status: 'open',
        timezone: 'Africa/Accra',
      },
    });
    eid = r.body.id;
    lifecycle.electionId = eid;
    const p = await api('POST', `/api/admin/elections/${eid}/positions`, { token: adminToken, data: { title: 'President', max_select: 1 } });
    posId = p.body.id;
    const c = await api('POST', '/api/admin/candidates', {
      token: adminToken,
      form: (() => {
        const fd = new FormData();
        fd.append('election_id', String(eid));
        fd.append('position_id', String(posId));
        fd.append('name', 'Life Candidate');
        return fd;
      })(),
    });
    candId = c.body.id;
  });

  it('validates the election time zone', async () => {
    const r = await api('POST', '/api/admin/elections', {
      token: adminToken,
      data: { title: 'BAD TZ', starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), timezone: 'Mars/Olympus_Mons' },
    });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /time ?zone/i);
  });

  it('refuses to open an election whose start time is in the future', async () => {
    const r = await api('POST', '/api/admin/elections', {
      token: adminToken,
      data: {
        title: 'FUTURE ELECTION',
        starts_at: new Date(Date.now() + 86400000).toISOString(),
        ends_at: new Date(Date.now() + 172800000).toISOString(),
        status: 'draft',
      },
    });
    const id = r.body.id;
    const open = await api('POST', `/api/admin/elections/${id}/status`, { token: adminToken, data: { status: 'open' } });
    assert.equal(open.status, 409);
    assert.match(open.body.error, /start|future|not yet/i);
  });

  it('refuses illegal lifecycle jumps', async () => {
    const draft = await api('POST', '/api/admin/elections', {
      token: adminToken,
      data: { title: 'DRAFT E', starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), status: 'draft' },
    });
    // draft -> published would announce an outcome that was never run.
    const skip = await api('POST', `/api/admin/elections/${draft.body.id}/status`, { token: adminToken, data: { status: 'published' } });
    assert.equal(skip.status, 409);
  });

  it('treats a published election as final', async () => {
    const e = await api('POST', '/api/admin/elections', {
      token: adminToken,
      data: { title: 'FINAL E', starts_at: new Date(Date.now() - 7200000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), status: 'open' },
    });
    const id = e.body.id;
    assert.equal((await api('POST', `/api/admin/elections/${id}/status`, { token: adminToken, data: { status: 'closed' } })).status, 200);
    assert.equal((await api('POST', `/api/admin/elections/${id}/status`, { token: adminToken, data: { status: 'published' } })).status, 200);
    const reopen = await api('POST', `/api/admin/elections/${id}/status`, { token: adminToken, data: { status: 'open' } });
    assert.equal(reopen.status, 409, 'a published election must not be reopened');
  });

  it('records a vote, then protects every artefact the record depends on', async () => {
    const token = (await api('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } })).body.token;
    const vote = await api('POST', `/api/elections/${eid}/vote`, { token, data: { selections: { [posId]: [candId] } } });
    assert.equal(vote.status, 200);

    // The window can no longer be rewritten once ballots exist.
    const shift = await api('PUT', `/api/admin/elections/${eid}`, {
      token: adminToken,
      data: { starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 99999999).toISOString() },
    });
    assert.equal(shift.status, 409);

    const delCand = await api('DELETE', `/api/admin/candidates/${candId}`, { token: adminToken });
    assert.equal(delCand.status, 409, 'a candidate who has received votes cannot be deleted');

    const delPos = await api('DELETE', `/api/admin/positions/${posId}`, { token: adminToken });
    assert.equal(delPos.status, 409, 'a position with recorded ballots cannot be deleted');

    const delElection = await api('DELETE', `/api/admin/elections/${eid}`, { token: adminToken });
    assert.equal(delElection.status, 409, 'an election with recorded ballots cannot be deleted');
  });

  it('still allows text-only edits to an election that has votes', async () => {
    const r = await api('PUT', `/api/admin/elections/${eid}`, { token: adminToken, data: { description: 'Corrected after publication' } });
    assert.equal(r.status, 200);
  });
});

describe('results visibility policy', () => {
  it('restricts results to administrators when configured', async () => {
    const r = await api('POST', '/api/admin/elections', {
      token: adminToken,
      data: { title: 'HIDDEN RESULTS', starts_at: new Date(Date.now() - 7200000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), status: 'open' },
    });
    const id = r.body.id;
    await api('POST', `/api/admin/elections/${id}/status`, { token: adminToken, data: { status: 'closed' } });
    await api('POST', `/api/admin/elections/${id}/status`, { token: adminToken, data: { status: 'published' } });

    const voterToken = (await api('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } })).body.token;
    assert.equal((await api('GET', `/api/elections/${id}/results`, { token: voterToken })).status, 200);

    await api('PUT', '/api/super/settings', { token: superToken, data: { key: 'results_visibility', value: 'admins_only' } });
    const blocked = await api('GET', `/api/elections/${id}/results`, { token: voterToken });
    assert.equal(blocked.status, 403, 'students must be refused when results are admin-only');
    assert.equal((await api('GET', `/api/elections/${id}/results`, { token: adminToken })).status, 200,
      'administrators keep access regardless of the policy');

    await api('PUT', '/api/super/settings', { token: superToken, data: { key: 'results_visibility', value: 'published_only' } });
    assert.equal((await api('GET', `/api/elections/${id}/results`, { token: voterToken })).status, 200);
  });
});

describe('ballot secrecy', () => {
  it('reports participation on the roll without revealing any choice', async () => {
    const r = await api('GET', `/api/admin/elections/${lifecycle.electionId}/roll`, { token: adminToken });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.rows));
    const me = r.body.rows.find((x) => x.email === 'voter@sec.edu');
    assert.ok(me, 'the voter must appear on the roll');
    assert.equal(me.has_voted, true);
    assert.equal(me.voted_at !== null, true);
    const dumped = JSON.stringify(r.body);
    assert.ok(!dumped.includes('selections'), 'the roll must never contain ballot contents');
    assert.ok(!dumped.includes('candidate_id'), 'the roll must never contain candidate selections');
  });

  it('denies the roll endpoint to voters', async () => {
    const voterToken = (await api('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } })).body.token;
    const r = await api('GET', `/api/admin/elections/${lifecycle.electionId}/roll`, { token: voterToken });
    assert.equal(r.status, 403);
  });
});

describe('notifications', () => {
  it('records a vote confirmation the voter can actually read back', async () => {
    // This is the regression guard for the notifications.status CHECK
    // constraint: an invalid status made every insert fail silently.
    const token = (await api('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } })).body.token;
    const list = await api('GET', '/api/notifications', { token });
    assert.equal(list.status, 200);
    assert.ok(list.body.length > 0, 'a notification must have been stored');

    const voteNotice = list.body.find((n) => n.type === 'vote.cast');
    assert.ok(voteNotice, 'the vote confirmation must be present');
    assert.ok(['pending', 'sent', 'failed'].includes(voteNotice.status),
      `status must satisfy the CHECK constraint, got ${voteNotice.status}`);
    assert.match(voteNotice.title, /Vote recorded/i);

    // It must not leak what was voted for.
    assert.ok(!/candA|Cand A|candidate/i.test(voteNotice.body || ''), 'the notice must not name a candidate');
  });

  it('notifies eligible voters when an election opens', async () => {
    const voterToken = (await api('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } })).body.token;
    const before = (await api('GET', '/api/notifications', { token: voterToken })).body.length;
    const e = await api('POST', '/api/admin/elections', {
      token: adminToken,
      data: { title: 'NOTIFY OPEN', starts_at: new Date(Date.now() - 1000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), status: 'draft' },
    });
    const opened = await api('POST', `/api/admin/elections/${e.body.id}/status`, { token: adminToken, data: { status: 'open' } });
    assert.equal(opened.status, 200);
    const after = (await api('GET', '/api/notifications', { token: voterToken })).body;
    assert.ok(after.length > before, 'opening an election must notify eligible voters');
    assert.ok(after.some((n) => n.type === 'election.opened'));
  });

  it('marks notifications read without deleting them', async () => {
    const token = (await api('POST', '/api/auth/login', { data: { identifier: 'voter@sec.edu', password: 'VoterPass@123' } })).body.token;
    const before = (await api('GET', '/api/notifications', { token })).body;
    const unread = before.filter((n) => !n.read_at);
    assert.ok(unread.length > 0, 'expected at least one unread notification');

    const marked = await api('POST', '/api/notifications/read', { token, data: { ids: unread.map((n) => n.id) } });
    assert.equal(marked.status, 200);
    const after = (await api('GET', '/api/notifications', { token })).body;
    assert.equal(after.length, before.length, 'marking read must not remove notifications');
    for (const n of unread) {
      const row = after.find((x) => x.id === n.id);
      assert.ok(row.read_at, 'the notification should now be marked read');
    }
  });
});

describe('superadmin safeguards', () => {
  it('will not let the last active superadmin be demoted or disabled', async () => {
    const users = await api('GET', '/api/super/users', { token: superToken });
    const me = users.body.find((u) => u.email === 'super@sec.edu');
    const demote = await api('PUT', `/api/super/users/${me.id}`, { token: superToken, data: { role: 'admin' } });
    assert.equal(demote.status, 409, 'demoting the last superadmin must be refused');
    const disable = await api('PUT', `/api/super/users/${me.id}`, { token: superToken, data: { is_active: 0 } });
    assert.equal(disable.status, 409, 'disabling the last superadmin must be refused');
  });

  it('will not let a superadmin delete their own account', async () => {
    const users = await api('GET', '/api/super/users', { token: superToken });
    const me = users.body.find((u) => u.email === 'super@sec.edu');
    const r = await api('DELETE', `/api/super/users/${me.id}`, { token: superToken });
    assert.equal(r.status, 400);
  });

  it('refuses to delete a voter who has recorded a ballot', async () => {
    const users = await api('GET', '/api/super/users', { token: superToken });
    const voter = users.body.find((u) => u.email === 'voter@sec.edu');
    const r = await api('DELETE', `/api/super/users/${voter.id}`, { token: superToken });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /deactivate/i);
  });

  it('enforces a minimum password length on administrator resets', async () => {
    const users = await api('GET', '/api/super/users', { token: superToken });
    const admin = users.body.find((u) => u.email === 'admin@sec.edu');
    const r = await api('PUT', `/api/super/users/${admin.id}`, { token: superToken, data: { password: 'short' } });
    assert.equal(r.status, 400);
  });

  it('never exposes password hashes over the user API', async () => {
    const r = await api('GET', '/api/super/users', { token: superToken });
    const dumped = JSON.stringify(r.body);
    assert.ok(!dumped.includes('password_hash'));
    assert.ok(!dumped.includes('$2a$') && !dumped.includes('$2b$'), 'no bcrypt hash may appear');
  });
});
