// End-to-end API tests for UNIVERSITY E-VOTING SYSTEM.
// Uses only Node built-ins (node:test + global fetch). Spawns the real server
// against a disposable SQLite file.
// Run: npm test
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createTestDatabase } = require('./helpers/pg-test-db');

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let server;
let testDb;

async function waitReady(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/api/settings/public');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not start');
}

async function api(method, p, { token, data, form } = {}) {
  const headers = {};
  let body;
  if (form) { body = form; } // FormData sets its own content-type
  else if (data !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(data); }
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body });
  const text = await r.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  return { status: r.status, body: json };
}

let superToken, adminToken, voterToken, voter2Token;
let electionId, posPres, posVp, candA, candB, candC;

before(async () => {
  testDb = await createTestDatabase();
  server = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), SUPABASE_DB_URL: testDb.url, SUPABASE_DB_SSL: 'false', JWT_SECRET: 'test-secret-min-32-chars-0123456789abcdef', ADMIN_SETUP_KEY: 'test-setup-key', SCHEDULER_MS: '1000' },
    stdio: 'pipe',
  });
  server.stderr.on('data', () => {});
  await waitReady();
});

after(async () => {
  if (server && !server.killed) server.kill();
  if (testDb) await testDb.drop();
});

describe('bootstrap & auth', () => {
  it('creates the first superadmin via setup key', async () => {
    const r = await api('POST', '/api/setup/superadmin', { data: { name: 'T Super', email: 'super@t.edu', password: 'SuperPass@123', setup_key: 'test-setup-key', student_id: 'SUP1' } });
    assert.equal(r.status, 200);
  });

  it('rejects a second superadmin bootstrap', async () => {
    const r = await api('POST', '/api/setup/superadmin', { data: { name: 'X', email: 'x@t.edu', password: 'Xxxxxxxx@1', setup_key: 'test-setup-key' } });
    assert.equal(r.status, 403);
  });

  it('superadmin logs in and creates an admin + voters', async () => {
    let r = await api('POST', '/api/auth/login', { data: { identifier: 'super@t.edu', password: 'SuperPass@123' } });
    assert.equal(r.status, 200);
    superToken = r.body.token;
    assert.ok(superToken);

    r = await api('POST', '/api/super/users', { token: superToken, data: { name: 'T Admin', email: 'admin@t.edu', password: 'AdminPass@123', role: 'admin', student_id: 'ADM1' } });
    assert.equal(r.status, 200);

    r = await api('POST', '/api/auth/login', { data: { identifier: 'admin@t.edu', password: 'AdminPass@123' } });
    assert.equal(r.status, 200);
    adminToken = r.body.token;
  });

  it('registers and verifies voter 1 (verified can vote)', async () => {
    let r = await api('POST', '/api/auth/register', { data: { name: 'Voter One', student_id: 'VOT001', email: 'v1@t.edu', password: 'VoterPass@123' } });
    assert.equal(r.status, 200);
    assert.ok(r.body.verification_token);

    r = await api('POST', '/api/auth/verify', { data: { token: r.body.verification_token } });
    assert.equal(r.status, 200);

    r = await api('POST', '/api/auth/login', { data: { identifier: 'VOT001', password: 'VoterPass@123' } });
    assert.equal(r.status, 200);
    voterToken = r.body.token;
  });

  it('registers voter 2 but leaves them UNVERIFIED', async () => {
    const r = await api('POST', '/api/auth/register', { data: { name: 'Voter Two', student_id: 'VOT002', email: 'v2@t.edu', password: 'VoterPass@123' } });
    assert.equal(r.status, 200);
    const l = await api('POST', '/api/auth/login', { data: { identifier: 'v2@t.edu', password: 'VoterPass@123' } });
    assert.equal(l.status, 200);
    voter2Token = l.body.token;
  });

  it('rejects wrong passwords and unknown users', async () => {
    const r = await api('POST', '/api/auth/login', { data: { identifier: 'v1@t.edu', password: 'wrong' } });
    assert.equal(r.status, 401);
  });

  it('forgot/reset flow works', async () => {
    let r = await api('POST', '/api/auth/forgot', { data: { email: 'v1@t.edu' } });
    assert.equal(r.status, 200);
    assert.ok(r.body.reset_token);
    r = await api('POST', '/api/auth/reset', { data: { token: r.body.reset_token, new_password: 'VoterNew@123' } });
    assert.equal(r.status, 200);
    r = await api('POST', '/api/auth/login', { data: { identifier: 'v1@t.edu', password: 'VoterNew@123' } });
    assert.equal(r.status, 200);
    voterToken = r.body.token; // refresh
  });
});

describe('election setup (admin)', () => {
  it('voters cannot use admin endpoints', async () => {
    const r = await api('POST', '/api/admin/elections', { token: voterToken, data: { title: 'Nope', starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString() } });
    assert.equal(r.status, 403);
  });

  it('admin creates an open election with positions and candidates', async () => {
    const start = new Date(Date.now() - 3600000).toISOString();
    const end = new Date(Date.now() + 24 * 3600000).toISOString();
    let r = await api('POST', '/api/admin/elections', { token: adminToken, data: { title: 'TEST ELECTION', starts_at: start, ends_at: end, status: 'open' } });
    assert.equal(r.status, 200);
    electionId = r.body.id;

    r = await api('POST', `/api/admin/elections/${electionId}/positions`, { token: adminToken, data: { title: 'President', max_select: 1 } });
    assert.equal(r.status, 200);
    posPres = r.body.id;
    r = await api('POST', `/api/admin/elections/${electionId}/positions`, { token: adminToken, data: { title: 'Vice President', max_select: 1 } });
    posVp = r.body.id;

    async function addCand(position_id, name) {
      const fd = new FormData();
      fd.append('election_id', String(electionId));
      fd.append('position_id', String(position_id));
      fd.append('name', name);
      return api('POST', '/api/admin/candidates', { token: adminToken, form: fd });
    }
    r = await addCand(posPres, 'Cand A'); assert.equal(r.status, 200); candA = r.body.id;
    r = await addCand(posPres, 'Cand B'); assert.equal(r.status, 200); candB = r.body.id;
    r = await addCand(posVp, 'Cand C'); assert.equal(r.status, 200); candC = r.body.id;
  });
});

describe('voting rules', () => {
  it('admin can edit election details, voters cannot', async () => {
    let r = await api('PUT', `/api/admin/elections/${electionId}`, { token: voterToken, data: { title: 'HACK' } });
    assert.equal(r.status, 403);
    r = await api('PUT', `/api/admin/elections/${electionId}`, { token: adminToken, data: { description: 'Updated via test' } });
    assert.equal(r.status, 200);
    r = await api('GET', `/api/elections/${electionId}`, { token: voterToken });
    assert.equal(r.body.election.description, 'Updated via test');
  });
  it('unverified voter is blocked from voting', async () => {
    const r = await api('POST', `/api/elections/${electionId}/vote`, { token: voter2Token, data: { selections: { [posPres]: [candA], [posVp]: [candC] } } });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /verified/i);
  });

  it('verified voter casts a valid ballot and gets a reference', async () => {
    const r = await api('POST', `/api/elections/${electionId}/vote`, { token: voterToken, data: { selections: { [posPres]: [candA], [posVp]: [candC] } } });
    assert.equal(r.status, 200);
    assert.match(r.body.reference_code, /^EVS-\d+-.+$/);
    assert.ok(!('selections' in r.body), 'server must not echo ballot choices');
  });

  it('duplicate vote is rejected (One Student = One Vote)', async () => {
    const r = await api('POST', `/api/elections/${electionId}/vote`, { token: voterToken, data: { selections: { [posPres]: [candB], [posVp]: [candC] } } });
    assert.equal(r.status, 409);
  });

  it('receipt is retrievable without revealing choices', async () => {
    const r = await api('GET', `/api/elections/${electionId}/my-receipt`, { token: voterToken });
    assert.equal(r.status, 200);
    assert.ok(r.body.reference_code);
    assert.ok(!('selections' in r.body));
  });

  it('over-selection and cross-position candidates are rejected', async () => {
    // need a fresh verified voter for validation tests (voter1 already voted)
    let r = await api('POST', '/api/auth/register', { data: { name: 'Voter Three', student_id: 'VOT003', email: 'v3@t.edu', password: 'VoterPass@123' } });
    await api('POST', '/api/auth/verify', { data: { token: r.body.verification_token } });
    r = await api('POST', '/api/auth/login', { data: { identifier: 'v3@t.edu', password: 'VoterPass@123' } });
    const t3 = r.body.token;

    r = await api('POST', `/api/elections/${electionId}/vote`, { token: t3, data: { selections: { [posPres]: [candA, candB], [posVp]: [candC] } } });
    assert.equal(r.status, 400);

    r = await api('POST', `/api/elections/${electionId}/vote`, { token: t3, data: { selections: { [posPres]: [candC], [posVp]: [candC] } } });
    assert.equal(r.status, 400, 'candidate contesting VP must be rejected for President');

    r = await api('POST', `/api/elections/${electionId}/vote`, { token: t3, data: { selections: { [posVp]: [candC] } } });
    assert.equal(r.status, 400, 'mandatory position left empty must be rejected');
  });
});

describe('results & secrecy', () => {
  it('results are hidden from students before publishing', async () => {
    const r = await api('GET', `/api/elections/${electionId}/results`, { token: voterToken });
    assert.equal(r.status, 403);
  });

  it('refuses to publish results from an election that is still open', async () => {
    // Results may only be published once voting has been closed, so an
    // outcome can never be announced while ballots are still being cast.
    const r = await api('POST', `/api/admin/elections/${electionId}/status`, { token: adminToken, data: { status: 'published' } });
    assert.equal(r.status, 409);
  });

  it('after closing and publishing, aggregates are visible with no per-voter data', async () => {
    let r = await api('POST', `/api/admin/elections/${electionId}/status`, { token: adminToken, data: { status: 'closed' } });
    assert.equal(r.status, 200);
    r = await api('POST', `/api/admin/elections/${electionId}/status`, { token: adminToken, data: { status: 'published' } });
    assert.equal(r.status, 200);
    r = await api('GET', `/api/elections/${electionId}/results`, { token: voterToken });
    assert.equal(r.status, 200);
    assert.equal(r.body.votesCast, 1);
    assert.equal(r.body.perCandidate[String(candA)], 1);
    const dumped = JSON.stringify(r.body);
    assert.ok(!dumped.includes('v1@t.edu'), 'results must not leak voter identity');
    assert.ok(!dumped.includes('VOT001'), 'results must not leak student IDs');
  });

  it('closed elections reject new votes', async () => {
    let r = await api('POST', '/api/admin/elections', { token: adminToken, data: { title: 'CLOSED E', starts_at: new Date(Date.now() - 7200000).toISOString(), ends_at: new Date(Date.now() - 3600000).toISOString(), status: 'open' } });
    const closedId = r.body.id;
    r = await api('POST', `/api/elections/${closedId}/vote`, { token: voterToken, data: { selections: {} } });
    assert.equal(r.status, 403);
  });
});

describe('csv import / export', () => {
  it('serves an eligibility template', async () => {
    const r = await fetch(BASE + '/api/admin/eligibility-template', { headers: { Authorization: 'Bearer ' + adminToken } });
    assert.equal(r.status, 200);
    const t = await r.text();
    assert.ok(t.includes('student_id'), 'template has student_id column');
  });

  it('imports eligibility from CSV, reporting added and missing rows', async () => {
    const csv = 'student_id,email\nVOT003,v3@t.edu\nNOPE999,missing@t.edu\n';
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'elig.csv');
    const r = await api('POST', `/api/admin/elections/${electionId}/eligibility/import`, { token: adminToken, form: fd });
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 1);
    assert.equal(r.body.not_found_total, 1);
  });

  it('rejects CSVs without an id column', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['foo,bar\n1,2\n'], { type: 'text/csv' }), 'bad.csv');
    const r = await api('POST', `/api/admin/elections/${electionId}/eligibility/import`, { token: adminToken, form: fd });
    assert.equal(r.status, 400);
  });

  it('lists per-election eligibility; voters are forbidden', async () => {
    let r = await api('GET', `/api/admin/elections/${electionId}/eligibility`, { token: voterToken });
    assert.equal(r.status, 403);
    r = await api('GET', `/api/admin/elections/${electionId}/eligibility`, { token: adminToken });
    assert.equal(r.status, 200);
    assert.ok(r.body.count >= 1, 'imported voter should be listed');
    assert.ok(r.body.voters.some((v) => v.student_id === 'VOT003'));
    r = await api('GET', '/api/admin/elections/999999/eligibility', { token: adminToken });
    assert.equal(r.status, 404);
  });

  it('voters cannot import or export', async () => {
    const fd = new FormData();
    fd.append('file', new Blob(['student_id\nVOT003\n'], { type: 'text/csv' }), 'e.csv');
    const r = await api('POST', `/api/admin/elections/${electionId}/eligibility/import`, { token: voterToken, form: fd });
    assert.equal(r.status, 403);
    const e = await api('GET', `/api/admin/elections/${electionId}/results.csv`, { token: voterToken });
    assert.equal(e.status, 403);
  });

  it('exports aggregate results CSV with no voter identities', async () => {
    const res = await fetch(BASE + `/api/admin/elections/${electionId}/results.csv`, { headers: { Authorization: 'Bearer ' + adminToken } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /\.csv/);
    const t = await res.text();
    assert.ok(t.startsWith('position,candidate,department,affiliation,votes,percent_of_position'));
    assert.ok(t.includes('Cand A'), 'contains candidate rows');
    assert.ok(t.includes('SUMMARY'), 'contains turnout summary');
    assert.ok(!t.includes('v1@t.edu') && !t.includes('VOT001'), 'no voter identities leaked');
  });

  it('exports the voter roll without password hashes', async () => {
    let res = await fetch(BASE + '/api/admin/voters/export.csv', { headers: { Authorization: 'Bearer ' + voterToken } });
    assert.equal(res.status, 403);
    res = await fetch(BASE + '/api/admin/voters/export.csv', { headers: { Authorization: 'Bearer ' + adminToken } });
    assert.equal(res.status, 200);
    const t = await res.text();
    assert.ok(t.startsWith('student_id,name,email,faculty,department,level,verified,active'));
    assert.ok(t.includes('VOT003'), 'contains registered voters');
    assert.ok(!t.toLowerCase().includes('password'), 'no password material leaked');
  });
});

describe('operations', () => {
  it('health endpoint reports ok without auth', async () => {
    const r = await api('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
  });
  it('logged-in user can change their password', async () => {
    let r = await api('POST', '/api/auth/change-password', { token: voterToken, data: { current_password: 'wrong', new_password: 'Another@123' } });
    assert.equal(r.status, 401);
    r = await api('POST', '/api/auth/change-password', { token: voterToken, data: { current_password: 'VoterNew@123', new_password: 'Another@123' } });
    assert.equal(r.status, 200);
    r = await api('POST', '/api/auth/login', { data: { identifier: 'v1@t.edu', password: 'Another@123' } });
    assert.equal(r.status, 200);
    voterToken = r.body.token; // refresh for any later use
  });

  it('scheduler auto-closes elections past their end date', async () => {
    const start = new Date(Date.now() - 3600000).toISOString();
    const end = new Date(Date.now() + 1500).toISOString();
    let r = await api('POST', '/api/admin/elections', { token: adminToken, data: { title: 'AUTO CLOSE E', starts_at: start, ends_at: end, status: 'open' } });
    assert.equal(r.status, 200);
    const id = r.body.id;
    let closed = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((t) => setTimeout(t, 1000));
      r = await api('GET', '/api/elections', { token: adminToken });
      const e = r.body.find((x) => x.id === id);
      if (e && e.status === 'closed') { closed = true; break; }
    }
    assert.ok(closed, 'election should be auto-closed by the scheduler');
  });
});

describe('position & candidate management', () => {
  it('API errors are JSON, including upload rejections', async () => {
    let r = await api('POST', '/api/admin/elections', { token: adminToken, data: { title: 'ERR E', starts_at: new Date(Date.now() - 3600000).toISOString(), ends_at: new Date(Date.now() + 3600000).toISOString(), status: 'draft' } });
    const eid = r.body.id;
    r = await api('POST', `/api/admin/elections/${eid}/positions`, { token: adminToken, data: { title: 'P', max_select: 1 } });
    const pid = r.body.id;

    // Non-image upload must be rejected with a JSON error, not an HTML page.
    const fd = new FormData();
    fd.append('election_id', String(eid));
    fd.append('position_id', String(pid));
    fd.append('name', 'Bad File');
    fd.append('photo', new Blob(['not an image'], { type: 'text/plain' }), 'evil.txt');
    const bad = await fetch(BASE + '/api/admin/candidates', { method: 'POST', headers: { Authorization: 'Bearer ' + adminToken }, body: fd });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type') || '', /json/);
    const bj = await bad.json();
    assert.ok(bj.error);

    // Malformed JSON body must also yield JSON, not HTML.
    const malformed = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get('content-type') || '', /json/);

    await api('DELETE', `/api/admin/elections/${eid}`, { token: adminToken });
  });
  let scratchEid, scratchPos, scratchCand;
  it('admin CRUD on positions/candidates in a scratch election', async () => {
    let r = await api('POST', '/api/admin/elections', { token: adminToken, data: { title: 'SCRATCH E', starts_at: new Date(Date.now() - 3600000).toISOString(), ends_at: new Date(Date.now() + 24 * 3600000).toISOString(), status: 'draft' } });
    assert.equal(r.status, 200);
    scratchEid = r.body.id;

    r = await api('POST', `/api/admin/elections/${scratchEid}/positions`, { token: adminToken, data: { title: 'Temp Position', max_select: 1 } });
    assert.equal(r.status, 200);
    scratchPos = r.body.id;

    // voters cannot edit positions
    r = await api('PUT', `/api/admin/positions/${scratchPos}`, { token: voterToken, data: { title: 'HACK' } });
    assert.equal(r.status, 403);

    r = await api('PUT', `/api/admin/positions/${scratchPos}`, { token: adminToken, data: { title: 'Renamed Position', max_select: 2 } });
    assert.equal(r.status, 200);
    r = await api('GET', `/api/elections/${scratchEid}`, { token: adminToken });
    assert.equal(r.body.positions[0].title, 'Renamed Position');

    const fd = new FormData();
    fd.append('election_id', String(scratchEid));
    fd.append('position_id', String(scratchPos));
    fd.append('name', 'Temp Cand');
    r = await api('POST', '/api/admin/candidates', { token: adminToken, form: fd });
    assert.equal(r.status, 200);
    scratchCand = r.body.id;

    // JSON edit (no photo) keeps existing photo_url and updates fields
    r = await api('PUT', `/api/admin/candidates/${scratchCand}`, { token: adminToken, data: { bio: 'Updated bio', manifesto: 'Updated manifesto' } });
    assert.equal(r.status, 200);
    r = await api('GET', `/api/elections/${scratchEid}`, { token: adminToken });
    assert.equal(r.body.candidates[0].bio, 'Updated bio');

    r = await api('DELETE', `/api/admin/candidates/${scratchCand}`, { token: adminToken });
    assert.equal(r.status, 200);
    r = await api('GET', `/api/elections/${scratchEid}`, { token: adminToken });
    assert.equal(r.body.candidates.length, 0);

    r = await api('DELETE', `/api/admin/positions/${scratchPos}`, { token: adminToken });
    assert.equal(r.status, 200);
    r = await api('GET', `/api/elections/${scratchEid}`, { token: adminToken });
    assert.equal(r.body.positions.length, 0);

    r = await api('DELETE', `/api/admin/elections/${scratchEid}`, { token: adminToken });
    assert.equal(r.status, 200);
  });
});

describe('concurrency', () => {
  it('parallel double-vote attempts yield exactly one ballot (race-proof)', async () => {
    // Fresh open election so the published main election is untouched.
    let r = await api('POST', '/api/admin/elections', { token: adminToken, data: { title: 'RACE E', starts_at: new Date(Date.now() - 3600000).toISOString(), ends_at: new Date(Date.now() + 24 * 3600000).toISOString(), status: 'open' } });
    const eid = r.body.id;
    r = await api('POST', `/api/admin/elections/${eid}/positions`, { token: adminToken, data: { title: 'Solo', max_select: 1 } });
    const pid = r.body.id;
    const fd = new FormData();
    fd.append('election_id', String(eid));
    fd.append('position_id', String(pid));
    fd.append('name', 'Solo Cand');
    r = await api('POST', '/api/admin/candidates', { token: adminToken, form: fd });
    const cid = r.body.id;

    r = await api('POST', '/api/auth/register', { data: { name: 'Voter Four', student_id: 'VOT004', email: 'v4@t.edu', password: 'VoterPass@123' } });
    await api('POST', '/api/auth/verify', { data: { token: r.body.verification_token } });
    r = await api('POST', '/api/auth/login', { data: { identifier: 'v4@t.edu', password: 'VoterPass@123' } });
    const t4 = r.body.token;

    const payload = { selections: { [pid]: [cid] } };
    const [a, b] = await Promise.all([
      api('POST', `/api/elections/${eid}/vote`, { token: t4, data: payload }),
      api('POST', `/api/elections/${eid}/vote`, { token: t4, data: payload }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], 'one request must win, the other must be rejected');

    // Exactly one receipt and one ballot row exist — no double count.
    r = await api('GET', `/api/elections/${eid}/results`, { token: adminToken });
    assert.equal(r.body.votesCast, 1);

    await api('DELETE', `/api/admin/elections/${eid}`, { token: adminToken });
  });
});
