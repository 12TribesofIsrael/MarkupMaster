const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle, Table, TableRow, TableCell,
  WidthType, ShadingType, UnderlineType, Tab, TabStopType, TabStopPosition,
} = require('docx');
const fs = require('fs');

// ─── Constants ────────────────────────────────────────────────────────────────
const FONT = 'Times New Roman';
const FONT_BODY = 11;   // pt  (docx sz = pt * 2)
const sz = pt => pt * 2;

const CRA_ADDRESSES = {
  experian:   { name: 'EXPERIAN INFORMATION SOLUTIONS, INC.', dept: 'Consumer Dispute Center', addr: 'P.O. Box 4500', city: 'Allen, TX 75013', phone: '(888) 397-3742' },
  equifax:    { name: 'EQUIFAX INFORMATION SERVICES, LLC',    dept: 'Office of Consumer Affairs', addr: 'P.O. Box 740256', city: 'Atlanta, GA 30374', phone: '(866) 349-5191' },
  transunion: { name: 'TRANSUNION, LLC',                      dept: 'Consumer Dispute Center', addr: 'P.O. Box 2000', city: 'Chester, PA 19016', phone: '(800) 916-8800' },
};

function getCRA(bureauStr) {
  const b = (bureauStr || '').toLowerCase();
  if (b.includes('equifax')) return CRA_ADDRESSES.equifax;
  if (b.includes('trans')) return CRA_ADDRESSES.transunion;
  return CRA_ADDRESSES.experian; // default
}

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

function makeViolationBlock(v) {
  const paras = [];

  // Violation header line
  paras.push(new Paragraph({
    spacing: { before: 180, after: 60 },
    children: [
      new TextRun({
        text: `VIOLATION #${v.number} — ${(v.title || '').toUpperCase()}`,
        bold: true,
        size: sz(FONT_BODY),
        font: FONT,
      }),
      v.statute ? new TextRun({ text: `  (${v.statute})`, size: sz(FONT_BODY), font: FONT }) : new TextRun({ text: '' }),
    ],
  }));

  // Severity badge line
  const sevColors = { CRITICAL: 'CC0000', HIGH: 'CC6600', MEDIUM: 'CC9900' };
  paras.push(new Paragraph({
    spacing: { before: 0, after: 60 },
    indent: { left: 360 },
    children: [
      new TextRun({
        text: `[${v.severity || 'HIGH'}]`,
        bold: true,
        color: sevColors[v.severity] || 'CC6600',
        size: sz(10),
        font: FONT,
      }),
    ],
  }));

  // Sub-fields (BMB order: WHAT IS WRONG → REPORT SHOWS → SHOULD SHOW → IMPACT → PRECEDENT → DEMAND)
  const fields = [
    { label: 'WHAT IS WRONG:', value: v.description },
    ...(v.reportShows ? [{ label: 'REPORT SHOWS:', value: v.reportShows }] : []),
    ...(v.shouldShow ? [{ label: 'SHOULD SHOW:', value: v.shouldShow }] : []),
    { label: 'IMPACT:', value: v.impact || null },
    ...(v.precedent ? [{ label: 'PRECEDENT:', value: v.precedent }] : []),
    { label: 'DEMAND:', value: v.demand },
  ];

  for (const f of fields) {
    if (!f.value) continue;
    paras.push(new Paragraph({
      spacing: { before: 40, after: 40 },
      indent: { left: 360 },
      children: [
        new TextRun({ text: `${f.label}  `, bold: true, size: sz(FONT_BODY), font: FONT }),
        new TextRun({ text: f.value, size: sz(FONT_BODY), font: FONT }),
      ],
    }));
  }

  return paras;
}

function makeSignatureBlock(consumerName, consumerAddress, today) {
  return [
    blank(120),
    makeBody('I certify under penalty of law that the information provided in this dispute is true and accurate to the best of my knowledge.', { italic: true }),
    blank(80),
    makeBody('Respectfully submitted,'),
    blank(200),
    makeBody('_________________________________'),
    makeBody(consumerName, { bold: true }),
    makeBody(consumerAddress),
    makeBody(`Date: ________________`),
    blank(120),
    makeBanner('CERTIFIED MAIL TRACKING'),
    makeBody('Certified Mail #: ________________________________', { indent: true }),
    makeBody('Date Mailed: ________________________________', { indent: true }),
    makeBody('Return Receipt Received: ________________________________', { indent: true }),
  ];
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

// ─── DISPUTE LETTER ───────────────────────────────────────────────────────────

async function generateDisputeLetterDocx(letterData, consumer, outputPath) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const furnisherName = letterData.furnisherName || 'CREDITOR';
  const furnisher = letterData.furnisher || {};
  const accounts = letterData.accounts || [];
  const violations = letterData.violations || [];
  const cra = getCRA(consumer.bureau);

  // Count accounts
  const acctCount = accounts.length;
  const acctWord = acctCount === 1 ? 'ONE (1) ACCOUNT' : `${numberWord(acctCount)} (${acctCount}) ACCOUNTS`;

  const children = [
    // Banner
    makeBanner('VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED'),
    blank(),

    // Date
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: today, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    blank(),

    // CRA address
    new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: cra.name, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    makeBody(cra.dept),
    makeBody(cra.addr),
    makeBody(cra.city),
    makeBody(cra.phone),
    blank(),

    // RE line
    new Paragraph({
      spacing: { before: 80, after: 80 },
      children: [new TextRun({ text: `RE:  FORMAL DISPUTE UNDER FCRA §1681i — ${furnisherName.toUpperCase()} — ${acctWord}`, bold: true, size: sz(FONT_BODY), font: FONT })],
    }),
    blank(),

    // CC block (CRITICAL — never omit per BMB protocol)
    new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: `CC:  ${furnisherName.toUpperCase()}`, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    ...(furnisher.address ? [makeBody(furnisher.address)] : []),
    ...(furnisher.phone ? [makeBody(furnisher.phone)] : []),
    makeBody('Certified Mail Tracking #: ________________________________'),
    blank(),

    // Consumer info
    makeLabelValue('Consumer:', consumer.name || '[Consumer Name]'),
    makeLabelValue('Address:', consumer.address || '[Consumer Address]'),
    makeLabelValue('DOB:', 'Redacted for security'),
    makeLabelValue('SSN (Last 4):', 'Redacted for security'),
    makeLabelValue('Report Date:', consumer.reportDate || today),

    makeHRule(),

    // Section I: Statutory Authority
    makeSectionHeading('I', 'STATUTORY AUTHORITY & CONSUMER RIGHTS'),
    makeBody('This formal dispute is submitted pursuant to the Fair Credit Reporting Act (FCRA), 15 U.S.C. §1681 et seq. The following statutes and standards govern this dispute:'),
    makeBody('• 15 U.S.C. §1681i(a) — Reinvestigation of disputed information; 30-day deadline', { indent: true }),
    makeBody('• 15 U.S.C. §1681e(b) — Maximum possible accuracy requirement', { indent: true }),
    makeBody('• 15 U.S.C. §1681g(a) — Full file disclosure and method of verification', { indent: true }),
    makeBody('• 15 U.S.C. §1681s-2(b) — Furnisher duties upon notice of dispute', { indent: true }),
    makeBody('• 15 U.S.C. §1681c(a)(4) — Seven-year reporting period limitation', { indent: true }),
    makeBody('• CDIA Metro 2® Credit Reporting Resource Guide (2023) — Technical field standards', { indent: true }),
    makeBody('Pursuant to Cushman v. TransUnion Corp., the CRA may not rely solely on the furnisher\'s verification — it must conduct a reasonable independent investigation. Boilerplate e-OSCAR responses are insufficient per Bradshaw v. BAC Home Loans Servicing, LP.'),

    // Section II: Disputed Accounts & Violations
    makeSectionHeading('II', 'DISPUTED ACCOUNTS & VIOLATIONS'),
  ];

  // Group violations by account
  const byAccount = {};
  for (const v of violations) {
    const key = v.accountName || v.account || furnisherName;
    if (!byAccount[key]) byAccount[key] = [];
    byAccount[key].push(v);
  }

  // If no account grouping, use accounts array
  if (Object.keys(byAccount).length === 0 && accounts.length > 0) {
    for (const acct of accounts) {
      byAccount[acct.accountName || acct.accountNumber] = [];
    }
  }

  // Output per-account
  for (const [acctName, acctViolations] of Object.entries(byAccount)) {
    const acct = accounts.find(a => a.accountName === acctName || a.accountNumber === acctName) || {};
    children.push(makeSubHeading(`${acctName.toUpperCase()} — Account #${acct.accountNumber || 'NOT VISIBLE ON REPORT'}`));
    // Build account detail lines from all available fields
    const acctDetails = [];
    if (acct.accountType) acctDetails.push(`Account Type: ${acct.accountType}`);
    if (acct.status) acctDetails.push(`Status: ${acct.status}${acct.statusCode ? ` (Code ${acct.statusCode})` : ''}`);
    if (acct.balance) acctDetails.push(`Balance: ${acct.balance}`);
    if (acct.pastDue) acctDetails.push(`Past Due: ${acct.pastDue}`);
    if (acct.creditLimit) acctDetails.push(`Credit Limit: ${acct.creditLimit}`);
    if (acct.highCredit) acctDetails.push(`High Credit: ${acct.highCredit}`);
    if (acct.originalChargeOffAmount) acctDetails.push(`Original Charge-Off Amount: ${acct.originalChargeOffAmount}`);
    if (acct.dateOpened) acctDetails.push(`Date Opened: ${acct.dateOpened}`);
    if (acct.dateClosed) acctDetails.push(`Date Closed: ${acct.dateClosed}`);
    if (acct.dofd) acctDetails.push(`DOFD: ${acct.dofd}`);
    if (acct.dateLastPayment) acctDetails.push(`Last Payment: ${acct.dateLastPayment}`);
    if (acct.paymentHistory) acctDetails.push(`Payment History: ${acct.paymentHistory}`);
    if (acct.ecoaCode) acctDetails.push(`ECOA: ${acct.ecoaCode}`);
    if (acct.responsibilityType) acctDetails.push(`Responsibility: ${acct.responsibilityType}`);
    if (acctDetails.length > 0) {
      // Split into 2 lines for readability
      const mid = Math.ceil(acctDetails.length / 2);
      children.push(makeBody(acctDetails.slice(0, mid).join('   |   ')));
      if (acctDetails.length > mid) {
        children.push(makeBody(acctDetails.slice(mid).join('   |   ')));
      }
    }
    for (const v of acctViolations) {
      children.push(...makeViolationBlock(v));
    }
    // Per-account summary line
    if (acctViolations.length > 0) {
      const critCount = acctViolations.filter(v => v.severity === 'CRITICAL').length;
      children.push(makeBody(`This account contains ${acctViolations.length} distinct FCRA/Metro 2® violation(s)${critCount > 0 ? ` (${critCount} CRITICAL)` : ''}. DEMAND: Investigate, correct, or delete this tradeline in its entirety.`, { bold: true }));
    }
  }

  // If violations weren't account-grouped, just output all
  if (Object.keys(byAccount).length === 0) {
    for (const v of violations) {
      children.push(...makeViolationBlock(v));
    }
  }

  // Section III: Legal Precedent & Case Law
  children.push(makeSectionHeading('III', 'LEGAL PRECEDENT & CASE LAW'));
  children.push(makeBody('The following federal case law supports the violations and demands identified in this dispute:'));
  children.push(makeBody(`• Gillespie v. Equifax Info. Servs. LLC — Truncated or masked account numbers violate §1681g(a)(1) because the consumer cannot independently verify the tradeline belongs to them.`, { indent: true }));
  children.push(makeBody(`• Seamans v. Temple University — Payment history that jumps from current to severe delinquency without the required intermediate steps (30→60→90→120→150→180) constitutes inaccurate reporting under §1681e(b).`, { indent: true }));
  children.push(makeBody(`• Cushman v. TransUnion Corp. — The CRA may not rely solely on the furnisher's e-OSCAR verification; it must conduct a reasonable, independent investigation per §1681i.`, { indent: true }));
  children.push(makeBody(`• Bradshaw v. BAC Home Loans Servicing, LP — Boilerplate, automated e-OSCAR responses from furnishers do not constitute a "reasonable investigation" under §1681s-2(b).`, { indent: true }));

  // Section IV: Statutory Demands
  children.push(makeSectionHeading('IV', 'STATUTORY DEMANDS'));
  children.push(makeBody(`Pursuant to FCRA §1681i(a), I hereby formally demand that ${cra.name} perform the following within thirty (30) days of receipt of this letter:`));

  const demands = [
    `Conduct a full and reasonable reinvestigation of each and every disputed item identified above, contacting ${furnisherName} and forwarding all relevant dispute information per §1681i(a)(2)(A).`,
    `Provide complete verification and documentation of each disputed item, or permanently delete the item from my consumer file per §1681i(a)(5)(A).`,
    `Suppress each disputed account from all consumer reports issued during the pendency of the investigation per §1681i(a)(5)(A).`,
    'Provide full file disclosure pursuant to §1681g(a), including the method of verification used for each item and the identity of each person contacted.',
    `Forward a complete description of the results of this reinvestigation to ${furnisherName} per §1681i(a)(6)(B)(iii).`,
    'Forward corrected reports to all persons who received a consumer report containing the disputed information within the prior two (2) years per §1681i(a)(6)(B)(i).',
    'Provide me with a corrected copy of my consumer disclosure upon completion of the reinvestigation per §1681i(a)(6)(A).',
    'Delete any and all information that cannot be fully verified, documented, and confirmed accurate within the 30-day deadline per §1681i(a)(5)(A).',
  ];

  const demandLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  demands.forEach((d, i) => {
    children.push(new Paragraph({
      spacing: { before: 60, after: 60 },
      indent: { left: 360 },
      children: [
        new TextRun({ text: `${demandLetters[i]}.  `, bold: true, size: sz(FONT_BODY), font: FONT }),
        new TextRun({ text: d, size: sz(FONT_BODY), font: FONT }),
      ],
    }));
  });

  // Section V: Timeline & Consequences
  children.push(makeSectionHeading('V', 'COMPLIANCE TIMELINE & LEGAL CONSEQUENCES'));
  children.push(makeBody(`This dispute must be fully investigated and resolved within thirty (30) days of receipt, pursuant to FCRA §1681i(a)(1). The investigation period may be extended to forty-five (45) days only if the consumer submits additional relevant information during the investigation.`));
  children.push(makeBody('Failure to comply with these requirements may subject your organization to civil liability under:'));
  children.push(makeBody('• §1681n — Willful noncompliance: Statutory damages of $100–$1,000 per violation, plus punitive damages and attorney\'s fees.', { indent: true }));
  children.push(makeBody('• §1681o — Negligent noncompliance: Actual damages plus attorney\'s fees and court costs.', { indent: true }));
  children.push(makeBody('This letter may be submitted as evidence in any subsequent civil litigation.'));

  // Section VI: Enclosed Documentation
  children.push(makeSectionHeading('VI', 'ENCLOSED DOCUMENTATION'));
  children.push(makeBody('The following documents are enclosed with this dispute letter:'));
  children.push(makeBody('☐  Government-issued photo identification (front and back)', { indent: true }));
  children.push(makeBody('☐  Proof of current address (utility bill, bank statement, or lease within 60 days)', { indent: true }));
  children.push(makeBody('☐  Highlighted copy of credit report with violations marked', { indent: true }));
  children.push(makeBody('☐  Copy of this dispute letter for your records', { indent: true }));

  // Section VII: Certificate of Service
  children.push(makeSectionHeading('VII', 'CERTIFICATE OF SERVICE'));
  children.push(makeBody(`I hereby certify that on this date, a true and correct copy of this dispute letter, together with all enclosures, has been sent via United States Certified Mail, Return Receipt Requested, to:`));
  children.push(makeBody(`1.  ${cra.name}, ${cra.dept}, ${cra.addr}, ${cra.city}`, { indent: true, bold: true }));
  children.push(makeBody(`2.  ${furnisherName}${furnisher.address ? ', ' + furnisher.address : ''}`, { indent: true, bold: true }));

  // Signature block
  children.push(...makeSignatureBlock(consumer.name || '[Consumer Name]', consumer.address || '[Consumer Address]', today));

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── FILE DISCLOSURE LETTER ───────────────────────────────────────────────────

async function generateFileDisclosureDocx(consumer, outputPath) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const cra = getCRA(consumer.bureau);

  const children = [
    makeBanner('VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED'),
    blank(),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: today, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    blank(),
    new Paragraph({ spacing: { before: 40, after: 40 }, children: [new TextRun({ text: cra.name, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    makeBody(cra.dept),
    makeBody(cra.addr),
    makeBody(cra.city),
    makeBody(cra.phone),
    blank(),
    new Paragraph({
      spacing: { before: 80, after: 80 },
      children: [new TextRun({ text: 'RE:  DEMAND FOR COMPLETE FILE DISCLOSURE PURSUANT TO FCRA §1681g(a)', bold: true, size: sz(FONT_BODY), font: FONT })],
    }),
    blank(),
    makeLabelValue('Consumer:', consumer.name || '[Consumer Name]'),
    makeLabelValue('Address:', consumer.address || '[Consumer Address]'),
    makeLabelValue('DOB:', 'Redacted for security'),
    makeLabelValue('SSN (Last 4):', 'Redacted for security'),
    makeLabelValue('Report Date:', consumer.reportDate || today),
    makeHRule(),

    makeSectionHeading('I', 'LEGAL BASIS FOR THIS DEMAND'),
    makeBody('Pursuant to the Fair Credit Reporting Act (FCRA), 15 U.S.C. §1681g(a), I hereby demand my complete consumer file disclosure. This statute affords every consumer the right to know the contents of their consumer file, the sources of that information, and the identity of every person or entity that has received a consumer report.'),
    makeBody('This demand is made pursuant to the following statutory provisions:'),
    makeBody('• §1681g(a)(1) — All information in my consumer file at the time of the request', { indent: true }),
    makeBody('• §1681g(a)(2) — Sources of the information in my file', { indent: true }),
    makeBody('• §1681g(a)(3) — Identification of each person that procured a consumer report within 12 months (employment: 24 months)', { indent: true }),
    makeBody('• §1681g(a)(4) — Dates, original payees, and amounts of any checks forming the basis of adverse characterization', { indent: true }),
    makeBody('• §1681g(a)(5) — Any record of inquiries received in connection with my credit', { indent: true }),

    makeSectionHeading('II', 'SPECIFIC INFORMATION DEMANDED'),
    makeBody('I hereby demand complete disclosure of the following:'),
    makeBody('A.  COMPLETE FILE CONTENTS — Every piece of information in my consumer file, including all tradelines, public records, inquiries, and collection accounts, with full account numbers (not truncated), as required by §1681g(a)(1) and Gillespie v. Equifax Info. Servs. LLC.', { indent: true }),
    makeBody('B.  SOURCES OF INFORMATION — The name, address, and telephone number of every data furnisher that has reported information currently in my file, per §1681g(a)(2).', { indent: true }),
    makeBody('C.  REPORT RECIPIENTS — Every person or entity that received a consumer report based on my file within the past 12 months (or 24 months for employment purposes), per §1681g(a)(3).', { indent: true }),
    makeBody('D.  DISPUTE AND INVESTIGATION RECORDS — All records of any disputes I have filed, the results of all investigations, and the method of verification used for each disputed item, per §1681i(c).', { indent: true }),
    makeBody('E.  SUPPRESSION AND FLAG RECORDS — Any §1681i(a)(5)(A) suppression flags placed on disputed items, and all "In Dispute" notations currently in my file.', { indent: true }),
    makeBody('F.  SCORING INFORMATION — Any credit score, risk score, or other numerical assessment derived from my file, along with the key factors affecting the score.', { indent: true }),

    makeSectionHeading('III', 'FORMAT REQUIREMENTS'),
    makeBody('The disclosure must be provided in a clear and accurate format that is easy to understand, pursuant to §1681g(a) and §1681h(e). Specifically:'),
    makeBody('• All account numbers must be provided in FULL — no truncation with X\'s or asterisks', { indent: true }),
    makeBody('• All dates must be clearly stated in MM/DD/YYYY format', { indent: true }),
    makeBody('• All balance, credit limit, and payment history fields must be complete', { indent: true }),
    makeBody('• The disclosure must be mailed to the address above within fifteen (15) days of receipt of this demand', { indent: true }),

    makeSectionHeading('IV', 'COMPLIANCE TIMELINE & LEGAL CONSEQUENCES'),
    makeBody('You are required to comply with this demand within fifteen (15) days of receipt per §1681g and §1681j. Failure to provide the requested disclosure may subject your organization to civil liability under §1681n (willful noncompliance: $100–$1,000 per violation plus punitive damages) or §1681o (negligent noncompliance: actual damages plus attorney\'s fees).'),

    makeSectionHeading('V', 'ENCLOSED DOCUMENTATION'),
    makeBody('The following identification documents are enclosed to verify my identity:'),
    makeBody('☐  Government-issued photo identification (front and back)', { indent: true }),
    makeBody('☐  Proof of current address (utility bill, bank statement, or lease within 60 days)', { indent: true }),

    ...makeSignatureBlock(consumer.name || '[Consumer Name]', consumer.address || '[Consumer Address]', today),
  ];

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── MAILING INSTRUCTIONS ─────────────────────────────────────────────────────

async function generateMailingInstructionsDocx(violationsData, outputPath) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const consumer = (violationsData && violationsData.consumer) || {};
  const furnishers = (violationsData && violationsData.furnishers) || [];
  const cra = getCRA(consumer.bureau);

  // Calculate 30-day deadline
  const mailingDate = new Date();
  const deadline = new Date(mailingDate);
  deadline.setDate(deadline.getDate() + 30);
  const deadlineStr = deadline.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const children = [
    makeBanner('CERTIFIED MAILING INSTRUCTIONS & 30-DAY TIMELINE'),
    blank(),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: `Consumer: ${consumer.name || '[Consumer Name]'}   |   Mailing Date: ${today}`, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    makeHRule(),

    makeSectionHeading('I', 'OVERVIEW — CERTIFIED MAIL PACKAGES'),
    makeBody('You will be sending the following certified mail packages. Each must be sent separately with its own tracking number:'),
    blank(80),
  ];

  // Overview table
  const tableRows = [
    ['#', 'Recipient', 'Address', 'Contents'],
    ['1', cra.name, `${cra.addr}, ${cra.city}`, `All dispute letters + File Disclosure + highlighted report + ID`],
    ...furnishers.map((f, i) => [
      String(i + 2),
      f.name,
      f.address || '[See furnisher address on letter]',
      `Furnisher demand letter for ${(f.accounts || []).length} account(s)`,
    ]),
  ];

  children.push(makeSimpleTable(tableRows[0], tableRows.slice(1)));
  children.push(blank());

  children.push(makeSectionHeading('II', 'ENVELOPE-BY-ENVELOPE ASSEMBLY INSTRUCTIONS'));

  // Package 1: CRA
  children.push(makeSubHeading(`PACKAGE 1: ${cra.name}`));
  children.push(makeBody(`Address: ${cra.name}, ${cra.dept}, ${cra.addr}, ${cra.city}`));
  children.push(makeBody('Contents checklist:'));
  children.push(makeBody('☐  All dispute letters (one per furnisher)', { indent: true }));
  children.push(makeBody('☐  File Disclosure Demand letter', { indent: true }));
  children.push(makeBody('☐  Highlighted and annotated copy of credit report', { indent: true }));
  children.push(makeBody('☐  Copy of government-issued photo ID (front & back)', { indent: true }));
  children.push(makeBody('☐  Proof of current address (dated within 60 days)', { indent: true }));
  children.push(blank(80));

  // Packages for each furnisher
  furnishers.forEach((f, i) => {
    children.push(makeSubHeading(`PACKAGE ${i + 2}: ${f.name.toUpperCase()}`));
    children.push(makeBody(`Address: ${f.address || '[Furnisher address — see dispute letter CC block]'}`));
    children.push(makeBody('Contents checklist:'));
    children.push(makeBody('☐  Furnisher demand letter (§1681s-2(b))', { indent: true }));
    children.push(makeBody('☐  Copy of government-issued photo ID (front & back)', { indent: true }));
    children.push(makeBody('☐  Proof of current address (dated within 60 days)', { indent: true }));
    children.push(blank(80));
  });

  children.push(makeSectionHeading('III', 'AT THE POST OFFICE — STEP BY STEP'));
  const poSteps = [
    'Bring all sealed envelopes and a valid government-issued ID.',
    'Request "Certified Mail with Return Receipt Requested" for EACH envelope.',
    'The postal clerk will affix green-and-white tracking barcodes to each envelope.',
    'Request the white PS Form 3811 (green card) for EACH envelope — write the recipient name on the "Article Addressed To" line.',
    'Keep all receipts and tracking numbers. Write each tracking number on your copy of the corresponding letter.',
    'Take a clear photo of each sealed envelope before handing it to the clerk.',
    'Estimated cost: $7–$9 per package (certified mail + return receipt).',
  ];
  poSteps.forEach((s, i) => children.push(makeBody(`${i + 1}.  ${s}`, { indent: true, before: 60 })));

  children.push(makeSectionHeading('IV', '30-DAY INVESTIGATION TIMELINE'));
  const timeline = [
    ['Day 0', today, 'Mail all packages via Certified Mail. Save all tracking numbers and receipts.'],
    ['Day 3–5', '', `${cra.name} and furnishers receive packages. Clock starts on 30-day investigation period.`],
    ['Day 5', '', `${cra.name} must forward dispute to ${furnishers.map(f => f.name).join(', ')} per §1681i(a)(2).`],
    ['Day 15', '', 'Optional: Call CRA consumer line to confirm dispute receipt. Note representative name and time.'],
    ['Day 30', deadlineStr, `FCRA §1681i(a)(1) DEADLINE: ${cra.name} must complete reinvestigation and send results.`],
    ['Day 35', '', 'If corrections made: Updated report should appear. Pull a new credit report to verify.'],
  ];
  children.push(makeSimpleTable(['Timeline', 'Date', 'Action Required'], timeline));
  children.push(blank());

  children.push(makeSectionHeading('V', `IF ${cra.name.split(' ')[0]} DOES NOT RESPOND`));
  children.push(makeBody('If you do not receive a response within 30 days of confirmed delivery:'));
  children.push(makeBody('1.  File a complaint with the Consumer Financial Protection Bureau (CFPB) at consumerfinance.gov/complaint — use your certified mail tracking number as proof.', { indent: true }));
  children.push(makeBody('2.  File a complaint with the Federal Trade Commission (FTC) at ftc.gov/complaint.', { indent: true }));
  children.push(makeBody('3.  Consult a consumer rights attorney regarding civil litigation under FCRA §1681n (willful noncompliance, up to $1,000 per violation + attorney\'s fees).', { indent: true }));

  children.push(makeSectionHeading('VI', "DO'S AND DON'TS"));
  children.push(makeBody('DO:', { bold: true }));
  children.push(makeBody('✓  Keep copies of everything — letters, tracking receipts, green return receipt cards', { indent: true }));
  children.push(makeBody('✓  Pull a new credit report after 35 days to verify corrections', { indent: true }));
  children.push(makeBody('✓  Document all phone calls (date, time, representative name, confirmation #)', { indent: true }));
  children.push(makeBody("DON'T:", { bold: true }));
  children.push(makeBody('✗  Apply for new credit during the dispute period', { indent: true }));
  children.push(makeBody('✗  Accept a "verification" response without demanding the method of verification', { indent: true }));
  children.push(makeBody('✗  Miss the 30-day window — set a calendar reminder for today + 30 days', { indent: true }));

  children.push(makeSectionHeading('VII', 'EXPECTED OUTCOMES'));
  children.push(makeBody('Based on the violations identified in this dispute package:'));
  children.push(makeBody('• Best case (all accounts deleted): +100 to +150 credit score points', { indent: true }));
  children.push(makeBody('• Likely case (mix of deletions and corrections): +50 to +100 points', { indent: true }));
  children.push(makeBody('• Minimum case (corrections only, no deletions): +20 to +50 points', { indent: true }));

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── HIGHLIGHTING GUIDE ───────────────────────────────────────────────────────

async function generateHighlightingGuideDocx(violationsData, outputPath) {
  const consumer = (violationsData && violationsData.consumer) || {};
  const furnishers = (violationsData && violationsData.furnishers) || [];

  const children = [
    makeBanner('CREDIT REPORT HIGHLIGHTING GUIDE'),
    blank(),
    new Paragraph({ spacing: { before: 80, after: 80 }, children: [new TextRun({ text: `Consumer: ${consumer.name || '[Consumer Name]'}   |   Bureau: ${consumer.bureau || 'Experian'}   |   Report Date: ${consumer.reportDate || ''}`, bold: true, size: sz(FONT_BODY), font: FONT })] }),
    makeHRule(),

    makeSectionHeading('I', 'SUPPLIES NEEDED'),
    makeBody('Before you begin, gather the following supplies:'),
    makeBody('• Yellow highlighter — for account identifiers and key fields', { indent: true }),
    makeBody('• Red highlighter or red pen — for violations and inaccuracies', { indent: true }),
    makeBody('• Orange highlighter — for financial figures (balances, amounts)', { indent: true }),
    makeBody('• Green highlighter or green pen — for margin notes and annotations', { indent: true }),
    makeBody('• Blue or black ballpoint pen — for writing margin notes', { indent: true }),
    makeBody('• Ruler — for neat underlining', { indent: true }),
    makeBody('• Extra copies of your credit report (you will need one copy per recipient in your mailing package)', { indent: true }),
    blank(80),

    makeSectionHeading('II', 'COLOR CODE SYSTEM'),
    makeSimpleTable(
      ['Color', 'What to Highlight', 'Examples'],
      [
        ['YELLOW', 'Account identifiers, names, numbers, key fields', 'Account name, account number, date opened, credit limit'],
        ['RED', 'Violations — inaccurate, missing, or incorrect data', 'Truncated account #, missing DOFD, wrong status code, ND payment history'],
        ['ORANGE', 'Financial figures that are disputed or inconsistent', 'Balance vs. Past Due mismatch, unexplained charge-off amount, over-limit balance'],
        ['GREEN', 'Margin notes — write your annotation beside the highlighted field', '"MISSING — demand deletion", "TRUNCATED — §1681g(a)(1)", "ND = NO DATA — violation"'],
      ]
    ),
    blank(),

    makeSectionHeading('III', 'PAGE-BY-PAGE MARKING INSTRUCTIONS'),
    makeBody('Follow these instructions for each account. Work page by page in order.'),
    blank(80),
  ];

  // Per-furnisher/account instructions
  let violationCount = 0;
  for (const furnisher of furnishers) {
    children.push(makeSubHeading(`FURNISHER: ${furnisher.name.toUpperCase()}`));

    const accounts = furnisher.accounts || [];
    const violations = furnisher.violations || [];

    for (const acct of accounts) {
      const acctViolations = violations.filter(v =>
        !v.accountName || v.accountName === acct.accountName || v.accountName === acct.accountNumber
      );

      children.push(new Paragraph({
        spacing: { before: 120, after: 60 },
        children: [new TextRun({ text: `Account: ${acct.accountName || acct.accountNumber || 'Unknown'}  |  Status: ${acct.status || 'N/A'}  |  Balance: ${acct.balance || 'N/A'}`, size: sz(FONT_BODY), font: FONT, bold: true })],
      }));

      if (acctViolations.length === 0 && violations.length > 0) {
        // Use all violations for this furnisher if no account-specific ones
        for (const v of violations) {
          violationCount++;
          children.push(makeBody(`${violationCount}. [RED] Highlight: "${v.title}" — Write in margin: "VIOLATION #${v.number}: ${v.statute || 'FCRA Violation'}"`, { indent: true }));
        }
      } else {
        for (const v of acctViolations) {
          violationCount++;
          const color = v.severity === 'CRITICAL' ? 'RED' :
                        v.severity === 'HIGH' ? 'RED' : 'ORANGE';
          children.push(makeBody(`${violationCount}. [${color}] ${v.title}`, { indent: true, bold: true }));
          children.push(makeBody(`Highlight: The ${guessField(v)} field on this account`, { indent: true }));
          children.push(makeBody(`Write in margin: "VIOLATION #${v.number} — ${v.statute || 'See dispute letter'}"`, { indent: true }));
          children.push(blank(40));
        }
      }
    }

    // If no accounts listed but violations exist
    if (accounts.length === 0 && violations.length > 0) {
      for (const v of violations) {
        violationCount++;
        children.push(makeBody(`${violationCount}. [RED] ${v.title} — Write in margin: "VIOLATION #${v.number}: ${v.statute || 'FCRA Violation'}"`, { indent: true }));
      }
    }
  }

  children.push(makeSectionHeading('IV', 'FINAL REVIEW CHECKLIST'));
  children.push(makeBody('Before sealing your envelopes, verify:'));
  children.push(makeBody('☐  Every account with a dispute letter has highlighted violations marked in red', { indent: true }));
  children.push(makeBody('☐  Every red highlight has a margin note citing the violation number and statute', { indent: true }));
  children.push(makeBody('☐  Financial figure discrepancies are highlighted in orange', { indent: true }));
  children.push(makeBody('☐  You have made enough copies (one set for each recipient + one for your records)', { indent: true }));
  children.push(makeBody('☐  Report pages are in order and all pages are included', { indent: true }));

  children.push(makeSectionHeading('V', 'COPY REQUIREMENTS'));
  children.push(makeBody('You will need the following copies of your highlighted credit report:'));
  children.push(makeBody('☐  1 copy — For the CRA (include in your main dispute package envelope)', { indent: true }));
  const cra = getCRA(consumer.bureau);
  furnishers.forEach((f, i) => {
    children.push(makeBody(`☐  1 copy — For ${f.name} (include in furnisher package #${i + 2})`, { indent: true }));
  });
  children.push(makeBody('☐  1 copy — For your personal records', { indent: true }));

  const doc = makeDoc(children);
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function numberWord(n) {
  const words = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN'];
  return words[n] || String(n);
}

function guessField(v) {
  const t = (v.title + ' ' + (v.description || '')).toLowerCase();
  if (t.includes('account number') || t.includes('truncat')) return 'account number';
  if (t.includes('dofd') || t.includes('first delinquency')) return 'Date of First Delinquency (DOFD)';
  if (t.includes('credit limit')) return 'Credit Limit';
  if (t.includes('payment history') || t.includes('nd') || t.includes('no data')) return 'Payment History Profile';
  if (t.includes('balance') || t.includes('past due')) return 'Balance / Past Due Amount';
  if (t.includes('date closed')) return 'Date Closed';
  if (t.includes('charge-off') || t.includes('original charge')) return 'Original Charge-Off Amount';
  if (t.includes('status')) return 'Account Status Code';
  if (t.includes('terms')) return 'Terms/Account Type';
  return 'disputed field';
}

module.exports = {
  generateDisputeLetterDocx,
  generateFileDisclosureDocx,
  generateMailingInstructionsDocx,
  generateHighlightingGuideDocx,
};
