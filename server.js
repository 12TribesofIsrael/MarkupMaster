require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const archiver = require('archiver');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const cookieParser = require('cookie-parser');
const { generateWattsLetterDocx, generateLitigationMemoDocx, generateFileDisclosureDocx, generateMailingInstructionsDocx, generateMarkupMapDocx, generateResultsDiffDocx, generateMovLetterDocx } = require('./docx-generator');
const { annotateCreditReportPdf, annotateImageSnapshot, annotateImageSnapshotOcr, refineSnapshotBoxes } = require('./pdf-annotator');
const store = require('./db');

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Serve static frontend ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// ─── PIN gate ─────────────────────────────────────────────────────────────────
// Everything except the static shell and /login requires the PIN cookie when
// APP_PIN is set. Reports, letters, and the DB hold consumer PII.
const APP_PIN = process.env.APP_PIN || '';
const pinToken = APP_PIN ? crypto.createHmac('sha256', APP_PIN).update('markupmaster-auth').digest('hex') : null;

app.post('/login', (req, res) => {
  if (!APP_PIN) return res.json({ ok: true, pinless: true });
  if (String((req.body || {}).pin) === APP_PIN) {
    res.cookie('mm_auth', pinToken, { httpOnly: true, sameSite: 'strict' });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong PIN.' });
});

function requirePin(req, res, next) {
  if (!APP_PIN) return next();
  if (req.cookies && req.cookies.mm_auth === pinToken) return next();
  res.status(401).json({ error: 'PIN required. POST /login with {"pin": "..."}.' });
}

// ─── Multer setup ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.sessionId || (req.sessionId = uuidv4());
    const dir = path.join(__dirname, 'uploads', sessionId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|pdf)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only JPG, PNG, and PDF files allowed'), ok);
  },
});

// ─── Load knowledge files at startup ─────────────────────────────────────────
let SYSTEM_PROMPT = '';

async function loadKnowledge() {
  const knowledgeDir = path.join(__dirname, 'docs');
  const files = fs.readdirSync(knowledgeDir);
  const parts = [];

  for (const file of files) {
    // Skip non-knowledge files and subdirectories
    if (file === 'CLAUDE.md' || file === 'prompt' || file === 'failed') continue;
    if (!fs.statSync(path.join(knowledgeDir, file)).isFile()) continue;

    const filePath = path.join(knowledgeDir, file);
    const ext = path.extname(file).toLowerCase();
    let text = '';

    try {
      if (['.md', '.txt', '.html'].includes(ext)) {
        text = fs.readFileSync(filePath, 'utf8');
      } else if (ext === '.pdf') {
        const buffer = fs.readFileSync(filePath);
        const parsed = await pdfParse(buffer);
        text = parsed.text;
      } else if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: filePath });
        text = result.value;
      }

      if (text.trim()) {
        // Cap large files to keep total system prompt under model token limit
        const MAX_FILE_CHARS = 40000;
        const truncated = text.length > MAX_FILE_CHARS
          ? text.slice(0, MAX_FILE_CHARS) + `\n\n[... truncated at ${MAX_FILE_CHARS} chars ...]`
          : text;
        parts.push(`\n\n${'='.repeat(60)}\nFILE: ${file}\n${'='.repeat(60)}\n${truncated}`);
      }
    } catch (err) {
      console.warn(`Warning: Could not load ${file}:`, err.message);
    }
  }

  SYSTEM_PROMPT = parts.join('\n');
  console.log(`Loaded ${parts.length} knowledge files into system prompt (${Math.round(SYSTEM_PROMPT.length / 1000)}k chars)`);
}

// ─── Anthropic client ─────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Stream a completion with the shared system prompt. Sonnet supports up to
// 64K output tokens but requires streaming at that size; when a big report
// exceeds the ceiling, feed the partial text back as an assistant prefill so
// the model continues exactly where it stopped, and stitch the rounds.
async function callClaude(userContentBlocks, sessionId) {
  const baseMessages = [{ role: 'user', content: userContentBlocks }];
  const MAX_CONTINUATIONS = 3;
  let responseText = '';
  for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
    // The API rejects assistant prefill ending in whitespace — trim before resuming.
    responseText = responseText.replace(/\s+$/, '');
    const messages = responseText
      ? [...baseMessages, { role: 'assistant', content: responseText }]
      : baseMessages;
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 64000,
      system: SYSTEM_PROMPT,
      messages,
    });
    const response = await stream.finalMessage();
    const textBlock = response.content.find((b) => b.type === 'text');
    responseText += textBlock ? textBlock.text : '';
    console.log(`[${sessionId}] Claude round ${round + 1}: ${Math.round(responseText.length / 1000)}k chars total, stop_reason=${response.stop_reason}`);
    if (response.stop_reason !== 'max_tokens') break;
    console.warn(`[${sessionId}] Hit max_tokens — requesting continuation ${round + 1}/${MAX_CONTINUATIONS}...`);
  }
  return responseText;
}

// Extract a tagged JSON block from a model response, tolerating truncation.
function extractTaggedJson(responseText, tag, sessionId) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = responseText.match(re);
  let jsonText = m ? m[1] : null;
  if (!jsonText) {
    const openIdx = responseText.indexOf(`<${tag}>`);
    if (openIdx !== -1) {
      console.warn(`[${sessionId}] Closing ${tag} tag missing — attempting truncated-JSON salvage.`);
      jsonText = responseText.slice(openIdx + tag.length + 2);
    }
  }
  if (!jsonText) return null;
  try { return JSON.parse(jsonText.trim()); }
  catch (e) {
    const repaired = repairTruncatedJson(jsonText);
    if (repaired) console.warn(`[${sessionId}] Recovered ${tag} via truncation repair.`);
    else console.warn(`[${sessionId}] ${tag} parse failed even after repair:`, e.message);
    return repaired;
  }
}

// ─── Truncated-JSON salvage ───────────────────────────────────────────────────
// Returns the closing brackets needed to balance `s`, or null if `s` ends inside a string.
function unclosedBrackets(s) {
  const stack = [];
  let inString = false, escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (inString) return null;
  return stack.reverse().map((ch) => (ch === '{' ? '}' : ']')).join('');
}

// Repair JSON cut off mid-generation: walk back to the last complete object
// boundary, then close every bracket still open at that point. The tail past
// the last complete violation/account is lost; everything before it survives.
function repairTruncatedJson(text) {
  const s = text.trim();
  for (let end = s.length; end > 0;) {
    const idx = s.lastIndexOf('}', end - 1);
    if (idx === -1) return null;
    const candidate = s.slice(0, idx + 1);
    const closers = unclosedBrackets(candidate);
    if (closers !== null) {
      try { return JSON.parse(candidate + closers); } catch { /* walk further back */ }
    }
    end = idx;
  }
  return null;
}

// ─── Campaign / client REST API ──────────────────────────────────────────────

app.get('/api/clients', requirePin, (req, res) => res.json(store.listClients()));
app.post('/api/clients', requirePin, (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Client name is required.' });
  res.json(store.createClient(b));
});
app.patch('/api/clients/:id', requirePin, (req, res) => {
  const c = store.updateClient(Number(req.params.id), req.body || {});
  if (!c) return res.status(404).json({ error: 'Client not found.' });
  res.json(c);
});

app.get('/api/campaigns', requirePin, (req, res) => res.json(store.listCampaigns()));
app.post('/api/campaigns', requirePin, (req, res) => {
  const { client_id, bureau } = req.body || {};
  if (!store.getClient(Number(client_id))) return res.status(400).json({ error: 'Unknown client_id.' });
  if (!['Experian', 'Equifax', 'TransUnion'].includes(bureau)) return res.status(400).json({ error: 'bureau must be Experian, Equifax, or TransUnion.' });
  res.json(store.createCampaign({ client_id: Number(client_id), bureau }));
});
app.get('/api/campaigns/:id', requirePin, (req, res) => {
  const dash = store.campaignDashboard(Number(req.params.id));
  if (!dash) return res.status(404).json({ error: 'Campaign not found.' });
  res.json(dash);
});
app.delete('/api/campaigns/:id', requirePin, (req, res) => {
  const id = Number(req.params.id);
  if (!store.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });
  const uuids = store.deleteCampaign(id);
  for (const u of uuids) fs.rmSync(path.join(__dirname, 'outputs', path.basename(u)), { recursive: true, force: true });
  fs.rmSync(path.join(store.DATA_DIR, 'files', String(id)), { recursive: true, force: true });
  res.json({ ok: true, removedRuns: uuids.length });
});

app.post('/api/campaigns/:id/events', requirePin, (req, res) => {
  const id = Number(req.params.id);
  if (!store.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });
  const { type, event_date, details, round_id, evidence_path } = req.body || {};
  if (!type || !event_date) return res.status(400).json({ error: 'type and event_date are required.' });
  res.json(store.addEvent({ campaign_id: id, round_id, type, event_date, details, evidence_path }));
});

app.patch('/api/rounds/:id', requirePin, (req, res) => {
  const round = store.updateRound(Number(req.params.id), req.body || {}, (req.body || {}).evidence_path);
  if (!round) return res.status(404).json({ error: 'Round not found.' });
  // Mailing a round marks its open items as sent — but only items on accounts
  // the consumer actually approved into the letter (account_decisions); items
  // gated out stay open. Rounds 2/3 also re-send the items the bureau
  // previously verified without fixing.
  if ((req.body || {}).mail_date && round.run_id) {
    const sent = `round${round.round_number}_sent`;
    const included = store.getDecisions(round.campaign_id).filter(d => d.include_in_letter);
    if (included.length > 0) {
      const stmt = store.db.prepare(`UPDATE violation_items SET status=?, status_round=?
        WHERE run_id=? AND status='open' AND furnisher_name=? AND (account_name=? OR account_name IS NULL)`);
      for (const d of included) stmt.run(sent, round.round_number, round.run_id, d.furnisher_name, d.account_name);
    } else {
      // No recorded gate decisions (quick/legacy flow) — treat all as sent.
      store.setItemsStatusByRun(round.run_id, 'open', sent, round.round_number);
    }
    if (round.round_number >= 2) {
      store.db.prepare(`UPDATE violation_items SET status=?, status_round=? WHERE campaign_id=? AND status='verified_unchanged'`)
        .run(sent, round.round_number, round.campaign_id);
    }
  }
  res.json(round);
});

app.post('/api/campaigns/:id/decisions', requirePin, (req, res) => {
  const id = Number(req.params.id);
  if (!store.getCampaign(id)) return res.status(404).json({ error: 'Campaign not found.' });
  const decisions = Array.isArray(req.body) ? req.body : [req.body];
  for (const d of decisions) {
    if (!d.furnisher_name || !d.account_name) return res.status(400).json({ error: 'furnisher_name and account_name required.' });
    store.upsertDecision({ ...d, campaign_id: id });
  }
  res.json(store.getDecisions(id));
});

// ─── Run violations: fetch / edit / regenerate ───────────────────────────────

// Watts "should we dispute" warnings — accounts the consumer may not want to
// poke. Computed per account; each warning must be acknowledged in the UI.
function computeWarnings(violationsData) {
  const out = [];
  const num = s => parseFloat(String(s || '').replace(/[^0-9.]/g, '')) || 0;
  for (const f of (violationsData.furnishers || [])) {
    for (const a of (f.accounts || [])) {
      const warnings = [];
      const isCollection = f.isCollector === true
        || /collection/i.test(String(a.accountType || '')) || /collection/i.test(String(a.status || ''));
      if (isCollection && num(a.balance) > 0) {
        warnings.push('Unpaid collection: disputing can put this debt back on the collector\'s radar. If your state\'s statute of limitations on the debt is still running, think hard before drawing attention — check your state\'s SOL first.');
      }
      const dofdYear = (String(a.dofd || '').match(/(19|20)\d{2}/) || [])[0];
      if (dofdYear && (new Date().getFullYear() - Number(dofdYear)) >= 6) {
        warnings.push('The first delinquency is over 6 years old — this item may age off your report on its own soon. Weigh whether disputing is worth waking it up.');
      }
      if (warnings.length > 0) out.push({ furnisher: f.name, account: a.accountName, warnings });
    }
  }
  return out;
}

function runViolationsPath(run) {
  return path.join(__dirname, 'outputs', path.basename(run.session_uuid), 'violations_data.json');
}

// Everything the litigation memo needs from campaign tracking.
function memoContextFor(campaignId) {
  const campaign = store.getCampaign(campaignId);
  const itemStatuses = {};
  for (const i of store.getItems(campaignId)) {
    itemStatuses[`${i.furnisher_name}||${i.account_name || ''}||${i.title || ''}`] = i.status;
  }
  return { events: store.getEvents(campaignId), solDeadline: campaign ? campaign.sol_deadline : null, itemStatuses };
}

app.get('/api/runs/:id/violations', requirePin, (req, res) => {
  const run = store.getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  const p = runViolationsPath(run);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Violations data missing for this run.' });
  const violationsData = JSON.parse(fs.readFileSync(p, 'utf8'));
  res.json({ run, violationsData, warnings: computeWarnings(violationsData) });
});

app.patch('/api/runs/:id/violations', requirePin, (req, res) => {
  const run = store.getRun(Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found.' });
  const data = (req.body || {}).violationsData;
  if (!data || !Array.isArray(data.furnishers)) return res.status(400).json({ error: 'violationsData with furnishers[] required.' });
  fs.writeFileSync(runViolationsPath(run), JSON.stringify(data, null, 2), 'utf8');
  res.json({ ok: true });
});

// Approve a round: regenerate the final letter set from the (possibly edited)
// violations JSON, restricted to the accounts the consumer approved, dated
// with the real mail date. Letters are never final without this step.
app.post('/api/rounds/:id/generate', requirePin, async (req, res) => {
  try {
    const round = store.getRound(Number(req.params.id));
    if (!round) return res.status(404).json({ error: 'Round not found.' });
    const run = store.getRun(round.run_id);
    if (!run) return res.status(400).json({ error: 'Round has no analysis run.' });
    const p = runViolationsPath(run);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Violations data missing for this run.' });

    const full = JSON.parse(fs.readFileSync(p, 'utf8'));
    const { mailDate, includedAccounts } = req.body || {};

    // Restrict to approved accounts when a selection is provided.
    let data = full;
    if (Array.isArray(includedAccounts)) {
      const keep = new Set(includedAccounts.map(x => `${x.furnisher}||${x.account}`));
      data = {
        ...full,
        furnishers: full.furnishers.map(f => ({
          ...f,
          accounts: (f.accounts || []).filter(a => keep.has(`${f.name}||${a.accountName}`)),
          violations: (f.violations || []).filter(v => keep.has(`${f.name}||${v.accountName}`)),
        })).filter(f => (f.violations || []).length > 0),
      };
      if (data.furnishers.length === 0) return res.status(400).json({ error: 'No accounts selected — nothing to generate.' });
    }

    const campaign = store.getCampaign(round.campaign_id);
    const client = campaign ? store.getClient(campaign.client_id) : null;
    const clientIdentity = client ? {
      phone: client.phone || '', phone2: client.phone_alt || '', email: client.email || '',
      dob: client.dob || '', ssn: client.ssn || '', formerNames: client.former_names || '',
      proofOfAddress: client.proof_of_address || '',
    } : {};

    // Round 2/3: recite the prior round's real dates and tracking.
    let prior = {};
    if (round.round_number >= 2) {
      const prev = store.db.prepare('SELECT * FROM rounds WHERE campaign_id=? AND round_number=?')
        .get(round.campaign_id, round.round_number - 1);
      if (prev) prior = { mailDate: prev.mail_date, tracking: prev.tracking_cra, deliveredDate: prev.delivered_date };
    }

    const outputDir = path.join(__dirname, 'outputs', path.basename(run.session_uuid));
    const options = { round: round.round_number, mailDate: mailDate || undefined, prior };

    await generateWattsLetterDocx(data, clientIdentity, options, path.join(outputDir, 'Dispute_Letter.docx'));
    await generateLitigationMemoDocx(data, memoContextFor(round.campaign_id),
      path.join(outputDir, 'Litigation_Memo.docx'), path.join(outputDir, 'litigation_memo.json'));
    await generateMarkupMapDocx(data, path.join(outputDir, 'Markup_Map.docx'));
    if (round.round_number === 1) {
      await generateFileDisclosureDocx(data.consumer, clientIdentity, path.join(outputDir, 'Full_File_Request.docx'));
    }
    await generateMailingInstructionsDocx(data, path.join(outputDir, 'Mailing_Instructions.docx'));

    // Rebuild the ZIP from everything in the session dir (except the zip itself).
    const zipPath = path.join(outputDir, 'BMB_Dispute_Package.zip');
    const all = fs.readdirSync(outputDir)
      .filter(n => n !== 'BMB_Dispute_Package.zip' && n !== 'raw_response.txt')
      .map(n => path.join(outputDir, n));
    await zipFiles(all, zipPath, outputDir);

    store.db.prepare('UPDATE rounds SET status=? WHERE id=?').run('approved', round.id);
    store.addEvent({
      campaign_id: round.campaign_id, round_id: round.id, type: 'letter_approved',
      event_date: new Date().toISOString().slice(0, 10),
      details: { round: round.round_number, accounts: includedAccounts || 'all' },
    });

    const names = ['Dispute_Letter.docx', 'Litigation_Memo.docx', 'Markup_Map.docx', 'Mailing_Instructions.docx', 'BMB_Dispute_Package.zip']
      .concat(round.round_number === 1 ? ['Full_File_Request.docx'] : []);
    res.json({
      ok: true, round: store.getRound(round.id),
      files: names.filter(n => fs.existsSync(path.join(outputDir, n)))
        .map(n => ({ name: n, url: `/download/${run.session_uuid}/${n}` })),
    });
  } catch (err) {
    console.error('generate failed:', err);
    res.status(500).json({ error: err.message || 'Generation failed.' });
  }
});

// ─── Response intake: results letter + fresh report → item-by-item outcomes ──

function buildIntakePrompt(priorItems) {
  return `COMPARE THE ATTACHED DOCUMENTS AGAINST THE CONSUMER'S PRIOR DISPUTE ITEMS.

The attachments are the credit bureau's results-of-investigation letter and/or a fresh copy of the
consumer's credit report, received AFTER the dispute below was investigated.

PRIOR DISPUTED ITEMS (JSON):
${JSON.stringify(priorItems, null, 1)}

For EVERY prior item, decide the outcome:
- "fixed" — the results letter or the fresh report shows the specific defect was corrected
- "deleted" — the account/tradeline no longer appears on the fresh report, or the results say deleted
- "verified_unchanged" — the bureau says verified/accurate AND/OR the same defect is still visible unchanged
- "unclear" — the attached documents do not show the outcome for this item

GROUNDING RULES (violation of these is failure):
1. Base every outcome ONLY on what you can literally read in the attachments. Never guess.
2. For every outcome except "unclear", quote the exact sentence, field, or value that proves it
   ("evidenceQuote") and, for "fixed", the new value ("newValue").
3. When in doubt, use "unclear". An "unclear" is always better than a wrong classification.
4. There is NO required distribution of outcomes. All-verified, all-fixed, and any mix are all valid results.

Also list any NEW violations the changes introduced (e.g. a "correction" that created a new
contradiction) under "newViolations", using the SAME violation object schema as the original
analysis (accountName, title, severity, statute, issueType, reportShows, shouldShow, description,
impact, precedent, demand, disputeWording, remedyType, remedyWording, internalContradiction, markup).
Also include a "furnisher" field on each new violation naming the furnisher exactly. Only report
clear, literally-readable defects — an empty list is a valid result.

CRITICAL OUTPUT RULE: Your ENTIRE response must be ONLY the <INTAKE_JSON>...</INTAKE_JSON> block:
<INTAKE_JSON>
{
  "outcomes": [ { "item": 1, "outcome": "fixed|deleted|verified_unchanged|unclear", "newValue": "... or null", "evidenceQuote": "... or null" } ],
  "newViolations": []
}
</INTAKE_JSON>`;
}

app.post('/api/campaigns/:id/intake', requirePin, (req, res, next) => {
  req.sessionId = uuidv4();
  next();
}, upload.array('files', 10), async (req, res) => {
  const sessionId = req.sessionId;
  try {
    const campaignId = Number(req.params.id);
    const campaign = store.getCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'Upload the results letter and/or the fresh report.' });

    // Target = latest mailed round still waiting on results.
    const round = store.db.prepare(
      `SELECT * FROM rounds WHERE campaign_id=? AND mail_date IS NOT NULL AND results_received_date IS NULL
       ORDER BY round_number DESC LIMIT 1`).get(campaignId);
    if (!round) return res.status(400).json({ error: 'No mailed round is waiting on results. Enter the mail date on the round first.' });

    const pendingStatuses = ['open', 'round1_sent', 'round2_sent', 'round3_sent', 'verified_unchanged'];
    const items = store.getItems(campaignId).filter(i => i.run_id === round.run_id || pendingStatuses.includes(i.status));
    const pending = items.filter(i => pendingStatuses.includes(i.status));
    if (pending.length === 0) return res.status(400).json({ error: 'No pending items to compare.' });

    const priorItems = pending.map(i => {
      const d = JSON.parse(i.detail_json || '{}');
      return {
        item: i.item_number, furnisher: i.furnisher_name, account: i.account_name,
        title: i.title, reportShows: d.reportShows || null,
        disputeWording: d.disputeWording || null, remedyWording: d.remedyWording || null,
      };
    });

    // Content blocks: attachments + intake prompt.
    const blocks = [{ type: 'text', text: buildIntakePrompt(priorItems) }];
    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const base64 = fs.readFileSync(file.path).toString('base64');
      blocks.push(ext === '.pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
        : { type: 'image', source: { type: 'base64', media_type: ext === '.png' ? 'image/png' : 'image/jpeg', data: base64 } });
    }

    console.log(`[${sessionId}] Intake: comparing ${pending.length} items against ${req.files.length} file(s)...`);
    const responseText = await callClaude(blocks, sessionId);

    const outputDir = path.join(__dirname, 'outputs', sessionId);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'raw_response.txt'), responseText);

    const intake = extractTaggedJson(responseText, 'INTAKE_JSON', sessionId);
    if (!intake || !Array.isArray(intake.outcomes)) {
      return res.status(500).json({ error: 'Could not parse the intake comparison. Check raw_response.txt and try again.' });
    }

    // Apply outcomes. The human always has the final word — "unclear" stays
    // pending and is classified by hand in the UI.
    const byNumber = {};
    pending.forEach(i => { byNumber[i.item_number] = i; });
    const groups = { fixed: [], deleted: [], verified_unchanged: [], unclear: [] };
    for (const o of intake.outcomes) {
      const item = byNumber[o.item];
      if (!item) continue;
      const outcome = ['fixed', 'deleted', 'verified_unchanged'].includes(o.outcome) ? o.outcome : 'unclear';
      const d = JSON.parse(item.detail_json || '{}');
      groups[outcome].push({
        item: item.item_number, furnisher: item.furnisher_name, account: item.account_name,
        title: item.title, before: d.reportShows || null,
        newValue: o.newValue || null, evidenceQuote: o.evidenceQuote || null,
      });
      if (outcome !== 'unclear') store.setItemStatus(item.id, outcome, round.round_number);
    }

    // Store the uploaded results/report files with the campaign.
    const destDir = path.join(store.DATA_DIR, 'files', String(campaignId), sessionId);
    fs.mkdirSync(destDir, { recursive: true });
    const stored = [];
    for (const file of req.files) {
      const dest = path.join(destDir, path.basename(file.originalname));
      fs.copyFileSync(file.path, dest);
      stored.push(dest);
    }
    const resultsDate = (req.body.results_date || new Date().toISOString().slice(0, 10));
    store.createReport({ campaign_id: campaignId, kind: 'results_letter', file_paths: stored, report_date: resultsDate });
    store.createRun({ campaign_id: campaignId, session_uuid: sessionId, purpose: 'intake_diff' });

    // Results date drives the SOL and the chronology.
    store.updateRound(round.id, { results_received_date: resultsDate });

    // Diff report.
    const diff = { roundNumber: round.round_number, resultsDate, groups };
    fs.writeFileSync(path.join(outputDir, 'intake_diff.json'), JSON.stringify(diff, null, 2), 'utf8');
    await generateResultsDiffDocx(diff, path.join(outputDir, 'Results_Diff.docx'));
    const files = [{ name: 'Results_Diff.docx', url: `/download/${sessionId}/Results_Diff.docx` }];

    // Load consumer + identity for follow-up letters.
    const priorRun = store.getRun(round.run_id);
    const priorData = JSON.parse(fs.readFileSync(runViolationsPath(priorRun), 'utf8'));
    const client = store.getClient(campaign.client_id);
    const clientIdentity = client ? {
      phone: client.phone || '', phone2: client.phone_alt || '', email: client.email || '',
      dob: client.dob || '', ssn: client.ssn || '', formerNames: client.former_names || '',
      proofOfAddress: client.proof_of_address || '',
    } : {};

    // Verified-unchanged items feed the next round (max 3) — and an optional
    // plain-language MOV request (supporting exhibit, never the case).
    let nextRound = null;
    if (groups.verified_unchanged.length > 0) {
      await generateMovLetterDocx(priorData.consumer, clientIdentity, groups.verified_unchanged, path.join(outputDir, 'MOV_Request.docx'));
      files.push({ name: 'MOV_Request.docx', url: `/download/${sessionId}/MOV_Request.docx` });

      if (round.round_number < 3) {
        const keep = new Set(groups.verified_unchanged.map(g => `${g.furnisher}||${g.account}||${g.title}`));
        const nextData = {
          ...priorData,
          furnishers: priorData.furnishers.map(f => ({
            ...f,
            violations: (f.violations || []).filter(v => keep.has(`${f.name}||${v.accountName || ''}||${v.title || ''}`)),
          })).filter(f => (f.violations || []).length > 0)
            .map(f => ({ ...f, accounts: (f.accounts || []).filter(a => (f.violations || []).some(v => v.accountName === a.accountName)) })),
        };
        // Fold in any new violations the "corrections" introduced.
        const newViolations = (Array.isArray(intake.newViolations) ? intake.newViolations : [])
          .filter(nv => nv && nv.title && nv.disputeWording);
        for (const nv of newViolations) {
          let f = nextData.furnishers.find(x => x.name === nv.furnisher);
          if (!f) { f = { name: nv.furnisher || 'UNKNOWN FURNISHER', address: null, phone: null, accounts: [], violations: [] }; nextData.furnishers.push(f); }
          f.violations.push(nv);
        }
        nextData.furnishers.forEach(f => f.violations.forEach((v, i) => { v.number = i + 1; }));

        const draftUuid = uuidv4();
        const draftDir = path.join(__dirname, 'outputs', draftUuid);
        fs.mkdirSync(draftDir, { recursive: true });
        fs.writeFileSync(path.join(draftDir, 'violations_data.json'), JSON.stringify(nextData, null, 2), 'utf8');
        const draftRunId = store.createRun({ campaign_id: campaignId, session_uuid: draftUuid, purpose: 'round_draft' });
        // Track only the genuinely NEW violations as items — the verified ones
        // already have rows from the earlier round (status verified_unchanged).
        let nextNum = store.db.prepare('SELECT MAX(item_number) m FROM violation_items WHERE campaign_id=?').get(campaignId).m || 0;
        const insNew = store.db.prepare(`INSERT INTO violation_items
          (campaign_id,run_id,furnisher_name,account_name,item_number,title,severity,statute,issue_type,remedy_type,is_collector,detail_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const nv of newViolations) {
          nextNum++;
          insNew.run(campaignId, draftRunId, nv.furnisher || 'UNKNOWN FURNISHER', nv.accountName || null, nextNum,
            nv.title || null, nv.severity || null, nv.statute || null, nv.issueType || null,
            nv.remedyType || null, 0, JSON.stringify(nv));
        }
        nextRound = store.createRound({ campaign_id: campaignId, round_number: round.round_number + 1, run_id: draftRunId });
      }
    }

    // The memo tracks the campaign — regenerate it after every intake so the
    // chronology, SOL, and per-item statuses are always current.
    const priorOutputsDir = path.join(__dirname, 'outputs', path.basename(priorRun.session_uuid));
    await generateLitigationMemoDocx(priorData, memoContextFor(campaignId),
      path.join(priorOutputsDir, 'Litigation_Memo.docx'), path.join(priorOutputsDir, 'litigation_memo.json'));
    files.push({ name: 'Litigation_Memo.docx', url: `/download/${priorRun.session_uuid}/Litigation_Memo.docx` });

    res.json({
      ok: true,
      diff,
      files,
      nextRound,
      counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
      solDeadline: store.getCampaign(campaignId).sol_deadline,
    });
  } catch (err) {
    console.error(`[${sessionId}] Intake error:`, err);
    res.status(500).json({ error: err.message || 'Intake failed.' });
  }
});

// Manual item classification — the human always has the final word.
app.patch('/api/items/:id', requirePin, (req, res) => {
  const { status, status_round } = req.body || {};
  const allowed = ['open', 'fixed', 'deleted', 'verified_unchanged', 'escalated'];
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
  const item = store.db.prepare('SELECT * FROM violation_items WHERE id=?').get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  store.setItemStatus(item.id, status, status_round || item.status_round);
  res.json(store.db.prepare('SELECT * FROM violation_items WHERE id=?').get(item.id));
});

// Escalate: verified-unchanged items become the lawsuit; memo regenerated.
app.post('/api/campaigns/:id/escalate', requirePin, async (req, res) => {
  try {
    const campaignId = Number(req.params.id);
    const campaign = store.getCampaign(campaignId);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found.' });
    store.db.prepare(`UPDATE violation_items SET status='escalated' WHERE campaign_id=? AND status='verified_unchanged'`).run(campaignId);
    store.setCampaignStatus(campaignId, 'litigation');
    store.addEvent({ campaign_id: campaignId, type: 'escalated', event_date: new Date().toISOString().slice(0, 10), details: 'Campaign escalated to litigation posture' });

    // Regenerate the memo from the latest analysis run with the full chronology.
    const run = store.db.prepare(
      `SELECT * FROM runs WHERE campaign_id=? AND purpose IN ('round1_analysis','round_draft') ORDER BY created_at DESC LIMIT 1`).get(campaignId);
    let memoUrl = null;
    if (run && fs.existsSync(runViolationsPath(run))) {
      const data = JSON.parse(fs.readFileSync(runViolationsPath(run), 'utf8'));
      const outputDir = path.join(__dirname, 'outputs', path.basename(run.session_uuid));
      await generateLitigationMemoDocx(data, memoContextFor(campaignId),
        path.join(outputDir, 'Litigation_Memo.docx'), path.join(outputDir, 'litigation_memo.json'));
      memoUrl = `/download/${run.session_uuid}/Litigation_Memo.docx`;
    }
    res.json({ ok: true, memoUrl });
  } catch (err) {
    console.error('Escalate error:', err);
    res.status(500).json({ error: err.message || 'Escalation failed.' });
  }
});

// ─── POST /analyze ────────────────────────────────────────────────────────────
app.post('/analyze', requirePin, (req, res, next) => {
  req.sessionId = uuidv4();
  next();
}, upload.array('files', 10), async (req, res) => {
  const sessionId = req.sessionId;

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }

  try {
    // Build image/document blocks for Claude
    const userContentBlocks = [];

    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const buffer = fs.readFileSync(file.path);
      const base64 = buffer.toString('base64');

      if (ext === '.pdf') {
        userContentBlocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        });
      } else {
        const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';
        userContentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        });
      }
    }

    // BMB Power Prompt
    const powerPrompt = `ANALYZE THIS CREDIT REPORT AND GENERATE A COMPLETE BMB DISPUTE PACKAGE.

═══════════════════════════════════════════════════════════════
ABSOLUTE GROUNDING RULES — VIOLATION OF THESE RULES IS FAILURE
═══════════════════════════════════════════════════════════════

1. ONLY report data you can LITERALLY READ from the credit report images. Every value you output (account numbers, balances, dates, amounts, statuses) MUST be directly visible in the uploaded images.

2. If a field is NOT VISIBLE or NOT PRESENT in the images, you MUST return null for that field. NEVER estimate, infer, calculate, or fabricate any value. A null is always better than a guess.

3. When reporting a violation, you MUST quote the EXACT value as it appears on the report. Use the format: "Report shows: [exact value]" in your description. If the report shows nothing for that field, say "Report shows: [BLANK/NOT PRESENT]".

4. NEVER invent dollar amounts, dates, account numbers, or credit limits. If you cannot read a number clearly from the image, use null and note "value not legible in image".

5. Do NOT round, adjust, or "clean up" values. If the report shows "$2,391.47" report exactly "$2,391.47" — not "$2,392" or "$2,400".

6. Account numbers: Report EXACTLY as shown, including any masking characters (X, *, etc.). If the report shows "6011XXXX2345" report exactly that. NEVER fill in masked digits.

7. EVERY account MUST have an account number. Credit reports always display at least a partial/masked account number for each tradeline. Look carefully at the image — the number may be partially masked (e.g. "XXXXXXXXXXXX3651"), may appear in a different font, or may be in a column labeled "Account #", "Account Number", or "Acct". If you truly cannot find it after careful examination, use the format "NOT VISIBLE — [reason]" as the accountNumber value, never null.

═══════════════════════════════════════════════════════════════
ACCOUNT SCOPE — DEROGATORY / NEGATIVE ACCOUNTS ONLY
═══════════════════════════════════════════════════════════════

Before any analysis, classify every account on the report. ONLY analyze and report violations for DEROGATORY accounts — accounts showing ANY of: charge-off, collection, repossession, foreclosure, settled / settled for less than full balance, past due balance > $0, delinquent or default status, or any late payment marker (30/60/90/120/150/180) anywhere in the payment history grid.

SKIP ENTIRELY — zero violations, no accounts[] entry, no letters — any account in good standing: "Pays As Agreed", "Paid As Agreed", "Current", "Paid", "Paid and Closed", "Never Late", "Exceptional Payment History", or any account with a clean payment history and no derogatory indicator anywhere on its tradeline. We only dispute negative items; positive accounts must not be touched.

If a furnisher has ONLY positive accounts, do NOT create a furnisher entry for it at all. If a furnisher has both, include only its derogatory accounts.

PRECEDENCE: the derogatory indicators ALWAYS override the status label. If the payment-history grid shows ANY late marker (30/60/90/120/150/180) or other derogatory indicator, the account IS derogatory and MUST be included — even when its status line says "Pays As Agreed" or "Current". A clean status label on top of a late-marked grid is itself a reporting contradiction worth disputing. The status label alone can only EXCLUDE an account when the grid and every other field are also clean.

CRITICAL — THIS SCOPE RULE FILTERS ACCOUNTS ONLY. It must NEVER remove, weaken, or skip any violation CATEGORY. For every DEROGATORY account, ALL 33 categories below still apply in FULL FORCE — explicitly including category 5 (ACCOUNT NUMBER): an account number masked or truncated with * or X characters (e.g. "*3312") prevents consumer verification and IS a violation (FCRA §1681g(a)(1) — CRITICAL). Every derogatory account whose displayed account number contains masking characters MUST receive this violation. Category 9b (DATE OF LAST ACTIVITY) applies with the same force: every derogatory account whose report prints a "Date of Last Activity" label with no value MUST receive that violation.

═══════════════════════════════════════════════════════════════
33-POINT ANALYSIS PROTOCOL (Credit Manifesto + SOP)
═══════════════════════════════════════════════════════════════

For EACH DEROGATORY account (per the ACCOUNT SCOPE rule above), systematically check ALL 33 categories below.
RULE: Every category that has a label on the report MUST have data — blank fields, dashes, or $0 where a real value should be = VIOLATION.
RULE: If a category exists on the report but has no data, that is INCOMPLETE REPORTING (FCRA §1681e(b)).
RULE: Experian and TransUnion are notorious for missing Date of First Delinquency — ALWAYS flag if missing.
RULE: TransUnion commonly shows "$0" as last payment — flag this (how can last payment be $0?).
RULE: Experian is notorious for having no data in payment history section — flag blank payment grids.

1. ACCOUNT STATUS — Is it correct? (open/closed/charged-off/collection/paid). Does it match reality? Status not updated = violation. Status says "Charged Off" but was paid = violation. (FCRA §1681e(b))

2. CHARGE-OFF AMOUNT — Is the amount written off present and accurate? Blank/missing = CRITICAL violation. Does it match balance at time of charge-off? Inflated or unexplained amount = violation. (Metro 2 Field 23)

3. CHARGE-OFF DATE — Is the date present and accurate? Missing = violation. Does it align with payment history showing 6 months delinquency? Future date or impossible date = violation.

4. ORIGINAL CREDITOR — Is the correct company listed? Wrong name, incomplete name, outdated name = violation. For collections: does it identify the original creditor? Missing original creditor on collection = violation. (FCRA §1681g(a)(2))

5. ACCOUNT NUMBER — Is it present? Truncated with X's/asterisks preventing consumer verification = violation (FCRA §1681g(a)(1) — CRITICAL). Fewer digits than expected = violation. Wrong number = violation.

6. ACCOUNT TYPE — Is the classification correct? (credit card, auto loan, mortgage, installment, revolving, collection). Wrong type affects credit scoring models. Mismatch = violation.

7. PAYMENT HISTORY — Is the 24-month grid complete and accurate? Check for:
   - Blank spaces in payment grid = NOT 100% maximum possible accuracy = VIOLATION (CRITICAL)
   - "ND" (No Data) entries = VIOLATION
   - Gaps or missing months = VIOLATION
   - Fewer than 24 months shown = VIOLATION
   - Delinquency progression must be logical: 30→60→90→120→150→180 days. Jumping from Current to 120+ without intermediate steps = VIOLATION (Seamans v. Temple University — CRITICAL)
   - "C/O" or "C" appearing with no prior late history = VIOLATION
   - Experian blank payment sections = flag as incomplete

8. LAST PAYMENT DATE — Is it present and accurate? Does it match the payment history grid? If report says last payment January but January in the grid shows something different = VIOLATION. Blank for active account = violation. "$0" as last payment = inaccurate (TransUnion common issue).

9. DELINQUENCY AND ACTIVITY DATES (DOFD + DOLA) — two separate fields, both checked on every derogatory account:

   9a. DATE OF FIRST DELINQUENCY (DOFD) — Is it present? MISSING DOFD = CRITICAL VIOLATION (consumer cannot determine 7-year removal date). Experian and TransUnion often omit this — ALWAYS CHECK. Does DOFD align with payment history? If DOFD says Feb 2018 but payment history shows a payment was made that month = contradiction = VIOLATION. (FCRA §1681c(a))

   9b. DATE OF LAST ACTIVITY (DOLA) — Is the field LABELED on the report, and does it have a value? Equifax prints this field on every tradeline; check it on EVERY derogatory account. Flag each of these:
   - Label printed with NO VALUE on a derogatory account = the consumer cannot tell when the account last had activity or confirm it is being aged correctly = VIOLATION (severity HIGH)
   - DOLA equal to a payment date LATER than the delinquency = the intervening payment reset the field = re-aging vector = VIOLATION
   - DOLA populated while DOFD is blank = the only date left to age the account by is one that resets on payment = VIOLATION
   - DOLA earlier than Date Opened, in the future, or later than Date Reported = VIOLATION
   - DOLA differing across bureaus for the same account = VIOLATION
   (FCRA §1681g(a), §1681e(b); Gillespie v. Equifax Info. Servs. LLC, 484 F.3d 938 (7th Cir. 2007) — a CRA's practice of amending the date of last activity can make the §1681g disclosure unclear, because the one field is used for two contradictory purposes: the last-payment date when current, the delinquency event when derogatory.)

   HARD RULE FOR DOLA — THE FCRA DOES NOT REQUIRE A DATE OF LAST ACTIVITY. Never write that the field is "required," "mandatory," or "must be reported" in description, impact, shouldShow, or demand. Frame it as a clarity/completeness defect: the label is printed but empty, so the tradeline cannot be understood or aged from the face of the report. Never cite a Metro 2 field number for DOLA — Metro 2 has no "Date of Last Activity" field, only an "Activity Date" field. Inconsistency is the strong claim, not absence.

10. COLLECTION INFORMATION — For collection accounts: is collection agency info accurate? Is original creditor identified? Same debt listed with multiple agencies = VIOLATION (duplicate tradeline). Outdated collection agency info = violation.

11. BALANCE HISTORY — Does the balance history align with actual account activity? Incomplete history = violation. Balance jumps that don't make sense = violation. Balance shows amounts not matching credit limit or payments = violation.

12. CREDIT LIMIT — Present for revolving accounts? Blank/missing/$0 for credit cards = VIOLATION (affects utilization ratio and credit scoring). Current balance > credit limit without explanation = violation. (Metro 2 Field 16)

13. ACCOUNT OPENING DATE — Is the date present and accurate? Must be consistent across all three bureaus (if checking multiple). Blank or invalid date = violation. Does payment history start from this date? If opened 11/2015 but payment history shows 60 days late in December 2015 = impossible = VIOLATION.

14. RESPONSIBILITY — Is it correctly marked? (Individual/Joint/Authorized User). Wrong designation = violation. ECOA code must match. Incorrect responsibility affects liability.

15. DISPUTE HISTORY — Is there a record of previous disputes? "Disputed by consumer" comment but NO "In Dispute" flag = VIOLATION (FCRA §1681i(a)(5)(A)). Missing dispute history when previously disputed = violation.

16. LATE PAYMENT DETAILS — Are the 30/60/90/120 day late indicators accurate? Late payments without documented verification method = violation (FCRA §1681i(c)). Arbitrary late markers with no explanation = violation.

17. HIGH BALANCE / HIGHEST BALANCE — Is it present and accurate? Missing entirely = violation. Doesn't match actual account history = violation. High balance should match credit limit or highest actual balance.

18. PAYMENT STATUS — Is it correct? (Paid as agreed, delinquent, default, charged off). Status conflicts with other fields = violation. Says "Current" but Past Due > $0 = violation. Says "Paid" but balance > $0 = violation.

19. REMARKS OR COMMENTS — Are they accurate? Misleading remarks = violation. Comments that give incorrect impression of account = violation. "Settled for less" not noted when account was settled = violation.

20. COMPLIANCE CONDITION CODES — Are special circumstance codes present when applicable? (natural disaster, active military duty). Missing when applicable = violation. Wrong code = violation.

21. ORIGINAL LOAN AMOUNT — For installment loans: is it present and accurate? Missing = violation. Reported incorrectly = violation. Doesn't match loan documents = violation.

22. CURRENT BALANCE — Is the amount currently owed accurate? Balance doesn't match reality = violation. Inflated balance = violation. Balance not updated after payment = violation. $0 balance with active charge-off status = conflicting data.

23. SCHEDULED PAYMENT AMOUNT — Is the monthly payment correct per loan agreement? Wrong amount = violation. Scheduled payment > $0 for charged-off account (should be $0) = violation. Missing for active account = violation.

24. PAST DUE AMOUNT — Is it accurate? Unexplained or suspicious past due = violation. Past Due > $0 but Status = Current = violation. Past Due = $0 but Status = Charge-off = suspicious.

25. PAYMENT RATING / STATUS CODE — Is the status code correct? Status 97 for paid account = violation (should be 64). Status 05 but balance > $0 = violation. Conflicting codes = violation. Status not reflecting actual condition = violation.

26. NARRATIVE CODES — Are standardized narrative codes accurate? Outdated codes = violation. Codes that misrepresent account status = violation.

27. SPECIAL COMMENT CODES — Are they accurate and properly explained? Unexplained codes = violation. Conflicting special comments = violation.

28. ESTIMATED REMOVAL DATE — Is the projected removal date calculated correctly? Should be 7 years from DOFD (10 years for bankruptcy). Missing = violation. Incorrectly calculated = violation. (FCRA §1681c(a))

29. DATE REPORTED — Is it recent/current? Outdated date reported = violation. Inconsistent with other account info = violation. Stale reporting = violation.

30. DATE UPDATED — When was info last updated? Outdated update date with current reporting = violation. Stale data being reported as current = violation.

31. PURCHASED FROM / SOLD TO — For transferred accounts: is transfer info complete? Missing transfer chain = violation. Incomplete chain of custody = violation. Same debt appearing under both original and purchasing creditor = duplicate = violation.

32. ORIGINAL CHARGE-OFF CREDITOR CLASSIFICATION — Is the creditor type correct? (bank, credit union, finance company). Wrong classification = violation.

33. SECONDARY AGENCY INFORMATION — For accounts with multiple agencies: is it accurate? Outdated secondary agency = violation. Same debt listed multiple times with different agencies = VIOLATION.

═══════════════════════════════════════════════════════════════
SOP CROSS-CHECK (from BMB Standard Operating Procedure)
═══════════════════════════════════════════════════════════════
After checking all 33 categories, also perform these SOP-level cross-checks:

A. COMPLETENESS SCAN: For every labeled category on the report that has NO DATA, a dash, or $0 where a real value belongs — flag as INCOMPLETE. Every category should have relevant information.

B. DATE CONSISTENCY: Verify Date Opened is consistent (if visible across sections). Check if last payment date matches the payment history grid month.

C. PAYMENT GRID INTEGRITY: Look at each year's payment history. Every box should have a status (OK/checkmark for on-time, or 30/60/90/120/150/180 for late). Blank boxes = NOT maximum possible accuracy.

D. DELINQUENCY PROGRESSION: If an account went delinquent, verify 30→60→90→120→150→180 day progression. Charge-off typically after 6 months delinquency. Missing steps = violation.

E. TERM PERIOD CHECK: For car loans, mortgages, installment loans — verify term period is listed and correct. Missing terms = violation.

F. CROSS-FIELD CONTRADICTIONS: Draw logical lines between fields. If DOFD says Feb 2018 but payment history shows payment that month = contradiction. If status says "Closed" but Date Closed is blank = contradiction.

═══════════════════════════════════════════════════════════════
CLOSED-UNIVERSE FORENSIC AUDIT (report-against-itself method)
═══════════════════════════════════════════════════════════════
In addition to the 33-point protocol, you are acting as a forensic factual credit report auditor.
Treat the credit report as a SELF-CONTAINED document. You are NOT trying to guess the "true" answer —
you are testing whether the bureau's OWN reporting is missing, blank, incomplete, inaccurate,
contradictory, internally inconsistent, confusing, or unsupported by its own report presentation.
Use ONLY what appears on the report itself: the Account Information section, the Payment History grid,
the Remarks/Comments/Status/Removal date/Date updated fields, and (if multiple bureau reports are
provided) the same account across bureaus. Never rely on outside documents or assumptions.

G. PAYMENT HISTORY GRID vs ACCOUNT INFORMATION — for each derogatory account, explicitly compare:
   - last payment date vs what the payment history grid shows for that month
   - last payment amount vs payment history
   - account status vs grid progression
   - charge-off status vs remarks
   - balance vs past due
   - closed status / date closed vs continued monthly updates after closure
   - DOFD vs the visible delinquency sequence in the grid
   - date of last activity vs the last payment date, vs the grid, vs the DOFD, and vs the date closed
     (a DOLA that equals a payment made after the delinquency is the re-aging vector; a populated
     DOLA alongside a blank DOFD leaves the account ageable only by a date that resets on payment)
   - estimated removal date vs visible delinquency timing
   - "paid in full" remarks vs charge-off / past due / delinquent reporting
   - high balance / credit limit / monthly payment / terms vs the rest of the account
   Repeated charge-off reporting month after month, unexplained resets, and updates after closure
   are each independent findings.

H. CROSS-BUREAU COMPARISON — if more than one bureau's report is provided for the same account,
   compare balances, dates, statuses, payment histories, remarks, credit limits, high balances,
   past due amounts, DOFD timing, date-of-last-activity values, closure dates, removal dates, and
   data present on one report but missing on another. Each material inconsistency is a separate finding.

I. ISSUE CLASSIFICATION — classify every violation with exactly one issueType:
   "Missing field" | "Blank field" | "Incomplete field" | "Internal inconsistency" |
   "Contradiction between account info and payment history" | "Contradiction within payment history" |
   "Cross-bureau inconsistency" | "Potential reporting issue requiring clarification"
   Do NOT automatically say every blank field is illegal or false — state precisely WHY the field is
   challenged: it is missing, it conflicts with another part of the same report, it makes the reporting
   incomplete or contradictory, or the tradeline cannot be understood or verified from the face of the report.

J. PLAIN-LANGUAGE DISPUTE WORDING — for every violation, also write:

   "disputeWording": one or two short, factual, plain-English consumer sentences stating WHAT is
   wrong and WHY, at the field/month/dollar level. Quote the exact wrong value and where it appears.
   HARD RULES for disputeWording and remedyWording:
   - NO statute citations, NO case names, NO "FCRA", NO "Metro 2", NO field numbers, NO legal
     vocabulary of any kind. These are written by an ordinary consumer describing a factual error.
     (Statutes and case law belong ONLY in the "statute" and "precedent" fields — those feed an
     internal memo, never the mailed letter.)
   - Fact framing only, never a legal argument. Never "this violates my rights" — instead "this
     is wrong, here is exactly why."
   - When the defect is the report contradicting itself, SAY SO in that form: "Your own report
     shows [value A] at [location A] but [value B] at [location B]. Both cannot be true."
   - For missing data, phrase as a question: "What was the date of first delinquency?"
   - No threats, no overexplaining, no template-sounding filler.

   "remedyType": exactly one of "correct" | "delete" | "explain" — what the consumer wants for
   THIS item. Use "correct" when a specific right value or completion is the fix, "delete" when
   the tradeline cannot be verified or the derogatory reporting is unsupportable, "explain" when
   the consumer needs information (e.g. a full account number) before anything can be verified.

   "remedyWording": ONE plain-English sentence stating the exact remedy for THIS item, matched to
   the defect — never a blanket demand. Examples of the required style:
   - "Please correct the balance from $2,391.47 to $0."
   - "Please fill in the missing payment history for March 2023 through July 2024, or delete
     this account if you cannot."
   - "Please report the correct date of first delinquency, or delete this account."
   - "Please provide the full account number so I can verify this account, or delete it."

   "internalContradiction": when the defect is the report contradicting itself, an object
   { "locationA": "...", "valueA": "...", "locationB": "...", "valueB": "..." } naming both spots
   and both values exactly as printed. Otherwise null.

   Examples of the required disputeWording style:
   - "What was the date of first delinquency?"
   - "The Last Payment Date is listed as Aug 14, 2023, but the payment history grid shows no
     payment that month. How can both be true?"
   - "The account is listed in charge-off status, but the remarks say 'paid in full.' Both
     cannot be true."

K. MARKUP LOCATIONS — for every violation, record where on the report it is visible so it can be
   boxed in red. Use the PDF page number the field appears on. If a contradiction involves two
   locations (e.g. a field in Account Information AND a month cell in the Payment History grid),
   list BOTH locations — both get boxed for the same item.
   markText QUOTING RULES (the box is placed by searching the page text, so markText MUST be findable):
   - markText must be text LITERALLY printed on the page. NEVER use "...", "■", or bracketed
     descriptions like "[blank cell]" or "[checkmark Sep]" — those strings do not exist on the page.
   - For a blank/missing month cell in the Payment History grid, use the year row: "2026 row".
   - For a row in the 24 Month History table, use the row's leading date: "06/25 row".
   - For a labeled field, quote label and value exactly: "Scheduled Payment Amount:" or "Balance: $932".
   WHAT GETS A BOX — HIGHLIGHTING SWEEP RULES (every box must show something WRONG at that exact spot;
   a reader looking at any box must see the defect right there):
   - Single-field defect (blank, missing, $0 where a real value belongs, wrong value): box THAT FIELD ONLY.
   - Contradiction between two fields: box BOTH fields — both values are part of the dispute.
   - Payment-grid defect (blank cells, missing months, illogical delinquency progression): box the year
     row(s) where the defect is visible — NOTHING else.
   - NEVER box a healthy, correctly-populated field as "context", "reference", or "supporting evidence"
     for a defect that lives somewhere else. If the field's own reporting is fine, it gets NO box.
   - DATE OF 1ST DELINQUENCY: box it ONLY when the field itself is blank/missing. A populated DOFD is
     NEVER boxed — for delinquency-progression issues, box the payment-history year row(s) instead.
   - DATE OF LAST ACTIVITY: when the label is printed with no value, box the label itself
     (markText "Date of Last Activity:"). When the field is populated AND contradicts another field,
     box BOTH the DOLA field and the field it contradicts. A populated, non-contradictory DOLA is
     NEVER boxed.
   - TRUNCATED ACCOUNT NUMBER: the box goes on the Account Number field ("Account Number: *0725").

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

CRITICAL OUTPUT RULE: Your ENTIRE response must be ONLY the <VIOLATIONS_JSON>...</VIOLATIONS_JSON> block. Begin your response immediately with the opening <VIOLATIONS_JSON> tag. Do NOT write any analysis, narration, account listing, or preamble before it (no "I'll analyze...", no "ACCOUNTS IDENTIFIED:"). Do all reasoning silently and emit only the JSON. Any text outside the tags is a failure.

Output your findings as structured JSON between <VIOLATIONS_JSON> and </VIOLATIONS_JSON> tags using EXACTLY this schema:

<VIOLATIONS_JSON>
{
  "consumer": {
    "name": "Full Name as shown on report",
    "address": "Full Address as shown on report",
    "reportDate": "MM/DD/YYYY as shown on report",
    "bureau": "Experian|Equifax|TransUnion as shown on report"
  },
  "summary": {
    "total": 0,
    "critical": 0,
    "high": 0,
    "medium": 0
  },
  "furnishers": [
    {
      "name": "Furnisher Name exactly as shown on report",
      "address": "Furnisher Address if visible, or null",
      "phone": "Phone if visible, or null",
      "isCollector": "true if this furnisher is a collection agency or debt buyer (collection tradelines, 'placed for collection', purchased debt), false if an original creditor, null if unclear",
      "accounts": [
        {
          "accountName": "Exactly as shown on report",
          "accountNumber": "REQUIRED — exactly as shown including masking characters (e.g. 'XXXXXXXXXXXX3651'). If truly not findable after careful search, use 'NOT VISIBLE'",
          "accountType": "Credit Card|Installment|Mortgage|Auto|Line of Credit|Collection — as shown, or null",
          "status": "Exactly as shown on report (e.g. 'Charge-off', 'Collection', 'Paid')",
          "statusCode": "Numeric status code if shown (e.g. 97, 64, 05), or null",
          "balance": "Exact dollar amount as shown, or null if not visible",
          "pastDue": "Exact dollar amount as shown, or null if not visible",
          "creditLimit": "Exact amount as shown, or null if not visible",
          "highCredit": "Exact amount as shown, or null if not visible",
          "originalChargeOffAmount": "Exact amount as shown, or null if not visible",
          "scheduledPayment": "Exact amount as shown, or null if not visible",
          "dateOpened": "Exactly as shown on report, or null",
          "dateClosed": "Exactly as shown on report, or null",
          "dateLastActive": "Exactly as shown, or null",
          "dateLastPayment": "Exactly as shown, or null",
          "dateReported": "Exactly as shown, or null",
          "dofd": "Exactly as shown, or null if not present",
          "paymentHistory": "The 24-month payment string exactly as shown (e.g. 'CCCC1234567X'), or null",
          "termsType": "Revolving|Installment — as shown, or null",
          "ecoaCode": "ECOA code as shown, or null",
          "specialComment": "Any special comment code/text as shown, or null",
          "disputeFlag": "true if 'In Dispute' flag visible, false if not, null if unclear",
          "responsibilityType": "Individual|Joint|Authorized User — as shown, or null"
        }
      ],
      "violations": [
        {
          "number": 1,
          "accountName": "Must match an account in accounts[]",
          "title": "Short violation title in ALL CAPS",
          "severity": "CRITICAL|HIGH|MEDIUM",
          "statute": "FCRA section / Metro 2 Field / case law",
          "issueType": "Missing field|Blank field|Incomplete field|Internal inconsistency|Contradiction between account info and payment history|Contradiction within payment history|Cross-bureau inconsistency|Potential reporting issue requiring clarification",
          "reportShows": "EXACT value from the credit report that proves this violation (quote verbatim), or 'FIELD NOT PRESENT' if the violation is a missing field",
          "shouldShow": "What the correct/compliant value should be, or 'Must be present per [statute]'",
          "description": "Detailed description referencing the exact data from the report",
          "impact": "How this harms the consumer or prevents verification",
          "precedent": "Case law citation or null",
          "demand": "Specific remedy: delete, correct, provide documentation, or investigate",
          "disputeWording": "One or two short factual plain-English sentences per rule J — no statutes, no legal vocabulary, exact values quoted",
          "remedyType": "correct|delete|explain per rule J",
          "remedyWording": "One plain-English sentence stating the exact remedy for this item per rule J",
          "internalContradiction": { "locationA": "where value A appears", "valueA": "exact value A", "locationB": "where value B appears", "valueB": "exact value B" },
          "markup": [
            {
              "page": 3,
              "section": "Account Information|Payment History|Remarks|Personal Information|Summary",
              "markText": "The exact text/field/month cell to draw a red box around, quoted as it appears (e.g. 'Last Payment Date: Aug 14, 2023' or 'September 2023 payment history cell')"
            }
          ]
        }
      ]
    }
  ]
}
</VIOLATIONS_JSON>

IMPORTANT QUALITY RULES:
- CITATION ACCURACY — THIS OVERRIDES EVERY KNOWLEDGE-BASE FILE. Several older files in the knowledge base cite *Gillespie v. Equifax Info. Servs. LLC* as the truncated-account-number case, and one gives it a fabricated reporter cite. That is WRONG. Gillespie is 484 F.3d 938 (7th Cir. 2007) and it is the DATE OF LAST ACTIVITY case — it holds that a CRA's practice of amending the date of last activity can render the §1681g file disclosure unclear. NEVER put Gillespie in the "statute" or "precedent" field of a truncated-account-number violation; that violation cites FCRA §1681g(a)(1) alone with precedent null. Gillespie belongs ONLY on date-of-last-activity violations.
- FURNISHERS ONLY: Only list actual data furnishers (creditors, lenders, collection agencies). Do NOT create a furnisher entry for the CRA itself (TransUnion, Experian, Equifax). CRA-level issues belong in the individual furnisher violations.
- Every value in "accounts" must be EXACTLY as shown on the credit report images, or null. Do NOT fabricate any data.
- Every violation "reportShows" field must quote the EXACT value from the report.
- Do NOT generate a violation if your own analysis concludes the data is actually correct. If you check a category and find no issue, skip it — do not create a violation with a title claiming a problem and then a body saying there is no problem.
- Number violations sequentially across ALL accounts per furnisher (not restarting at 1 per account).
- There is NO minimum violation count. Zero violations for an account is a valid and correct result. Never invent, stretch, or pad a violation to reach a count — every dispute must be one the consumer could defend under oath.
- EVERY violation MUST include issueType, disputeWording, remedyType, remedyWording, and at least one markup entry with the real PDF page number where the field appears. If a contradiction spans two locations, include both markup entries (both belong to the same item).
- Do not invent missing dates, balances, or payment amounts in disputeWording — phrase missing data as a question ("What was the monthly payment?").
- Never claim fraud or identity theft unless the report itself supports it.`;

    // Snapshot mode: image uploads have no text layer to search, so the red
    // boxes must come from model-supplied coordinates instead.
    const hasImageUpload = req.files.some((f) => path.extname(f.originalname).toLowerCase() !== '.pdf');
    if (hasImageUpload) {
      userContentBlocks.unshift({
        type: 'text',
        text: `SNAPSHOT MODE — IMAGE UPLOADS (applies because at least one uploaded file is an image, not a PDF):
The upload is a screenshot/photo of a report section, so red boxes are placed by COORDINATES, not text search. For EVERY markup entry, ADD a "bbox" field: [x0, y0, x1, y1] on a 0–1000 normalized grid where (0,0) is the TOP-LEFT corner of that image and (1000,1000) is the BOTTOM-RIGHT. x0,y0 is the box's top-left corner; x1,y1 is its bottom-right. The box must TIGHTLY enclose ONLY the exact field, value, or grid row named in markText — small padding is fine, never the whole page or a whole section. For "page", use the 1-based position of the image among the uploaded files (first uploaded image = 1). The annotated report is generated directly from these coordinates, so their accuracy is critical.
If the uploads include the report's first/header pages, read the consumer name, address, report date, and bureau from them — but do NOT analyze accounts shown there for violations unless they are derogatory tradelines.`,
      });
    }
    userContentBlocks.unshift({ type: 'text', text: powerPrompt });

    // Call Claude
    console.log(`[${sessionId}] Calling Claude API with ${req.files.length} file(s)...`);
    const responseText = await callClaude(userContentBlocks, sessionId);

    // Keep the raw response on disk so a bad parse is always diagnosable.
    const outputDir = path.join(__dirname, 'outputs', sessionId);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'raw_response.txt'), responseText);

    // Parse JSON block — tolerate a truncated response (missing closing tag,
    // cut-off JSON) by repairing the tail instead of discarding the analysis.
    let violationsData = extractTaggedJson(responseText, 'VIOLATIONS_JSON', sessionId);

    if (!violationsData) {
      console.error(`[${sessionId}] No VIOLATIONS_JSON found in response. First 500 chars:`, responseText.substring(0, 500));
      // Fallback structure
      violationsData = {
        consumer: { name: 'Unknown Consumer', address: '', reportDate: new Date().toLocaleDateString(), bureau: 'Experian' },
        summary: { total: 0, critical: 0, high: 0, medium: 0 },
        furnishers: [],
        disputeLetters: [],
        mailingInstructions: responseText,
        highlightingGuide: '',
      };
    }

    // Bureau resolution: the UI dropdown wins; otherwise the bureau the model
    // read off the pages. Never guess — a snapshot with no bureau visible and
    // no dropdown choice is an error, not an Experian default.
    const bureauChoice = String(req.body.bureau || 'auto').toLowerCase();
    const BUREAU_LABELS = { experian: 'Experian', equifax: 'Equifax', transunion: 'TransUnion' };
    violationsData.consumer = violationsData.consumer || {};
    if (BUREAU_LABELS[bureauChoice]) {
      violationsData.consumer.bureau = BUREAU_LABELS[bureauChoice];
    } else if (!/experian|equifax|transunion/i.test(String(violationsData.consumer.bureau || ''))) {
      console.warn(`[${sessionId}] Bureau undetectable and no dropdown choice — rejecting run.`);
      return res.status(422).json({
        error: 'Could not detect which credit bureau this report is from. Select Equifax, Experian, or TransUnion in the Credit Bureau dropdown and run the analysis again.',
      });
    }

    // Filter out CRA-as-furnisher entries (TransUnion/Experian/Equifax are CRAs, not furnishers)
    const craNames = ['transunion', 'experian', 'equifax'];
    if (violationsData.furnishers) {
      violationsData.furnishers = violationsData.furnishers.filter(f => {
        const nameLower = (f.name || '').toLowerCase();
        return !craNames.some(cra => nameLower.includes(cra));
      });
    }

    // Does this report actually print a "Date of Last Activity" label? Equifax does
    // on every tradeline; the other bureaus often do not. Guard 4 below only fires
    // when the label is really on the page — otherwise the injected item would point
    // at a field that does not exist and the box would have nothing to land on.
    // Image/snapshot uploads have no text layer, so DOLA stays model-only there.
    let reportPrintsDolaLabel = false;
    for (const file of req.files) {
      if (path.extname(file.originalname).toLowerCase() !== '.pdf') continue;
      try {
        const parsed = await pdfParse(fs.readFileSync(file.path));
        if (/date of last activity/i.test(parsed.text)) { reportPrintsDolaLabel = true; break; }
      } catch (err) {
        console.warn(`[${sessionId}] Could not scan ${file.originalname} for the DOLA label:`, err.message);
      }
    }

    // Deterministic guards — enforce the highlighting rules even when the model slips.
    if (violationsData.furnishers) {
      for (const f of violationsData.furnishers) {
        const accounts = f.accounts || [];
        const violations = f.violations || [];

        // Guard 1: a populated Date of 1st Delinquency is never boxed. Drop any
        // markup entry pointing at a filled-in DOFD field (the defect those
        // violations describe lives in the payment grid, which stays boxed) —
        // but never drop a violation's last remaining markup location.
        for (const v of violations) {
          if (!v.markup || v.markup.length < 2) continue;
          const acct = accounts.find(a => a.accountName === v.accountName) || {};
          if (!acct.dofd) continue;
          const kept = v.markup.filter(m => !/date of (1st|first) delinquency|DOFD/i.test(String(m.markText || '')));
          if (kept.length > 0) v.markup = kept;
        }

        // Injected violations get their box on the account's own page — taken
        // from the account's other violations' markup entries.
        const pageOfAccount = (acctName) => {
          for (const v of violations) {
            if (v.accountName !== acctName) continue;
            for (const m of (v.markup || [])) if (m.page != null) return m.page;
          }
          return null;
        };

        // Guard 2: every account whose displayed number is masked (*/X) must
        // carry the truncated-account-number violation (FCRA §1681g(a)(1)).
        // Inject the standard violation if the model omitted it.
        for (const acct of accounts) {
          const num = String(acct.accountNumber || '');
          if (!/[*X]/i.test(num) || /NOT VISIBLE/i.test(num)) continue;
          const has = violations.some(v =>
            v.accountName === acct.accountName &&
            /TRUNCAT|ACCOUNT NUMBER/i.test(String(v.title || '')));
          if (has) continue;
          console.log(`[${sessionId}] Guard: injecting truncated-account-number violation for ${f.name} (${num})`);
          violations.unshift({
            accountName: acct.accountName,
            title: 'TRUNCATED ACCOUNT NUMBER PREVENTS CONSUMER VERIFICATION',
            severity: 'CRITICAL',
            statute: 'FCRA §1681g(a)(1)',
            issueType: 'Incomplete field',
            reportShows: num,
            shouldShow: 'Full account number sufficient for the consumer to identify and verify the account',
            description: `The account number is displayed as "${num}" — masked to the point that the consumer cannot independently verify that this tradeline belongs to them or match it against their own records.`,
            impact: 'The consumer cannot verify the account, dispute specific entries, or confirm the tradeline is theirs.',
            precedent: null,
            demand: 'Provide the full account number or delete the tradeline.',
            disputeWording: `The account number is shown only as "${num}." I cannot tell from this masked number whether this account is actually mine.`,
            remedyType: 'explain',
            remedyWording: 'Please provide the full account number so I can verify this account, or delete it.',
            internalContradiction: null,
            markup: [{ page: pageOfAccount(acct.accountName), section: 'Account Information', markText: `Account Number: ${num}` }],
          });
        }

        // Guard 3: every derogatory account (all accounts here are, by scope)
        // with a blank Date of 1st Delinquency must carry the missing-DOFD
        // violation — category 9, always-flag per the BMB protocol.
        for (const acct of accounts) {
          if (acct.dofd) continue;
          const has = violations.some(v =>
            v.accountName === acct.accountName &&
            /DOFD|(FIRST|1ST) DELINQUENCY/i.test(String(v.title || '')));
          if (has) continue;
          console.log(`[${sessionId}] Guard: injecting missing-DOFD violation for ${f.name} (${acct.accountName})`);
          violations.push({
            accountName: acct.accountName,
            title: 'DATE OF FIRST DELINQUENCY MISSING',
            severity: 'CRITICAL',
            statute: 'FCRA §1681c(a); Metro 2 Field 25',
            issueType: 'Missing field',
            reportShows: 'FIELD NOT PRESENT',
            shouldShow: 'DOFD must be reported so the consumer can determine the 7-year removal date',
            description: 'The Date of 1st Delinquency field is blank. This account reports derogatory history, so the DOFD is required — without it the consumer cannot determine when the negative information must be removed under the 7-year rule.',
            impact: 'The consumer cannot verify the 7-year removal timeline or confirm the delinquency is being aged correctly (FCRA §1681c(a)).',
            precedent: null,
            demand: 'Report the accurate Date of 1st Delinquency or delete the tradeline.',
            disputeWording: 'This account reports late payments, but the Date of 1st Delinquency field is blank. What was the date of first delinquency?',
            remedyType: 'correct',
            remedyWording: 'Please report the correct date of first delinquency, or delete this account.',
            internalContradiction: null,
            markup: [{ page: pageOfAccount(acct.accountName), section: 'Account Information', markText: 'Date of 1st Delinquency:' }],
          });
        }

        // Guard 4: every derogatory account whose report PRINTS a Date of Last
        // Activity label but leaves it empty must carry the blank-DOLA item —
        // category 9b. Watts: the FCRA does not require this field, so this is
        // pled as a §1681g clarity/completeness defect (Gillespie), never as a
        // mandatory-field omission, and it is written to the bureau as a question.
        if (reportPrintsDolaLabel) {
          for (const acct of accounts) {
            if (acct.dateLastActive) continue;
            const has = violations.some(v =>
              v.accountName === acct.accountName &&
              /LAST ACTIVITY/i.test(String(v.title || '')));
            if (has) continue;
            console.log(`[${sessionId}] Guard: injecting blank-DOLA violation for ${f.name} (${acct.accountName})`);
            violations.push({
              accountName: acct.accountName,
              title: 'DATE OF LAST ACTIVITY FIELD BLANK',
              severity: 'HIGH',
              statute: 'FCRA §1681g(a); §1681e(b)',
              issueType: 'Blank field',
              reportShows: 'FIELD LABELED BUT EMPTY',
              shouldShow: 'A date of last activity that is explained by the rest of the tradeline, or no label at all',
              description: 'The report prints a "Date of Last Activity" label for this account and leaves it empty. The account reports derogatory history, so the consumer is left unable to tell from the face of the report when the account last had activity, or to reconcile that against the delinquency dates and the payment history.',
              impact: 'The tradeline cannot be understood or aged from the face of the report. Gillespie v. Equifax holds that confusion in this field can make the file disclosure unclear — Equifax uses the one field for two contradictory purposes: the last-payment date when an account is current, the delinquency event when it is derogatory.',
              precedent: 'Gillespie v. Equifax Info. Servs. LLC, 484 F.3d 938 (7th Cir. 2007)',
              demand: 'Report the date of last activity for this account, or state in writing that there is none.',
              disputeWording: 'The Date of Last Activity field on this account is blank. What was the date of last activity?',
              remedyType: 'explain',
              remedyWording: 'Please report the date of last activity for this account, or tell me in writing that there is none.',
              internalContradiction: null,
              markup: [{ page: pageOfAccount(acct.accountName), section: 'Account Information', markText: 'Date of Last Activity:' }],
            });
          }
        }
        f.violations = violations;
        // Renumber sequentially — guard-injected violations carry no number, and
        // model numbering can drift; letters and the markup map key off this.
        violations.forEach((v, i) => { v.number = i + 1; });
      }
    }

    // Recompute summary counts from actual violation severity badges (not Claude's summary)
    if (violationsData.furnishers) {
      let total = 0, critical = 0, high = 0, medium = 0;
      for (const f of violationsData.furnishers) {
        for (const v of (f.violations || [])) {
          total++;
          if (v.severity === 'CRITICAL') critical++;
          else if (v.severity === 'HIGH') high++;
          else if (v.severity === 'MEDIUM') medium++;
        }
      }
      violationsData.summary = { total, critical, high, medium };
    }

    // Generate output files (outputDir already created for the raw-response dump)

    const generatedFiles = [];

    // Consumer identity details typed into the wizard (all optional — blanks
    // render as fill-in lines in the letters).
    const clientIdentity = {
      phone: req.body.phone || '',
      phone2: req.body.phone2 || '',
      email: req.body.email || '',
      dob: req.body.dob || '',
      ssn: req.body.ssn || '',
      formerNames: req.body.formerNames || '',
      proofOfAddress: req.body.proofOfAddress || '',
    };

    // The one mailed dispute instrument: the plain-English Watts letter.
    const wattsPath = path.join(outputDir, 'Dispute_Letter.docx');
    await generateWattsLetterDocx(violationsData, clientIdentity, {}, wattsPath);
    generatedFiles.push({ name: 'Dispute_Letter.docx', path: wattsPath, label: 'Dispute Letter (mail this)' });

    // Internal litigation memo — statutes, case law, damages, chronology.
    const memoPath = path.join(outputDir, 'Litigation_Memo.docx');
    const memoJsonPath = path.join(outputDir, 'litigation_memo.json');
    await generateLitigationMemoDocx(violationsData, {}, memoPath, memoJsonPath);
    generatedFiles.push({ name: 'Litigation_Memo.docx', path: memoPath, label: 'Litigation Memo (INTERNAL — do not mail)' });

    // Markup Map (red box locations; item numbers match the dispute letter)
    const markupPath = path.join(outputDir, 'Markup_Map.docx');
    await generateMarkupMapDocx(violationsData, markupPath);
    generatedFiles.push({ name: 'Markup_Map.docx', path: markupPath, label: 'Markup Map (Red Box Guide)' });

    // Plain-language §1681g full-file request (separate envelope)
    const disclosurePath = path.join(outputDir, 'Full_File_Request.docx');
    await generateFileDisclosureDocx(violationsData.consumer, clientIdentity, disclosurePath);
    generatedFiles.push({ name: 'Full_File_Request.docx', path: disclosurePath, label: 'Full-File Request (mail separately)' });

    // Mailing Instructions docx — pass full structured data
    const mailingPath = path.join(outputDir, 'Mailing_Instructions.docx');
    await generateMailingInstructionsDocx(violationsData, mailingPath);
    generatedFiles.push({ name: 'Mailing_Instructions.docx', path: mailingPath, label: 'Mailing Instructions' });

    // HTML Violation Report
    const htmlReport = generateViolationReportHtml(violationsData);
    const htmlPath = path.join(outputDir, 'Violation_Report.html');
    fs.writeFileSync(htmlPath, htmlReport, 'utf8');
    generatedFiles.push({ name: 'Violation_Report.html', path: htmlPath, label: 'Interactive Violation Report' });

    // Persist parsed violations JSON (debugging + re-annotation without re-analyzing)
    fs.writeFileSync(path.join(outputDir, 'violations_data.json'), JSON.stringify(violationsData, null, 2), 'utf8');

    // Original + annotated credit report copies.
    // The original is kept untouched; the annotated copy gets red boxes only
    // (no numbering) at the locations listed in the Markup Map.
    // Full-report mode (PDF): boxes are placed by searching the text layer.
    // Snapshot mode (image): boxes come from model-supplied bbox coordinates.
    let imageIndex = 0;
    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      const isPdf = ext === '.pdf';
      if (!isPdf) imageIndex++;
      const base = path.basename(file.originalname, path.extname(file.originalname)).replace(/[^a-zA-Z0-9_-]/g, '_');
      try {
        const originalName = `Original_Credit_Report_${base}${ext}`;
        const originalCopy = path.join(outputDir, originalName);
        fs.copyFileSync(file.path, originalCopy);
        generatedFiles.push({ name: originalName, path: originalCopy, label: `Original Credit Report — ${file.originalname}` });

        const annotatedName = `Annotated_Credit_Report_${base}.pdf`;
        const annotatedPath = path.join(outputDir, annotatedName);
        let stats;
        if (isPdf) {
          stats = await annotateCreditReportPdf(file.path, violationsData, annotatedPath, { scoped: req.files.length > 1 });
        } else {
          // Preferred: OCR gives exact word positions, so boxes land by text
          // search just like the PDF path. Model bbox coordinates (plus a
          // self-correction pass) are the fallback when OCR is unavailable.
          try {
            stats = await annotateImageSnapshotOcr(file.path, violationsData, annotatedPath, imageIndex);
            console.log(`[${sessionId}] Snapshot annotated via OCR text search`);
          } catch (ocrErr) {
            console.warn(`[${sessionId}] OCR annotation unavailable (${ocrErr.message}) — using model coordinates`);
            stats = await annotateImageSnapshot(file.path, violationsData, annotatedPath, imageIndex);
            if (stats.located > 0) {
              try {
                const corrected = await refineSnapshotBoxes(anthropic, file.path, annotatedPath, violationsData, imageIndex);
                if (corrected > 0) {
                  stats = await annotateImageSnapshot(file.path, violationsData, annotatedPath, imageIndex);
                  console.log(`[${sessionId}] Box self-correction adjusted ${corrected} box(es) on ${file.originalname}`);
                  fs.writeFileSync(path.join(outputDir, 'violations_data.json'), JSON.stringify(violationsData, null, 2), 'utf8');
                }
              } catch (e) {
                console.warn(`[${sessionId}] Box self-correction skipped for ${file.originalname}:`, e.message);
              }
            }
          }
        }
        console.log(`[${sessionId}] Annotated ${file.originalname}: ${stats.located}/${stats.totalItems} items boxed${stats.missed.length ? ` (not located: ${stats.missed.map(m => m.item).join(', ')})` : ''}`);
        if (stats.located > 0) {
          generatedFiles.push({ name: annotatedName, path: annotatedPath, label: `Annotated Credit Report (red boxes) — ${file.originalname}` });
        } else {
          // No boxes landed on this file (e.g. header pages) — an unmarked
          // "annotated" copy is just a confusing duplicate of the original.
          fs.rmSync(annotatedPath, { force: true });
          console.log(`[${sessionId}] No boxes on ${file.originalname} — annotated copy omitted.`);
        }
      } catch (e) {
        console.warn(`[${sessionId}] Annotation failed for ${file.originalname}:`, e.message);
      }
    }

    // ZIP everything
    const zipPath = path.join(outputDir, 'BMB_Dispute_Package.zip');
    await zipFiles(generatedFiles.map(f => f.path), zipPath, outputDir);

    // Campaign persistence — when the run belongs to a campaign, store the
    // report files, the run, every violation item, and open the next round.
    const campaignId = Number(req.body.campaignId) || null;
    let roundInfo = null;
    if (campaignId && store.getCampaign(campaignId)) {
      const destDir = path.join(store.DATA_DIR, 'files', String(campaignId), sessionId);
      fs.mkdirSync(destDir, { recursive: true });
      const stored = [];
      for (const file of req.files) {
        const dest = path.join(destDir, path.basename(file.originalname));
        fs.copyFileSync(file.path, dest);
        stored.push(dest);
      }
      const reportId = store.createReport({ campaign_id: campaignId, kind: 'initial_report', file_paths: stored, report_date: violationsData.consumer.reportDate });
      const runId = store.createRun({ campaign_id: campaignId, report_id: reportId, session_uuid: sessionId, purpose: 'round1_analysis' });
      store.insertViolationItems(campaignId, runId, violationsData);
      const maxRound = store.db.prepare('SELECT MAX(round_number) m FROM rounds WHERE campaign_id=?').get(campaignId).m || 0;
      try {
        roundInfo = store.createRound({ campaign_id: campaignId, round_number: Math.min(maxRound + 1, 3), run_id: runId });
      } catch (e) {
        console.warn(`[${sessionId}] Round already exists for campaign ${campaignId}:`, e.message);
      }
      store.addEvent({
        campaign_id: campaignId, round_id: roundInfo ? roundInfo.id : null,
        type: 'analysis_run', event_date: new Date(),
        details: { sessionId, summary: violationsData.summary },
      });
    }

    // Cleanup uploads
    fs.rmSync(path.join(__dirname, 'uploads', sessionId), { recursive: true, force: true });

    res.json({
      sessionId,
      campaignId,
      round: roundInfo,
      violations: violationsData.summary,
      furnishers: (violationsData.furnishers || []).map(f => ({
        name: f.name,
        violationCount: (f.violations || []).length,
        accountCount: (f.accounts || []).length,
        accounts: (f.accounts || []).map(a => a.accountName).filter(Boolean),
      })),
      files: generatedFiles.map(f => ({ name: f.name, label: f.label, url: `/download/${sessionId}/${f.name}` })),
      zipUrl: `/download/${sessionId}/BMB_Dispute_Package.zip`,
    });

  } catch (err) {
    console.error(`[${sessionId}] Error:`, err);
    res.status(500).json({ error: err.message || 'Analysis failed. Please try again.' });
  }
});

// ─── GET /download/:sessionId/:filename ───────────────────────────────────────
app.get('/download/:sessionId/:filename', requirePin, (req, res) => {
  const { sessionId, filename } = req.params;
  // Sanitize to prevent path traversal
  const safeName = path.basename(filename);
  const safeSession = path.basename(sessionId);
  const filePath = path.join(__dirname, 'outputs', safeSession, safeName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }
  res.download(filePath);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateViolationReportHtml(data) {
  const consumer = data.consumer || {};
  const summary = data.summary || {};
  const furnishers = data.furnishers || [];

  const severityColor = { CRITICAL: '#c0392b', HIGH: '#e67e22', MEDIUM: '#f39c12' };
  const severityBg = { CRITICAL: '#fdecea', HIGH: '#fef5ec', MEDIUM: '#fefdf0' };

  const furnisherHtml = furnishers.map(f => {
    const violHtml = (f.violations || []).map(v => `
      <div class="violation" style="border-left:4px solid ${severityColor[v.severity] || '#6b7280'};padding:12px 16px;margin:8px 0;background:${severityBg[v.severity] || '#f9fafb'};border-radius:0 6px 6px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <strong>#${v.number} — ${v.title}</strong>
          <span style="font-size:11px;font-weight:700;color:${severityColor[v.severity] || '#6b7280'};background:white;padding:2px 8px;border-radius:12px;border:1px solid ${severityColor[v.severity] || '#6b7280'}">${v.severity}</span>
        </div>
        <div style="font-size:12px;color:#6b7280;margin-bottom:6px;">${v.statute}</div>
        ${v.reportShows ? `<div style="margin-bottom:4px;font-size:13px;"><strong style="color:#991b1b;">Report Shows:</strong> <code style="background:#fee2e2;padding:2px 6px;border-radius:3px">${v.reportShows}</code></div>` : ''}
        ${v.shouldShow ? `<div style="margin-bottom:4px;font-size:13px;"><strong style="color:#166534;">Should Show:</strong> <code style="background:#dcfce7;padding:2px 6px;border-radius:3px">${v.shouldShow}</code></div>` : ''}
        <div style="margin-bottom:6px;">${v.description}</div>
        <div style="font-size:13px;color:#2563eb;"><strong>Demand:</strong> ${v.demand}</div>
      </div>`).join('');

    const accountsHtml = (f.accounts || []).map(a => `
      <tr>
        <td>${a.accountName}</td>
        <td style="font-family:monospace">${a.accountNumber && a.accountNumber !== 'null' ? a.accountNumber : '(not shown)'}</td>
        <td><span style="padding:2px 8px;border-radius:12px;font-size:12px;background:${a.status === 'Current' ? '#dcfce7' : '#fee2e2'};color:${a.status === 'Current' ? '#166534' : '#991b1b'}">${a.status}</span></td>
        <td>${a.balance || '—'}</td>
        <td>${a.creditLimit || '—'}</td>
        <td>${a.dofd || '—'}</td>
      </tr>`).join('');

    return `
    <div style="background:white;border-radius:12px;padding:24px;margin-bottom:24px;box-shadow:0 1px 3px rgba(0,0,0,.1)">
      <h2 style="margin:0 0 4px;color:#0a1628;">${f.name}</h2>
      <div style="font-size:13px;color:#6b7280;margin-bottom:16px;">${f.address || ''} ${f.phone || ''}</div>
      ${f.accounts && f.accounts.length ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
        <thead><tr style="background:#f8fafc;text-align:left;">
          <th style="padding:8px 12px">Account</th><th style="padding:8px 12px">Number</th>
          <th style="padding:8px 12px">Status</th><th style="padding:8px 12px">Balance</th>
          <th style="padding:8px 12px">Credit Limit</th><th style="padding:8px 12px">DOFD</th>
        </tr></thead>
        <tbody>${accountsHtml}</tbody>
      </table>` : ''}
      <h3 style="color:#0a1628;margin:0 0 12px;">Violations (${(f.violations || []).length})</h3>
      ${violHtml || '<p style="color:#6b7280;font-style:italic">No violations identified</p>'}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BMB Violation Report — ${consumer.name || 'Consumer'}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, 'Times New Roman', serif; background: #f0f4f8; color: #1e293b; }
  @media print { body { background: white; } .no-print { display: none; } }
</style>
</head>
<body>
<div style="background:linear-gradient(135deg,#1a1a2e,#0f3460);color:white;padding:32px;text-align:center;" class="no-print">
  <h1 style="font-size:24px;margin-bottom:4px;">BMB AI Automation — Markup Mastery Violation Analysis</h1>
  <p style="opacity:.7">${consumer.name} &bull; ${consumer.bureau || ''} Report &bull; ${consumer.reportDate || ''}</p>
</div>

<div style="max-width:900px;margin:32px auto;padding:0 16px;">

  <!-- Summary Cards -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:32px;">
    ${[
      { label: 'Total Violations', value: summary.total || 0, color: '#0a1628', bg: '#e0e7ff' },
      { label: 'Critical', value: summary.critical || 0, color: '#dc2626', bg: '#fee2e2' },
      { label: 'High', value: summary.high || 0, color: '#ea580c', bg: '#ffedd5' },
      { label: 'Medium', value: summary.medium || 0, color: '#ca8a04', bg: '#fef9c3' },
    ].map(c => `
    <div style="background:${c.bg};border-radius:12px;padding:20px;text-align:center;">
      <div style="font-size:36px;font-weight:800;color:${c.color}">${c.value}</div>
      <div style="font-size:13px;color:${c.color};opacity:.8;margin-top:4px">${c.label}</div>
    </div>`).join('')}
  </div>

  <!-- Furnisher Sections -->
  ${furnisherHtml || '<div style="background:white;border-radius:12px;padding:32px;text-align:center;color:#6b7280">No furnishers identified in analysis.</div>'}

  <div style="text-align:center;color:#94a3b8;font-size:12px;padding:32px 0">
    Generated by BMB AI Automation — Markup Mastery Generator &bull; ${new Date().toLocaleDateString()}
  </div>
</div>
</body>
</html>`;
}

async function zipFiles(filePaths, zipPath, baseDir) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const fp of filePaths) {
      if (fs.existsSync(fp)) archive.file(fp, { name: path.basename(fp) });
    }
    archive.finalize();
  });
}

// ─── Outputs retention ────────────────────────────────────────────────────────
// Session outputs hold consumer PII (reports, letters). Sweep out old session
// dirs on startup so they don't accumulate forever. Campaign-linked retention
// replaces this once persistence lands.
function pruneOldOutputs() {
  const retentionDays = Number(process.env.OUTPUT_RETENTION_DAYS || 30);
  const outputsDir = path.join(__dirname, 'outputs');
  if (!fs.existsSync(outputsDir)) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const keep = new Set(store.listRunUuids());   // campaign-linked runs are kept
  let pruned = 0;
  for (const entry of fs.readdirSync(outputsDir)) {
    if (keep.has(entry)) continue;
    const dir = path.join(outputsDir, entry);
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        pruned++;
      }
    } catch { /* concurrent removal — ignore */ }
  }
  if (pruned > 0) console.log(`Pruned ${pruned} orphan output session(s) older than ${retentionDays} days`);
}

// ─── Start server ─────────────────────────────────────────────────────────────
loadKnowledge().then(() => {
  pruneOldOutputs();
  // Bind to loopback only — outputs and letters carry consumer PII.
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n✅ BMB AI Automation — Markup Mastery Generator running at http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to load knowledge files:', err);
  process.exit(1);
});
