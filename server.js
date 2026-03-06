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

Follow the MANDATORY VIOLATION ANALYSIS PROTOCOL exactly:
1. Run the full 33-point Metro 2® charge-off audit on every account
2. Apply the RED FLAG QUICK REFERENCE CHECKLIST (Sections A–L) to every account
3. Identify ALL violations organized by furnisher (NOT by account)
4. One dispute package per unique furnisher

CRITICAL: First output your findings as structured JSON between <VIOLATIONS_JSON> and </VIOLATIONS_JSON> tags using EXACTLY this schema:

<VIOLATIONS_JSON>
{
  "consumer": {
    "name": "Full Name",
    "address": "Full Address",
    "reportDate": "MM/DD/YYYY",
    "bureau": "Experian|Equifax|TransUnion"
  },
  "summary": {
    "total": 0,
    "critical": 0,
    "high": 0,
    "medium": 0
  },
  "furnishers": [
    {
      "name": "Furnisher Name",
      "address": "Furnisher Address (if available)",
      "phone": "Phone (if available)",
      "accounts": [
        {
          "accountName": "Name",
          "accountNumber": "Number (as shown, may be truncated)",
          "status": "Charge-off|Collection|Delinquent|Current|Closed",
          "balance": "$0.00",
          "pastDue": "$0.00",
          "dateOpened": "MM/YYYY",
          "dofd": "MM/YYYY or null"
        }
      ],
      "violations": [
        {
          "number": 1,
          "accountName": "Account name this violation belongs to (must match an account in accounts[])",
          "title": "Short violation title in ALL CAPS (e.g. CREDIT LIMIT MISSING)",
          "severity": "CRITICAL",
          "statute": "FCRA §1681g(a)(1) / Metro 2® Field 25 / etc.",
          "description": "Detailed description of exactly what is wrong and what data is missing or inaccurate",
          "impact": "How this specific violation harms the consumer or prevents accurate verification",
          "precedent": "Relevant case law if applicable (e.g. Gillespie v. Equifax Info. Servs. LLC) or null",
          "demand": "Specific remedy demanded — delete, correct, or provide documentation"
        }
      ]
    }
  ]
}
</VIOLATIONS_JSON>

After the JSON block, provide any additional narrative analysis needed.`;

    userContentBlocks.unshift({ type: 'text', text: powerPrompt });

    // Call Claude
    console.log(`[${sessionId}] Calling Claude API with ${req.files.length} file(s)...`);
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
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
        <div style="margin-bottom:6px;">${v.description}</div>
        <div style="font-size:13px;color:#2563eb;"><strong>Demand:</strong> ${v.demand}</div>
      </div>`).join('');

    const accountsHtml = (f.accounts || []).map(a => `
      <tr>
        <td>${a.accountName}</td>
        <td style="font-family:monospace">${a.accountNumber}</td>
        <td><span style="padding:2px 8px;border-radius:12px;font-size:12px;background:${a.status === 'Current' ? '#dcfce7' : '#fee2e2'};color:${a.status === 'Current' ? '#166534' : '#991b1b'}">${a.status}</span></td>
        <td>${a.balance}</td>
        <td>${a.pastDue}</td>
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
          <th style="padding:8px 12px">Past Due</th><th style="padding:8px 12px">DOFD</th>
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
  <h1 style="font-size:24px;margin-bottom:4px;">BMB Credit Report Violation Analysis</h1>
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
    Generated by BMB Ultimate Dispute Letter Generator &bull; ${new Date().toLocaleDateString()}
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
    console.log(`\n✅ BMB Dispute Generator running at http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('Failed to load knowledge files:', err);
  process.exit(1);
});
