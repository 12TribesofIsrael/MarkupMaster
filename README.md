# Markup Mastery — FCRA Dispute Campaign Manager

A local Node.js web app that runs credit-report dispute **campaigns** end to end in the
doctrine of consumer attorney John G. Watts: AI-detected violations, plain-English dispute
letters a judge can't dismiss as credit-repair spam, certified-mail tracking with a live
30-day clock, response intake that diffs the bureau's answer item by item, FINAL NOTICE
rounds 2–3, and a litigation memo + chronology that's ready to become a federal complaint.

---

## What It Does

1. **Analyze** — Upload 1–10 credit report pages (JPG/PNG/PDF). Claude
   (`claude-sonnet-4-6`) runs the 33-point Metro 2® audit with the full `docs/` knowledge
   base as context and returns field-level violations per furnisher.
2. **Gate & approve** — For every account you confirm two Watts rules: the information is
   *actually wrong* (defensible under oath), and you'd be *thrilled if the whole account
   were deleted*. You can edit every item's wording. Only after approval are final letters
   generated — nothing goes out unreviewed.
3. **Mail & track** — Certified mail only (never online). You log the mail date, tracking
   number, and delivery date; the app computes and counts down the 30-day §1681i clock.
4. **Intake results** — When the results-of-investigation letter arrives, upload it with a
   fresh report. Every item is classified **fixed / deleted / verified-unchanged /
   unclear** with evidence quotes. Verified-unchanged items auto-draft a FINAL NOTICE
   round (max 3 rounds) that recites your real mailing chronology — or escalate.
5. **Build the case** — Every dated act lands in the chronology. The internal
   `Litigation_Memo.docx` maps each item to its statutes (§1681e(b), §1681i, §1681g,
   §1681s-2(b), FDCPA §1692e(8) for collectors), carries the 3d-Circuit case bank and
   §1681n damages math, and tracks the 2-year SOL from the results date.

### The letter doctrine

The **mailed** letter contains **zero** statutes, case names, or Metro 2 citations — a
specific factual error, why it's wrong, a reference to the circled report page, and the
exact remedy, per item, plus a demand for a written explanation (the willfulness record).
Full identity block and ID + address-proof enclosures defeat the "we don't think this is
you" stall. Every furnisher is cc'd a complete copy. All the law lives in the internal
litigation memo instead — mailed letters persuade investigators; memos win lawsuits.

---

## Setup

```bash
npm install
```

`.env`:
```
ANTHROPIC_API_KEY=sk-ant-api03-...
PORT=4000
APP_PIN=1234                # optional but recommended — gates the app & downloads
OUTPUT_RETENTION_DAYS=30    # optional — orphan session cleanup
```

```bash
node server.js
```

Open **http://localhost:4000** (the server binds to 127.0.0.1 only — reports and letters
contain PII).

---

## Using the App

- **Clients** → add a client (the identity block that goes on every letter) → **New
  campaign** (one bureau per campaign) → **Start Round 1 analysis** → upload the report.
- **Round view** → check the two gates per account, acknowledge any warnings (unpaid
  collections that SOL-wise shouldn't be poked, items about to age off), edit wording,
  **Approve & generate**, print/sign/mail per the Mailing Instructions, then enter the
  mail date + tracking.
- **Campaign dashboard** → watch the 30-day countdown, log phone calls (kills the "you
  should have called" defense), and open **Response intake** when results arrive.
- **Quick analysis** (top nav) still works without any campaign tracking.

### Output set per approved round

| File | What it is |
|------|-----------|
| `Dispute_Letter.docx` | The one mailed dispute instrument (plain English) |
| `Full_File_Request.docx` | §1681g full-file request — separate envelope (round 1) |
| `Litigation_Memo.docx` + `.json` | INTERNAL — statutes, cases, damages, chronology |
| `Markup_Map.docx` | Red-box guide; numbers match the letter |
| `Annotated_Credit_Report_*.pdf` | Report copy with the errors boxed in red |
| `Mailing_Instructions.docx` | Envelope-by-envelope assembly + timeline |
| `Violation_Report.html` | Interactive severity breakdown |
| `BMB_Dispute_Package.zip` | Everything bundled |

Intake adds `Results_Diff.docx` (before→after per item) and `MOV_Request.docx`
(method-of-verification request — a supporting exhibit, never the case).

---

## File Structure

```
server.js              Express app: PIN gate, campaign REST API, /analyze, intake
db.js                  SQLite store (better-sqlite3): clients, campaigns, rounds,
                       violation_items, events (the willfulness chronology)
docx-generator.js      All document generators
cra-addresses.js       CRA dispute addresses (single source of truth)
pdf-annotator.js       Red-box annotation (PDF text layer / OCR / model bboxes)
public/                Vanilla-JS SPA (hash router, no build step)
docs/                  Knowledge base loaded into the system prompt
data/                  DB + campaign files (gitignored — PII)
outputs/<uuid>/        Generated documents per run (gitignored — PII)
reports/               Sample report for testing
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `invalid x-api-key` | Edit `.env` and add your real `ANTHROPIC_API_KEY` |
| `EADDRINUSE port 4000` | `netstat -ano \| findstr :4000` then `taskkill /F /PID <pid>` |
| `prompt is too long` | Fewer than 10 images per run, or split across two runs |
| 401 responses | The PIN gate is on — the UI will prompt; or unset `APP_PIN` |
| Empty output ZIP | Check the terminal for Claude API errors (auth or quota) |
| Annotated PDF missing | OCR fallback needs `python` + `tesseract` on PATH — non-fatal |

**Not legal advice.** This tool prepares self-help consumer documents; every citation in
the litigation memo must be verified against primary sources before any filing.
