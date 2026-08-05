const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle, Table, TableRow, TableCell,
  WidthType, ShadingType, UnderlineType, Tab, TabStopType, TabStopPosition,
} = require('docx');
const fs = require('fs');
const { getCRA } = require('./cra-addresses');

// ─── Constants ────────────────────────────────────────────────────────────────
const FONT = 'Times New Roman';
const FONT_BODY = 11;   // pt  (docx sz = pt * 2)
const sz = pt => pt * 2;

// ─── Shared Helpers ───────────────────────────────────────────────────────────

function blank(after = 80) {
  return new Paragraph({ spacing: { after } });
}

function makeBanner(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 100, after: 100 },
    border: {
      top:    { style: BorderStyle.SINGLE, size: 4, color: '000000' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000' },
    },
    shading: { type: ShadingType.SOLID, color: '000000', fill: '000000' },
    children: [
      new TextRun({ text, bold: true, color: 'FFFFFF', size: sz(11), font: FONT }),
    ],
  });
}

function makeSectionHeading(roman, title) {
  return new Paragraph({
    spacing: { before: 240, after: 100 },
    border: {
      bottom: { style: BorderStyle.DOUBLE, size: 4, color: '000000' },
    },
    children: [
      new TextRun({ text: `${roman}.  ${title}`, bold: true, size: sz(FONT_BODY), font: FONT }),
    ],
  });
}

function makeSubHeading(text) {
  return new Paragraph({
    spacing: { before: 160, after: 60 },
    children: [
      new TextRun({ text, bold: true, underline: { type: UnderlineType.SINGLE }, size: sz(FONT_BODY), font: FONT }),
    ],
  });
}

function makeBody(text, opts = {}) {
  return new Paragraph({
    spacing: { before: opts.before || 60, after: opts.after || 60 },
    indent: opts.indent ? { left: 360 } : undefined,
    children: [
      new TextRun({ text, size: sz(FONT_BODY), font: FONT, bold: opts.bold, italics: opts.italic }),
    ],
  });
}

function makeLabelValue(label, value) {
  return new Paragraph({
    spacing: { before: 40, after: 40 },
    children: [
      new TextRun({ text: `${label.padEnd(16)}`, bold: true, size: sz(FONT_BODY), font: FONT }),
      new TextRun({ text: value, size: sz(FONT_BODY), font: FONT }),
    ],
  });
}

function makeHRule() {
  return new Paragraph({
    spacing: { before: 120, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: '888888' } },
    children: [],
  });
}

function makeSimpleTable(headers, rows) {
  const headerCells = headers.map(h => new TableCell({
    shading: { type: ShadingType.SOLID, color: '222222', fill: '222222' },
    children: [new Paragraph({
      children: [new TextRun({ text: h, bold: true, color: 'FFFFFF', size: sz(10), font: FONT })],
    })],
  }));

  const dataRows = rows.map(row => new TableRow({
    children: row.map(cell => new TableCell({
      children: [new Paragraph({
        children: [new TextRun({ text: cell || '', size: sz(10), font: FONT })],
      })],
    })),
  }));

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: headerCells, tableHeader: true }),
      ...dataRows,
    ],
  });
}

function makeDoc(children) {
  return new Document({
    sections: [{
      properties: {
        page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } },
      },
      children,
    }],
  });
}

// Placeholder for identity fields the consumer hasn't typed in yet — the
// blank renders in the letter so the user fills it in by hand before mailing.
const idVal = (v, width = 24) => (v && String(v).trim()) || '_'.repeat(width);

// Unique, non-null report pages a violation's red boxes land on.
function markupPages(v) {
  const pages = [...new Set((v.markup || []).map(m => m.page).filter(p => p != null))];
  return pages;
}

// Fallback wording when the model omitted disputeWording (older runs).
function wordingOf(v) {
  if (v.disputeWording) {
    // Older runs baked a blanket remedy tail into the wording; the remedy is
    // now its own per-item sentence, so strip the legacy tail.
    return String(v.disputeWording).replace(/\s*Please fix or delete this entire account\.?\s*$/i, '').trim();
  }
  return v.reportShows && v.reportShows !== 'FIELD NOT PRESENT'
    ? `The report shows "${v.reportShows}" for ${v.title ? v.title.toLowerCase() : 'this field'}, which is inaccurate or inconsistent.`
    : `${v.title ? v.title.charAt(0) + v.title.slice(1).toLowerCase() : 'A required field'} is missing or blank on this account.`;
}

function remedyOf(v) {
  if (v.remedyWording) return v.remedyWording;
  return 'Please correct this, or delete this account if you cannot verify it as complete and accurate.';
}

// ─── WATTS DISPUTE LETTER (the only mailed dispute instrument) ────────────────
//
// Doctrine (John G. Watts): plain English, no statute citations, cooperative
// tone, per-item specificity, exact remedy per item, ID + address proof
// enclosed, circled report pages enclosed, full copy cc'd to every furnisher,
// written-explanation demand as the willfulness record.

async function generateWattsLetterDocx(violationsData, clientIdentity = {}, options = {}, outputPath) {
  const consumer = (violationsData && violationsData.consumer) || {};
  const furnishers = (violationsData && violationsData.furnishers) || [];
  const cra = getCRA(consumer.bureau);
  const round = options.round || 1;
  const prior = options.prior || {};

  const dateLine = options.mailDate
    || '[DATE MAILED — fill in the day you actually mail this letter]';
  const phone = idVal(clientIdentity.phone, 18);
  const email = idVal(clientIdentity.email, 24);
  const proofName = (clientIdentity.proofOfAddress && String(clientIdentity.proofOfAddress).trim())
    || 'a recent utility bill or bank statement';

  const children = [
    makeBanner('VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED'),
    blank(),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: dateLine, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    blank(),
    new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: cra.name, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    ...(cra.dept ? [makeBody(cra.dept)] : []),
    makeBody(cra.addr),
    makeBody(cra.city),
    blank(),

    // Full identity block — anticipates and defeats the "we don't think this
    // is really you" stall letter.
    makeLabelValue('From:', consumer.name || '[Consumer Name]'),
    makeLabelValue('Address:', consumer.address || '[Consumer Address]'),
    makeLabelValue('Phone:', phone + (clientIdentity.phone2 ? `  /  ${clientIdentity.phone2}` : '')),
    makeLabelValue('Email:', email),
    makeLabelValue('Date of birth:', idVal(clientIdentity.dob, 14)),
    makeLabelValue('SSN:', idVal(clientIdentity.ssn, 14)),
    ...(clientIdentity.formerNames ? [makeLabelValue('Former name(s):', clientIdentity.formerNames)] : []),
    blank(),

    makeBody(`RE: Dispute of inaccurate information on my ${consumer.bureau || ''} credit report (report dated ${consumer.reportDate || '[report date]'})`, { bold: true }),
  ];

  if (round >= 2) {
    children.push(makeBody(round >= 3 ? 'THIRD AND FINAL NOTICE' : 'SECOND NOTICE — FINAL NOTICE BEFORE I TAKE FURTHER ACTION', { bold: true }));
  }

  children.push(makeHRule());
  children.push(makeBody('To whom it may concern:'));

  if (round >= 2) {
    const sent = prior.mailDate ? ` on ${prior.mailDate}` : '';
    const trk = prior.tracking ? ` (certified mail tracking number ${prior.tracking})` : '';
    const dlv = prior.deliveredDate ? `, and it was delivered on ${prior.deliveredDate}` : '';
    children.push(makeBody(`This is not my first letter about these errors. I mailed you a dispute about these exact same items${sent} by certified mail${trk}${dlv}. You responded that you verified the items listed below, but you did not fix them. The errors are still on my report, and they are still wrong for the same reasons I explained before. I am asking you again to actually look at what your own report says and correct it.`));
  }

  children.push(makeBody(`I have personally reviewed my ${consumer.bureau || ''} credit report and it contains errors. So you can be sure this letter really is from me, I have enclosed a copy of my government-issued photo ID and ${proofName} showing my name and current address. I have also enclosed the pages of my credit report with each error circled in red.`));
  children.push(makeBody('Here are the errors, listed account by account. For each one I explain what is wrong, why it is wrong, and exactly what I am asking you to do.'));
  children.push(blank(80));

  let itemNo = 0;
  for (const f of furnishers) {
    const violations = f.violations || [];
    if (violations.length === 0) continue;
    const acctNums = (f.accounts || []).map(a => a.accountNumber).filter(Boolean).join(', ');
    children.push(makeSubHeading(`${f.name.toUpperCase()}${acctNums ? ` — Account ${acctNums}` : ''}`));
    for (const v of violations) {
      itemNo++;
      const pages = markupPages(v);
      const proofSentence = pages.length > 0
        ? ` See the circled item on enclosed report page ${pages.join(' and page ')}.`
        : '';
      children.push(new Paragraph({
        spacing: { before: 80, after: 80 },
        indent: { left: 360 },
        children: [
          new TextRun({ text: `${itemNo}.  `, bold: true, size: sz(FONT_BODY), font: FONT }),
          new TextRun({ text: `${wordingOf(v)}${proofSentence} `, size: sz(FONT_BODY), font: FONT }),
          new TextRun({ text: remedyOf(v), bold: true, size: sz(FONT_BODY), font: FONT }),
        ],
      }));
    }
  }

  children.push(blank(80));
  // Willfulness scaffold — written for the future judge, in consumer words.
  children.push(makeBody('If, after your investigation, you decide to keep any of the items above on my report, please send me a written explanation of what you reviewed for that item and copies of the documents you relied on. If an item cannot be verified as complete and accurate, please delete it.'));
  children.push(makeBody('Please send me the results of your investigation and an updated copy of my credit report showing the corrections, and notify anyone who received my report of the corrections, as applicable.'));
  children.push(makeBody(`I expect you to take this letter seriously, and I am confident you will fix these errors. If anything about my request is unclear, please write to me at my address above, call me at ${phone}, or email me at ${email} — I am happy to answer questions or send anything else you need.`));
  children.push(blank(120));
  children.push(makeBody('Sincerely,'));
  children.push(blank(200));
  children.push(makeBody('_________________________________'));
  children.push(makeBody(consumer.name || '[Consumer Name]', { bold: true }));
  children.push(makeBody(consumer.address || '[Consumer Address]'));
  children.push(blank(120));

  // Enclosures — listed so the record shows exactly what was sent.
  children.push(makeBody('Enclosures:', { bold: true }));
  children.push(makeBody('1.  Copy of my government-issued photo ID', { indent: true }));
  children.push(makeBody(`2.  Copy of ${proofName} showing my name and current address`, { indent: true }));
  children.push(makeBody('3.  Pages of my credit report with each error circled in red', { indent: true }));
  children.push(blank(80));

  // Every furnisher receives a COMPLETE copy of this letter with all
  // enclosures — the furnisher is judged by the notice it had.
  const withViolations = furnishers.filter(f => (f.violations || []).length > 0);
  if (withViolations.length > 0) {
    children.push(makeBody('cc (each sent a complete copy of this letter with all enclosures, by certified mail):', { bold: true }));
    withViolations.forEach((f, i) => {
      children.push(makeBody(`${i + 1}.  ${f.name}${f.address ? `, ${f.address}` : ' — [address as shown on my credit report]'}`, { indent: true }));
    });
    children.push(blank(80));
  }

  // Consumer-side record keeping (filled in by hand at the post office).
  children.push(makeBody('For my records — certified mail tracking:', { bold: true }));
  children.push(makeBody('Tracking # (this letter): ________________________________', { indent: true }));
  children.push(makeBody('Date mailed: ____________________   Return receipt received: ____________________', { indent: true }));

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── LITIGATION MEMO (internal — never mailed) ───────────────────────────────
//
// Holds everything that was deliberately stripped out of the mailed letter:
// statute mapping, case law, damages math, SOL tracking, and the event
// chronology. Its JSON sidecar is structured to populate the federal
// complaint template (docs/BMB_Federal_Complaint_Template_NEW.md) counts:
//   COUNT I  — 15 U.S.C. §1681i   (CRA reinvestigation)
//   COUNT II — 15 U.S.C. §1681e(b) (maximum possible accuracy)
//   COUNT III— 15 U.S.C. §1681s-2(b) (furnisher investigation)
// plus §1681g (separate file-request letter) and FDCPA §1692e(8) for
// collector furnishers.

const CASE_BANK = [
  { cite: 'Kelly v. RealPage Inc., 47 F.4th 202 (3d Cir. 2022)', binding: '3d Cir. — BINDING in Delaware', holding: 'A plain-language request for the consumer\'s "full file" is legally sufficient under §1681g; supplies the §1681g violation theory and the standing analysis.' },
  { cite: 'Seamans v. Temple Univ., 744 F.3d 853 (3d Cir. 2014)', binding: '3d Cir. — BINDING in Delaware', holding: 'Reporting that is technically accurate but materially incomplete or misleading is actionable; supports incomplete-field and payment-history-gap items.' },
  { cite: 'Cushman v. Trans Union Corp., 115 F.3d 220 (3d Cir. 1997)', binding: '3d Cir. — BINDING in Delaware', holding: 'A CRA may not simply parrot the furnisher\'s verification; §1681i requires an independent, reasonable reinvestigation.' },
  { cite: 'Gillespie v. Equifax Info. Servs. LLC, 484 F.3d 938 (7th Cir. 2007)', binding: '7th Cir. — persuasive', holding: 'File disclosure must be complete enough for the consumer to identify and verify accounts; supports truncated-account-number items.' },
  { cite: 'Chiang v. Verizon New England Inc., 595 F.3d 26 (1st Cir. 2010)', binding: '1st Cir. — persuasive', holding: 'The specificity of the consumer\'s dispute defines the scope of the investigation owed — the reason the mailed letter itemizes every error at field level.' },
  { cite: 'Bradshaw v. BAC Home Loans Servicing, LP, 816 F. Supp. 2d 1066 (D. Or. 2011)', binding: 'D. Or. — persuasive', holding: 'Boilerplate e-OSCAR verification is not a reasonable investigation under §1681s-2(b).' },
  { cite: 'Morris v. Carrington Mortgage Servs. (see Watts corpus)', binding: 'persuasive', holding: 'The furnisher is judged largely by the notice the CRA gives it — the reason every furnisher is cc\'d a complete copy of the dispute letter.' },
];

function statuteTags(v, furnisher) {
  const s = String(v.statute || '');
  const tags = new Set();
  if (/1681e\(b\)/i.test(s)) tags.add('§1681e(b)');
  if (/1681i/i.test(s)) tags.add('§1681i');
  if (/1681g/i.test(s)) tags.add('§1681g');
  if (/1681c/i.test(s)) tags.add('§1681c(a)');
  if (/1681s-2/i.test(s)) tags.add('§1681s-2(b)');
  if (tags.size === 0) tags.add('§1681e(b)'); // inaccuracy/incompleteness default
  if (furnisher && furnisher.isCollector === true) tags.add('FDCPA §1692e(8)');
  return [...tags];
}

async function generateLitigationMemoDocx(violationsData, memoContext = {}, outputPath, jsonPath) {
  const consumer = (violationsData && violationsData.consumer) || {};
  const furnishers = (violationsData && violationsData.furnishers) || [];
  const events = memoContext.events || [];
  const solDeadline = memoContext.solDeadline || null;
  // Map "furnisher||account||title" → lifecycle status (from violation_items).
  const itemStatuses = memoContext.itemStatuses || {};
  const statusOf = (f, v) => itemStatuses[`${f.name}||${v.accountName || ''}||${v.title || ''}`] || null;

  const children = [
    makeBanner('INTERNAL LITIGATION MEMO — DO NOT MAIL'),
    makeBody('This memo is the litigation-side record of the dispute. The mailed letter deliberately contains no statutes or case law (a plain factual dispute raises the investigation owed and cannot be brushed off as credit-repair boilerplate); this memo maps every mailed item to its statutory hooks for the lawsuit that follows if the errors are verified without correction.', { italic: true }),
    makeHRule(),

    makeSectionHeading('I', 'PARTIES & REPORT'),
    makeLabelValue('Consumer:', consumer.name || '[Consumer Name]'),
    makeLabelValue('CRA:', `${consumer.bureau || '[Bureau]'} (prospective defendant under §§1681i, 1681e(b), 1681g)`),
    makeLabelValue('Report date:', consumer.reportDate || '[report date]'),
  ];

  furnishers.forEach(f => {
    if ((f.violations || []).length === 0) return;
    children.push(makeBody(`Furnisher: ${f.name}${f.isCollector === true ? '  — COLLECTOR/DEBT BUYER (adds FDCPA §1692e(8) exposure)' : ''} (prospective defendant under §1681s-2(b))`, { indent: true }));
  });

  children.push(makeSectionHeading('II', 'VIOLATION-TO-STATUTE MAP'));
  children.push(makeBody('Item numbers match the mailed dispute letter and the Markup Map. Every item, once disputed to the CRA and verified without correction, supports the §1681i claim against the CRA and the §1681s-2(b) claim against the furnisher; the statute column lists the additional specific hooks.'));

  const hasStatuses = Object.keys(itemStatuses).length > 0;
  const rows = [];
  let itemNo = 0;
  for (const f of furnishers) {
    for (const v of (f.violations || [])) {
      itemNo++;
      const row = [
        String(itemNo),
        v.accountName || f.name,
        v.title || '',
        v.severity || '',
        statuteTags(v, f).join('; '),
        `${v.remedyType || 'correct'} — ${v.remedyWording || v.demand || ''}`,
      ];
      if (hasStatuses) row.push((statusOf(f, v) || 'open').replace(/_/g, ' '));
      rows.push(row);
    }
  }
  const headers = ['#', 'Account', 'Violation', 'Severity', 'Statutory hooks', 'Remedy sought'];
  if (hasStatuses) headers.push('Status');
  children.push(makeSimpleTable(headers, rows));
  if (hasStatuses) {
    const verifiedCount = Object.values(itemStatuses).filter(s => s === 'verified_unchanged' || s === 'escalated').length;
    if (verifiedCount > 0) {
      children.push(makeBody(`${verifiedCount} item(s) were VERIFIED WITHOUT CORRECTION after a documented certified-mail dispute — each is a completed reinvestigation failure and the core of the §1681i / §1681s-2(b) counts.`, { bold: true }));
    }
  }
  children.push(blank());

  children.push(makeSectionHeading('III', 'CLAIM THEORIES'));
  children.push(makeBody('§1681i (reinvestigation): reaches any item in the consumer FILE; requires an actual inaccuracy (accurate reporting is a complete defense) but no third-party publication. This dispute letter is the claim-creating act; the 30-day clock runs from CRA receipt.', { indent: true }));
  children.push(makeBody('§1681e(b) (maximum possible accuracy): REQUIRES publication — a third party must have received a report containing the error. Track credit pulls/denials after the failed reinvestigation; a turndown after the botched investigation is the damages core.', { indent: true }));
  children.push(makeBody('§1681s-2(b) (furnisher duties): triggered ONLY by the CRA forwarding the dispute — never by direct letters to the furnisher. The cc copy does not trigger duties by itself, but once the CRA notice arrives the furnisher must consider the full letter it was sent. Plead in the alternative: the CRA forwarded the dispute, or alternatively failed to (deepening the CRA\'s own liability).', { indent: true }));
  children.push(makeBody('§1681g (file disclosure): a separate claim built by the separate plain-language full-file request letter (Kelly v. RealPage). If the CRA answers with the standard consumer report instead of the full file, that failure is its own count.', { indent: true }));
  const collectors = furnishers.filter(f => f.isCollector === true && (f.violations || []).length > 0);
  if (collectors.length > 0) {
    children.push(makeBody(`FDCPA §1692e(8) (collectors: ${collectors.map(f => f.name).join(', ')}): a debt collector who reports after this dispute without flagging the debt as disputed makes a false representation. Proof pattern: dispute date (certified receipt) + post-dispute report update lacking the disputed flag.`, { indent: true }));
  }

  children.push(makeSectionHeading('IV', 'CASE-LAW BANK (Delaware / 3d Circuit first)'));
  for (const c of CASE_BANK) {
    children.push(makeBody(`${c.cite} [${c.binding}] — ${c.holding}`, { indent: true }));
  }
  children.push(makeBody('VERIFY every citation against the primary source before it goes into any filing.', { bold: true }));

  children.push(makeSectionHeading('V', 'DAMAGES INPUTS'));
  const total = itemNo;
  children.push(makeBody(`Violations documented: ${total}. Willful noncompliance (§1681n): statutory damages $100–$1,000 per violation → $${(total * 100).toLocaleString()}–$${(total * 1000).toLocaleString()}, plus punitive damages and fees. Negligent (§1681o): actual damages plus fees.`));
  children.push(makeBody('Actual damages to document: credit denials AFTER the failed reinvestigation, higher rates/deposits, and emotional distress the consumer can articulate concretely. Build the timeline; never apply for credit purely to manufacture a denial.', { indent: true }));

  children.push(makeSectionHeading('VI', 'STATUTE OF LIMITATIONS'));
  children.push(makeBody(solDeadline
    ? `FCRA SOL deadline on file: ${solDeadline} (2 years from the results of investigation; outer limit 5 years from violation — §1681p).`
    : 'FCRA §1681p: earlier of 2 years after discovery or 5 years after the violation. Practical trigger: the date the results of investigation arrive — recorded automatically once campaign tracking logs it.'));

  children.push(makeSectionHeading('VII', 'EVENT CHRONOLOGY (the willfulness record)'));
  if (events.length > 0) {
    children.push(makeSimpleTable(
      ['Date', 'Event', 'Details'],
      events.map(e => [e.event_date || '', e.type || '', typeof e.details === 'string' ? e.details : JSON.stringify(e.details || '')])
    ));
  } else {
    children.push(makeBody('No events recorded yet. Once the campaign tracker logs the mailing date, tracking number, delivery, results, calls, and later rounds, this table becomes the chronology that gets pleaded — certified-letter dates bracketing the CRA\'s own responses are what proves willfulness.', { italic: true }));
  }

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  if (jsonPath) {
    // Machine-readable sidecar, keyed for the federal complaint template.
    const perViolationStatutes = [];
    let n = 0;
    const counts = { '1681i': [], '1681e(b)': [], '1681g': [], '1681s-2(b)': [], '1681c(a)': [], 'FDCPA 1692e(8)': [] };
    for (const f of furnishers) {
      for (const v of (f.violations || [])) {
        n++;
        const tags = statuteTags(v, f);
        perViolationStatutes.push({
          item: n, furnisher: f.name, account: v.accountName || null, title: v.title || null,
          severity: v.severity || null, statutes: tags, remedyType: v.remedyType || null,
          remedyWording: v.remedyWording || null, precedent: v.precedent || null,
          status: statusOf(f, v),
        });
        for (const t of tags) {
          const key = t.replace('§', '');
          if (counts[key]) counts[key].push(n);
        }
        // Every disputed item feeds Counts I and III once verified unchanged.
        if (!counts['1681i'].includes(n)) counts['1681i'].push(n);
        if (!counts['1681s-2(b)'].includes(n)) counts['1681s-2(b)'].push(n);
      }
    }
    const sidecar = {
      parties: {
        consumer: { name: consumer.name || null, address: consumer.address || null },
        cra: consumer.bureau || null,
        furnishers: furnishers.filter(f => (f.violations || []).length > 0)
          .map(f => ({ name: f.name, address: f.address || null, isCollector: f.isCollector === true })),
      },
      reportDate: consumer.reportDate || null,
      counts,
      perViolationStatutes,
      damages: { violationCount: n, willfulRange: [n * 100, n * 1000] },
      solDeadline: solDeadline,
      chronology: events,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(sidecar, null, 2), 'utf8');
  }
}

// ─── §1681g FULL-FILE REQUEST (plain language, separate envelope) ─────────────
//
// Kelly v. RealPage, 47 F.4th 202 (3d Cir. 2022): a plain-language request
// for the full file is legally sufficient. No invented deadlines, no threats
// — if the CRA answers with the standard report instead of the file, that
// failure itself becomes the §1681g count.

async function generateFileDisclosureDocx(consumer, clientIdentity = {}, outputPath) {
  const cra = getCRA(consumer.bureau);
  const phone = idVal(clientIdentity.phone, 18);
  const proofName = (clientIdentity.proofOfAddress && String(clientIdentity.proofOfAddress).trim())
    || 'a recent utility bill or bank statement';

  const children = [
    makeBanner('VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED'),
    blank(),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: '[DATE MAILED — fill in the day you actually mail this letter]', bold: true, size: sz(FONT_BODY), font: FONT })] }),
    blank(),
    new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: cra.name, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    ...(cra.dept ? [makeBody(cra.dept)] : []),
    makeBody(cra.addr),
    makeBody(cra.city),
    blank(),
    makeLabelValue('From:', consumer.name || '[Consumer Name]'),
    makeLabelValue('Address:', consumer.address || '[Consumer Address]'),
    makeLabelValue('Phone:', phone),
    makeLabelValue('Email:', idVal(clientIdentity.email, 24)),
    makeLabelValue('Date of birth:', idVal(clientIdentity.dob, 14)),
    makeLabelValue('SSN:', idVal(clientIdentity.ssn, 14)),
    blank(),
    makeBody('RE: Request for my complete consumer file (full file disclosure)', { bold: true }),
    makeHRule(),
    makeBody('To whom it may concern:'),
    makeBody('Please send me a complete copy of my consumer file — all of the information you have about me at the time of this request, not just the standard credit report you normally mail out. Please include everything in the file, the sources of that information, and a list of everyone who has received a report about me. Please also include full account numbers, not shortened or masked ones, so I can actually check the accounts against my own records.'),
    makeBody(`So you can be sure this request really is from me, I have enclosed a copy of my government-issued photo ID and ${proofName} showing my name and current address.`),
    makeBody(`If anything about my request is unclear, please write to me at my address above or call me at ${phone}. Thank you.`),
    blank(120),
    makeBody('Sincerely,'),
    blank(200),
    makeBody('_________________________________'),
    makeBody(consumer.name || '[Consumer Name]', { bold: true }),
    makeBody(consumer.address || '[Consumer Address]'),
    blank(120),
    makeBody('Enclosures:', { bold: true }),
    makeBody('1.  Copy of my government-issued photo ID', { indent: true }),
    makeBody(`2.  Copy of ${proofName} showing my name and current address`, { indent: true }),
    blank(80),
    makeBody('For my records — certified mail tracking:', { bold: true }),
    makeBody('Tracking #: ________________________________   Date mailed: ____________________', { indent: true }),
  ];

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── MAILING INSTRUCTIONS ─────────────────────────────────────────────────────

async function generateMailingInstructionsDocx(violationsData, outputPath) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const consumer = (violationsData && violationsData.consumer) || {};
  const furnishers = ((violationsData && violationsData.furnishers) || []).filter(f => (f.violations || []).length > 0);
  const cra = getCRA(consumer.bureau);

  // Printed as guidance only — the campaign tracker computes the real
  // deadlines from the date you actually mail.
  const mailingDate = new Date();
  const deadline = new Date(mailingDate);
  deadline.setDate(deadline.getDate() + 30);
  const deadlineStr = deadline.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const children = [
    makeBanner('CERTIFIED MAILING INSTRUCTIONS & 30-DAY TIMELINE'),
    blank(),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: `Consumer: ${consumer.name || '[Consumer Name]'}   |   Generated: ${today}`, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    makeHRule(),

    makeSectionHeading('I', 'OVERVIEW — CERTIFIED MAIL PACKAGES'),
    makeBody('You will send the following certified mail packages. Each goes in its own envelope with its own tracking number and its own green return-receipt card. NEVER dispute online — you cannot prove what you said, and it is hard to attach your documents. Certified paper mail is the foundation of the record.'),
    blank(80),
  ];

  const tableRows = [
    ['1', cra.name, `${cra.addr}, ${cra.city}`, 'Dispute letter + photo ID + proof of address + circled report pages'],
    ['2', cra.name, `${cra.addr}, ${cra.city}`, 'Full-file request letter + photo ID + proof of address (SEPARATE envelope)'],
    ...furnishers.map((f, i) => [
      String(i + 3),
      f.name,
      f.address || '[Address as shown on the credit report / dispute letter cc list]',
      'COMPLETE copy of the dispute letter with ALL enclosures',
    ]),
  ];
  children.push(makeSimpleTable(['#', 'Recipient', 'Address', 'Contents'], tableRows));
  children.push(blank());

  children.push(makeSectionHeading('II', 'ENVELOPE-BY-ENVELOPE ASSEMBLY'));

  children.push(makeSubHeading(`PACKAGE 1: ${cra.name} — THE DISPUTE`));
  children.push(makeBody(`Address: ${cra.name}, ${cra.dept ? cra.dept + ', ' : ''}${cra.addr}, ${cra.city}`));
  children.push(makeBody('☐  Signed dispute letter (date it the day you mail it)', { indent: true }));
  children.push(makeBody('☐  Copy of government-issued photo ID (front & back)', { indent: true }));
  children.push(makeBody('☐  Proof of current address (utility bill or bank statement, dated within 60 days)', { indent: true }));
  children.push(makeBody('☐  Credit report pages with the errors circled in red (use the annotated copy or mark a fresh copy per the Markup Map)', { indent: true }));
  children.push(blank(80));

  children.push(makeSubHeading(`PACKAGE 2: ${cra.name} — THE FULL-FILE REQUEST`));
  children.push(makeBody(`Address: same as Package 1 — but a SEPARATE envelope with its own tracking number.`));
  children.push(makeBody('☐  Signed full-file request letter (date it the day you mail it)', { indent: true }));
  children.push(makeBody('☐  Copy of government-issued photo ID (front & back)', { indent: true }));
  children.push(makeBody('☐  Proof of current address (dated within 60 days)', { indent: true }));
  children.push(blank(80));

  furnishers.forEach((f, i) => {
    children.push(makeSubHeading(`PACKAGE ${i + 3}: ${f.name.toUpperCase()} — COURTESY COPY OF THE DISPUTE`));
    children.push(makeBody(`Address: ${f.address || '[Furnisher address — from the credit report or the letter\'s cc list]'}`));
    children.push(makeBody('☐  COMPLETE copy of the dispute letter', { indent: true }));
    children.push(makeBody('☐  Copy of government-issued photo ID (front & back)', { indent: true }));
    children.push(makeBody('☐  Proof of current address (dated within 60 days)', { indent: true }));
    children.push(makeBody('☐  Credit report pages with the errors circled in red', { indent: true }));
    children.push(makeBody('Why: the furnisher is judged by the notice it had. This copy does not replace the CRA dispute — it makes sure the furnisher has your full letter when the CRA\'s notice arrives.', { indent: true, italic: true }));
    children.push(blank(80));
  });

  children.push(makeSectionHeading('III', 'AT THE POST OFFICE — STEP BY STEP'));
  const poSteps = [
    'Bring all sealed envelopes and a valid government-issued ID.',
    'Request "Certified Mail with Return Receipt Requested" for EACH envelope.',
    'The postal clerk will affix green-and-white tracking barcodes to each envelope.',
    'Request the PS Form 3811 (green card) for EACH envelope — write the recipient name on the "Article Addressed To" line.',
    'Keep all receipts and tracking numbers. Write each tracking number on your copy of the corresponding letter.',
    'Take a clear photo of each sealed envelope before handing it to the clerk.',
    'When you get home, enter the mail date and every tracking number into the campaign tracker — that is what starts the real deadline clock.',
    'Estimated cost: $7–$9 per package (certified mail + return receipt).',
  ];
  poSteps.forEach((s, i) => children.push(makeBody(`${i + 1}.  ${s}`, { indent: true, before: 60 })));

  children.push(makeSectionHeading('IV', '30-DAY INVESTIGATION TIMELINE (GUIDANCE)'));
  children.push(makeBody('The dates below assume you mail today; the campaign tracker computes the binding dates from the mail date and delivery date you enter.'));
  const timeline = [
    ['Day 0', today, 'Mail all packages via Certified Mail. Save all tracking numbers and receipts. Log them in the tracker.'],
    ['Day 3–5', '', `${cra.name} receives the packages. The 30-day reinvestigation clock starts on receipt.`],
    ['Day 5', '', `${cra.name} must forward the dispute to ${furnishers.map(f => f.name).join(', ') || 'the furnisher(s)'} within 5 business days.`],
    ['Day 15', '', 'Optional: call the CRA consumer line to confirm receipt. Log the call — date, time, representative name.'],
    ['Day 30', deadlineStr, `${cra.name} must complete the reinvestigation and send you the results.`],
    ['Day 35', '', 'Pull a fresh credit report and start the response intake — upload the results letter and the new report.'],
  ];
  children.push(makeSimpleTable(['Timeline', 'Date', 'Action'], timeline));
  children.push(blank());

  children.push(makeSectionHeading('V', 'WHEN THE RESULTS ARRIVE (OR DON\'T)'));
  children.push(makeBody('When the results of investigation arrive: save the letter, pull a fresh report, and run the response intake in the app — it compares every disputed item against the new report and builds the next step (a final-notice round or the litigation memo).', { indent: true }));
  children.push(makeBody('Call the bureau after the results arrive and ask about anything not fixed. Log the call in the tracker. This removes their "you should have called us" argument and shows the dispute is serious to you.', { indent: true }));
  children.push(makeBody('If a "suspicious mail" / "we don\'t think this is you" letter arrives instead: do NOT start over. Re-send the identical letter with the same ID and proof of address, log it, and keep the stall letter — their refusal to investigate is part of the record.', { indent: true }));
  children.push(makeBody('If there is no response within 30 days of confirmed delivery: file a CFPB complaint at consumerfinance.gov/complaint using your tracking number as proof, and note the non-response in the tracker — a no-investigation is worse for them than a bad investigation.', { indent: true }));

  children.push(makeSectionHeading('VI', "DO'S AND DON'TS"));
  children.push(makeBody('DO:', { bold: true }));
  children.push(makeBody('✓  Keep signed copies of every letter WITH its attachments — paper, scanned, and cloud', { indent: true }));
  children.push(makeBody('✓  Date each letter the day you actually mail it', { indent: true }));
  children.push(makeBody('✓  Pull a new credit report after 35 days and run the response intake', { indent: true }));
  children.push(makeBody('✓  Document every phone call (date, time, representative name, what was said)', { indent: true }));
  children.push(makeBody("DON'T:", { bold: true }));
  children.push(makeBody('✗  Dispute online — you cannot prove what you said', { indent: true }));
  children.push(makeBody('✗  Apply for new credit during the dispute period', { indent: true }));
  children.push(makeBody('✗  Accept a "verified" response without asking how it was verified', { indent: true }));
  children.push(makeBody('✗  Miss the 30-day window — the tracker will count it down for you', { indent: true }));

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── RESULTS DIFF REPORT (after response intake) ─────────────────────────────

async function generateResultsDiffDocx(diff, outputPath) {
  const children = [
    makeBanner('RESULTS OF INVESTIGATION — ITEM-BY-ITEM DIFF'),
    blank(),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: `Round ${diff.roundNumber}   |   Results received: ${diff.resultsDate || '[date]'}`, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    makeHRule(),
  ];

  const sections = [
    ['FIXED', diff.groups.fixed, 'The bureau corrected these. Verify each on the fresh report, then leave them alone.'],
    ['DELETED', diff.groups.deleted, 'These tradelines are gone. Best possible outcome — confirm they stay gone (watch for reinsertion).'],
    ['VERIFIED WITHOUT CORRECTION', diff.groups.verified_unchanged, 'The bureau claims it verified these, but the defects are unchanged. THIS is the litigation core — each one is a reinvestigation that failed.'],
    ['UNCLEAR', diff.groups.unclear, 'The documents do not clearly show the outcome. Review these by hand and classify them yourself in the round view.'],
  ];

  for (const [title, rows, note] of sections) {
    if (!rows || rows.length === 0) continue;
    children.push(makeSubHeading(`${title} (${rows.length})`));
    children.push(makeBody(note, { italic: true }));
    children.push(makeSimpleTable(
      ['#', 'Account', 'Item', 'Before', 'After / evidence'],
      rows.map(r => [String(r.item), r.account || r.furnisher || '', r.title || '',
        r.before || '', [r.newValue, r.evidenceQuote ? `"${r.evidenceQuote}"` : ''].filter(Boolean).join(' — ')])
    ));
    children.push(blank());
  }

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── METHOD-OF-VERIFICATION REQUEST (optional supporting exhibit) ─────────────
//
// Watts doctrine: never the case itself — a supporting exhibit. The bureau's
// three-sentence boilerplate answer becomes evidence of how thin the
// "investigation" was.

async function generateMovLetterDocx(consumer, clientIdentity = {}, verifiedItems = [], outputPath) {
  const cra = getCRA(consumer.bureau);
  const phone = idVal(clientIdentity.phone, 18);

  const children = [
    makeBanner('VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED'),
    blank(),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: '[DATE MAILED — fill in the day you actually mail this letter]', bold: true, size: sz(FONT_BODY), font: FONT })] }),
    blank(),
    new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: cra.name, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    ...(cra.dept ? [makeBody(cra.dept)] : []),
    makeBody(cra.addr),
    makeBody(cra.city),
    blank(),
    makeLabelValue('From:', consumer.name || '[Consumer Name]'),
    makeLabelValue('Address:', consumer.address || '[Consumer Address]'),
    makeLabelValue('Phone:', phone),
    blank(),
    makeBody('RE: How did you verify these items?', { bold: true }),
    makeHRule(),
    makeBody('To whom it may concern:'),
    makeBody('You recently sent me the results of an investigation into items I disputed, and you said the following items were verified as accurate. For each one, please describe how you verified it: what you reviewed, who you contacted, and what documents you looked at.'),
  ];

  verifiedItems.forEach((it, i) => {
    children.push(makeBody(`${i + 1}.  ${it.account ? it.account + ' — ' : ''}${it.title || ''}`, { indent: true }));
  });

  children.push(makeBody('Please send me your description in writing at my address above. Thank you.'));
  children.push(blank(120));
  children.push(makeBody('Sincerely,'));
  children.push(blank(200));
  children.push(makeBody('_________________________________'));
  children.push(makeBody(consumer.name || '[Consumer Name]', { bold: true }));
  children.push(makeBody(consumer.address || '[Consumer Address]'));

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── MARKUP MAP ───────────────────────────────────────────────────────────────

async function generateMarkupMapDocx(violationsData, outputPath) {
  const consumer = (violationsData && violationsData.consumer) || {};
  const furnishers = (violationsData && violationsData.furnishers) || [];

  const children = [
    makeBanner('MARKUP MAP — RED BOX GUIDE'),
    blank(),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: `Consumer: ${consumer.name || '[Consumer Name]'}   |   Bureau: ${consumer.bureau || ''}   |   Report Date: ${consumer.reportDate || ''}`, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    makeHRule(),
    makeBody('Every numbered item below matches the same item number in the Dispute Letter. On your copy of the credit report: draw a RED BOX around each field or payment-history cell listed. Boxes only — do NOT write numbers on the report. When one item lists two locations, box BOTH locations.'),
    blank(80),
  ];

  let itemNo = 0;
  for (const f of furnishers) {
    const violations = f.violations || [];
    if (violations.length === 0) continue;
    children.push(makeSubHeading(`FURNISHER: ${f.name.toUpperCase()}`));

    for (const v of violations) {
      itemNo++;
      const marks = (v.markup && v.markup.length > 0) ? v.markup : [{
        page: null,
        section: 'Account Information',
        markText: v.reportShows && v.reportShows !== 'FIELD NOT PRESENT'
          ? v.reportShows
          : `${v.title || 'disputed'} field (blank/missing)`,
      }];

      children.push(new Paragraph({
        spacing: { before: 140, after: 40 },
        children: [
          new TextRun({ text: `Item ${itemNo}`, bold: true, size: sz(FONT_BODY), font: FONT }),
          new TextRun({ text: `   [${v.issueType || v.severity || ''}]`, italics: true, size: sz(10), font: FONT }),
        ],
      }));
      children.push(makeBody(`Account: ${v.accountName || f.name}`, { indent: true }));
      children.push(makeBody(`Page: ${marks.map(m => m.page != null ? m.page : 'locate on report').join(' + ')}`, { indent: true }));
      children.push(makeBody(`Section: ${marks.map(m => m.section || 'Account Information').join(' + ')}`, { indent: true }));
      marks.forEach((m, i) => {
        children.push(makeBody(`${i === 0 ? 'Mark this:' : 'Also mark this:'} "${m.markText}"${m.page != null ? ` (page ${m.page})` : ''}`, { indent: true, bold: true }));
      });
      children.push(makeBody(`Annotation: Red box around ${marks.length > 1 ? 'both locations' : 'this location'} — box only, no number written on the report`, { indent: true }));
      children.push(makeBody(`Why: ${v.description || v.title || ''}`, { indent: true }));
    }
  }

  if (itemNo === 0) {
    children.push(makeBody('No dispute items were identified — nothing to mark.'));
  }

  children.push(blank(120));
  children.push(makeBody('Note: The package also includes an auto-annotated copy of the report with these red boxes already drawn. Use this map to verify each box, or to mark a fresh copy by hand.', { italic: true }));

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

module.exports = {
  generateWattsLetterDocx,
  generateLitigationMemoDocx,
  generateFileDisclosureDocx,
  generateMailingInstructionsDocx,
  generateMarkupMapDocx,
  generateResultsDiffDocx,
  generateMovLetterDocx,
};
