# RULES.md — The Brain of the Markup Mastery Linear Workflow

This file is the single authoritative recipe. The pipeline is a LINEAR
WORKFLOW: fixed nodes, fixed order, fixed rules. Every run of every report
walks the same sequence and applies the same rules to every account. Nothing
in the boxing path thinks; it follows this file. The model (LLM) participates
at exactly one node, and it is only allowed to ADD — it can never remove an
account, skip a rule, or move a box.

If code and this file disagree, this file is right and the code is a bug.
When the doctrine changes, change this file in the same commit as the code.

The two master markups in `mastermarkups/` (TransUnion + Experian, marked by
hand by BMB) are the visual ground truth for what a finished marked-up report
looks like. Every rule below about boxing exists to reproduce them. SOP.md in
this folder is the original narrative walkthrough of the same doctrine; this
file is its formalization — where they appear to differ, this file governs.

─────────────────────────────────────────────────────────────────────────────
## THE SEQUENCE (fixed, in order — no node may be skipped or reordered)
─────────────────────────────────────────────────────────────────────────────

1. **INTAKE** — consumer's report pages uploaded (PDF/JPG/PNG, ≤20MB each).
   Client record supplies identity, photo ID scans, proof-of-address scans.

2. **READ THE PAPER (deterministic)** — extract every page's text:
   text layer when one exists; otherwise OCR every page (psm 6 + psm 11
   sparse merge). Sideways scans are auto-uprighted (tesseract OSD); all
   later geometry is computed upright and mapped back at draw time.

3. **ACCOUNT ROSTER (deterministic)** — read every printed account heading
   off the paper: TransUnion `NAME 123456789012****` heading lines, Experian
   `Account Name <NAME>` label rows. Track section (adverse vs satisfactory)
   from the report's own section headers. Inquiry / public-record /
   personal-info sections are dead zones — creditor names there are tiles,
   never accounts. THE ROSTER IS THE LAW: every printed account is in the
   audit. The model cannot add to or subtract from the roster.

4. **MODEL AUDIT (the only thinking node)** — Claude reads the report images
   and reports accounts, field values, and judgment findings (cross-field
   contradictions, status/history conflicts, narrative items) with dispute
   wording. Its account list is MERGED under the roster: anything it lists
   that the paper confirms stays; anything the paper prints that the model
   missed is added with an empty item list (identity by account-number
   digits — near-full prefix agreement required; a shared 6-digit issuer
   prefix is NOT the same account: ten Nelnet loans all start 900000).

5. **GUARDS (deterministic, per account, in order)** — Section A below.

6. **UNPOPULATED-FIELD SWEEP (deterministic, per account)** — Section B
   below. Every finding carries a measured rectangle and attaches to a
   letter item. Boxes ARE violations; violations ARE boxes. 1:1, always.

7. **LETTER ASSEMBLY (deterministic templates)** — Section C below. Watts
   letter rules are absolute.

8. **ANNOTATION (deterministic)** — draw every sweep rectangle verbatim;
   place every model item's box by text search of the disputed text, with
   heading fallback only when the disputed field is absent from the page.
   Red boxes only. Never numbered. Never on the original — always a copy.

9. **COVERAGE GATE (deterministic, hard stop)** — every audited account must
   end the run with at least one placed box. Any account with letter items
   and zero boxes = red DO-NOT-MAIL banner naming the account. A silent miss
   ships an incomplete package; there are no silent misses.

10. **HUMAN GATE (mandatory)** — the consumer reviews every account
    (actually-wrong + thrilled-if-deleted gates), confirms every address
    against their photo ID, edits wording, approves. Only approval generates
    final letters. No letter ever mails in a consumer's name unreviewed.

11. **MAIL + RECORD** — mail dates, tracking, delivery captured; every
    real-world act gets a row in the `events` chronology with its real-world
    date. The §1681i 30-day clock runs from delivery.

12. **RESPONSE INTAKE** — when results arrive, diff every item: fixed /
    deleted / verified-unchanged / unclear. `verified_unchanged` feeds the
    FINAL NOTICE round. Rounds cap at 3; after that, escalation (litigation
    memo already pleads from the chronology).

─────────────────────────────────────────────────────────────────────────────
## SECTION A — GUARD RULES (what EVERY account gets, by condition)
─────────────────────────────────────────────────────────────────────────────

Apply to every account on the roster, both sections, unless marked
adverse-only. Conditions are read off the paper, never inferred.

**A1. Masked account number** (number prints with X's or asterisks)
→ Item: TRUNCATED ACCOUNT NUMBER PREVENTS CONSUMER VERIFICATION.
  Severity CRITICAL. Internal statute: FCRA §1681g(a)(1).
  Remedy: explain — "Please provide the full account number so I can verify
  this account, or delete it."
  Box: the account-identity row (name + masked number), exact rectangle.
  Applies to EVERY account, adverse or satisfactory (the archetype boxes
  Atlantic in the satisfactory section).

**A2. Missing Date of First Delinquency** (derogatory account, DOFD absent)
→ ADVERSE-SECTION ONLY. Item: DATE OF FIRST DELINQUENCY MISSING.
  Severity CRITICAL. Internal: FCRA §1681c(a); Metro 2 Field 25.
  Remedy: correct — report the DOFD or delete.
  A POPULATED DOFD is NEVER boxed. If the field is absent from the page
  entirely, the box falls back to the account heading (a pointer, flagged
  as weak in annotation status).

**A3. Blank Date of Last Activity** (label printed, value empty, derogatory)
→ ADVERSE-SECTION ONLY, and ONLY when the report actually prints the label
  (Equifax does; the others often don't — never box a field that isn't
  there). Item: DATE OF LAST ACTIVITY FIELD BLANK. Severity HIGH.
  DOLA is NOT an FCRA-required field (Watts). Plead as §1681g
  clarity/completeness (Gillespie v. Equifax, 484 F.3d 938 (7th Cir. 2007)
  — the DOLA case, not the account-number case). NEVER cite a Metro 2 field
  number for it. Written to the bureau as a question:
  "The Date of Last Activity field on this account is blank. What was the
  date of last activity?"

**A4. Addresses** — a report legitimately carries address history. An
  address that does not match the ID is NOT a violation. NEVER auto-inject
  an address dispute. The consumer answers "have you ever lived here" per
  address; only a confirmed NO becomes an item (the MY PERSONAL INFORMATION
  pseudo-furnisher, always item 1, excluded from cc list and mailing).
  An address matching the ID can never be disputed — the letter would
  contradict its own enclosures. If the personal-info page wasn't uploaded,
  say the check was skipped; never claim "no other addresses found".

─────────────────────────────────────────────────────────────────────────────
## SECTION B — SWEEP RULES (anything printed but not populated gets a box)
─────────────────────────────────────────────────────────────────────────────

The master-markup doctrine: ANYTHING the report prints but does not populate
is circled/boxed, and every box ties to a letter item. Findings only ever
attach to roster accounts — a block owned by no audited account is never
boxed (ownership closes at foreign account names, satisfactory-vs-audit
number mismatches, and dead-zone sections).

**B1. Account identity anchor** — every audited account's name+number row is
  boxed. Attaches to the account's truncation item when the number is
  masked; otherwise to the account's first item as its anchor.

**B2. Blank labeled field** (label prints alone, value area empty — e.g.
  TransUnion "Phone" with nothing after it)
→ grouped per-account item: ACCOUNT FIELDS PRINTED BUT LEFT EMPTY.
  Severity HIGH. Internal: FCRA §1681g(a). Remedy: explain — fill in each
  field or say in writing why it is blank. One item per account listing all
  its blank fields; one box per field, spanning label to the empty value
  area. The blank-Phone row is recovered even when OCR drops the faint
  label (Address→Date-Opened gap rule).

**B3. Dash-valued field** (Experian-style "Interest Type   -")
→ same grouped item as B2. Vertically adjacent dash fields share one box
  (archetype style). DOFD/DOLA labels found blank hand their rectangle to
  the A2/A3 items instead of the group.

**B4. TransUnion unpopulated payment-history columns** (Balance / Past Due /
  Remarks all print "---" for a month)
→ grouped per-account item: PAYMENT HISTORY PRINTS NO DATA. Severity HIGH.
  Internal: FCRA §1681g(a)(1); §1681e(b). Remedy: explain — report the
  actual month-by-month history or confirm in writing none exists.
  Box per unpopulated column; ONE box around the whole month-grid block when
  every column in it is unpopulated (archetype style). The Rating row does
  not count as population, and neither do the layout's other money rows
  (Scheduled Payment, Amount Paid, Payment Received) — a grid layout adding
  rows must never suppress the block box.
  **Whole-history rule (master TransUnion markup): when an account's entire
  printed history is unpopulated, EVERY block of it is boxed, first month to
  last — the whole history is marked, never a sample.** The dispute letter
  states it in plain words: "There is no payment history reported for the
  following months on this account: <the actual months/ranges>."

**B5. Experian ND cells** ("ND — no data for this period")
→ same grouped item as B4. Always boxed, any position. Adjacent ND cells in
  a row share one box; single-column stacks merge vertically. The legend
  line is never boxed.

**B6. Experian dash runs inside the asserted window** — dashes between the
  account's Date Opened month and the newest "... as of <Month Year>"
  narrative month are asserted history the grid fails to show → boxed,
  extended to the full contiguous run; a bare-year row whose cells all
  dropped (all-dash) inside the window is boxed across the row. Dashes
  before opening or after the last assertion are natural and never boxed.

**B7. If the model already wrote an equivalent item** (e.g. its own
  payment-history-gaps finding), the sweep attaches its rectangles to that
  item instead of creating a duplicate. Same-named accounts under one
  furnisher keep separate items, keyed by account digits.

**B8. NEVER-BOX LIST.** These are never boxed, by any layer:
  - the consumer's identity fields — Social Security Number, Date of Birth,
    Name, Also Known As (they are the consumer's own data, not violations)
  - section-intro prose and legends ("Adverse information typically
    remains…", the payment-history guide, ND/CO legend lines)
  - inquiry tiles, public-record and personal-info section content (address
    items come only from the consumer's per-address answers, rule A4)
  - populated fields (a filled-in DOFD, a printed phone number)
  Text-search placement must never use a generic fragment (like "date of")
  that can land on identity fields or prose. When a disputed field's label
  is absent from the page entirely, the box goes to the ACCOUNT HEADING on
  the account's own page — nowhere else — and is flagged as weak.

─────────────────────────────────────────────────────────────────────────────
## SECTION C — WATTS LETTER RULES (absolute; violations of these are bugs)
─────────────────────────────────────────────────────────────────────────────

**C1.** The mailed dispute letter is PLAIN ENGLISH. No statute citations, no
  case names, no Metro 2 language anywhere in mailed text. A specific
  factual error + the exact remedy asked, per item. Legalistic template
  letters read as credit-repair spam and get dismissed as "worthless
  letters."

**C2.** All statutes and case law live ONLY in the internal Litigation Memo
  (never mailed). The memo pleads from the `events` chronology.

**C3.** Remedy matches the defect: field-level error → correct or explain
  that field. NEVER a blanket "delete this entire account" for a
  field-level error. Blank/unpopulated items are written as questions —
  that is the willfulness scaffold: the bureau's written answer (or
  silence) is evidence in round 2/3 and litigation.

**C4.** Letters are organized by furnisher; item numbers are GLOBAL across
  the letter and match the Markup Map and `violation_items.item_number`.
  Every injection or splice renumbers. The address pseudo-furnisher is
  always first and takes item 1.

**C5.** Enclosures on every round: photo ID + proof of address exhibit
  pages (the letter asserts them on its face — never drop the exhibit while
  keeping the sentence), the boxed (annotated) report copy, full copy cc'd
  to every furnisher. The §1681g full-file request mails in its own
  envelope (plain-language, Kelly v. RealPage).

**C6.** NEVER reintroduce: minimum violation quotas; statutes in mailed
  text; blanket deletes for field errors; 609-letter/magic-letter framing.

**C8. ONE identity block, one date, for every letter in a package.** The
  consumer's From / Address / Phone / Email / Date of birth / SSN block is
  built in a single helper (`makeIdentityBlock`) fed by a single server-side
  builder (`identityFor(client)`), and every mailed letter — dispute, §1681g
  full-file request, method-of-verification — prints exactly the same block.
  Two letters out of one run must never disagree; a letter printing blank
  fill-in lines while its envelope-mate prints the real details is the
  identity stall the block exists to defeat, self-inflicted. Where the client
  record genuinely has no value, the fill-in line is correct.

**C9. No placeholder date at the top of a letter.** The mail date is written
  by hand ONCE, in the "certified mail tracking" block at the foot of every
  letter. The top date line prints only when a real mail date is known
  (`options.mailDate`); otherwise it is omitted entirely. Two blanks for the
  same fact invite two different dates on one letter.

**C7.** Round 2/3 letters are FINAL NOTICE letters built from
  verified-unchanged items only. Rounds cap at 3.

─────────────────────────────────────────────────────────────────────────────
## SECTION D — DIVISION OF LABOR (who may do what)
─────────────────────────────────────────────────────────────────────────────

**Code (deterministic — the workflow):** page reading, rotation, roster,
guards A1–A3, all sweep rules B1–B7, box geometry, renumbering, coverage
gate, document generation, chronology rows. Runs identically every time.
No discretion.

**Model (one node, additive only):** field extraction and judgment findings
— contradictions between fields, status/history conflicts, wrong balances,
re-aging, obsolete items — each with plain-language dispute wording. The
model may never: define the account roster, decide whether an account is
boxed, place a rectangle, or drop a deterministic item.

**Human (two gates):** the consumer's approval gate before any letter
generates (mandatory, no exceptions), and the address yes/no answers. BMB
review of the coverage banner before mailing.

**Verification standard:** never judge a marked-up report by counts —
render the pages and look, against the archetypes.
