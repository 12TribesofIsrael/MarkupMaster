require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const archiver = require('archiver');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const { generateDisputeLetterDocx, generateFileDisclosureDocx, generateMailingInstructionsDocx, generateHighlightingGuideDocx } = require('./docx-generator');

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Serve static frontend ───────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

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

// ─── POST /analyze ────────────────────────────────────────────────────────────
app.post('/analyze', (req, res, next) => {
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
33-POINT ANALYSIS PROTOCOL (Credit Manifesto + SOP)
═══════════════════════════════════════════════════════════════

For EACH account on the credit report, systematically check ALL 33 categories below.
RULE: Every category that has a label on the report MUST have data — blank fields, dashes, or $0 where a real value should be = VIOLATION.
RULE: If a category exists on the report but has no data, that is INCOMPLETE REPORTING (FCRA §1681e(b)).
RULE: Experian and TransUnion are notorious for missing Date of First Delinquency — ALWAYS flag if missing.
RULE: TransUnion commonly shows "$0" as last payment — flag this (how can last payment be $0?).
RULE: Experian is notorious for having no data in payment history section — flag blank payment grids.

1. ACCOUNT STATUS — Is it correct? (open/closed/charged-off/collection/paid). Does it match reality? Status not updated = violation. Status says "Charged Off" but was paid = violation. (FCRA §1681e(b))

2. CHARGE-OFF AMOUNT — Is the amount written off present and accurate? Blank/missing = CRITICAL violation. Does it match balance at time of charge-off? Inflated or unexplained amount = violation. (Metro 2 Field 23)

3. CHARGE-OFF DATE — Is the date present and accurate? Missing = violation. Does it align with payment history showing 6 months delinquency? Future date or impossible date = violation.

4. ORIGINAL CREDITOR — Is the correct company listed? Wrong name, incomplete name, outdated name = violation. For collections: does it identify the original creditor? Missing original creditor on collection = violation. (FCRA §1681g(a)(2))

5. ACCOUNT NUMBER — Is it present? Truncated with X's/asterisks preventing consumer verification = violation (Gillespie v. Equifax, FCRA §1681g(a)(1) — CRITICAL). Fewer digits than expected = violation. Wrong number = violation.

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

9. DATE OF FIRST DELINQUENCY (DOFD) — Is it present? MISSING DOFD = CRITICAL VIOLATION (consumer cannot determine 7-year removal date). Experian and TransUnion often omit this — ALWAYS CHECK. Does DOFD align with payment history? If DOFD says Feb 2018 but payment history shows a payment was made that month = contradiction = VIOLATION. (FCRA §1681c(a))

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
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

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
          "reportShows": "EXACT value from the credit report that proves this violation (quote verbatim), or 'FIELD NOT PRESENT' if the violation is a missing field",
          "shouldShow": "What the correct/compliant value should be, or 'Must be present per [statute]'",
          "description": "Detailed description referencing the exact data from the report",
          "impact": "How this harms the consumer or prevents verification",
          "precedent": "Case law citation or null",
          "demand": "Specific remedy: delete, correct, provide documentation, or investigate"
        }
      ]
    }
  ]
}
</VIOLATIONS_JSON>

IMPORTANT QUALITY RULES:
- FURNISHERS ONLY: Only list actual data furnishers (creditors, lenders, collection agencies). Do NOT create a furnisher entry for the CRA itself (TransUnion, Experian, Equifax). CRA-level issues belong in the individual furnisher violations.
- Every value in "accounts" must be EXACTLY as shown on the credit report images, or null. Do NOT fabricate any data.
- Every violation "reportShows" field must quote the EXACT value from the report.
- Do NOT generate a violation if your own analysis concludes the data is actually correct. If you check a category and find no issue, skip it — do not create a violation with a title claiming a problem and then a body saying there is no problem.
- Number violations sequentially across ALL accounts per furnisher (not restarting at 1 per account).
- Minimum expected violations per account type: Charge-offs 5+, Collections 3+, Delinquent 2+, Late payments 2+.`;

    userContentBlocks.unshift({ type: 'text', text: powerPrompt });

    // Call Claude
    console.log(`[${sessionId}] Calling Claude API with ${req.files.length} file(s)...`);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 32000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContentBlocks }],
    });

    const responseText = response.content[0].type === 'text' ? response.content[0].text : '';
    console.log(`[${sessionId}] Claude response received (${Math.round(responseText.length / 1000)}k chars)`);

    // Parse JSON block
    let violationsData = null;
    const jsonMatch = responseText.match(/<VIOLATIONS_JSON>([\s\S]*?)<\/VIOLATIONS_JSON>/);
    if (jsonMatch) {
      try {
        violationsData = JSON.parse(jsonMatch[1].trim());
      } catch (e) {
        console.warn(`[${sessionId}] JSON parse failed:`, e.message);
      }
    }

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

    // Filter out CRA-as-furnisher entries (TransUnion/Experian/Equifax are CRAs, not furnishers)
    const craNames = ['transunion', 'experian', 'equifax'];
    if (violationsData.furnishers) {
      violationsData.furnishers = violationsData.furnishers.filter(f => {
        const nameLower = (f.name || '').toLowerCase();
        return !craNames.some(cra => nameLower.includes(cra));
      });
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

    // Generate output files
    const outputDir = path.join(__dirname, 'outputs', sessionId);
    fs.mkdirSync(outputDir, { recursive: true });

    const generatedFiles = [];

    // Generate one .docx dispute letter per furnisher (using structured data)
    for (const furnisher of (violationsData.furnishers || [])) {
      const safeName = furnisher.name.replace(/[^a-zA-Z0-9]/g, '_');
      const filename = `Dispute_Letter_${safeName}.docx`;
      const filepath = path.join(outputDir, filename);
      await generateDisputeLetterDocx(
        { furnisherName: furnisher.name, furnisher, accounts: furnisher.accounts || [], violations: furnisher.violations || [] },
        violationsData.consumer,
        filepath
      );
      generatedFiles.push({ name: filename, path: filepath, label: `Dispute Letter — ${furnisher.name}` });
    }

    // File Disclosure Demand letter
    const disclosurePath = path.join(outputDir, 'File_Disclosure_Demand.docx');
    await generateFileDisclosureDocx(violationsData.consumer, disclosurePath);
    generatedFiles.push({ name: 'File_Disclosure_Demand.docx', path: disclosurePath, label: 'File Disclosure Demand (§1681g)' });

    // Mailing Instructions docx — pass full structured data
    const mailingPath = path.join(outputDir, 'Mailing_Instructions.docx');
    await generateMailingInstructionsDocx(violationsData, mailingPath);
    generatedFiles.push({ name: 'Mailing_Instructions.docx', path: mailingPath, label: 'Mailing Instructions' });

    // Highlighting Guide docx — pass full structured data
    const guidePath = path.join(outputDir, 'Highlighting_Guide.docx');
    await generateHighlightingGuideDocx(violationsData, guidePath);
    generatedFiles.push({ name: 'Highlighting_Guide.docx', path: guidePath, label: 'Highlighting Guide' });

    // HTML Violation Report
    const htmlReport = generateViolationReportHtml(violationsData);
    const htmlPath = path.join(outputDir, 'Violation_Report.html');
    fs.writeFileSync(htmlPath, htmlReport, 'utf8');
    generatedFiles.push({ name: 'Violation_Report.html', path: htmlPath, label: 'Interactive Violation Report' });

    // ZIP everything
    const zipPath = path.join(outputDir, 'BMB_Dispute_Package.zip');
    await zipFiles(generatedFiles.map(f => f.path), zipPath, outputDir);

    // Cleanup uploads
    fs.rmSync(path.join(__dirname, 'uploads', sessionId), { recursive: true, force: true });

    res.json({
      sessionId,
      violations: violationsData.summary,
      furnishers: (violationsData.furnishers || []).map(f => ({
        name: f.name,
        violationCount: (f.violations || []).length,
        accountCount: (f.accounts || []).length,
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
app.get('/download/:sessionId/:filename', (req, res) => {
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
function buildLetterText(furnisher, consumer) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const violationLines = (furnisher.violations || []).map(v =>
    `VIOLATION #${v.number}: ${v.title}\n[${v.severity}]\nStatute: ${v.statute}\nFinding: ${v.description}\nDemand: ${v.demand}`
  ).join('\n\n');

  return `VIA CERTIFIED MAIL — RETURN RECEIPT REQUESTED
Tracking No.: ___________________________

${today}

${consumer.bureau || 'Experian'} Consumer Dispute Department
Attn: Disputes/Compliance

RE: FORMAL DISPUTE UNDER FCRA §1681i — ${furnisher.name.toUpperCase()} ACCOUNTS

CC: ${furnisher.name}
${furnisher.address || '[Furnisher Address]'}
${furnisher.phone || ''}

Consumer: ${consumer.name}
Address: ${consumer.address}
Date of Birth: [Redacted]
SSN (Last 4): [Redacted]
Report Date: ${consumer.reportDate}

═══════════════════════════════════════════════════

SECTION I — STATUTORY AUTHORITY & CONSUMER RIGHTS

This dispute is submitted pursuant to the Fair Credit Reporting Act (FCRA), 15 U.S.C. §1681 et seq., including:
• §1681i(a) — Reinvestigation of disputed information
• §1681e(b) — Maximum possible accuracy requirement
• §1681g(a) — Full file disclosure
• §1681s-2(b) — Furnisher duties upon notice of dispute
• Metro 2® Credit Reporting Standards (CDIA 2023)

═══════════════════════════════════════════════════

SECTION II — DISPUTED ACCOUNTS & VIOLATIONS

${violationLines}

═══════════════════════════════════════════════════

SECTION III — STATUTORY DEMANDS

Pursuant to FCRA §1681i(a), I hereby demand:

A. Conduct a full and reasonable reinvestigation of each disputed item identified above.
B. Contact the furnisher (${furnisher.name}) and provide all relevant dispute information per §1681i(a)(2).
C. Provide complete verification of each item or delete it from my consumer file.
D. Provide full file disclosure per §1681g(a), including method of verification for each item.
E. Suppress all disputed items during investigation per §1681i(a)(5)(A).
F. Provide a corrected copy of my consumer disclosure upon completion per §1681i(a)(6).
G. Forward a description of reinvestigation results to all other consumer reporting agencies per §1681i(a)(6)(B).
H. Delete any information that cannot be verified within the 30-day deadline per §1681i(a)(5)(A).

═══════════════════════════════════════════════════

COMPLIANCE TIMELINE

Investigation must be completed within 30 days of receipt per FCRA §1681i(a)(1).
Failure to comply may result in civil litigation under §1681n (willful, up to $1,000 per violation) or §1681o (negligent, actual damages + attorney fees).

═══════════════════════════════════════════════════

CERTIFICATION

I certify under penalty of law that the information provided in this dispute is true and accurate to the best of my knowledge.

Respectfully submitted,

_______________________________
${consumer.name}
Date: ${today}

Enclosures:
□ Government-issued photo ID
□ Proof of current address
□ Highlighted copy of credit report
□ Copy of this dispute letter`;
}

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

// ─── Start server ─────────────────────────────────────────────────────────────
loadKnowledge().then(() => {
  app.listen(PORT, () => {
    console.log(`\n✅ BMB AI Automation — Markup Mastery Generator running at http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to load knowledge files:', err);
  process.exit(1);
});
