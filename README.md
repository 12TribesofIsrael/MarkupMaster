# BMB Ultimate Dispute Letter Generator

A local Node.js web application that analyzes credit report images using Claude AI and automatically generates a complete, litigation-ready FCRA dispute package.

---

## What It Does

Upload 1–10 credit report images (JPG, PNG, or PDF). The app sends them to Claude (`claude-sonnet-4-6`) along with the full BMB knowledge base, runs a 33-point Metro 2® violation audit on every account, and produces a ready-to-mail dispute package in under 2 minutes.

**Output per run (7 files):**
- `Dispute_Letter_[Furnisher].docx` — One letter per furnisher (covers all their accounts), addressed to the CRA with CC to the furnisher
- `File_Disclosure_Demand.docx` — Standalone §1681g(a) demand for complete file disclosure
- `Mailing_Instructions.docx` — Per-envelope checklists, 30-day timeline table, CFPB escalation steps
- `Highlighting_Guide.docx` — Color-coded page-by-page marking guide for the credit report
- `Violation_Report.html` — Interactive violation report with severity breakdown
- `BMB_Dispute_Package.zip` — All files bundled for download

---

## Setup

### 1. Install dependencies
```bash
cd c:\Users\Tommy\disputeapp
npm install
```

### 2. Add your API key
Edit `.env`:
```
ANTHROPIC_API_KEY=sk-ant-api03-...
PORT=4000
```

### 3. Start the server
```bash
node server.js
```

Open **http://localhost:4000**

---

## Starting the Server

Every time you restart your computer or close the terminal, you need to restart the server:

```bash
cd c:\Users\Tommy\disputeapp
node server.js
```

You should see:
```
Loaded 16 knowledge files into system prompt (336k chars)
✅ BMB Dispute Generator running at http://localhost:4000
```

---

## Using the App

1. Open **http://localhost:4000** in your browser
2. Drag and drop credit report images (JPG/PNG) or PDF pages — up to 10 files, 20MB each
3. Click **Analyze Credit Report**
4. Wait 60–90 seconds while Claude analyzes the report
5. Review the violation summary (Total / Critical / High / Medium counts)
6. Download the full ZIP or individual files

---

## Running from the Command Line (no browser)

To run a batch analysis directly:

```bash
cd c:\Users\Tommy\disputeapp
curl -X POST http://localhost:4000/analyze \
  -F "files=@Reports/intro.jpg" \
  -F "files=@Reports/page2.jpg" \
  --max-time 300
```

Output files are saved to `outputs/<session-id>/`. Copy them to a named folder:

```bash
cp -r outputs/<session-id>/. outputs/ClientName-Date/
```

---

## File Structure

```
disputeapp/
  server.js              ← Express server — API calls, docx generation, ZIP
  docx-generator.js      ← All DOCX formatting logic (letters, guides, instructions)
  package.json
  .env                   ← Your API key (never share or commit this)
  .env.example           ← Template for .env
  public/
    index.html           ← Web UI
    style.css
    app.js
  docs/                  ← All 16 BMB knowledge files loaded as AI context
    Markup_Example/      ← Reference letter examples (not loaded as context)
  Reports/               ← Sample credit report images for testing
  outputs/               ← Generated dispute packages (one folder per run)
    test-run/            ← Test output from the Thomas Lee sample report
```

---

## Knowledge Base (docs/)

The server loads all 16 files from `docs/` into Claude's system prompt at startup. These govern how violations are identified and letters are written:

| File | Purpose |
|------|---------|
| `BMB_Generator_-_Operating_Protocolv2_1.txt` | Master operating protocol — governs entire analysis |
| `BMB_6-Letter_Furnisher_Dispute_Package_Template.md` | Primary letter structure template |
| `BMB_MANDATORY_VIOLATION_ANALYSIS_PROTOCOL.md` | 6-phase analysis protocol |
| `BMB_RED_FLAG_QUICK_REFERENCE_CHECKLIST.md` | 12-section per-account violation checklist |
| `Metro_2__Field_Violation_Catcher__Comprehensive_Reference.md` | 33-point Metro 2® audit |
| `FCRA_-_Fair_Credit_Reporting_Act.pdf` | Full FCRA statute (§1681 et seq.) |
| `FDCPA_-_Fair_Debt_Collection_Practices_Act.pdf` | Full FDCPA statute (§1692 et seq.) |
| `Metro_2_Credit_Reporting_Guide.pdf` | CDIA Metro 2® technical field standards |
| `The_credit_manifesto.md` | Furnisher duties, 33-point charge-off review |
| `BMB_Dispute_Letter_Standard_Format.md` | Reference letter format and tone |
| `BMB_Federal_Complaint_Template_NEW.md` | Litigation escalation template |
| `Universal_CRA_Dispute_Letter_Template__Per_Furnisher_.md` | CRA letter template |
| `Universal_Mailing_Instructions___Timeline_Template.md` | 30-day timeline procedures |
| `Statute_of_Limitations_by_State__Enforcement_Guide.md` | State SOL reference |
| `FCRA_Damage_Calculator___1681n____1681o_SaaS_Foundation_.html` | Damage calculator |
| `BMB_FILE_STRUCTURE_GUIDE.md` | File relationship map |

---

## Letter Format

All dispute letters follow the BMB standard format:

1. **VIA CERTIFIED MAIL** banner (black background)
2. Date + CRA address block
3. **RE:** line with statute citations
4. **CC:** furnisher block (address + tracking number blank)
5. Consumer info (name, address, DOB/SSN redacted, report date)
6. **Section I** — Statutory Authority (FCRA §1681i, §1681e(b), §1681g(a), §1681s-2(b), Metro 2®)
7. **Section II** — Disputed Accounts & Violations (numbered, per account, with WHAT IS WRONG / IMPACT / PRECEDENT / DEMAND)
8. **Section III** — 8 Statutory Demands (A–H)
9. **Section IV** — Compliance Timeline & Legal Consequences (§1681n / §1681o)
10. **Section V** — Enclosed Documentation checklist
11. Certification + Signature block
12. **CERTIFIED MAIL TRACKING** footer

---

## Key Rules (enforced by the AI)

- **One letter per furnisher** — not per account. All accounts from one creditor are grouped into a single letter.
- **Violations numbered sequentially** across all accounts within a furnisher's letter.
- **CC line is mandatory** — every CRA dispute letter copies the furnisher.
- **Statute citations are exact** — `§1681i(a)(5)(A)`, not "FCRA says..."
- **33-point Metro 2® audit** runs on every charge-off and delinquent account.

---

## Violation Severity Levels

| Level | Color | Meaning |
|-------|-------|---------|
| CRITICAL | Red | Must delete or correct — directly affects 7-year reporting or account verifiability |
| HIGH | Orange | Significant inaccuracy — Metro 2® field violation or improper status |
| MEDIUM | Yellow | Documentation gap — requires clarification or correction |

---

## Escalation Path (after 30 days with no response)

1. File CFPB complaint at **consumerfinance.gov/complaint** (use certified mail tracking number)
2. File FTC complaint at **ftc.gov/complaint**
3. Consult consumer rights attorney — civil litigation under:
   - **§1681n** (willful): $100–$1,000 statutory per violation + punitive damages + attorney fees
   - **§1681o** (negligent): Actual damages + attorney fees + court costs

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `invalid x-api-key` | Edit `.env` and add your real `ANTHROPIC_API_KEY` |
| `EADDRINUSE port 4000` | Another process is using port 4000. Kill it: `netstat -ano \| findstr :4000` then `taskkill /F /PID <pid>` |
| `prompt is too long` | Reduce to fewer than 10 images per run, or split across two runs |
| Server not responding | Restart: `node server.js` from the `disputeapp` directory |
| Empty output ZIP | Check the terminal for Claude API errors — usually an auth or quota issue |
