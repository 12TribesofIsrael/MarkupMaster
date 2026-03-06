# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **BMB Ultimate Dispute Letter Generator** — a local Node.js web application that:
1. Accepts uploaded credit report images (JPG/PNG/PDF)
2. Sends them to the Anthropic API (`claude-sonnet-4-6`) with all BMB knowledge files as system context
3. Parses the AI response to extract violations organized by furnisher
4. Generates a complete dispute package: `.docx` letters (one per furnisher) + HTML violation report + ZIP download

## Target File Structure

```
bmb-webapp/
  server.js          <- Express server, Anthropic API calls, docx generation, zip
  public/
    index.html       <- Single-page app (dark-themed dashboard)
    style.css
    app.js
  knowledge/         <- All BMB project knowledge files loaded into system prompt
  uploads/           <- Temp storage for uploaded images (multer)
  outputs/           <- Generated files per session
  package.json
  .env               <- ANTHROPIC_API_KEY (never commit)
```

## Commands

```bash
node server.js          # Start app on port 3000
npm install             # Install dependencies
```

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `multer` | File upload handling |
| `docx` | Word document generation |
| `archiver` | ZIP file creation |
| `@anthropic-ai/sdk` | Anthropic API calls |
| `dotenv` | Environment variable loading |

## Architecture

### Backend (`server.js`)
- Loads all files in `knowledge/` as concatenated system prompt text
- Accepts uploaded images (base64-encoded) in user message
- Calls `claude-sonnet-4-6` with the BMB Power Prompt from `BMB_Generator_-_Operating_Protocolv2_1.txt`
- Parses structured violation data from Claude's response (organized by furnisher)
- Feeds parsed data into `docx` generators to produce per-furnisher letters
- ZIPs all outputs and serves as single download

### Dispute Package Output (per session)
- One `.docx` CRA dispute letter per furnisher (covering all that furnisher's accounts)
- One `.docx` furnisher demand letter per furnisher (§1681s-2(b))
- One PDF Highlighting Guide
- One HTML annotated violation report (color-coded: RED/YELLOW/ORANGE/PURPLE/BLUE/GREEN)
- One complete Mailing Instructions document
- All files bundled into one `.zip`

### Letter Organization Rule
Letters are organized **by furnisher, not by account**. If a furnisher has 3 accounts, all 3 go into ONE letter. Total packages = number of unique furnishers.

### DOCX Letter Format (mandatory structure)
1. VIA CERTIFIED MAIL header block
2. CRA address
3. RE line with statute citations
4. CC block (furnisher address + tracking number blank) — **CRITICAL, never omit**
5. Consumer info block
6. Numbered violations with statute citations (sequential across all accounts per furnisher)
7. 8 statutory demands (A–H)
8. Compliance timeline (30 days)
9. Certification and signature block

## Knowledge Files (loaded as system context)

| File | Role |
|------|------|
| `BMB_Generator_-_Operating_Protocolv2_1.txt` | Master operating protocol — governs entire analysis |
| `BMB_6-Letter_Furnisher_Dispute_Package_Template.md` | Primary letter structure template |
| `BMB_MANDATORY_VIOLATION_ANALYSIS_PROTOCOL.md` | 6-phase analysis protocol (must complete before letter generation) |
| `BMB_RED_FLAG_QUICK_REFERENCE_CHECKLIST.md` | 12-section per-account violation checklist (Sections A–L) |
| `BMB_DISPUTE_GENERATION_PROCESS_FLOWCHART.md` | Enforced step sequence |
| `Metro_2__Field_Violation_Catcher__Comprehensive_Reference.md` | 33-point charge-off audit |
| `FCRA_-_Fair_Credit_Reporting_Act.pdf` | Primary statute (§1681i, §1681e, §1681g, §1681s-2, §1681c, §1681n, §1681o) |
| `FDCPA_-_Fair_Debt_Collection_Practices_Act.pdf` | Used for collection accounts (§1692g, §1692e, §1692f) |
| `Metro_2_Credit_Reporting_Guide.pdf` | Technical field standards (Fields 11-26, FAQ 31-36) |
| `The_credit_manifesto_.pdf` | Furnisher duties, 33-point charge-off review |
| `Universal_Mailing_Instructions___Timeline_Template.md` | 30-day timeline and certified mail procedures |
| `Statute_of_Limitations_by_State__Enforcement_Guide.md` | State SOL reference for litigation |
| `FCRA_Damage_Calculator___1681n____1681o_SaaS_Foundation_.html` | Statutory damage calculator |
| `BMB_Federal_Complaint_Template_NEW.docx` | Escalation: litigation-grade federal complaint |
| `Universal_CRA_Dispute_Letter_Template__Per_Furnisher_.md` | CRA letter template |

## Key Legal Citations Used in Letters

- **Gillespie v. Equifax** — truncated account numbers (§1681g(a)(1))
- **Seamans v. Temple University** — improper delinquency sequencing (§1681e(b))
- **Cushman v. TransUnion** — CRA must conduct independent investigation (§1681i)
- **Bradshaw v. BAC Home Loans** — boilerplate e-OSCAR responses insufficient (§1681i)

## UI Requirements

- Dark navy header, white cards
- Step indicator: Upload → Analyzing → Generating → Download
- Progress bar during API call
- Violation summary cards (total, critical, high, medium) before download
- Download button for full ZIP + individual file links
- Clear error states
