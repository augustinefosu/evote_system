// Demo database seed: demo accounts, a realistic voter roll, the 2026 open
// election and a finished 2025 election with published sample results.
//
// Every cast vote is written exactly the way production records one —
// an anonymous `ballots` row (no voter link) plus a `vote_receipts` row
// (voter + reference only, no choices) — so the demo never compromises
// ballot secrecy and riding every seat works like the real thing.
//
// Postgres is asynchronous, so the whole seed runs inside main(). The logic,
// order and deterministic PRNG are unchanged from the SQLite version, so a
// re-seed reproduces exactly the same names, rolls and results.
const db = require('./db-pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Deterministic PRNG so re-seeding reproduces the same names, rolls and results
// in the same order every time (a demo, not a living system).
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(2025);

// ---------------------------------------------------------------------------
// Demo accounts
// ---------------------------------------------------------------------------
async function ensureUser({ name, student_id, email, role, faculty, department, level, verified, passwordHash }) {
  const ex = await db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
  if (ex) return ex.id;
  // lastInsertRowid is no longer free, the way SQLite's implicit rowid was:
  // Postgres has to be told to hand the generated key back.
  const info = await db.prepare('INSERT INTO users(name,student_id,email,password_hash,role,faculty,department,level,verified) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id')
    .run(name, student_id, email.toLowerCase(), passwordHash, role, faculty || '', department || '', level || '', verified ? 1 : 0);
  return info.lastInsertRowid;
}

const FACULTIES = [
  { name: 'Engineering', departments: [['Computer Engineering', 70], ['Electrical Engineering', 55], ['Mechanical Engineering', 45], ['Civil Engineering', 40]] },
  { name: 'Business School', departments: [['Business Administration', 85], ['Accounting', 75], ['Banking & Finance', 60]] },
  { name: 'Law', departments: [['Law', 150]] },
  { name: 'Social Sciences', departments: [['Economics', 95], ['Sociology', 80], ['Political Science', 75]] },
  { name: 'Science', departments: [['Mathematics', 90], ['Biology', 75], ['Chemistry', 65], ['Physics', 50]] },
  { name: 'Health Sciences', departments: [['Nursing', 55], ['Public Health', 45], ['Pharmacy', 34]] },
];

const GIVEN = ['Kwame', 'Ama', 'Kofi', 'Abena', 'Yaw', 'Efua', 'Kojo', 'Akosua', 'Nana', 'Esi',
  'Kweku', 'Adjoa', 'Fiifi', 'Kwabena', 'Araba', 'Kobina', 'Baaba', 'Ebo', 'Emefa', 'Selassie',
  'Nii', 'Adaeze', 'Kelechi', 'Chidinma', 'Tunde', 'Ayo', 'Gifty', 'Ernestina', 'Lord', 'Bright',
  'Seth', 'Efia', 'Ohemaa', 'Naa', 'Maame', 'Jojo', 'Paa', 'Kwesi', 'Derrick', 'Josephine',
  'Michael', 'Grace', 'Samuel', 'Victoria'];
const SURNAMES = ['Mensah', 'Osei', 'Boateng', 'Owusu', 'Annan', 'Antwi', 'Adjei', 'Quaye', 'Frimpong', 'Asante',
  'Amoah', 'Acheampong', 'Appiah', 'Yeboah', 'Addo', 'Bonsu', 'Tetteh', 'Darko', 'Opoku', 'Adu',
  'Laryea', 'Quartey', 'Nkrumah', 'Danquah', 'Tagoe', 'Amankwah', 'Ofori', 'Sarpong', 'Essien', 'Nyarko',
  'Agyapong', 'Kumi', 'Djangmah', 'Ampofo', 'Crentsil', 'Dodoo', 'Ayensu', 'Antobam', 'Okae', 'Boadu',
  'Poku', 'Owiredu', 'Amankona', 'Tuffour'];

const LEVEL_WEIGHTS = [[100, 0.12], [200, 0.24], [300, 0.31], [400, 0.33]];
function pickLevel() {
  const r = rng();
  let acc = 0;
  for (const [lv, w] of LEVEL_WEIGHTS) { acc += w; if (r <= acc) return String(lv); }
  return '400';
}

async function main() {
  // Every (given, surname) pair is unique, so generated emails are guaranteed
  // unique without an extra existence check per row.
  const fullNames = [];
  for (const g of GIVEN) for (const s of SURNAMES) fullNames.push([g, s]);
  // Shuffle deterministically, then walk the list in order.
  for (let i = fullNames.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [fullNames[i], fullNames[j]] = [fullNames[j], fullNames[i]];
  }

  // The three named demo students share the documented Student@2026 password.
  const demoHash = bcrypt.hashSync('Student@2026', 12);
  const superId = await ensureUser({ name: 'Super Admin', student_id: 'SUPER001', email: 'superadmin@university.edu', role: 'superadmin', verified: 1, passwordHash: bcrypt.hashSync('SuperAdmin@2026', 12) });
  const adminId = await ensureUser({ name: 'Electoral Commissioner', student_id: 'ADMIN001', email: 'admin@university.edu', role: 'admin', verified: 1, passwordHash: bcrypt.hashSync('Admin@2026', 12) });
  const v1 = await ensureUser({ name: 'Ama Serwaa', student_id: 'UEN0012023', email: 'ama.serwaa@student.university.edu', role: 'voter', faculty: 'Engineering', department: 'Computer Engineering', level: '400', verified: 1, passwordHash: demoHash });
  const v2 = await ensureUser({ name: 'Kwame Owusu', student_id: 'UEN0022023', email: 'kwame.owusu@student.university.edu', role: 'voter', faculty: 'Engineering', department: 'Electrical Engineering', level: '300', verified: 1, passwordHash: demoHash });
  // v3 is deliberately un-verified: use it to demonstrate the verification gate.
  const v3 = await ensureUser({ name: 'Efua Agyemang', student_id: 'UBS0032023', email: 'efua@student.university.edu', role: 'voter', faculty: 'Business School', department: 'Business Administration', level: '200', verified: 0, passwordHash: demoHash });

  // -------------------------------------------------------------------------
  // Realistic voter roll
  // -------------------------------------------------------------------------
  // v3 is in the roster list below too (un-verified demonstration account).
  const rosterPlan = []; // { name, email, student_id, faculty, department, level, verified }
  for (const fac of FACULTIES) {
    for (const [dept, count] of fac.departments) {
      for (let i = 0; i < count; i++) {
        const [given, surname] = fullNames.pop();
        rosterPlan.push({
          name: `${given} ${surname}`,
          email: `${given.toLowerCase()}.${surname.toLowerCase()}@student.university.edu`,
          student_id: `UST${1000 + rosterPlan.length + 1}${rng() < 0.5 ? '2023' : '2024'}`,
          faculty: fac.name,
          department: dept,
          level: pickLevel(),
          verified: rng() < 0.96 ? 1 : 0, // a few un-verified accounts so filters have variety
        });
      }
    }
  }

  const rollUserIds = [];
  for (const s of rosterPlan) {
    const id = await ensureUser({ ...s, role: 'voter', passwordHash: demoHash });
    rollUserIds.push(id);
  }

  // -------------------------------------------------------------------------
  // 2026 SRC GENERAL ELECTION (open, matches the "12:00 PM 30 September 2026" demo)
  // -------------------------------------------------------------------------
  let eid;
  const exE = await db.prepare('SELECT id FROM elections WHERE title=?').get('2026 SRC GENERAL ELECTION');
  if (exE) eid = exE.id;
  else {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    const end = new Date('2026-09-30T12:00:00Z').toISOString();
    eid = (await db.prepare('INSERT INTO elections(title,description,instructions,starts_at,ends_at,status,created_by) VALUES(?,?,?,?,?,?,?) RETURNING id').run(
      '2026 SRC GENERAL ELECTION',
      'Official Student Representative Council general election for the 2026 academic year. All verified students are eligible to vote.',
      '1. Verify your identity.\n2. Select ONE candidate per position (unless stated otherwise).\n3. Review your ballot carefully.\n4. Submit — you cannot change your vote after submission.\n5. Save your confirmation reference.',
      start, end, 'open', adminId
    )).lastInsertRowid;
  }

  async function ensurePosition(electionId, title, desc, order) {
    const ex = await db.prepare('SELECT id FROM positions WHERE election_id=? AND title=?').get(electionId, title);
    if (ex) return ex.id;
    return (await db.prepare('INSERT INTO positions(election_id,title,description,max_select,min_select,is_mandatory,sort_order) VALUES(?,?,?,?,?,?,?) RETURNING id')
      .run(electionId, title, desc, 1, 1, 1, order)).lastInsertRowid;
  }
  const pPres = await ensurePosition(eid, 'SRC President', 'Chief representative of all students', 1);
  const pVp = await ensurePosition(eid, 'SRC Vice President', 'Deputy to the President', 2);
  const pSec = await ensurePosition(eid, 'General Secretary', 'Secretariat and records', 3);
  const pTreas = await ensurePosition(eid, 'Treasurer', 'Finance and budgeting', 4);
  const pWelf = await ensurePosition(eid, 'Welfare Officer', 'Student welfare and support', 5);

  async function ensureCandidate(electionId, posId, name, dept, extra = {}) {
    const ex = await db.prepare('SELECT id FROM candidates WHERE election_id=? AND position_id=? AND name=?').get(electionId, posId, name);
    if (ex) return ex.id;
    return (await db.prepare('INSERT INTO candidates(election_id,position_id,name,student_id,department,faculty,level,affiliation,bio,manifesto,photo_url,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id')
      .run(electionId, posId, name, extra.student_id || '', dept, extra.faculty || 'Engineering', extra.level || '400', extra.affiliation || 'Independent',
        extra.bio || `${name} is a dedicated student leader contesting for this position.`,
        extra.manifesto || `My vision: transparent leadership, student welfare first, and accountable representation. Vote ${name} for progress.`, '', 0)).lastInsertRowid;
  }
  await ensureCandidate(eid, pPres, 'John Mensah', 'Computer Engineering', { student_id: 'UEN0102022', level: '400', affiliation: 'Independent', bio: 'John is a 400-level Computer Engineering student, former class representative and debate society president.' });
  await ensureCandidate(eid, pPres, 'Abena Osei', 'Business Administration', { student_id: 'UBS0112022', faculty: 'Business School', level: '300', affiliation: 'Progress Alliance', bio: 'Abena has served on the welfare committee and led campus volunteer programs.' });
  await ensureCandidate(eid, pPres, 'Yaw Boateng', 'Law', { student_id: 'LAW0122022', faculty: 'Law', level: '400', affiliation: 'Unity Front', bio: 'Yaw is a law student passionate about student rights and academic fairness.' });
  await ensureCandidate(eid, pVp, 'Efua Agyemang', 'Accounting', { faculty: 'Business School', level: '200' });
  await ensureCandidate(eid, pVp, 'Kofi Annan Jr', 'Mechanical Engineering', { level: '300' });
  await ensureCandidate(eid, pSec, 'Ama Serwaa', 'Computer Engineering', { level: '400' });
  await ensureCandidate(eid, pSec, 'Kojo Antwi', 'Economics', { faculty: 'Social Sciences', level: '300' });
  await ensureCandidate(eid, pTreas, 'Nana Adjei', 'Accounting', { faculty: 'Business School', level: '300' });
  await ensureCandidate(eid, pTreas, 'Esi Quaye', 'Mathematics', { faculty: 'Science', level: '200' });
  await ensureCandidate(eid, pWelf, 'Akosua Frimpong', 'Nursing', { faculty: 'Health Sciences', level: '300' });
  await ensureCandidate(eid, pWelf, 'Kwame Owusu', 'Electrical Engineering', { level: '300' });

  // Explicit electoral roll for the open election so the admin roll UI,
  // eligibility management and turnout figures are demonstrable from day one.
  const addElig = db.prepare('INSERT INTO voter_eligibility(election_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING');
  const addEligTx = db.transaction(async (ids) => { for (const id of ids) await addElig.run(eid, id); });
  await addEligTx([v1, v2, v3, ...rollUserIds]);

  // -------------------------------------------------------------------------
  // 2025 SRC GENERAL ELECTION — published with sample results
  // -------------------------------------------------------------------------
  const HIST_TITLE = '2025 SRC GENERAL ELECTION';
  const hRollCount = 1120;
  const hTurnout = 836;
  let hid;
  const exH = await db.prepare('SELECT id FROM elections WHERE title=?').get(HIST_TITLE);

  if (exH) {
    hid = exH.id;
  } else {
    hid = (await db.prepare('INSERT INTO elections(title,description,instructions,starts_at,ends_at,status,created_by,published_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id').run(
      HIST_TITLE,
      'Official Student Representative Council general election for the 2025 academic year.',
      '1. Select ONE candidate per position.\n2. Review your ballot.\n3. Submit — one student, one vote.',
      '2025-09-20T08:00:00Z', '2025-10-01T17:00:00Z', 'published', adminId, '2025-10-03T09:30:00Z'
    )).lastInsertRowid;

    const hPos = [
      ['SRC President', 'Chief representative of all students', 1,
        [['Kofi Asante', 'Computer Engineering', { affiliation: 'Independent', bio: 'Two-term faculty representative known for transparent reporting.' }],
         ['Ama Danso', 'Business Administration', { faculty: 'Business School', affiliation: 'Progress Alliance', bio: 'Led the campus entrepreneurship week and welfare drives.' }],
         ['Fiifi Quartey', 'Mathematics', { faculty: 'Science', affiliation: 'Unity Front', bio: 'Science faculty president focused on lab funding and fairness.' }]]],
      ['SRC Vice President', 'Deputy to the President', 2,
        [['Yaw Opoku', 'Mechanical Engineering', { affiliation: 'Independent' }],
         ['Esi Amankwaa', 'Economics', { faculty: 'Social Sciences', affiliation: 'Progress Alliance' }],
         ['Adjoa Sarpong', 'Nursing', { faculty: 'Health Sciences', affiliation: 'Unity Front' }]]],
      ['General Secretary', 'Secretariat and records', 3,
        [['Kofi Antobam', 'Political Science', { faculty: 'Social Sciences', affiliation: 'Independent' }],
         ['Naa Djangmah', 'Law', { faculty: 'Law', affiliation: 'Unity Front' }]]],
      ['Treasurer', 'Finance and budgeting', 4,
        [['Selassie Ampofo', 'Accounting', { faculty: 'Business School', affiliation: 'Progress Alliance' }],
         ['Kobina Dodoo', 'Mathematics', { faculty: 'Science', affiliation: 'Independent' }]]],
      ['Welfare Officer', 'Student welfare and support', 5,
        [['Akosua Asante', 'Nursing', { faculty: 'Health Sciences', affiliation: 'Progress Alliance' }],
         ['Bright Nyarko', 'Sociology', { faculty: 'Social Sciences', affiliation: 'Independent' }],
         ['Maame Opoku', 'Public Health', { faculty: 'Health Sciences', affiliation: 'Unity Front' }]]],
      ['Organising Secretary', 'Events and campaigns', 6,
        [['Kwesi Ayensu', 'Business Administration', { faculty: 'Business School', affiliation: 'Progress Alliance' }],
         ['Jojo Owiredu', 'Computer Engineering', { affiliation: 'Independent' }],
         ['Grace Kumi', 'Biology', { faculty: 'Science', affiliation: 'Unity Front' }]]],
      ['Faculty Representative — Engineering', 'Representative of the Engineering faculty on the SRC', 7,
        [['Derrick Okae', 'Civil Engineering', { affiliation: 'Independent' }],
         ['Victor Tuffour', 'Electrical Engineering', { affiliation: 'Unity Front' }]]],
    ];

    for (const [title, desc, order, cands] of hPos) {
      const pid = await ensurePosition(hid, title, desc, order);
      for (const [name, dept, extra] of cands) {
        await ensureCandidate(hid, pid, name, dept, { ...extra, level: '400' });
      }
    }
  }

  // The named demo students also exist in the generated roster (same email), so
  // dedupe by user id before anything else.
  const allRoll = [...new Set([v1, v2, v3, ...rollUserIds])];
  const shuffled = allRoll.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const roll = shuffled.slice(0, hRollCount);

  // Electoral roll for the historical election.
  const hElig = db.prepare('INSERT INTO voter_eligibility(election_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING');
  const hEligTx = db.transaction(async (ids) => { for (const id of ids) await hElig.run(hid, id); });
  await hEligTx(roll);

  // Ballots and receipts are only written once per election, so re-running the
  // seed on an existing database never fabricates a second set of votes.
  const hReceipts = (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE election_id=?').get(hid)).c;
  const hBallots = (await db.prepare('SELECT COUNT(*) c FROM ballots WHERE election_id=?').get(hid)).c;
  if (hReceipts === 0 && hBallots === 0) {
    const voters = roll.slice(0, hTurnout);
    const hStart = (await db.prepare('SELECT starts_at FROM elections WHERE id=?').get(hid)).starts_at;

    const posRows = await db.prepare('SELECT * FROM positions WHERE election_id=? ORDER BY sort_order').all(hid);
    const candRows = await db.prepare('SELECT * FROM candidates WHERE election_id=?').all(hid);
    // Candidate "strength" weights per position drive a realistic spread.
    const WEIGHTS = {
      'SRC President': [0.48, 0.33, 0.19],
      'SRC Vice President': [0.41, 0.35, 0.24],
      'General Secretary': [0.55, 0.45],
      'Treasurer': [0.58, 0.42],
      'Welfare Officer': [0.44, 0.32, 0.24],
      'Organising Secretary': [0.37, 0.34, 0.29],
      'Faculty Representative — Engineering': [0.62, 0.38],
    };

    const addRec = db.prepare("INSERT INTO vote_receipts(election_id,voter_id,reference_code,created_at) VALUES(?,?,?,?)");
    const addBallot = db.prepare('INSERT INTO ballots(election_id,position_id,candidate_id,is_abstain,created_at) VALUES(?,?,?,?,?)');
    const bake = db.transaction(async (all) => {
      for (const q of all) { await addRec.run(...q.rec); for (const b of q.ballots) await addBallot.run(...b); }
    });

    const day = 24 * 3600 * 1000;
    const startTs = Date.parse(hStart);
    const jobs = [];
    voters.forEach((uid, vi) => {
      const ref = `EVS-2025-${hid}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const castAt = new Date(startTs + ((vi / voters.length) * 11 * day) + Math.floor(rng() * day)).toISOString();
      const ballots = [];
      for (const p of posRows) {
        if (rng() < 0.04) { // a few abstainers per position for the abstention metric
          ballots.push([hid, p.id, null, 1, castAt]);
          continue;
        }
        const inPos = candRows.filter((c) => c.position_id === p.id);
        const w = WEIGHTS[p.title] || inPos.map(() => 1 / inPos.length);
        let r = rng(), k = 0;
        while (k < inPos.length - 1 && r > w[k]) { r -= w[k]; k++; }
        ballots.push([hid, p.id, inPos[k].id, 0, castAt]);
      }
      jobs.push({ rec: [hid, uid, ref, castAt], ballots });
    });
    await bake(jobs);
  }

  // Lifecycle audit trail for the demo election (once).
  const publishedTrail = await db.prepare('SELECT id FROM audit_logs WHERE details LIKE ?').get(`%#${hid} closed -> published%`);
  if (!publishedTrail) {
    const addAudit = db.prepare('INSERT INTO audit_logs(actor_id,action,details,ip,created_at) VALUES(?,?,?,?,?)');
    await addAudit.run(adminId, 'admin.election.created', `"${HIST_TITLE}" created`, '127.0.0.1', '2025-08-12T10:00:00Z');
    await addAudit.run(adminId, 'admin.election_status', `#${hid} draft -> open`, '127.0.0.1', '2025-09-20T07:55:00Z');
    await addAudit.run(adminId, 'admin.election_status', `#${hid} open -> closed`, '127.0.0.1', '2025-10-01T17:05:00Z');
    await addAudit.run(adminId, 'admin.election_status', `#${hid} closed -> published`, '127.0.0.1', '2025-10-03T09:30:00Z');
  }

  // In-app notifications for a subset of the historical roll (once), so the bell
  // menu has realistic content without fabricating thousands of rows.
  const notifCount = (await db.prepare('SELECT COUNT(*) c FROM notifications WHERE election_id=?').get(hid)).c;
  if (notifCount === 0) {
    const addNotif = db.prepare('INSERT INTO notifications(user_id,election_id,type,title,body,channel,status,read_at,created_at,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    const notifBase = new Date('2025-10-03T09:31:00Z');
    for (let i = 0; i < Math.min(40, roll.length); i++) {
      const uid = roll[i];
      const read = rng() < 0.6 ? notifBase.toISOString() : null;
      await addNotif.run(uid, hid, 'results.published', `Results published — ${HIST_TITLE}`,
        `Results for "${HIST_TITLE}" have been published.\n\nView results: ${process.env.APP_URL || 'http://localhost:3000'}/results.html?id=${hid}`,
        'inapp', 'sent', read, notifBase.toISOString(), notifBase.toISOString());
    }
  }

  // -------------------------------------------------------------------------
  console.log('Seed complete.');
  console.log('Elections: 2026 SRC GENERAL ELECTION (open, id ' + eid + '), 2025 SRC GENERAL ELECTION (published, id ' + hid + ').');
  const totals = {
    students: (await db.prepare("SELECT COUNT(*) c FROM users WHERE role='voter'").get()).c,
    eligible2026: (await db.prepare('SELECT COUNT(*) c FROM voter_eligibility WHERE election_id=?').get(eid)).c,
    roll2025: (await db.prepare('SELECT COUNT(*) c FROM voter_eligibility WHERE election_id=?').get(hid)).c,
    ballots2025: (await db.prepare('SELECT COUNT(*) c FROM ballots WHERE election_id=?').get(hid)).c,
    receipts2025: (await db.prepare('SELECT COUNT(*) c FROM vote_receipts WHERE election_id=?').get(hid)).c,
  };
  console.log(`  ${totals.students} registered voters · 2026 roll: ${totals.eligible2026} · 2025 roll: ${totals.roll2025} · 2025 ballots: ${totals.ballots2025} · 2025 receipts: ${totals.receipts2025}`);
  console.log('Demo accounts:');
  console.log('  superadmin@university.edu / SuperAdmin@2026');
  console.log('  admin@university.edu / Admin@2026');
  console.log('  ama.serwaa@student.university.edu / Student@2026 (UEN0012023, verified)');
  console.log('  kwame.owusu@student.university.edu / Student@2026 (UEN0022023, verified)');
  console.log('  efua@student.university.edu / Student@2026 (UBS0032023, NOT verified — try the verify gate)');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
