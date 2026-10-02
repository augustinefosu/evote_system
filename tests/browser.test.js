'use strict';
/*
 * Runtime smoke tests for the browser client.
 *
 * The API suites prove the server behaves; they say nothing about whether the
 * page controllers actually run in a browser. These tests drive a real headless
 * Edge/Chrome over the DevTools Protocol (using Node's built-in WebSocket, so
 * there is no puppeteer/playwright dependency) and assert that every page:
 *
 *   - loads its external JavaScript with no uncaught exception,
 *   - logs no console error and makes no failed (4xx/5xx) subresource request,
 *   - is not blocked by the strict CSP, and
 *   - renders without falling into its `.alert.error` failure state.
 *
 * If no Chromium browser is installed the whole suite skips rather than fails,
 * so the project stays testable on machines without one.
 */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.BROWSER_TEST_PORT || 3213);
const CDP_PORT = Number(process.env.BROWSER_TEST_CDP_PORT || 9222);
const BASE = `http://127.0.0.1:${PORT}`;

const BROWSER_CANDIDATES = [
  process.env.BROWSER_BIN,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const browserBin = process.env.BROWSER_TEST === '0'
  ? undefined
  : BROWSER_CANDIDATES.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });

const skipReason = process.env.BROWSER_TEST === '0'
  ? 'BROWSER_TEST=0'
  : (browserBin ? false : 'no Chromium-based browser found');

let server;
let serverLog = '';
let browser;
let profileDir;
let cdp;
let targetId;
let sessionId;
const pageErrors = new Map();   // label -> array of messages

// Label the diagnostics collected by CDP events are attributed to. Declared at
// module scope because the event handlers below close over it.
let currentPage = 'startup';

/*
 * Failures that are part of a correct run rather than a defect, so the strict
 * assertions stay meaningful:
 *   - /api/auth/me answering 401/403 while signed out, which is how every page
 *     learns it has no session and should redirect;
 *   - /favicon.ico, which this project does not ship.
 */
function isExpectedNoise(rawUrl, status) {
  if (!rawUrl) return false;
  let pathname = rawUrl;
  try { pathname = new URL(rawUrl).pathname; } catch { /* relative or odd */ }
  if (pathname === '/favicon.ico') return true;
  return pathname === '/api/auth/me' && (status === 401 || status === 403);
}

// ---------- tiny CDP client ----------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || '')})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) for (const fn of this.listeners) fn(msg);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, useSession = true) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (useSession && sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (server.exitCode !== null) throw new Error(`server exited early (code ${server.exitCode}):\n${serverLog}`);
    try { if ((await fetch(BASE + '/api/health')).ok) return; } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error('server did not start');
}

// ---------- fixture ----------

const fixture = { superEmail: 'bsuper@sec.edu', adminEmail: 'badmin@sec.edu', voterEmail: 'bvoter@sec.edu' };
let openElectionId;
let publishedElectionId;

async function api(method, urlPath, { token, data, form } = {}) {
  const headers = {};
  let body;
  if (form) { body = form; } else if (data !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(BASE + urlPath, { method, headers, body });
  const text = await r.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  return { status: r.status, body: parsed };
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function buildFixture() {
  await api('POST', '/api/setup/superadmin', {
    data: { name: 'Browser Super', email: fixture.superEmail, password: 'SuperPass@123', setup_key: 'browser-key', student_id: 'BSUP1' },
  });
  const superToken = (await api('POST', '/api/auth/login', { data: { identifier: fixture.superEmail, password: 'SuperPass@123' } })).body.token;

  await api('POST', '/api/super/users', { token: superToken, data: { name: 'Browser Admin', email: fixture.adminEmail, password: 'AdminPass@123', role: 'admin' } });
  const adminToken = (await api('POST', '/api/auth/login', { data: { identifier: fixture.adminEmail, password: 'AdminPass@123' } })).body.token;

  const reg = await api('POST', '/api/auth/register', {
    data: { name: 'Browser Voter', student_id: 'BROW001', email: fixture.voterEmail, password: 'VoterPass@123' },
  });
  await api('POST', '/api/auth/verify', { data: { token: reg.body.verification_token } });
  const voterId = reg.body.user_id;

  // An open election the voter is eligible for, so the dashboard, election and
  // ballot pages all have real content to render.
  const open = await api('POST', '/api/admin/elections', {
    token: adminToken,
    data: {
      title: 'BROWSER OPEN ELECTION',
      starts_at: new Date(Date.now() - 3600000).toISOString(),
      ends_at: new Date(Date.now() + 86400000).toISOString(),
      status: 'open',
      timezone: 'Africa/Accra',
    },
  });
  openElectionId = open.body.id;
  const pos = await api('POST', `/api/admin/elections/${openElectionId}/positions`, {
    token: adminToken, data: { title: 'SRC President', min_select: 1, max_select: 1, mandatory: 1 },
  });
  const fd = new FormData();
  fd.append('election_id', String(openElectionId));
  fd.append('position_id', String(pos.body.id));
  fd.append('name', 'Browser Candidate');
  fd.append('photo', new Blob([png], { type: 'image/png' }), 'candidate.png');
  await api('POST', '/api/admin/candidates', { token: adminToken, form: fd });
  await api('POST', `/api/admin/elections/${openElectionId}/eligibility`, { token: adminToken, data: { user_id: voterId } });

  // A second, published election so the results page has a real outcome to show.
  const done = await api('POST', '/api/admin/elections', {
    token: adminToken,
    data: {
      title: 'BROWSER PUBLISHED ELECTION',
      starts_at: new Date(Date.now() - 7200000).toISOString(),
      ends_at: new Date(Date.now() - 3600000).toISOString(),
      status: 'open',
      timezone: 'Africa/Accra',
    },
  });
  publishedElectionId = done.body.id;
  const pos2 = await api('POST', `/api/admin/elections/${publishedElectionId}/positions`, {
    token: adminToken, data: { title: 'Auditor', min_select: 1, max_select: 1, mandatory: 1 },
  });
  const fd2 = new FormData();
  fd2.append('election_id', String(publishedElectionId));
  fd2.append('position_id', String(pos2.body.id));
  fd2.append('name', 'Published Candidate');
  fd2.append('photo', new Blob([png], { type: 'image/png' }), 'candidate.png');
  await api('POST', '/api/admin/candidates', { token: adminToken, form: fd2 });
  await api('POST', `/api/admin/elections/${publishedElectionId}/eligibility`, { token: adminToken, data: { user_id: voterId } });
  await api('POST', `/api/admin/elections/${publishedElectionId}/status`, { token: adminToken, data: { status: 'closed' } });
  await api('POST', `/api/admin/elections/${publishedElectionId}/status`, { token: adminToken, data: { status: 'published' } });

  // Give the second election some turnout so the results page renders charts.
  await api('POST', `/api/admin/elections/${publishedElectionId}/vote`, {
    data: { selections: [{ position_id: pos2.body.id, candidate_ids: [] }] },
  }).catch(() => { /* anonymous fixture voter cannot vote from here; not required */ });
}

// ---------- page driving ----------

async function evaluate(expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(`evaluate failed: ${r.exceptionDetails.text} ${(r.exceptionDetails.exception || {}).description || ''}`);
  }
  return r.result.value;
}

// Generous by default: this suite shares the machine with the API suites, whose
// bcrypt work (cost 12) can starve the headless browser. A slow run should wait,
// not fail.
async function waitFor(expression, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(`!!(${expression})`)) return true;
    await wait(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function record(pageUrl, message) {
  if (!pageErrors.has(pageUrl)) pageErrors.set(pageUrl, []);
  pageErrors.get(pageUrl).push(message);
}

/**
 * Load a page in the same tab, collecting anything the browser complains about.
 * Reusing one tab keeps the cookie jar, so a single sign-in covers every
 * authenticated page that follows.
 */
async function visit(pathAndQuery, label) {
  pageErrors.delete(label);
  const url = BASE + pathAndQuery;
  await cdp.send('Page.navigate', { url });
  await waitFor(`document.readyState === 'complete'`, `${label} to load`);
  // Let the page controller finish its initial fetches and render.
  await wait(900);

  const diag = await evaluate(`JSON.stringify({
    title: document.title,
    alerts: Array.from(document.querySelectorAll('.alert.error')).map((n) => n.textContent.trim()),
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 3000),
    redirected: location.pathname + location.search,
  })`);
  return JSON.parse(diag);
}

// Mirrors what public/js/api.js does: read the readable CSRF cookie and echo it
// back on writes. Without this, a raw fetch is rejected with 403 as soon as a
// session cookie exists, which is correct server behaviour but not what a
// genuine client does.
async function csrfHeaders() {
  const token = await evaluate(`(() => {
    const m = document.cookie.match(/(?:^|;\\s*)evs_csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  })()`);
  return token ? { 'X-CSRF-Token': token } : {};
}

async function signIn(identifier, password) {
  const headers = { 'Content-Type': 'application/json', ...(await csrfHeaders()) };
  const result = await evaluate(`fetch('/api/auth/login', {
    method: 'POST',
    headers: ${JSON.stringify(headers)},
    body: JSON.stringify(${JSON.stringify({ identifier, password })}),
  }).then(async (r) => JSON.stringify({ status: r.status, body: await r.text() }))`);
  const { status, body } = JSON.parse(result);
  assert.equal(status, 200, `sign-in failed for ${identifier}: ${status} ${body}`);
}

async function signOut() {
  const headers = await csrfHeaders();
  await evaluate(`fetch('/api/auth/logout', { method: 'POST', headers: ${JSON.stringify(headers)} }).then((r) => r.status)`);
  // Confirm the session really ended, so a later sign-in is not silently
  // applied on top of the previous one.
  const still = await evaluate(`fetch('/api/auth/me', { headers: ${JSON.stringify(headers)} }).then((r) => r.status)`);
  assert.equal(still, 401, 'sign-out did not clear the session');
}

// ---------- suite ----------

describe('browser runtime', { skip: skipReason }, () => {
  before(async () => {
    if (!browserBin) return;

    const DB = path.join(os.tmpdir(), `evoting-browser-${process.pid}.db`);
    for (const suffix of ['', '-shm', '-wal']) { try { fs.unlinkSync(DB + suffix); } catch { /* fresh */ } }

    server = spawn('node', ['src/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: DB,
        JWT_SECRET: 'browser-test-secret-min-32-chars-0123456789',
        ADMIN_SETUP_KEY: 'browser-key',
        SCHEDULER_MS: '60000',
      },
      stdio: 'pipe',
    });
    server.stdout.on('data', (d) => { serverLog += d; });
    server.stderr.on('data', (d) => { serverLog += d; });
    await waitReady();
    await buildFixture();

    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evoting-cdp-'));
    browser = spawn(browserBin, [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-sandbox',
      'about:blank',
    ], { stdio: 'ignore' });

    // Wait for the DevTools endpoint to accept connections.
    let version = null;
    for (let i = 0; i < 40 && !version; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); } catch { await wait(500); }
    }
    assert.ok(version && version.webSocketDebuggerUrl, 'DevTools endpoint never became available');

    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }, false));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }, false));

    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        record(currentPage, `uncaught exception: ${d.text} ${(d.exception && d.exception.description) || ''}`.trim());
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        record(currentPage, `console.error: ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level !== 'error') return;
        // "Failed to load resource" duplicates what Network.responseReceived
        // already reports, but without the URL. CSP violations and other
        // security messages arrive here and must not be filtered.
        if (/^Failed to load resource/i.test(e.text)) return;
        if (isExpectedNoise(e.url, e.status)) return;
        record(currentPage, `browser log [${e.source}]: ${e.text}`);
      }
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    cdp.on((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Network.responseReceived') {
        const { response, type } = msg.params;
        if (response.status < 400 || type === 'Document') return;
        if (isExpectedNoise(response.url, response.status)) return;
        record(currentPage, `failed request ${response.status} ${response.url}`);
      }
    });

    // Land on the app origin before any test runs: relative fetches (sign-in,
    // sign-out) need a real origin, and about:blank has none.
    await cdp.send('Page.navigate', { url: BASE + '/index.html' });
    await waitFor(`document.readyState === 'complete'`, 'initial page load');
  });

  after(async () => {
    if (cdp) { try { await cdp.send('Browser.close', {}, false); } catch { /* closing anyway */ } cdp.close(); }
    if (browser) { try { browser.kill(); } catch { /* already exited */ } }
    if (server && !server.killed) server.kill();
    if (profileDir) {
      // Edge can still hold the profile for a moment after it exits, and
      // fs.rmSync({force}) swallows that failure, which would leak a directory
      // on every run. Retry briefly, then leave it rather than crash the suite.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          fs.rmSync(profileDir, { recursive: true, force: true });
          if (!fs.existsSync(profileDir)) break;
        } catch { /* still locked */ }
        await wait(300);
      }
    }
  });

  // The current page label, used to attribute diagnostics collected by events.
  const pages = [
    { label: 'index', path: '/index.html', auth: null, expectRender: true },
    { label: 'login', path: '/login.html', auth: null, expectRender: true },
    { label: 'register', path: '/register.html', auth: null, expectRender: true },
    { label: 'verify', path: '/verify.html', auth: null, expectRender: true },
  ];

  test('public pages render without browser errors', async () => {
    if (!browserBin) return;
    await signOut();
    for (const p of pages) {
      currentPage = p.label;
      const d = await visit(p.path, p.label);
      const errors = pageErrors.get(p.label) || [];
      assert.deepEqual(errors, [], `${p.label} reported browser errors:\n  ${errors.join('\n  ')}`);
      if (p.expectRender) {
        assert.deepEqual(d.alerts, [], `${p.label} rendered an error alert: ${d.alerts.join(' | ')}`);
        assert.ok(d.text.length > 0, `${p.label} rendered no visible text`);
      }
    }
  });

  test('forgot.html redirects to the verification page without a CSP violation', async () => {
    if (!browserBin) return;
    currentPage = 'forgot';
    pageErrors.delete('forgot');
    await cdp.send('Page.navigate', { url: BASE + '/forgot.html' });
    await waitFor(`location.pathname === '/verify.html'`, 'forgot.html to redirect');
    const errors = pageErrors.get('forgot') || [];
    assert.deepEqual(errors, [], `forgot redirect reported errors:\n  ${errors.join('\n  ')}`);
  });

  test('student pages render a real election for a signed-in voter', async () => {
    if (!browserBin) return;
    currentPage = 'voter-signin';
    await visit('/login.html', 'voter-signin');
    await signIn(fixture.voterEmail, 'VoterPass@123');

    const checks = [
      { label: 'dashboard', path: '/dashboard.html', must: 'BROWSER OPEN ELECTION' },
      { label: 'election', path: `/election.html?id=${openElectionId}`, must: 'SRC President' },
      { label: 'ballot', path: `/ballot.html?id=${openElectionId}`, must: 'Browser Candidate' },
      { label: 'results', path: `/results.html?id=${publishedElectionId}`, must: null },
    ];
    for (const c of checks) {
      currentPage = c.label;
      const d = await visit(c.path, c.label);
      const errors = pageErrors.get(c.label) || [];
      assert.deepEqual(errors, [], `${c.label} reported browser errors:\n  ${errors.join('\n  ')}`);
      assert.deepEqual(d.alerts, [], `${c.label} rendered an error alert: ${d.alerts.join(' | ')}`);
      assert.ok(
        d.redirected.endsWith(c.path.replace(/^\//, '').split('?')[0]) || d.redirected.endsWith(c.path),
        `${c.label} unexpectedly redirected to ${d.redirected}`,
      );
      if (c.must) assert.ok(d.text.includes(c.must), `${c.label} did not render expected content: ${d.text}`);
    }
  });

  test('the ballot page offers real candidates to choose from', async () => {
    if (!browserBin) return;
    currentPage = 'ballot-controls';
    const d = await visit(`/ballot.html?id=${openElectionId}`, 'ballot-controls');
    const errors = pageErrors.get('ballot-controls') || [];
    assert.deepEqual(errors, [], `ballot reported browser errors:\n  ${errors.join('\n  ')}`);
    assert.ok(
      d.text.includes('Browser Candidate') && d.text.includes('SRC President'),
      `ballot did not show the position and candidate: ${d.text}`,
    );
  });

  test('admin page loads every tab without errors', async () => {
    if (!browserBin) return;
    currentPage = 'admin-signin';
    await signOut();
    await visit('/login.html', 'admin-signin');
    await signIn(fixture.adminEmail, 'AdminPass@123');

    currentPage = 'admin';
    const d = await visit('/admin.html', 'admin');
    let errors = pageErrors.get('admin') || [];
    assert.deepEqual(errors, [], `admin page reported browser errors:\n  ${errors.join('\n  ')}`);
    assert.ok(d.redirected.endsWith('admin.html'), `admin page redirected to ${d.redirected}`);
    assert.deepEqual(d.alerts, [], `admin page rendered an error alert: ${d.alerts.join(' | ')}`);

    // Each tab renders on demand; a broken controller shows up here. Tabs are
    // addressed by data-tab so the checks do not depend on label wording.
    for (const tab of ['elections', 'positions', 'voters', 'activity']) {
      currentPage = `admin:${tab}`;
      pageErrors.delete(currentPage);
      const ok = await evaluate(`(() => {
        const btn = document.querySelector('.tabs button[data-tab=${JSON.stringify(tab)}]');
        if (!btn) return 'no-tab';
        btn.click();
        return 'clicked';
      })()`);
      assert.equal(ok, 'clicked', `admin tab "${tab}" not found`);
      await wait(1200);
      const tabErrors = pageErrors.get(currentPage) || [];
      assert.deepEqual(tabErrors, [], `admin tab "${tab}" reported browser errors:\n  ${tabErrors.join('\n  ')}`);
      const alerts = await evaluate(`Array.from(document.querySelectorAll('.alert.error')).map((n) => n.textContent.trim())`);
      assert.deepEqual(alerts, [], `admin tab "${tab}" rendered an error alert: ${alerts.join(' | ')}`);
    }
  });

  test('the admin candidate Edit button opens a working editor', async () => {
    if (!browserBin) return;
    // Regression guard: the Positions pane threw a TypeError on every render
    // because it cleared a #candidate-editor slot that was never created, which
    // also silently disabled the candidate filter and made Edit a dead button.
    currentPage = 'admin:candidate-edit';
    pageErrors.delete(currentPage);
    const opened = await evaluate(`(() => {
      const tab = document.querySelector('.tabs button[data-tab="positions"]');
      if (!tab) return { ok: false, why: 'no Positions tab' };
      tab.click();
      return { ok: true };
    })()`);
    assert.ok(opened.ok, opened.why);
    // Wait for the pane to finish loading before clicking. A re-render that
    // lands after the click clears the inline editor, so clicking into a
    // half-loaded pane would be a race rather than a test of the editor.
    await waitFor(
      `!document.querySelector('#pane-positions .loading') && document.querySelectorAll('#position-list-slot tbody tr').length > 0`,
      'the positions pane to finish loading',
    );
    await waitFor(`document.querySelectorAll('#candidate-list-slot [data-action="edit-candidate"]').length > 0`, 'candidate edit buttons');
    await wait(750);

    await evaluate(`document.querySelector('#candidate-list-slot [data-action="edit-candidate"]').click()`);
    await waitFor(`!!document.querySelector('#candidate-editor form#edit-candidate-form')`, 'the candidate edit form');

    const filled = await evaluate(`(() => {
      const f = document.querySelector('#edit-candidate-form');
      return JSON.stringify({ name: f.querySelector('#ec-name').value, positions: f.querySelector('#ec-position').options.length });
    })()`);
    const d = JSON.parse(filled);
    assert.ok(d.name.length > 0, 'the edit form should be pre-filled with the candidate name');
    assert.ok(d.positions > 0, 'the edit form should offer the election positions');

    const errors = pageErrors.get(currentPage) || [];
    assert.deepEqual(errors, [], `candidate editor reported browser errors:\n  ${errors.join('\n  ')}`);
  });

  test('the admin candidate list can be filtered by position', async () => {
    if (!browserBin) return;
    currentPage = 'admin:candidate-filter';
    pageErrors.delete(currentPage);
    const options = await evaluate(`document.querySelector('#cand-position').options.length`);
    assert.ok(options > 1, `the position filter should be populated from the election, got ${options} option(s)`);

    const before = await evaluate(`document.querySelectorAll('#candidate-list-slot tbody tr').length`);
    await evaluate(`(() => {
      const sel = document.querySelector('#cand-position');
      sel.value = sel.options[1].value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await wait(900);
    const after = await evaluate(`document.querySelectorAll('#candidate-list-slot tbody tr').length`);
    assert.ok(after <= before, `filtering should not increase the row count (${before} -> ${after})`);
    const errors = pageErrors.get(currentPage) || [];
    assert.deepEqual(errors, [], `candidate filter reported browser errors:\n  ${errors.join('\n  ')}`);
  });

  test('superadmin page loads every tab without errors', async () => {
    if (!browserBin) return;
    currentPage = 'super-signin';
    await signOut();
    await visit('/login.html', 'super-signin');
    await signIn(fixture.superEmail, 'SuperPass@123');

    currentPage = 'superadmin';
    const d = await visit('/superadmin.html', 'superadmin');
    let errors = pageErrors.get('superadmin') || [];
    assert.deepEqual(errors, [], `superadmin page reported browser errors:\n  ${errors.join('\n  ')}`);
    assert.ok(d.redirected.endsWith('superadmin.html'), `superadmin page redirected to ${d.redirected}`);
    assert.deepEqual(d.alerts, [], `superadmin page rendered an error alert: ${d.alerts.join(' | ')}`);

    for (const tab of ['admins', 'users', 'settings', 'audit']) {
      currentPage = `superadmin:${tab}`;
      pageErrors.delete(currentPage);
      const ok = await evaluate(`(() => {
        const btn = document.querySelector('.tabs button[data-tab=${JSON.stringify(tab)}]');
        if (!btn) return 'no-tab';
        btn.click();
        return 'clicked';
      })()`);
      assert.equal(ok, 'clicked', `superadmin tab "${tab}" not found`);
      await wait(1200);
      const tabErrors = pageErrors.get(currentPage) || [];
      assert.deepEqual(tabErrors, [], `superadmin tab "${tab}" reported browser errors:\n  ${tabErrors.join('\n  ')}`);
      const alerts = await evaluate(`Array.from(document.querySelectorAll('.alert.error')).map((n) => n.textContent.trim())`);
      assert.deepEqual(alerts, [], `superadmin tab "${tab}" rendered an error alert: ${alerts.join(' | ')}`);
    }
  });

  test('the superadmin User Register actions are actually wired up', async () => {
    if (!browserBin) return;
    // Regression guard: the edit/enable/delete buttons were previously rendered
    // in the User Register pane but delegated from a different pane, so they
    // did nothing when clicked.
    currentPage = 'superadmin:user-actions';
    pageErrors.delete(currentPage);
    const probe = await evaluate(`(() => {
      const btn = document.querySelector('.tabs button[data-tab="users"]');
      if (!btn) return { ok: false, why: 'no User Register tab' };
      btn.click();
      return { ok: true };
    })()`);
    assert.ok(probe.ok, probe.why);
    await waitFor(`document.querySelectorAll('#pane-users [data-action]').length > 0`, 'user action buttons');

    const before = await evaluate(`document.querySelectorAll('#user-editor form').length`);
    await evaluate(`document.querySelector('#pane-users [data-action="edit"]').click()`);
    await waitFor(`document.querySelectorAll('#user-editor form').length > ${before}`, 'the edit form to appear');
    const where = await evaluate(`document.querySelector('#user-editor').closest('[role="tabpanel"]').id`);
    assert.equal(where, 'pane-users', 'the editor must render in the pane that triggered it');
  });

  test('an unauthenticated visitor is redirected away from admin pages', async () => {
    if (!browserBin) return;
    currentPage = 'guard';
    pageErrors.delete('guard');
    await signOut();
    await cdp.send('Page.navigate', { url: BASE + '/admin.html' });
    await waitFor(`location.pathname === '/login.html'`, 'admin.html to redirect an anonymous visitor');
    const where = await evaluate('location.pathname');
    assert.equal(where, '/login.html');
  });

  test('a voter cannot reach the admin page', async () => {
    if (!browserBin) return;
    currentPage = 'guard-role';
    pageErrors.delete('guard-role');
    await visit('/login.html', 'guard-role');
    await signIn(fixture.voterEmail, 'VoterPass@123');
    await cdp.send('Page.navigate', { url: BASE + '/admin.html' });
    await wait(1500);
    const where = await evaluate('location.pathname');
    assert.notEqual(where, '/admin.html', 'a voter must not stay on the admin page');
  });
});
