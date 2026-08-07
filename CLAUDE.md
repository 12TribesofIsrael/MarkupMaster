# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Markup Mastery** — a local Node.js web app that runs FCRA dispute **campaigns** end to end,
following the dispute doctrine of consumer attorney John G. Watts (doctrine source: the RAG
corpus in `c:\Users\Claude\Litigation`):

1. Upload credit report pages (JPG/PNG/PDF) → Claude (`claude-sonnet-4-6`) runs the 33-point
   Metro 2® audit with the `docs/` knowledge base as system context
2. The consumer reviews per-account **gates** (actually-wrong + thrilled-if-deleted), edits
   wording, and approves — only then are final letters generated
3. Mail dates / tracking / delivery are captured; the 30-day §1681i clock is tracked
4. When results arrive, **response intake** diffs every item (fixed / deleted /
   verified-unchanged / unclear), drafts a FINAL NOTICE round 2/3 from the verified items,
   and maintains the willfulness chronology for litigation

## The Watts letter doctrine (why the letters look the way they do)

- The **mailed** dispute letter is plain English: no statute citations, no case names, no
  Metro 2 — a specific factual error + exact remedy per item, ID + address proof enclosed,
  circled report pages enclosed, full copy cc'd to every furnisher, and a demand for a
  written explanation (the willfulness scaffold). Legalistic template letters get treated
  as credit-repair spam and dismissed by judges as "worthless letters."
- All statutes/case law live in the **internal** `Litigation_Memo.docx` (+
  `litigation_memo.json`, keyed to `docs/BMB_Federal_Complaint_Template_NEW.md` counts).
- The §1681g letter is a plain-language full-file request (Kelly v. RealPage, 3d Cir.).
- NEVER reintroduce: minimum violation quotas in the prompt, statutes in mailed letter text,
  blanket "delete this entire account" remedies for field-level errors, or a 609-letter/
  magic-letter framing.

## File Structure

```
server.js            Express app: PIN gate, campaign REST API, /analyze, intake, generate
db.js                better-sqlite3 store: clients, campaigns, reports, runs, rounds,
                     account_decisions, violation_items, events (the chronology)
docx-generator.js    All document generators (Watts letter, memo, 1681g, mailing, markup
                     map, results diff, MOV request)
cra-addresses.js     Single source of truth for CRA dispute addresses
pdf-annotator.js     Red-box annotation of the report copy (text layer / OCR / model bbox)
ocr_words.py         pytesseract word-box helper (needs python + tesseract on PATH)
public/              Vanilla-JS SPA: js/api.js, js/router.js, js/views/{clients,campaign,
                     round,intake,chronology}.js — hash-routed, no build step
docs/                Knowledge base loaded into the system prompt (40k chars/file cap)
data/                SQLite DB + campaign files (gitignored — holds PII)
outputs/<uuid>/      Per-run generated documents (gitignored — holds PII)
```

## Commands

```bash
npm install
node server.js          # http://localhost:4000  (binds 127.0.0.1 only)
```

`.env`: `ANTHROPIC_API_KEY` (required), `PORT` (default 4000), `APP_PIN` (optional but
recommended — gates /analyze, /api, /download), `OUTPUT_RETENTION_DAYS` (default 30,
orphan-session pruning; campaign-linked runs are kept).

## Output set per approved round

`Dispute_Letter.docx` (the only mailed dispute instrument) · `Litigation_Memo.docx` + `.json`
(internal, never mailed) · `Markup_Map.docx` · `Full_File_Request.docx` (round 1, separate
envelope) · `Mailing_Instructions.docx` · `Violation_Report.html` · original + annotated
report copies · `BMB_Dispute_Package.zip`. Intake adds `Results_Diff.docx` and
`MOV_Request.docx` (supporting exhibit only).

## Key invariants

- Letters are organized by furnisher; item numbers are global across the letter and match
  the Markup Map and `violation_items.item_number`.
- Deterministic guards in `server.js` inject masked-account-number (§1681g(a)(1)),
  missing-DOFD, and blank-Date-of-Last-Activity violations, then renumber — never remove
  the renumbering pass. The DOLA guard only fires when the uploaded PDF actually prints a
  "Date of Last Activity" label (Equifax does, the others often don't), so it never boxes a
  field that isn't there.
- Date of Last Activity is **not** an FCRA-required field (Watts). Never plead a blank DOLA as
  a mandatory-field omission and never cite a Metro 2 field number for it — it is a §1681g
  clarity defect, and Gillespie v. Equifax, 484 F.3d 938 (7th Cir. 2007) is the DOLA case,
  not the account-number case.
- `violationsData` JSON schema is dictated in the `/analyze` prompt; per-violation fields
  `remedyType`/`remedyWording`/`internalContradiction` and per-furnisher `isCollector`
  are required by the generators.
- Rounds are capped at 3. `verified_unchanged` → FINAL NOTICE round or escalation.
- The `events` table is the willfulness chronology — every real-world act gets a row with
  its real-world date; the memo pleads straight from it.
- Human approval is mandatory: `POST /api/rounds/:id/generate` is the only path to final
  letters (CRO-liability lesson — no unreviewed letters in the consumer's name).
