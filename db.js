// Persistence layer — single-user local app, better-sqlite3 (synchronous).
// The events table is the willfulness chronology: every real-world act
// (mailed, delivered, results, calls) lands here with its real-world date,
// and the litigation memo pleads straight from it.
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT, phone TEXT, phone_alt TEXT, email TEXT,
  dob TEXT, ssn TEXT, former_names TEXT, proof_of_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  bureau TEXT NOT NULL CHECK (bureau IN ('Experian','Equifax','TransUnion')),
  status TEXT NOT NULL DEFAULT 'active',          -- active|complete|litigation
  sol_deadline TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  kind TEXT NOT NULL,                             -- initial_report|results_letter|updated_report
  file_paths TEXT NOT NULL,                       -- JSON array
  report_date TEXT,
  uploaded_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  report_id INTEGER REFERENCES reports(id),
  session_uuid TEXT NOT NULL,                     -- outputs/<uuid>/
  purpose TEXT NOT NULL,                          -- round1_analysis|intake_diff
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  round_number INTEGER NOT NULL CHECK (round_number BETWEEN 1 AND 3),
  status TEXT NOT NULL DEFAULT 'draft',           -- draft|approved|mailed|results_received|closed
  run_id INTEGER REFERENCES runs(id),             -- analysis run whose items this round mails
  mail_date TEXT, delivered_date TEXT,
  tracking_cra TEXT,
  deadline_30 TEXT, deadline_35 TEXT,
  results_received_date TEXT,
  UNIQUE (campaign_id, round_number)
);

CREATE TABLE IF NOT EXISTS account_decisions (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  furnisher_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_number TEXT,
  can_dispute INTEGER,                            -- gate 1: actually wrong, defensible under oath
  thrilled_if_deleted INTEGER,                    -- gate 2
  warning_ack INTEGER DEFAULT 0,
  include_in_letter INTEGER NOT NULL DEFAULT 0,
  UNIQUE (campaign_id, furnisher_name, account_name)
);

CREATE TABLE IF NOT EXISTS violation_items (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),
  furnisher_name TEXT NOT NULL,
  account_name TEXT,
  item_number INTEGER,
  title TEXT, severity TEXT, statute TEXT, issue_type TEXT,
  remedy_type TEXT,
  is_collector INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',            -- open|round1_sent|fixed|deleted|verified_unchanged|round2_sent|round3_sent|escalated
  status_round INTEGER,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
  round_id INTEGER REFERENCES rounds(id),
  type TEXT NOT NULL,   -- report_pulled|analysis_run|letter_approved|mailed|delivered|results_received|call_logged|note|g_request_mailed|escalated
  event_date TEXT NOT NULL,                       -- real-world date, user-entered
  details TEXT,                                   -- JSON
  evidence_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const iso = d => d instanceof Date ? d.toISOString().slice(0, 10) : d;

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d)) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function addYears(dateStr, years) {
  const d = new Date(dateStr + 'T12:00:00');
  if (isNaN(d)) return null;
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

// ─── Clients ─────────────────────────────────────────────────────────────────

const listClients = () => db.prepare('SELECT * FROM clients ORDER BY name').all();
const getClient = id => db.prepare('SELECT * FROM clients WHERE id=?').get(id);
function createClient(c) {
  const r = db.prepare(`INSERT INTO clients (name,address,phone,phone_alt,email,dob,ssn,former_names,proof_of_address)
    VALUES (@name,@address,@phone,@phone_alt,@email,@dob,@ssn,@former_names,@proof_of_address)`)
    .run({ name: c.name, address: c.address || null, phone: c.phone || null, phone_alt: c.phone_alt || null,
      email: c.email || null, dob: c.dob || null, ssn: c.ssn || null,
      former_names: c.former_names || null, proof_of_address: c.proof_of_address || null });
  return getClient(r.lastInsertRowid);
}
function updateClient(id, c) {
  const cur = getClient(id);
  if (!cur) return null;
  const next = { ...cur, ...c, id };
  db.prepare(`UPDATE clients SET name=@name,address=@address,phone=@phone,phone_alt=@phone_alt,email=@email,
    dob=@dob,ssn=@ssn,former_names=@former_names,proof_of_address=@proof_of_address WHERE id=@id`).run(next);
  return getClient(id);
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

const getCampaign = id => db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
function listCampaigns() {
  return db.prepare(`
    SELECT c.*, cl.name AS client_name,
      (SELECT COUNT(*) FROM violation_items vi WHERE vi.campaign_id=c.id) AS item_count,
      (SELECT COUNT(*) FROM violation_items vi WHERE vi.campaign_id=c.id AND vi.status='verified_unchanged') AS verified_count,
      (SELECT MAX(round_number) FROM rounds r WHERE r.campaign_id=c.id) AS latest_round
    FROM campaigns c JOIN clients cl ON cl.id=c.client_id
    ORDER BY c.created_at DESC`).all();
}
function createCampaign({ client_id, bureau }) {
  const r = db.prepare('INSERT INTO campaigns (client_id,bureau) VALUES (?,?)').run(client_id, bureau);
  return getCampaign(r.lastInsertRowid);
}
function campaignDashboard(id) {
  const campaign = getCampaign(id);
  if (!campaign) return null;
  return {
    campaign,
    client: getClient(campaign.client_id),
    rounds: db.prepare('SELECT * FROM rounds WHERE campaign_id=? ORDER BY round_number').all(id),
    events: db.prepare('SELECT * FROM events WHERE campaign_id=? ORDER BY event_date, id').all(id),
    items: db.prepare('SELECT * FROM violation_items WHERE campaign_id=? ORDER BY furnisher_name, item_number').all(id),
    decisions: db.prepare('SELECT * FROM account_decisions WHERE campaign_id=?').all(id),
    runs: db.prepare('SELECT * FROM runs WHERE campaign_id=? ORDER BY created_at').all(id),
    reports: db.prepare('SELECT id, campaign_id, kind, report_date, uploaded_at FROM reports WHERE campaign_id=? ORDER BY uploaded_at').all(id),
  };
}
function deleteCampaign(id) {
  const runs = db.prepare('SELECT session_uuid FROM runs WHERE campaign_id=?').all(id);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM events WHERE campaign_id=?').run(id);
    db.prepare('DELETE FROM violation_items WHERE campaign_id=?').run(id);
    db.prepare('DELETE FROM account_decisions WHERE campaign_id=?').run(id);
    db.prepare('DELETE FROM rounds WHERE campaign_id=?').run(id);
    db.prepare('DELETE FROM runs WHERE campaign_id=?').run(id);
    db.prepare('DELETE FROM reports WHERE campaign_id=?').run(id);
    db.prepare('DELETE FROM campaigns WHERE id=?').run(id);
  });
  tx();
  // Caller removes the files (outputs/<uuid> dirs + data/files/<id>).
  return runs.map(r => r.session_uuid);
}
const setCampaignStatus = (id, status) => db.prepare('UPDATE campaigns SET status=? WHERE id=?').run(status, id);
const setSolDeadline = (id, date) => db.prepare('UPDATE campaigns SET sol_deadline=? WHERE id=? AND sol_deadline IS NULL').run(date, id);

// ─── Reports / Runs ──────────────────────────────────────────────────────────

function createReport({ campaign_id, kind, file_paths, report_date }) {
  const r = db.prepare('INSERT INTO reports (campaign_id,kind,file_paths,report_date) VALUES (?,?,?,?)')
    .run(campaign_id, kind, JSON.stringify(file_paths || []), report_date || null);
  return r.lastInsertRowid;
}
function createRun({ campaign_id, report_id, session_uuid, purpose }) {
  const r = db.prepare('INSERT INTO runs (campaign_id,report_id,session_uuid,purpose) VALUES (?,?,?,?)')
    .run(campaign_id, report_id || null, session_uuid, purpose);
  return r.lastInsertRowid;
}
const getRun = id => db.prepare('SELECT * FROM runs WHERE id=?').get(id);
const listRunUuids = () => db.prepare('SELECT session_uuid FROM runs').all().map(r => r.session_uuid);

// ─── Rounds ──────────────────────────────────────────────────────────────────

const getRound = id => db.prepare('SELECT * FROM rounds WHERE id=?').get(id);
function createRound({ campaign_id, round_number, run_id }) {
  const r = db.prepare('INSERT INTO rounds (campaign_id,round_number,run_id) VALUES (?,?,?)')
    .run(campaign_id, round_number, run_id || null);
  return getRound(r.lastInsertRowid);
}
// PATCH semantics: each date field set here also computes deadlines and logs
// the matching chronology event.
function updateRound(id, patch, evidence_path) {
  const round = getRound(id);
  if (!round) return null;
  const fields = {};
  const events = [];

  if (patch.status) fields.status = patch.status;
  if (patch.mail_date) {
    fields.mail_date = iso(patch.mail_date);
    fields.status = 'mailed';
    // Fallback clock: mail + 5-day forwarding cushion + 30 days.
    fields.deadline_30 = addDays(fields.mail_date, 35);
    fields.deadline_35 = addDays(fields.mail_date, 40);
    events.push({ type: 'mailed', event_date: fields.mail_date, details: { tracking_cra: patch.tracking_cra || round.tracking_cra || null } });
  }
  if (patch.tracking_cra) fields.tracking_cra = patch.tracking_cra;
  if (patch.delivered_date) {
    fields.delivered_date = iso(patch.delivered_date);
    // Real clock: 30 days from CRA receipt.
    fields.deadline_30 = addDays(fields.delivered_date, 30);
    fields.deadline_35 = addDays(fields.delivered_date, 35);
    events.push({ type: 'delivered', event_date: fields.delivered_date, details: { tracking_cra: patch.tracking_cra || round.tracking_cra || null } });
  }
  if (patch.results_received_date) {
    fields.results_received_date = iso(patch.results_received_date);
    fields.status = 'results_received';
    events.push({ type: 'results_received', event_date: fields.results_received_date, details: {} });
  }

  const keys = Object.keys(fields);
  if (keys.length > 0) {
    db.prepare(`UPDATE rounds SET ${keys.map(k => `${k}=@${k}`).join(',')} WHERE id=@id`).run({ ...fields, id });
  }
  for (const e of events) {
    addEvent({ campaign_id: round.campaign_id, round_id: id, type: e.type, event_date: e.event_date, details: e.details, evidence_path: evidence_path || null });
  }
  // SOL: 2 years from first results-of-investigation (practical trigger).
  if (patch.results_received_date) {
    setSolDeadline(round.campaign_id, addYears(iso(patch.results_received_date), 2));
  }
  return getRound(id);
}

// ─── Account decisions (Watts gates) ─────────────────────────────────────────

function upsertDecision(d) {
  db.prepare(`INSERT INTO account_decisions (campaign_id,furnisher_name,account_name,account_number,can_dispute,thrilled_if_deleted,warning_ack,include_in_letter)
    VALUES (@campaign_id,@furnisher_name,@account_name,@account_number,@can_dispute,@thrilled_if_deleted,@warning_ack,@include_in_letter)
    ON CONFLICT (campaign_id,furnisher_name,account_name) DO UPDATE SET
      can_dispute=excluded.can_dispute, thrilled_if_deleted=excluded.thrilled_if_deleted,
      warning_ack=excluded.warning_ack, include_in_letter=excluded.include_in_letter`)
    .run({ account_number: null, can_dispute: null, thrilled_if_deleted: null, warning_ack: 0, include_in_letter: 0, ...d });
}
const getDecisions = campaign_id => db.prepare('SELECT * FROM account_decisions WHERE campaign_id=?').all(campaign_id);

// ─── Violation items ─────────────────────────────────────────────────────────

function insertViolationItems(campaign_id, run_id, violationsData) {
  const stmt = db.prepare(`INSERT INTO violation_items
    (campaign_id,run_id,furnisher_name,account_name,item_number,title,severity,statute,issue_type,remedy_type,is_collector,detail_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    let itemNo = 0;
    for (const f of (violationsData.furnishers || [])) {
      for (const v of (f.violations || [])) {
        itemNo++;
        stmt.run(campaign_id, run_id, f.name, v.accountName || null, itemNo,
          v.title || null, v.severity || null, v.statute || null, v.issueType || null,
          v.remedyType || null, f.isCollector === true ? 1 : 0, JSON.stringify(v));
      }
    }
    return itemNo;
  });
  return tx();
}
const getItems = campaign_id => db.prepare('SELECT * FROM violation_items WHERE campaign_id=? ORDER BY furnisher_name, item_number').all(campaign_id);
function setItemStatus(id, status, status_round) {
  db.prepare('UPDATE violation_items SET status=?, status_round=? WHERE id=?').run(status, status_round || null, id);
}
function setItemsStatusByRun(run_id, fromStatus, toStatus, status_round) {
  db.prepare('UPDATE violation_items SET status=?, status_round=? WHERE run_id=? AND status=?')
    .run(toStatus, status_round || null, run_id, fromStatus);
}

// ─── Events (the chronology) ─────────────────────────────────────────────────

function addEvent({ campaign_id, round_id, type, event_date, details, evidence_path }) {
  const r = db.prepare('INSERT INTO events (campaign_id,round_id,type,event_date,details,evidence_path) VALUES (?,?,?,?,?,?)')
    .run(campaign_id, round_id || null, type, iso(event_date),
      details == null ? null : (typeof details === 'string' ? details : JSON.stringify(details)),
      evidence_path || null);
  return db.prepare('SELECT * FROM events WHERE id=?').get(r.lastInsertRowid);
}
const getEvents = campaign_id => db.prepare('SELECT * FROM events WHERE campaign_id=? ORDER BY event_date, id').all(campaign_id);

module.exports = {
  db, addDays, addYears,
  listClients, getClient, createClient, updateClient,
  listCampaigns, getCampaign, createCampaign, campaignDashboard, deleteCampaign, setCampaignStatus, setSolDeadline,
  createReport, createRun, getRun, listRunUuids,
  getRound, createRound, updateRound,
  upsertDecision, getDecisions,
  insertViolationItems, getItems, setItemStatus, setItemsStatusByRun,
  addEvent, getEvents,
  DATA_DIR,
};
