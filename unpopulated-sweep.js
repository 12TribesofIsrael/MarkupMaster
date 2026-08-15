// Deterministic unpopulated-field sweep — the master-markup doctrine
// (mastermarkups/ holds the two archetype reports it reproduces).
//
// Rule: anything the report PRINTS but does not POPULATE gets a red box, and
// every box corresponds to a violation item in the letter. No model judgment
// is involved anywhere in this file: the detectors are plain pattern matches
// over the report's own text lines (text layer or OCR), and the rectangles
// they emit are drawn exactly as measured (pdf-annotator strategy 'sweep').
//
// What it finds, per the archetypes:
//  - the account-identity row (name + account number) of every audited
//    account — boxed as the anchor that ties the account's items to the page;
//    a masked number ("349993019196****") is the §1681g(a)(1) guard-2 item
//  - labeled fields printed with no value (TransUnion "Phone" with nothing
//    after it) and fields whose printed value is a bare dash (Experian
//    "Interest Type   -"), vertically merged when adjacent
//  - TransUnion payment-history columns whose Balance / Past Due / Remarks
//    all print "---" — one box per column, one big box when the whole
//    month-grid block is unpopulated
//  - Experian "ND" (no data) cells, merged when adjacent
//  - Experian dash runs inside the account's asserted history window: months
//    between Date Opened and the newest "... as of <Month Year>" narrative
//    date, where the grid then prints no data
const { normalize } = require('./pdf-annotator');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = MONTHS.map(m => m.slice(0, 3));
const MONTH_DISPLAY = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Punctuation-tolerant comparison key — OCR drops or invents dots and parens
// ("High Balance (Hist.)" ↔ "high balance hist").
function cmp(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Labels that, printed alone on their line (TransUnion prints label + value on
// one visual line, so a label-only line means the value area is empty), are
// blank-field findings. Grid row names (Balance / Past Due / Remarks / Rating)
// are deliberately absent — those repeat inside payment-history grids.
const LINE_BLANK_LABELS = [
  'address', 'phone', 'date opened', 'date closed', 'date paid out', 'date updated',
  'last payment made', 'pay status', 'terms', 'responsibility', 'account type',
  'loan type', 'original amount', 'original creditor',
  'high balance', 'high balance hist', 'credit limit', 'credit limit hist',
  'date of last activity', 'date of 1st delinquency', 'date of first delinquency',
  'estimated month and year this item will be removed',
];

// Labels whose printed value can be a bare dash (Experian's account-info
// style). Scanned at item level because two label columns share a baseline.
const DASH_LABELS = [
  'account type', 'responsibility', 'interest type', 'date opened',
  'status updated', 'recent payment', 'monthly payment', 'credit limit',
  'original balance', 'highest balance', 'terms', 'on record until',
  'balance updated', 'recent balance', 'balance', 'status',
].sort((a, b) => b.length - a.length); // longest first

const DASH_VALUE = /^[-–—_.]{1,3}$/;      // a printed "-" value (OCR variants included)
const GRID_DASH = /^[-–—~_.]{1,4}$/;      // a "---" grid cell as OCR reads it
const LABEL_ECHO = /^(balance|past|due|remarks|rating)$/; // OCR ghost-repeats of grid labels

// Masked account number: 349993019196**** / USY72XXXX / ****1234. OCR reads
// asterisks as quotes and backticks often enough that those count as mask
// characters too.
function isMaskedNumber(tok) {
  const t = String(tok || '').replace(/["'“”‘’`´°]/g, '*');
  // The middle [a-z0-9]{0,2} absorbs OCR digit-lookalikes ("60110ixxxxx"
  // reads an i for the 1).
  return /[0-9]{2,}[a-z0-9]{0,2}[x*]{2,}/i.test(t) || /^[x*]{4,}[0-9]{2,}$/i.test(t);
}

// OCR month-name matching: "une 2022", "duly 2024", "april2025" all appear in
// real output. Exact name, containment, then shared 3-char suffix/prefix.
function monthIndexFuzzy(word) {
  const w = String(word || '').toLowerCase();
  let i = MONTHS.indexOf(w);
  if (i >= 0) return i;
  if (w.length >= 3) {
    i = MONTHS.findIndex(m => m.includes(w) || w.includes(m));
    if (i >= 0) return i;
    i = MONTHS.findIndex(m => m.slice(-3) === w.slice(-3));
    if (i >= 0) return i;
    i = MONTHS.findIndex(m => m.slice(0, 3) === w.slice(0, 3));
    if (i >= 0) return i;
  }
  return -1;
}

function rectOf(items, pad = 4) {
  const minX = Math.min(...items.map(i => i.x));
  const maxX = Math.max(...items.map(i => i.x + i.w));
  const minY = Math.min(...items.map(i => i.y));
  const maxY = Math.max(...items.map(i => i.y + i.h));
  return { x: minX - pad, y: minY - pad, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2 };
}

function unionRect(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x, y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function titleCase(s) {
  return String(s).replace(/\b[a-z]/g, c => c.toUpperCase());
}

function digitsOf(s) {
  return String(s || '').replace(/[^0-9]/g, '');
}

// ── Ownership timeline ───────────────────────────────────────────────────────
// One walk over the document records which audited account's block every line
// sits in. Blocks open at a heading (TransUnion: "AMERICAN EXPRESS
// 349993019196****" as a line of its own; Experian: the bare name as a title,
// or an "Account Name <name>" label row), close at satisfactory-section
// breaks and at heading-shaped lines for accounts outside the audit, and an
// "Account Number <value>" row both records the block's own number and can
// open a block on continuation pages whose heading fell on an earlier page.
const SECTION_BREAK = /accounts (with|in) good standing|satisfactory accounts|regular accounts|inquir(y|ies)|public record|consumer statement|personal information/;

function buildNameIndex(violationsData) {
  const idx = [];
  for (const f of (violationsData.furnishers || [])) {
    for (const a of (f.accounts || [])) {
      const n = normalize(a.accountName);
      if (n.length >= 4 && !idx.some(e => e.key === n)) idx.push({ key: n, furnisher: f });
    }
    const fn = normalize(f.name);
    if (fn.length >= 4 && !idx.some(e => e.key === fn)) idx.push({ key: fn, furnisher: f });
  }
  return idx.sort((a, b) => b.key.length - a.key.length);
}

function headingEntry(lineText, nameIndex) {
  for (const e of nameIndex) {
    if (lineText === e.key || lineText.startsWith(e.key + ' ')) return e;
  }
  return null;
}

// A heading-shaped line for an account outside the audit: short line ending in
// a long digit run (optionally masked), no date separators.
function looksLikeForeignHeading(lineText) {
  const toks = lineText.split(' ');
  if (toks.length < 2 || toks.length > 8) return false;
  const last = toks[toks.length - 1].replace(/["'“”‘’`´°]/g, '*');
  if (last.includes('/') || last.includes('$')) return false;
  return /^[0-9]{6,}[x*]*$/i.test(last) || /^[0-9]{4,}[x*]{2,}$/i.test(last);
}

const AS_OF_MONTH = new RegExp(`(${MONTH_ABBR.join('|')})[a-z]*\\.? ?,? ?((?:19|20)\\d{2})`, 'g');

/**
 * Walk all pages once. Returns:
 *   sortedLines: per page, lines sorted top-down
 *   ownerOf(pi, li): the owner block a line belongs to (or null)
 *   owners: every block instance seen — { key, entry, numberText, window }
 * window = { min, max } month serials the account's own narrative asserts
 * (Date Opened month … newest "as of" month), used to gate dash-run boxing.
 */
function buildOwnership(pages, nameIndex) {
  const sortedLines = pages.map(p => [...p.lines].sort((a, b) => b.y - a.y));
  const ownerAt = sortedLines.map(ls => new Array(ls.length).fill(null));
  const owners = [];
  let owner = null;
  // Inside an inquiries / public-records / personal-info section, creditor
  // names are inquiry tiles, not account blocks — a "JPMCB CARD" there must
  // not reopen ownership. The zone ends at the next accounts-side marker.
  let deadZone = false;
  const DEAD_ZONE = /inquir(y|ies)|public record|personal information|consumer statement/;
  const LIVE_ZONE = /adverse information|satisfactory accounts|account info\b|account history|potentially negative/;

  const openOwner = (entry, numberText) => {
    owner = { key: entry.key, entry, numberText: numberText || null, window: null, headed: true };
    owners.push(owner);
    return owner;
  };
  const widen = (serial) => {
    if (!owner) return;
    if (!owner.window) owner.window = { min: serial, max: serial };
    owner.window.min = Math.min(owner.window.min, serial);
    owner.window.max = Math.max(owner.window.max, serial);
  };

  for (let pi = 0; pi < sortedLines.length; pi++) {
    for (let li = 0; li < sortedLines[pi].length; li++) {
      const L = sortedLines[pi][li];
      const cmpText = cmp(L.text);

      if (DEAD_ZONE.test(L.text)) { deadZone = true; owner = null; continue; }
      if (deadZone) {
        if (LIVE_ZONE.test(L.text)) deadZone = false;
        else continue;
      }

      const head = headingEntry(L.text, nameIndex);
      if (head) {
        const numTok = L.text.slice(head.key.length).trim().split(' ')[0] || null;
        openOwner(head, numTok);
        ownerAt[pi][li] = owner;
        continue;
      }
      if (cmpText.startsWith('account name ')) {
        const rest = L.text.replace(/^.*?account name/i, '').trim();
        const e = headingEntry(rest, nameIndex);
        if (e) { openOwner(e, null); ownerAt[pi][li] = owner; continue; }
        // A real account block whose name is NOT in the audit — a
        // good-standing tradeline. Experian headings carry no number, so
        // this label row is the only reliable close signal.
        owner = null;
        continue;
      }
      if (SECTION_BREAK.test(L.text) || (owner && looksLikeForeignHeading(L.text))) {
        owner = null;
        continue;
      }
      if (cmpText.startsWith('account number ')) {
        const raw = L.text.replace(/^.*?account number/i, '').trim().split(' ')[0];
        if (owner && raw && !owner.numberText) owner.numberText = raw;
        // Continuation page whose heading fell before page 1 of this file:
        // the number alone identifies the block.
        if (!owner && raw && digitsOf(raw).length + (raw.match(/[x*]/gi) || []).length >= 6) {
          for (const e of nameIndex) {
            for (const a of (e.furnisher.accounts || [])) {
              const d = digitsOf(a.accountNumber);
              const rd = digitsOf(raw);
              if (rd.length >= 4 && d.length >= 4 && (d.startsWith(rd) || rd.startsWith(d.slice(0, rd.length)))) {
                openOwner({ key: normalize(a.accountName), furnisher: e.furnisher }, raw);
                break;
              }
            }
            if (owner) break;
          }
        }
        ownerAt[pi][li] = owner;
        continue;
      }

      ownerAt[pi][li] = owner;

      // Narrative window for THIS block. "on record until <date>" is a purge
      // date, not history — cut it (and the removal-estimate wording) before
      // harvesting months, and only read months that follow an "as of".
      if (owner && /\bas of\b/.test(L.text)) {
        const cut = L.text.replace(/on record until[\s\S]*$/, '').replace(/estimated month[\s\S]*$/, '');
        let from = cut.indexOf('as of');
        while (from >= 0) {
          const seg = cut.slice(from);
          const nextAsOf = seg.slice(5).indexOf('as of');
          const scope = nextAsOf >= 0 ? seg.slice(0, nextAsOf + 5) : seg;
          AS_OF_MONTH.lastIndex = 0;
          let mm;
          while ((mm = AS_OF_MONTH.exec(scope)) !== null) {
            widen(Number(mm[2]) * 12 + MONTH_ABBR.indexOf(mm[1]));
          }
          from = nextAsOf >= 0 ? from + 5 + nextAsOf : -1;
        }
      }
      if (owner && cmpText.startsWith('date opened')) {
        const d = L.text.match(/(\d{1,2})\/\d{1,2}\/((?:19|20)\d{2})/);
        if (d) widen(Number(d[2]) * 12 + (Number(d[1]) - 1));
      }
    }
  }
  return { sortedLines, ownerOf: (pi, li) => ownerAt[pi][li], owners };
}

// ── Deterministic account roster ─────────────────────────────────────────────
// The report itself prints every account it contains — a heading line of
// name + (masked) number on TransUnion, an "Account Name <name>" label row on
// Experian. Reading those is pattern matching, not judgment, so the roster of
// accounts to audit comes from the paper, never from the model. The model can
// ADD narrative items on top; it can no longer make an account disappear by
// failing to list it.
const TU_HEADING = /^([a-z0-9 .,'&()\/#-]{4,48}?) ([a-z]{0,4}[0-9x*"'“”‘’`´°]{6,})$/i;

// A heading's number token must be substantial: a real account number (8+
// digits) or a masked one (2+ mask characters). Grid cells — balances like
// "70478", years like "2026" — never qualify.
function isAccountNumberToken(tok) {
  const t = String(tok || '').replace(/["'“”‘’`´°]/g, '*');
  return (t.match(/[x*]/gi) || []).length >= 2 || digitsOf(t).length >= 8;
}

// A heading's name must read like a creditor: real words, not a row of grid
// values, a field label, or a month header.
const NAME_BLOCKLIST = /^(balance|past due|remarks|rating|payment received|amount paid|scheduled payment|high balance|credit limit|total months|date|phone|address|account|estimated|page)\b/;
const MONTH_WORD = new RegExp(`\\b(${MONTHS.join('|')})\\b`, 'g');

function isCreditorName(name) {
  const n = cmp(name);
  if (n.length < 4 || NAME_BLOCKLIST.test(n)) return false;
  const alpha = (n.match(/[a-z]/g) || []).length;
  if (alpha < 4) return false;                       // mostly digits = grid row
  if ((n.match(MONTH_WORD) || []).length >= 1 && /\b(19|20)\d{2}\b/.test(n)) return false; // month header
  if (n.split(' ').length > 6) return false;
  return true;
}

function extractAccountRoster(pages) {
  const roster = [];
  const seen = new Set();
  let section = 'adverse';
  let deadZone = false;
  const push = (name, number, page) => {
    const key = cmp(name) + '|' + digitsOf(number).slice(0, 10);
    if (cmp(name).length < 4 || seen.has(key)) return;
    seen.add(key);
    roster.push({ name: name.trim(), number: (number || '').trim() || null, page, section });
  };

  for (let pi = 0; pi < pages.length; pi++) {
    const lines = [...pages[pi].lines].sort((a, b) => b.y - a.y);
    for (const L of lines) {
      const t = L.text;
      // Section markers are short header lines; prose like "…reported with no
      // adverse information…" must not flip the section back.
      if (/inquir(y|ies)|public record|consumer statement/.test(t) && t.length < 60) { deadZone = true; continue; }
      if (/adverse information|potentially negative/.test(t) && t.length < 60) { deadZone = false; section = 'adverse'; continue; }
      if (/satisfactory accounts|good standing|account history/.test(t) && t.length < 60) { deadZone = false; section = 'satisfactory'; continue; }
      if (deadZone) continue;

      // Experian: "account name <NAME>" label row (value may run into the
      // next column — cut at a known right-column label).
      const an = cmp(t).match(/^account name (.+)$/);
      if (an) {
        const name = an[1].replace(/ balance.*$/, '').replace(/ (date opened|status|account type).*$/, '');
        if (isCreditorName(name)) push(name, null, pi + 1);
        continue;
      }
      const num = cmp(t).match(/^account number ([a-z0-9x*]{6,})/);
      if (num && roster.length && roster[roster.length - 1].number == null) {
        roster[roster.length - 1].number = num[1];
        continue;
      }
      // TransUnion: the heading IS "NAME 123456789012****"
      const m = t.match(TU_HEADING);
      if (m && isCreditorName(m[1]) && isAccountNumberToken(m[2])) {
        push(m[1], m[2], pi + 1);
      }
    }
  }
  return roster;
}

/**
 * Fold the deterministic roster into violationsData: any printed account the
 * model failed to list is added (with an empty violation list — the guards
 * and the sweep then give it its items and boxes). Existing model accounts
 * are left untouched; matching is by digits, then by name.
 * Roster-only satisfactory accounts are tagged so the derogatory-only guards
 * (missing-DOFD) skip them.
 */
function mergeRosterIntoViolations(violationsData, roster) {
  const added = [];
  violationsData.furnishers = violationsData.furnishers || [];
  for (const r of roster) {
    const rDigits = digitsOf(r.number);
    let hit = null;
    for (const f of violationsData.furnishers) {
      for (const a of (f.accounts || [])) {
        const d = digitsOf(a.accountNumber);
        const bothNumbered = rDigits.length >= 6 && d.length >= 6;
        if (bothNumbered) {
          let k = 0;
          while (k < d.length && k < rDigits.length && d[k] === rDigits[k]) k++;
          // Same account = the visible digits agree essentially to the end
          // (one trailing OCR slip allowed). A shared 6-digit issuer prefix is
          // NOT identity — ten Nelnet loans all start 900000.
          if (k >= 6 && k >= Math.min(d.length, rDigits.length) - 1) { hit = a; break; }
          // Same name but different digits = a DIFFERENT account (the model
          // often collapses ten same-named student loans into one) — keep
          // looking; if nothing digit-matches, this roster entry is added.
          continue;
        }
        if (cmp(a.accountName) === cmp(r.name)) { hit = a; break; }
      }
      if (hit) break;
    }
    if (hit) continue;
    const name = r.name.toUpperCase();
    let furnisher = violationsData.furnishers.find(f => cmp(f.name) === cmp(name));
    if (!furnisher) {
      furnisher = { name, isCollector: false, accounts: [], violations: [] };
      violationsData.furnishers.push(furnisher);
    }
    furnisher.accounts = furnisher.accounts || [];
    furnisher.accounts.push({
      accountName: name,
      accountNumber: (r.number || 'NOT VISIBLE — heading only').toUpperCase(),
      dofd: null,
      dateLastActive: null,
      _rosterSection: r.section,
      _rosterAdded: true,
    });
    added.push({ name, number: r.number, page: r.page, section: r.section });
  }
  return added;
}

// ── The sweep ────────────────────────────────────────────────────────────────
/**
 * pages: pdf-annotator line structure ({ lines: [{ y, text, items, ranges }] }).
 * Returns findings: { kind, page (1-based), rect, owner, label, detail } —
 * rects in the same upright bottom-left space the annotator draws in.
 */
function sweepPages(pages, violationsData) {
  const nameIndex = buildNameIndex(violationsData);
  if (nameIndex.length === 0) return [];
  const own = buildOwnership(pages, nameIndex);
  const findings = [];

  for (let pi = 0; pi < pages.length; pi++) {
    const lines = own.sortedLines[pi];
    const pageRight = Math.max(540, ...lines.flatMap(L => L.items.map(i => i.x + i.w)));
    // Track the last "address" field row per owner for the blank-Phone gap
    // fallback below.
    let addressLine = null;

    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      const owner = own.ownerOf(pi, li);
      const cmpText = cmp(L.text);

      // Account identity rows (anchor / masked number)
      const head = headingEntry(L.text, nameIndex);
      if (head && owner) {
        const numTok = L.text.slice(head.key.length).trim().split(' ')[0] || '';
        findings.push({
          kind: isMaskedNumber(numTok) ? 'masked-number' : 'account-anchor',
          page: pi + 1, rect: rectOf(L.items), owner, label: L.text, detail: numTok || null,
        });
        continue;
      }
      if (!owner) continue;
      if (cmpText.startsWith('account number ')) {
        const raw = L.text.replace(/^.*?account number/i, '').trim().split(' ')[0];
        if (isMaskedNumber(raw)) {
          findings.push({ kind: 'masked-number', page: pi + 1, rect: rectOf(L.items), owner, label: 'account number', detail: raw });
        }
        continue;
      }
      if (cmpText.startsWith('account name ')) continue; // ownership event, boxed via anchor when audited

      // Blank labeled field: the line IS a label, value area empty.
      if (LINE_BLANK_LABELS.includes(cmpText)) {
        const rect = rectOf(L.items);
        const right = pageRight - 18;
        if (right > rect.x + rect.width) rect.width = right - rect.x;
        findings.push({ kind: 'blank-field', page: pi + 1, rect, owner, label: cmpText, detail: null });
        continue;
      }

      // Blank-Phone gap fallback (TransUnion): the faint bare "Phone" label
      // under a red-boxed row is the one word OCR reliably drops. TransUnion
      // prints Phone between Address and Date Opened; when those two rows are
      // more than a row-and-a-half apart with nothing between, the row in the
      // gap is a blank Phone.
      if (cmpText.startsWith('address ')) { addressLine = { L, owner }; continue; }
      if (cmpText.startsWith('date opened') && addressLine && addressLine.owner === owner) {
        // Adjacent rows sit ~45–50pt apart on these reports; a missing row
        // doubles that. The gap's midpoint is where the Phone row prints.
        const gap = addressLine.L.y - L.y;
        if (gap > 70 && gap < 140 &&
            !lines.some(o => o !== L && o !== addressLine.L && o.y < addressLine.L.y - 4 && o.y > L.y + 4)) {
          const labelX = Math.min(...addressLine.L.items.map(i => i.x));
          findings.push({
            kind: 'blank-field', page: pi + 1, owner, label: 'phone', detail: null,
            rect: { x: labelX - 4, y: addressLine.L.y - gap / 2 - 12, width: (pageRight - 18) - labelX + 4, height: 26 },
          });
        }
        addressLine = null;
        continue;
      }

      // Dash-valued fields (Experian): "interest type -" — possibly several
      // per visual line (two label columns share a baseline).
      for (const df of dashFields(L)) {
        findings.push({ kind: 'dash-field', page: pi + 1, rect: rectOf(df.items), owner, label: df.label, detail: '-' });
      }

      // A dash that drifted onto its own baseline ("Monthly Payment" on one
      // OCR line, its "-" 5pt away on the next) still belongs to the label
      // line beside it.
      if (DASH_VALUE.test(L.text)) {
        for (const N of lines) {
          if (N === L || Math.abs(N.y - L.y) > 12) continue;
          const lbl = trailingDashLabel(N);
          if (!lbl) continue;
          findings.push({
            kind: 'dash-field', page: pi + 1, rect: rectOf([...lbl.items, ...L.items]),
            owner, label: lbl.label, detail: '-',
          });
          break;
        }
      }
    }
  }

  findings.push(...sweepTransUnionGrids(pages, own, nameIndex));
  findings.push(...sweepExperianGrids(pages, own, nameIndex));

  // Merge vertically-adjacent dash-field boxes (the archetype draws one box
  // around "Recent Payment - / Monthly Payment - / Credit Limit -").
  return mergeVertical(findings, 'dash-field', 26);
}

// Find label→dash pairs inside one visual line at item level. A label that
// repeats on its line is a payment-grid row ("past due past due …"), never an
// account-info field — skip it there.
function dashFields(L) {
  const out = [];
  const items = L.items;
  for (let i = 0; i < items.length; i++) {
    for (const label of DASH_LABELS) {
      const labWords = label.split(' ');
      if (i + labWords.length > items.length) continue;
      const slice = items.slice(i, i + labWords.length);
      if (cmp(slice.map(s => s.str).join(' ')) !== label) continue;
      if (L.text.split(label).length > 2) continue; // repeated → grid row
      const next = items[i + labWords.length];
      if (!next || !DASH_VALUE.test(next.str.trim())) continue;
      if (next.x - (slice[slice.length - 1].x + slice[slice.length - 1].w) > 260) continue;
      out.push({ label, items: [...slice, next] });
      i += labWords.length;
      break;
    }
  }
  return out;
}

// The label at the END of a line, when it is one of the dash-value labels —
// the companion of a lone dash on the neighboring baseline.
function trailingDashLabel(L) {
  for (const label of DASH_LABELS) {
    const labWords = label.split(' ');
    if (L.items.length < labWords.length) continue;
    const slice = L.items.slice(-labWords.length);
    if (cmp(slice.map(s => s.str).join(' ')) === label && L.text.split(label).length === 2) {
      return { label, items: slice };
    }
  }
  return null;
}

// Merge same-kind findings stacked vertically with overlapping x-spans.
function mergeVertical(findings, kind, gap) {
  const rest = findings.filter(f => f.kind !== kind);
  let merged = findings.filter(f => f.kind === kind).map(f => ({ ...f }));
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const a = merged[i], b = merged[j];
        if (a.page !== b.page || a.owner !== b.owner) continue;
        const yGap = Math.max(b.rect.y - (a.rect.y + a.rect.height), a.rect.y - (b.rect.y + b.rect.height));
        const xOverlapLen = Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width) - Math.max(a.rect.x, b.rect.x);
        if (yGap >= gap || xOverlapLen <= 0.6 * Math.min(a.rect.width, b.rect.width)) continue;
        a.rect = unionRect(a.rect, b.rect);
        if (!a.label.includes(b.label)) a.label += ', ' + b.label;
        if (b.detail && a.detail !== b.detail) a.detail = [a.detail, b.detail].filter(Boolean).join(', ');
        merged.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return [...rest, ...merged];
}

// ── TransUnion month-grid detector ───────────────────────────────────────────
// Grid block: a line of ≥3 "October 2023"-style headers, then Balance /
// Past Due / Remarks / Rating label+value line pairs. A column whose three
// value cells are all missing-or-dashes is unpopulated.
const MONTH_YEAR = /([a-z]{2,12})[.,]? ?((?:19|20)\d{2})/g;
const ROW_LABELS = ['balance', 'past due', 'remarks', 'rating'];

// "October 2023"-ish columns on a line, with item geometry. OCR misreads
// month names ("une 2022", "duly 2024"), so the month is fuzzy-matched and an
// unrecognized-but-year-bearing word still yields a column (geometry is what
// the box needs; the name only feeds the letter's wording).
function monthColumns(L) {
  const cols = [];
  let m;
  MONTH_YEAR.lastIndex = 0;
  while ((m = MONTH_YEAR.exec(L.text)) !== null) {
    const items = L.ranges.filter(r => r.end > m.index && r.start < m.index + m[0].length).map(r => r.item);
    if (!items.length) continue;
    cols.push({
      month: monthIndexFuzzy(m[1]), raw: m[1], year: Number(m[2]),
      left: Math.min(...items.map(i => i.x)),
      right: Math.max(...items.map(i => i.x + i.w)),
    });
  }
  return cols;
}

function sweepTransUnionGrids(pages, own, nameIndex) {
  const findings = [];
  for (let pi = 0; pi < pages.length; pi++) {
    const lines = own.sortedLines[pi];
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      const owner = own.ownerOf(pi, li);
      if (!owner) continue;
      const cols = monthColumns(L);
      if (cols.length < 3) continue;

      // Collect the rows under this header until the next header/heading.
      const rows = {}; // label -> { valueLines: [] }
      let current = null;
      let endY = Math.min(...L.items.map(i => i.y));
      let prevY = L.y;
      for (let lj = li + 1; lj < lines.length && lj < li + 14; lj++) {
        const R = lines[lj];
        if (monthColumns(R).length >= 3 || headingEntry(R.text, nameIndex) || /total months/.test(R.text)) break;
        // Grid rows sit ~35pt apart; a bigger drop means the grid ended and
        // this is the footer or the next section — without this, the block box
        // stretches to the bottom of the page.
        if (prevY - R.y > 90 || /https?:|transunion\.com|experian\.com|account information/.test(R.text)) break;
        prevY = R.y;
        const realToks = [...new Set(R.text.split(' ').filter(Boolean))];
        const labelOnly = realToks.length <= 2 && ROW_LABELS.includes(cmp(realToks.join(' ')));
        if (labelOnly) {
          const lab = ROW_LABELS.find(rl => R.text.includes(rl));
          current = rows[lab] = rows[lab] || { valueLines: [] };
        } else if (current) {
          current.valueLines.push(R);
        }
        endY = Math.min(endY, Math.min(...R.items.map(i => i.y)));
      }
      if (!rows.balance && !rows['past due']) continue;

      // Judge each column: unpopulated when balance+past due+remarks cells
      // are all absent or dash-like. Tesseract renders a faint "---" as
      // nothing at all on all-blank pages, and as short vowel junk ("aaa",
      // "aia") or ghost repeats of the row labels when real values sit
      // nearby — all of those count as unpopulated; a real value always
      // carries a digit or a slash code.
      const DASH_JUNK = /^[aioe.,'"~_\-–—]{1,4}$/i;
      const colState = cols.map(c => {
        let empty = 0, checked = 0;
        for (const lab of ['balance', 'past due', 'remarks']) {
          const row = rows[lab];
          if (!row) continue;
          checked++;
          const cell = row.valueLines.flatMap(V => V.items)
            .filter(i => i.x + i.w > c.left - 8 && i.x < c.right + 8)
            .filter(i => !LABEL_ECHO.test(i.str.trim().toLowerCase()));
          if (cell.length === 0 || cell.every(i => GRID_DASH.test(i.str.trim()) || DASH_JUNK.test(i.str.trim()))) empty++;
        }
        return checked > 0 && empty === checked;
      });
      if (!colState.some(Boolean)) continue;

      const headerTop = Math.max(...L.items.map(i => i.y + i.h));
      const monthName = (c) => `${c.month >= 0 ? MONTH_DISPLAY[c.month] : titleCase(c.raw)} ${c.year}`;
      if (colState.every(Boolean)) {
        // Whole block unpopulated → one box around the block (archetype style)
        findings.push({
          kind: 'grid-columns', page: pi + 1, owner,
          rect: {
            x: Math.min(...cols.map(c => c.left)) - 30, y: endY - 10,
            width: (Math.max(...cols.map(c => c.right)) - Math.min(...cols.map(c => c.left))) + 60,
            height: (headerTop - endY) + 20,
          },
          label: 'payment history',
          detail: `${monthName(cols[0])} – ${monthName(cols[cols.length - 1])}`,
        });
      } else {
        colState.forEach((emptyCol, ci) => {
          if (!emptyCol) return;
          const c = cols[ci];
          findings.push({
            kind: 'grid-columns', page: pi + 1, owner,
            rect: { x: c.left - 8, y: endY - 8, width: (c.right - c.left) + 16, height: (headerTop - endY) + 16 },
            label: 'payment history', detail: monthName(c),
          });
        });
      }
    }
  }
  return findings;
}

// ── Experian grid detector: ND cells + in-window dash runs ───────────────────
function sweepExperianGrids(pages, own, nameIndex) {
  const findings = [];
  const monthColsByOwner = new Map(); // owner -> month-letter column centers

  for (let pi = 0; pi < pages.length; pi++) {
    const lines = own.sortedLines[pi];
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      const owner = own.ownerOf(pi, li);
      if (!owner) continue;

      // Month-letter header: J F M A M J J A S O N D
      const singles = L.items.filter(i => /^[jfmasond]$/i.test(i.str.trim()));
      if (singles.length >= 10) {
        monthColsByOwner.set(owner, singles.sort((a, b) => a.x - b.x).map((it, idx) => ({ idx, x: it.x + it.w / 2 })));
        continue;
      }

      // Legend lines must never be boxed
      if (/no data for this period|payment history guide|charge off$|collection$|terms met/.test(L.text)) continue;

      // Grid year row: "2025 co nd co – ..."
      const yr = L.text.match(/^((?:19|20)\d{2})(\s|$)/);
      if (!yr) continue;
      const year = Number(yr[1]);
      const yearItem = L.items.find(i => i.str.trim() === yr[1]);
      const cells = L.items.filter(i => i !== yearItem);
      const monthCols = monthColsByOwner.get(owner) || null;

      // A year row with NO cells at all: the faint dashes were too weak for
      // OCR entirely (the archetype's all-dash 2023 collection row reads as
      // just "2023"). If the account's asserted window touches that year, the
      // whole row is unreported history — box it across the grid's width.
      if (cells.length === 0 && yearItem && owner.window) {
        const inWindow = Array.from({ length: 12 }, (_, m) => year * 12 + m)
          .some(s => s >= owner.window.min && s <= owner.window.max);
        if (inWindow) {
          const right = monthCols ? Math.max(...monthCols.map(c => c.x)) + 12
            : yearItem.x + yearItem.w + 320;
          findings.push({
            kind: 'dash-run', page: pi + 1, owner, label: 'no data',
            detail: `all of ${year}`,
            rect: { x: yearItem.x - 5, y: yearItem.y - 5, width: right - yearItem.x + 10, height: yearItem.h + 10 },
          });
        }
        continue;
      }

      const colIdx = (it) => {
        if (monthCols) {
          let best = 0, bd = Infinity;
          for (const c of monthCols) {
            const d = Math.abs((it.x + it.w / 2) - c.x);
            if (d < bd) { bd = d; best = c.idx; }
          }
          return best;
        }
        return cells.filter(o => o.x < it.x).length;
      };

      // ND cells — always findings
      for (const nd of cells.filter(i => cmp(i.str) === 'nd')) {
        findings.push({
          kind: 'nd-cells', page: pi + 1, rect: rectOf([nd], 5), owner,
          label: 'nd', detail: `${MONTH_DISPLAY[Math.min(colIdx(nd), 11)]} ${year}`,
          _cell: { m: colIdx(nd), year },
        });
      }

      // Dash cells — findings only when their run overlaps the asserted
      // window (Date Opened … newest "as of" month, gathered in buildOwnership)
      const dashes = cells
        .filter(i => GRID_DASH.test(i.str.trim()) && i.str.trim().length <= 2)
        .map(i => ({ it: i, m: colIdx(i) }))
        .sort((a, b) => a.m - b.m);
      if (!dashes.length || !owner.window) continue;
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const serials = run.map(r => year * 12 + Math.min(r.m, 11));
        const overlaps = serials.some(s => s >= owner.window.min && s <= owner.window.max);
        if (overlaps) {
          const its = run.map(r => r.it);
          if (run.length === dashes.length && cells.length === dashes.length && yearItem) its.push(yearItem);
          findings.push({
            kind: 'dash-run', page: pi + 1, rect: rectOf(its, 5), owner, label: 'no data',
            detail: `${MONTH_DISPLAY[Math.min(run[0].m, 11)]}–${MONTH_DISPLAY[Math.min(run[run.length - 1].m, 11)]} ${year}`,
          });
        }
        run = [];
      };
      for (const d of dashes) {
        if (run.length && d.m - run[run.length - 1].m > 1) flush();
        run.push(d);
      }
      flush();
    }
  }
  return mergeNdCells(findings);
}

// ND merge, archetype style: adjacent cells in the SAME row merge into one
// horizontal box; single-column stacks across adjacent rows merge vertically.
// Never both — a diagonal blob would swallow populated cells.
function mergeNdCells(findings) {
  const rest = findings.filter(f => f.kind !== 'nd-cells');
  let nds = findings.filter(f => f.kind === 'nd-cells').map(f => ({ ...f }));
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < nds.length; i++) {
      for (let j = i + 1; j < nds.length; j++) {
        const a = nds[i], b = nds[j];
        if (a.page !== b.page || a.owner !== b.owner) continue;
        const yCenterDiff = Math.abs((a.rect.y + a.rect.height / 2) - (b.rect.y + b.rect.height / 2));
        const xGap = Math.max(b.rect.x - (a.rect.x + a.rect.width), a.rect.x - (b.rect.x + b.rect.width));
        const xCenterDiff = Math.abs((a.rect.x + a.rect.width / 2) - (b.rect.x + b.rect.width / 2));
        const yGap = Math.max(b.rect.y - (a.rect.y + a.rect.height), a.rect.y - (b.rect.y + b.rect.height));
        const cellW = Math.min(a.rect.width, b.rect.width);
        const sameRow = yCenterDiff < a.rect.height / 2 && xGap < cellW * 1.6;
        const sameCol = xCenterDiff < cellW * 0.8 && yGap < Math.min(a.rect.height, b.rect.height) * 1.2 &&
          a.rect.width < cellW * 1.6 && b.rect.width < cellW * 1.6;
        if (!sameRow && !sameCol) continue;
        a.rect = unionRect(a.rect, b.rect);
        if (b.detail && a.detail !== b.detail) a.detail = [a.detail, b.detail].filter(Boolean).join(', ');
        nds.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return [...rest, ...nds];
}

// ── Findings → violations ────────────────────────────────────────────────────
// "Whatever the violation says, that's what the box should be": every sweep
// box is attached to a letter item, and those items' boxes are the measured
// rectangles — never a re-search. Existing items (model or guards 1–4) absorb
// matching findings; what's left is injected as grouped per-account items.

// Resolve a finding's owner block to the audited account it belongs to.
// Two accounts can share a name (both AmEx cards on the Experian archetype),
// so the block's own account number breaks the tie by longest shared digit
// prefix.
function resolveAccount(owner) {
  const f = owner.entry.furnisher;
  const named = (f.accounts || []).filter(a => normalize(a.accountName) === owner.key);
  const cands = named.length ? named : (f.accounts || []);
  const blockDigits = digitsOf(owner.numberText);
  // The block printed its own account number: it must agree with the audited
  // account's digits. A same-named tradeline with a different number is a
  // different (good-standing, unaudited) account — never box it under the
  // audited one's letter items.
  if (blockDigits.length >= 4) {
    let best = null, bestLen = 3;
    for (const a of cands) {
      const d = digitsOf(a.accountNumber);
      let k = 0;
      while (k < d.length && k < blockDigits.length && d[k] === blockDigits[k]) k++;
      if (k > bestLen) { bestLen = k; best = a; }
    }
    return { furnisher: f, account: best };
  }
  return { furnisher: f, account: cands[0] || null };
}

function sweepMark(fileName, fnd, section, markText) {
  return {
    page: fnd.page,
    section,
    markText,
    sweep: { file: fileName, page: fnd.page, rect: fnd.rect },
  };
}

// Insert a violation right after the account's existing items so the letter
// reads account-by-account.
function insertForAccount(violations, accountName, v) {
  let at = violations.length;
  for (let i = violations.length - 1; i >= 0; i--) {
    if (violations[i].accountName === accountName) { at = i + 1; break; }
  }
  violations.splice(at, 0, v);
}

/**
 * Fold one file's sweep findings into violationsData. `fileName` is the
 * uploaded file's original name — sweep marks only ever draw on that file.
 * Returns a summary for the console/annotation log.
 */
function injectSweepViolations(violationsData, findings, fileName) {
  const summary = { anchors: 0, masked: 0, blankFields: 0, gridMarks: 0, newItems: 0, unattributed: 0 };
  const grouped = new Map(); // account -> { fields: [], grid: [], resolved }

  for (const fnd of findings) {
    if (!fnd.owner || !fnd.owner.entry) { summary.unattributed++; continue; }
    const resolved = resolveAccount(fnd.owner);
    if (!resolved.account) { summary.unattributed++; continue; }
    const acctName = resolved.account.accountName;
    const acctDigits = digitsOf(resolved.account.accountNumber) || acctName;
    const violations = resolved.furnisher.violations = resolved.furnisher.violations || [];
    const byAcct = (re) => violations.find(v => v.accountName === acctName && re.test(String(v.title || '')));
    const key = `${resolved.furnisher.name} ${acctName} ${acctDigits}`;
    if (!grouped.has(key)) grouped.set(key, { fields: [], grid: [], anchors: [], resolved });
    const g = grouped.get(key);

    switch (fnd.kind) {
      case 'masked-number': {
        // The §1681g(a)(1) truncation item (guard 2 guarantees one exists when
        // the model's own account number is masked; the report can be masked
        // even when the model recorded more, so create it if absent). A
        // furnisher can hold several same-named accounts (three AmEx cards on
        // the archetype), so the digits must agree too, not just the name.
        const sharePrefix = (a, b) => {
          let k = 0;
          while (k < a.length && k < b.length && a[k] === b[k]) k++;
          return k >= 4;
        };
        let v = violations.find(x => x.accountName === acctName &&
          /TRUNCAT|ACCOUNT NUMBER/i.test(String(x.title || '')) &&
          (x._sweepAcct ? x._sweepAcct === acctDigits : sharePrefix(digitsOf(x.reportShows), digitsOf(fnd.detail))));
        if (!v) {
          v = {
            accountName: acctName,
            title: 'TRUNCATED ACCOUNT NUMBER PREVENTS CONSUMER VERIFICATION',
            severity: 'CRITICAL',
            statute: 'FCRA §1681g(a)(1)',
            issueType: 'Incomplete field',
            reportShows: fnd.detail || 'masked account number',
            shouldShow: 'Full account number sufficient for the consumer to identify and verify the account',
            description: `The account number is displayed as "${fnd.detail || 'a masked value'}" — masked to the point that the consumer cannot independently verify that this tradeline belongs to them.`,
            impact: 'The consumer cannot verify the account, dispute specific entries, or confirm the tradeline is theirs.',
            precedent: null,
            demand: 'Provide the full account number or delete the tradeline.',
            disputeWording: `The account number is shown only as "${fnd.detail || 'a masked value'}." I cannot tell from this masked number whether this account is actually mine.`,
            remedyType: 'explain',
            remedyWording: 'Please provide the full account number so I can verify this account, or delete it.',
            internalContradiction: null,
            markup: [],
            _sweepInjected: true,
            _sweepAcct: acctDigits,
          };
          insertForAccount(violations, acctName, v);
          summary.newItems++;
        }
        // The measured rectangle replaces any account-number text-search mark
        // — same target, exact geometry.
        v.markup = (v.markup || []).filter(m => m.sweep || !/account number/i.test(String(m.markText || '')));
        v.markup.unshift(sweepMark(fileName, fnd, 'Account identification', `Account number shown as "${fnd.detail || 'masked'}"`));
        summary.masked++;
        break;
      }
      case 'account-anchor': {
        // Identity row box — attached at group-flush time so it can land on
        // this exact account's own sweep item when one exists.
        g.anchors.push(fnd);
        break;
      }
      case 'blank-field':
      case 'dash-field': {
        const labels = fnd.label.split(', ');
        // DOFD / DOLA blanks belong to guards 3 & 4 — hand them the rectangle.
        const dofd = labels.some(l => /date of (1st|first) delinquency/.test(l));
        const dola = labels.some(l => /date of last activity/.test(l));
        const target = dofd ? byAcct(/DOFD|(FIRST|1ST) DELINQUENCY/i)
          : dola ? byAcct(/LAST ACTIVITY/i)
          : null;
        const display = labels.map(titleCase).join(', ');
        if (target) {
          target.markup = (target.markup || []).filter(m => m.sweep || !/delinquency|last activity/i.test(String(m.markText || '')));
          target.markup.unshift(sweepMark(fileName, fnd, 'Account Information', `${display}: (blank)`));
          summary.blankFields++;
        } else {
          // An existing item already about this exact blank field absorbs it.
          const existing = labels.length === 1 &&
            violations.find(v => v.accountName === acctName &&
              /BLANK|MISSING|EMPTY|NOT (PRESENT|REPORTED)|OMITTED/i.test(String(v.title || '')) &&
              String(v.title || '').toUpperCase().includes(labels[0].toUpperCase()));
          if (existing) {
            existing.markup = existing.markup || [];
            existing.markup.unshift(sweepMark(fileName, fnd, 'Account Information', `${display}: (blank)`));
            summary.blankFields++;
          } else {
            g.fields.push({ fnd, display });
          }
        }
        break;
      }
      case 'grid-columns':
      case 'nd-cells':
      case 'dash-run': {
        g.grid.push(fnd);
        break;
      }
      default:
        break;
    }
  }

  // Grouped items: one blank-fields item and one payment-history item per
  // account, carrying every remaining rectangle for that account. Groups are
  // tagged with the account's digits so a furnisher's same-named accounts
  // (three AmEx cards) each keep their own items.
  for (const { fields, grid, anchors, resolved } of grouped.values()) {
    const acctName = resolved.account.accountName;
    const acctDigits = digitsOf(resolved.account.accountNumber) || acctName;
    const violations = resolved.furnisher.violations;

    if (fields.length) {
      const list = [...new Set(fields.map(f => f.display))].join('; ');
      const v = violations.find(x => x.accountName === acctName && x._sweepBlankGroup === acctDigits);
      const marks = fields.map(f => sweepMark(fileName, f.fnd, 'Account Information', `${f.display}: (blank)`));
      if (v) {
        v.markup.push(...marks);
        v.reportShows += `; ${list}`;
      } else {
        insertForAccount(violations, acctName, {
          accountName: acctName,
          title: 'ACCOUNT FIELDS PRINTED BUT LEFT EMPTY',
          severity: 'HIGH',
          statute: 'FCRA §1681g(a)',
          issueType: 'Blank field',
          reportShows: list,
          shouldShow: 'Each printed field populated, or omitted entirely',
          description: `The report prints the following field labels for this account and leaves the values empty: ${list}. A file disclosure the consumer cannot read complete information from does not satisfy §1681g(a).`,
          impact: 'The consumer cannot verify these aspects of the tradeline or reconcile them against their own records.',
          precedent: null,
          demand: 'Report the information for each empty field, or state in writing that there is none.',
          disputeWording: `For this account, these fields are printed on my report with nothing in them: ${list}. Please fill in the actual information for each one, or tell me in writing why each is blank.`,
          remedyType: 'explain',
          remedyWording: 'Please provide the missing information for each blank field, or confirm in writing that none exists.',
          internalContradiction: null,
          markup: marks,
          _sweepInjected: true,
          _sweepAcct: acctDigits,
          _sweepBlankGroup: acctDigits,
        });
        summary.newItems++;
      }
      summary.blankFields += fields.length;
    }

    if (grid.length) {
      const ranges = [...new Set(grid.map(f => f.detail).filter(Boolean))].join('; ');
      const existing = violations.find(x => x.accountName === acctName &&
        (x._sweepGridGroup === acctDigits || (!x._sweepGridGroup &&
          /PAYMENT HISTORY/i.test(String(x.title || '')) &&
          /BLANK|MISSING|EMPTY|NO DATA|UNPOPULATED|NOT REPORTED/i.test(String(x.title || '')))));
      const marks = grid.map(f => sweepMark(fileName, f, 'Payment History',
        `Payment history ${f.detail || ''}: no data reported`.trim()));
      if (existing) {
        existing.markup = existing.markup || [];
        existing.markup.push(...marks);
        if (existing._sweepGridGroup) existing.reportShows += `; ${ranges}`;
      } else {
        insertForAccount(violations, acctName, {
          accountName: acctName,
          title: 'PAYMENT HISTORY PRINTS NO DATA',
          severity: 'HIGH',
          statute: 'FCRA §1681g(a)(1); §1681e(b)',
          issueType: 'Incomplete field',
          reportShows: `No data in payment history: ${ranges}`,
          shouldShow: 'The actual month-by-month payment history for every period the grid prints',
          description: `The payment-history grid for this account prints no information (blank, "---", or "ND" cells) for: ${ranges}. The tradeline reports derogatory status, yet the month-by-month record that would let the consumer verify that status is not disclosed.`,
          impact: 'The consumer cannot reconcile the account\'s claimed delinquencies against an actual payment record.',
          precedent: null,
          demand: 'Report the actual month-by-month payment history for these periods, or state in writing that none exists.',
          disputeWording: `The payment history for this account shows no information at all for these months: ${ranges}. What is the actual month-by-month history for those periods?`,
          remedyType: 'explain',
          remedyWording: 'Please report the actual payment history for these months, or confirm in writing that no data exists.',
          internalContradiction: null,
          markup: marks,
          _sweepInjected: true,
          _sweepAcct: acctDigits,
          _sweepGridGroup: acctDigits,
        });
        summary.newItems++;
      }
      summary.gridMarks += grid.length;
    }

    // Anchors: box the identity row and attach it to this exact account's own
    // sweep item when one exists (digit-tagged); otherwise the account's first
    // name-matching violation carries it.
    for (const fnd of anchors) {
      const v = violations.find(x => x._sweepAcct === acctDigits) ||
        violations.find(x => x.accountName === acctName) || violations[0];
      if (!v) { summary.unattributed++; continue; }
      v.markup = v.markup || [];
      v.markup.push(sweepMark(fileName, fnd, 'Account identification', `Account heading — ${titleCase(fnd.label)}`));
      summary.anchors++;
    }
  }

  // Item numbers are global per furnisher and the letter keys off them —
  // renumber after every splice, exactly like the server guards do.
  for (const f of (violationsData.furnishers || [])) {
    (f.violations || []).forEach((v, i) => { v.number = i + 1; });
  }
  return summary;
}

module.exports = { sweepPages, injectSweepViolations, extractAccountRoster, mergeRosterIntoViolations };
