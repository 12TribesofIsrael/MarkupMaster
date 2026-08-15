# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Markup Mastery** — a local Node.js web app that runs FCRA dispute **campaigns** end to end,
following the dispute doctrine of consumer attorney John G. Watts (doctrine source: the RAG
corpus in `c:\Users\Claude\Litigation`):

1. Upload credit report pages (JPG/PNG/PDF) → Claude (`claude-sonnet-4-6`) runs the 33-point
   Metro 2® audit with the `docs/` knowledge base as system context
2. The consumer reviews per-account **gates** (actually-wrong + thrilled-if-deleted) and
   confirms every address the report prints against their photo ID, edits wording, and
   approves — only then are final letters generated
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
                     account_decisions, violation_items, report_addresses,
                     events (the chronology)
docx-generator.js    All document generators (Watts letter, memo, 1681g, mailing, markup
                     map, results diff, MOV request) + the ID/proof exhibit pages
identity-docs.js     Photo ID + proof-of-address scans: PDF→PNG normalization, PNG/JPEG
                     header dimension reader (no image dependency)
cra-addresses.js     Single source of truth for CRA dispute addresses
pdf-annotator.js     Red-box annotation of the report copy (text layer / OCR / model bbox)
ocr_words.py         pytesseract word-box helper for image snapshots
ocr_pdf_pages.py     pytesseract per-page word boxes for SCANNED PDFs (no text layer)
render_pdf_pages.py  pymupdf PDF→PNG page renderer (identity documents)
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
- Some bureau PDFs (browser-printed Experian in particular) are **pure page images with no
  text layer**, so the annotator's text search finds nothing and the marked-up copy comes out
  empty. `annotateCreditReportPdf` OCRs every page (`ocr_pdf_pages.py`) and feeds the result
  through the same box-placement path — but only when the text layer is *completely* empty,
  so a report that already places boxes never changes behavior. When a file still produces no
  boxes, `annotation_status.json` records it and the round page shows a banner: the annotated
  report is a mailed enclosure, so a silent miss ships an incomplete package.
- Deterministic guards in `server.js` inject masked-account-number (§1681g(a)(1)),
  missing-DOFD, and blank-Date-of-Last-Activity violations, then renumber — never remove
  the renumbering pass.
- **Master-markup doctrine (`mastermarkups/` holds the two archetype reports):** anything
  the report prints but does not populate gets a red box, and every box corresponds to a
  letter item. `unpopulated-sweep.js` runs after the guards on every uploaded file's own
  text (text layer or OCR): masked account numbers, account-identity anchor rows,
  blank/dash field values, TransUnion `---` payment-history columns/blocks, Experian `ND`
  cells and in-window dash runs. Findings attach measured rectangles (`markup[].sweep`) to
  existing items or inject grouped per-account items; the annotator draws those rects
  verbatim (strategy `sweep`) — no model judgment anywhere in that path. Verify changes
  against the archetypes by rendering, not by counts.
- Rotated scans (browser-printed Experian: landscape content on portrait pages) are
  auto-uprighted by `ocr_pdf_pages.py` (tesseract OSD + yield check); all matching happens
  in upright space and `rectToPage` maps boxes back at draw time. The OCR also merges a
  psm 11 sparse pass — that is what recovers faint bare labels like a blank "Phone" row. The DOLA guard only fires when the uploaded PDF actually prints a
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
- The photo ID and proof of address the consumer uploads are stored **on the client**
  (`clients.id_doc_paths` / `proof_doc_paths`, JSON arrays of PNG/JPG paths) and print as
  EXHIBIT pages at the end of both the dispute letter and the §1681g letter. The letters
  assert on their face that both are enclosed — never ship a change that drops the exhibits
  while leaving that sentence in. When a scan is missing, the enclosure stays on the list and
  Mailing_Instructions prints an unchecked box instead of "already printed".
- **Address doctrine: a report legitimately carries address history, so an address that does
  not match the ID is NOT a violation.** Never auto-inject an address dispute. `/analyze`
  only *lists* addresses (`consumer.addressesOnReport` + `personalInfoSectionPresent`);
  the consumer answers "have you ever lived here" per address, and only a confirmed **no**
  becomes an item. An address matching the ID can never be disputed — the letter would
  contradict its own enclosures — and both the PATCH endpoint and `addressViolations()`
  refuse it. If the personal-information page was not uploaded, say the check was skipped;
  never report "no other addresses found".
- Address items ship as a `MY PERSONAL INFORMATION` pseudo-furnisher (`isPersonalInfo: true`)
  spliced in at generate time, always first so it takes item 1. It is excluded from the cc
  list, the mailing packages, and the account gate — its gate is the per-address answers.
  Generation renumbers every item afterward and resyncs `violation_items.item_number`.
