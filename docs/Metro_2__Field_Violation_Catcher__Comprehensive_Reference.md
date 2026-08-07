# Metro 2® Field Violation Catcher: Comprehensive Reference

**Purpose:** Line-by-line field analysis to identify Metro 2® violations that support FCRA §1681e(b) "maximum possible accuracy" disputes.

---

## QUICK REFERENCE: RED FLAGS BY FIELD

| Field | RED FLAG | Violation Code | Demand |
|-------|----------|-----------------|--------|
| Account Number (1-9) | Truncated/X's | TRUNCATE-001 | Full number or delete |
| Date Opened (10) | Missing/Invalid | DATEOPEN-001 | Provide or delete |
| DOFD (Field 25) | Blank/Missing | DOFD-001 | Provide or delete |
| Status Code | Wrong code | STATUS-001 | Correct code or delete |
| Balance (Field 40) | $0 with Status 97 | BAL-001 | Correct status or delete |
| Credit Limit (Field 16) | Blank/Zero | LIMIT-001 | Provide or delete |
| Payment History | "ND" entries | PYMT-001 | Full history or delete |
| High Credit | Missing | HIGHCRED-001 | Provide or delete |
| Terms/Frequency | Wrong for type | TERMS-001 | Correct or delete |
| Duplicate Reporting | Same acct 2+ times | DUP-001 | Delete duplicate(s) |

---

## FIELD-BY-FIELD VIOLATION ANALYSIS

### FIELD 1-9: ACCOUNT NUMBER

**Metro 2® Standard:** Account number must be reported in full per original creditor records

**RED FLAG:** Truncated number (contains "X" or fewer digits than expected)

**Violation Type:** FCRA §1681g(a)(1) (do NOT cite Gillespie here — Gillespie, 484 F.3d 938 (7th Cir. 2007), is the date-of-last-activity case)

**Impact:** Consumer cannot verify account or obtain confirmation from creditor

**How to Find:**
- Look for account numbers like: 
  - "601101XXXXXX" (6-digit truncation)
  - "****1234" (masked start)
  - Any number with fewer digits than expected

**Catch It:**
```
INSPECT: Credit report account number field
IF: Contains "X" or "****" or has fewer digits than typical for account type
THEN: RED FLAG - TRUNCATION VIOLATION
```

**Demand Language:**
> "Your credit report displays Account [Name] as [XXXXXX1234], which is truncated and does not provide the full account number required by FCRA §1681g(a)(1) and Metro 2® Field 1-9 standards. This prevents verification with the original creditor. DEMAND: Provide the complete account number in full or delete the tradeline."

**Metro 2® Reference:** Section A-2, Account Number Definition

---

### FIELD 10: DATE OPENED (ACCOUNT REPORTED TO BUREAU)

**Metro 2® Standard:** Month and year account was first opened/reported to the bureau

**RED FLAG:** Missing, blank, or shows year only (no month)

**Violation Type:** Incomplete reporting

**Impact:** Cannot verify account age or credit history timeline

**How to Find:**
- Account shows blank date opened field
- Shows "01/1900" or year-only format
- Shows impossible dates (future dates, before 1900)

**Catch It:**
```
INSPECT: Date opened field
IF: Blank/missing OR shows 01/1900 OR year only OR future date
THEN: RED FLAG - INCOMPLETE DATE OPENED
```

**Demand Language:**
> "Account [Name/Number] shows no date opened. Metro 2® Field 10 requires month and year of account opening. DEMAND: Provide valid date opened or delete account."

**Metro 2® Reference:** Section E-1, Account Reporting Date

---

### FIELD 16: CREDIT LIMIT (REVOLVING ONLY)

**Metro 2® Standard:** For revolving accounts (credit cards), must show original credit limit

**RED FLAG:** Blank, zero, or missing for credit card accounts

**Violation Type:** Incomplete reporting violates Metro 2®

**Impact:** Cannot verify available credit or credit utilization ratio

**How to Find:**
- Credit card showing $0 credit limit
- Field blank for credit card
- Revolving account with no limit reported

**Catch It:**
```
INSPECT: Credit limit for revolving accounts (credit cards)
IF: Blank/missing/zero AND account type is credit card
THEN: RED FLAG - MISSING CREDIT LIMIT
```

**Demand Language:**
> "Account [Name], a [Card Type] credit card, shows no reported credit limit. Metro 2® Field 16 requires the credit limit to be reported for all revolving accounts. Without a credit limit, the utilization ratio cannot be verified. DEMAND: Report the original credit limit or delete the account."

**Metro 2® Reference:** Section F-2, Credit Limit Requirements

---

### FIELD 18: PAYMENT HISTORY PROFILE (24-Month Profile)

**Metro 2® Standard:** Must show payment status for current month plus prior 23 months (24 months total)

**RED FLAG:** Contains "ND" (No Data), gaps, or truncated history

**Violation Type:** FCRA §1681e(b) - maximum accuracy; *Seamans v. Temple University* delinquency sequencing violation

**Impact:** Creates unverifiable delinquency timeline; consumer cannot confirm accuracy

**How to Find:**
- Payment history shows "ND" in any position
- Missing months in sequence
- History only shows 12 months instead of 24
- Shows consecutive "C" (current) then jumps to "X" (120+ days late)

**Catch It:**
```
INSPECT: 24-month payment history
IF: Contains "ND" OR shows gaps OR fewer than 24 positions
THEN: RED FLAG - PAYMENT HISTORY VIOLATION
ALSO IF: Payment progression illogical (e.g., C-C-C-X without intermediate delinquency steps)
THEN: RED FLAG - IMPROPER DELINQUENCY SEQUENCING
```

**Example Violation:**
```
Reported Payment History: C-C-C-C-C-C-N-D-D-D-X-X-X-X-X-X-X-X-X-X-X-X-X-X

RED FLAGS:
- Contains "N" and "D" entries (incomplete)
- Illogical progression: goes from C to X without 30-60-90-120-day steps
- "N" entries prevent verification
```

**Correct Payment History Should Show:**
For 120-day late progression:
- Months 1-3: Current (C)
- Month 4: 30 days late (1)
- Month 5: 60 days late (2)
- Month 6: 90 days late (3)
- Month 7: 120 days late (4)
- Months 8-24: Charged off status

**Demand Language:**
> "Account [Name] shows payment history profile containing multiple 'ND' (No Data) entries and improper delinquency sequencing. The credit report shows Current-Current-Current-Current, then jumps immediately to 120+ days without showing 30-60-90-day progression required by Metro 2® Field 18. This violates FCRA §1681e(b) maximum accuracy and Metro 2® Field 18 standards. DEMAND: Provide complete, accurate 24-month payment history with proper delinquency progression, or delete the account."

**Metro 2® Reference:** Section D-3, Payment History Reporting; FAQ 31, Payment History Codes

---

### FIELD 23: ORIGINAL CHARGE-OFF AMOUNT

**Metro 2® Standard:** For charged-off accounts (Status 97), must report the original amount charged off

**RED FLAG:** Missing, shows $0, or differs significantly from balance at time of charge-off

**Violation Type:** Metro 2® reporting error; FCRA §1681e(b)

**Impact:** Cannot verify amount actually charged off; affects debt validation

**How to Find:**
- Account Status = 97 (Charge-off) AND Field 23 = blank/$0
- Account shows $0 balance but no original charge-off amount
- Original charge-off amount less than balance at delinquency

**Catch It:**
```
INSPECT: Status code = 97 (Charge-off)
IF: Field 23 (Original Charge-off Amount) = blank OR $0
THEN: RED FLAG - MISSING CHARGE-OFF AMOUNT
ALSO INSPECT: Original Charge-off Amount vs. Balance at Delinquency
IF: Amounts don't reconcile (e.g., account balance was $5,000 but original charge-off only $2,000)
THEN: RED FLAG - CHARGE-OFF AMOUNT MISMATCH
```

**Demand Language:**
> "Account [Name] shows Status Code 97 (Charge-off) but the Original Charge-off Amount field is blank. Metro 2® Field 23 requires reporting the amount charged off by the creditor. DEMAND: Provide the original charge-off amount or delete the account."

**Metro 2® Reference:** Section B-2, Original Charge-off Amount; FAQ 34, Charge-off Standards

---

### FIELD 25: DATE OF FIRST DELINQUENCY (DOFD)

**Metro 2® Standard:** For delinquent/charged-off accounts, must show month/year of first delinquency

**RED FLAG:** Missing, shows "01/1900," or shows date AFTER charge-off date

**Violation Type:** FCRA §1681g(a); Cannot verify 7-year reporting period under §1681c(a)

**Impact:** Consumer cannot determine reporting deadline; 7-year SOL period unverifiable

**How to Find:**
- Delinquent account with blank DOFD
- Charge-off account showing DOFD = "01/1900" or all zeros
- DOFD appears AFTER the charge-off date (illogical)

**Catch It:**
```
INSPECT: Status code = 97, 93, or shows late payment
IF: Field 25 (DOFD) = blank/missing OR shows "01/1900" OR shows impossible date
THEN: RED FLAG - MISSING/INVALID DOFD
ALSO: Check DOFD vs. Date Closed
IF: DOFD is AFTER Date Closed, then RED FLAG
```

**Example Violations:**
```
Account Status: 97 (Charge-off)
Date Closed: 03/2022
DOFD: 01/1900
RED FLAG: DOFD is in the past, not tied to actual delinquency
```

**Demand Language:**
> "Account [Name] is reporting a charge-off status but shows Date of First Delinquency as [01/1900], which is clearly inaccurate and impossible. Metro 2® Field 25 requires the month/year of first delinquency. Without a valid DOFD, the consumer cannot verify the 7-year reporting deadline under FCRA §1681c(a). DEMAND: Provide the accurate Date of First Delinquency or delete the account."

**Metro 2® Reference:** Section B-1, DOFD Definition; FAQ 33, DOFD Hierarchy

---

### FIELD 26: DATE CLOSED/REPORTED

**Metro 2® Standard:** For closed accounts, must show month/year account was closed or deleted from creditor's records

**RED FLAG:** Missing for closed/deleted accounts, or shows future date

**Violation Type:** Incomplete reporting

**Impact:** Cannot verify when account ended or reporting period

**How to Find:**
- Status shows "DA" (Delete - Account Paid) without Date Closed
- Status shows "DF" (Delete - Account Paid in Full) without Date Closed
- Date Closed shows future date

**Catch It:**
```
INSPECT: Status code = DA, DF, or shows account paid in full
IF: Field 26 (Date Closed) = blank/missing
THEN: RED FLAG - MISSING CLOSE DATE
```

**Demand Language:**
> "Account [Name] shows status [DA - Paid] but provides no Date Closed. Metro 2® Field 26 requires reporting the month and year the account was closed. DEMAND: Provide the Date Closed or correct the account status."

---

### FIELD 40: CURRENT BALANCE (AMOUNT OWED)

**Metro 2® Standard:** Must reflect actual balance owed on reporting date

**RED FLAG:** Shows balance when Status = 97 (Charge-off) with $0 previous balance; $0 balance with active delinquency code

**Violation Type:** Metro 2® FAQ 34, 35; FCRA §1681e(b)

**Impact:** Misrepresents debt status; affects credit score calculation

**How to Find:**
- Charge-off account (Status 97) showing balance of $2,500 when it should be $0 or show as "Paid"
- Collection account showing $0 balance but still reporting as "Active"
- Account shows "Terms Met" (paid) but displays balance

**Catch It:**
```
INSPECT: Status code + Current Balance
IF: Status 97 (Charge-off) AND Balance > $0 BUT prior status shows paid
THEN: RED FLAG - BALANCE/STATUS MISMATCH
ALSO IF: Status 97 AND shows $0 balance but still reporting as active
THEN: RED FLAG - STATUS CODE ERROR (Should be 64 - Paid Charge-off)
ALSO IF: Status shows "Paid" (code 05) AND Balance > $0
THEN: RED FLAG - PAID ACCOUNT WITH BALANCE
```

**Example Violations:**
```
Account Status: 97 (Charge-off)
Current Balance: $0
Previous Balance: $5,000
Months Delinquent: 0
RED FLAG: Charge-off with $0 balance should have Status 64 (Paid Charge-off), not 97
```

**Demand Language:**
> "Account [Name] shows Status Code 97 (Charge-off) with a current balance of $0 and zero months delinquent. This indicates the account should be reported as Status Code 64 (Paid Charge-off) per Metro 2® FAQ 35. The current reporting is inaccurate and violates Metro 2® standards. DEMAND: Correct status to 64 or delete the account."

**Metro 2® Reference:** Section C-1, Balance Reporting; FAQ 34, 35

---

### DUPLICATE ACCOUNTS (FIELD 1-40 REPETITION)

**Metro 2® Standard:** Same account must NOT be reported twice with different statuses or balances

**RED FLAG:** Same account number appears on report twice; same account name with different statuses

**Violation Type:** Metro 2® FAQ 36; FDCPA §1692c (collection duplication)

**Impact:** Artificially damages credit; appears consumer owes same debt twice

**How to Find:**
- Same account number listed twice (exact match)
- Same account name listed twice with different balances/statuses
- Example: "AMEX 1234" showing as both "Charge-off" and "Paid Collection"

**Catch It:**
```
SCAN all accounts on report for duplicates:
IF: Same account number appears 2+ times
THEN: RED FLAG - DUPLICATE ACCOUNT (VIOLATION)
ALSO SCAN: By account name + creditor
IF: "AMEX Gold 5678" appears twice with different statuses
THEN: RED FLAG - DUPLICATE BY NAME
```

**Example Violation:**
```
Account 1: AMEX Account 1234567, Status: 97 (Charge-off), Balance: $5,000
Account 2: AMEX Account 1234567, Status: 93 (Collection), Balance: $5,100

RED FLAG: EXACT DUPLICATE - Same creditor, account number, roughly same balance
This is reporting the same debt twice under different statuses
```

**Demand Language:**
> "Your credit report lists Account [AMEX 1234567] appearing twice—once as Status 97 (Charge-off) with balance $5,000 and again as Status 93 (Collection) with balance $5,100. This is duplicate reporting of the same obligation. Metro 2® FAQ 36 prohibits duplicate reporting. This violates FDCPA §1692c duplicate debt collection and FCRA §1681e(b) accuracy standards. DEMAND: Delete one of the duplicate entries immediately."

**Metro 2® Reference:** Section C-2, Duplicate Account Rules; FAQ 36

---

### SCHEDULED MONTHLY PAYMENT (FIELD 10 / TERMS)

**Metro 2® Standard:** For charge-offs, scheduled payment should be $0; for revolving accounts, should match monthly minimum

**RED FLAG:** Charge-off account shows monthly payment (e.g., $250); credit card shows "12 months" fixed term

**Violation Type:** Metro 2® field accuracy; FCRA §1681e(b)

**Impact:** Misrepresents debt obligation; affects debt-to-income calculation

**How to Find:**
- Charge-off account (Status 97) showing "Scheduled Monthly Payment: $250"
- Credit card showing "Terms: 12 Months" (should be revolving, not fixed term)
- Installment loan showing no term frequency

**Catch It:**
```
INSPECT: Scheduled Monthly Payment (SMP)
IF: Status 97 (Charge-off) AND SMP > $0
THEN: RED FLAG - CHARGE-OFF WITH MONTHLY PAYMENT
ALSO INSPECT: Terms Duration/Frequency
IF: Account type = credit card AND Terms shows fixed month value (e.g., "12 Mo")
THEN: RED FLAG - REVOLVING ACCOUNT MARKED AS INSTALLMENT
```

**Example Violations:**
```
Account: AMEX Card
Status: Charge-off (97)
Scheduled Payment: $250/month
RED FLAG: Charge-offs should show $0 scheduled payment
```

**Demand Language:**
> "Account [Name], a charge-off, shows a Scheduled Monthly Payment of $250. Charged-off accounts must report $0 scheduled payment per Metro 2® standards. This misrepresents the debt obligation and violates FCRA §1681e(b). DEMAND: Correct scheduled payment to $0 or delete the account."

**Metro 2® Reference:** Section E-3, Scheduled Monthly Payment; Section F-1, Terms Duration

---

### ACCOUNT STATUS CODES (FIELD 28)

**Metro 2® Standard:** Status code must accurately reflect account state

**Common Violations:**

| Status Code | Standard | RED FLAG |
|-------------|----------|----------|
| 97 | Charged Off | Showing for paid accounts; old charge-offs (>7yrs) |
| 93 | Collection | Collection for same account also showing as "Charged-off" |
| 64 | Paid Charge-off | Missing when charge-off is paid |
| 05 | Paid | Account shows balance while marked paid |
| 61 | 180+ days | No path to this status (should have progression) |
| DA | Delete Paid | Should not appear on report after deletion |

**Catch It:**
```
For every account:
1. Check Status Code against Account Condition
2. If Status 97 and account is paid/settled → RED FLAG
3. If Status 05 (Paid) and balance > $0 → RED FLAG
4. If Status 64 (Paid Charge-off) but credit report doesn't reflect it → RED FLAG
5. If Status 93 and Status 97 exist for same account → RED FLAG (duplicate)
```

**Demand Language (by status error):**
> "Account [Name] is marked Status 97 (Charged-off) but we provided settlement agreement showing full payment on [date]. This account should be updated to Status 64 (Paid Charge-off) or deleted entirely. DEMAND: Correct status immediately or delete."

---

## 33-POINT CHARGE-OFF ACCURACY AUDIT (METRO 2® SPECIFIC)

When you find a Status 97 (Charge-off) account, verify ALL 33 points:

### CHARGE-OFF VERIFICATION CHECKLIST

#### REPORTING STATUS (Points 1-5)
- [ ] 1. Status Code = 97 (Correct code for charge-off)
- [ ] 2. Status Date = Month charged off
- [ ] 3. Date Closed = Furnished to/deleted from creditor records
- [ ] 4. DOFD = Accurate to 30 days
- [ ] 5. Original Charge-off Amount = Reported and matches documentation

#### ACCOUNT BALANCE (Points 6-10)
- [ ] 6. Current Balance = $0 if paid, or reflects remaining balance if active
- [ ] 7. Previous Balance = Accurate to balance at time of charge-off
- [ ] 8. High Credit = Matches credit limit or highest balance
- [ ] 9. Credit Limit = Provided for revolving accounts
- [ ] 10. Balance History = Shows progression from current to charged-off

#### PAYMENT HISTORY (Points 11-15)
- [ ] 11. 24-month Payment Profile = No "ND" (No Data) entries
- [ ] 12. Delinquency Progression = 30-60-90-120-150-180 sequence
- [ ] 13. Payment Activity = Reflects actual payment history
- [ ] 14. Current Status = Reflects actual current status
- [ ] 15. Late Payment Indicators = Accurate 30/60/90+ day codes

#### ACCOUNT DETAILS (Points 16-20)
- [ ] 16. Account Number = Full number (not truncated)
- [ ] 17. Account Name = Matches original creditor
- [ ] 18. Creditor Name = Correct furnisher
- [ ] 19. Account Type = Correct (credit card, auto, etc.)
- [ ] 20. Responsibility Type = Correct (individual, joint, authorized user)

#### TERMS & CONDITIONS (Points 21-25)
- [ ] 21. Terms Duration = Blank if revolving, or accurate for installment
- [ ] 22. Terms Frequency = Monthly, bi-weekly, etc. (or blank if revolving)
- [ ] 23. Scheduled Monthly Payment = $0 for charge-off, accurate for active
- [ ] 24. Installment Loan Flag = Correct type indicator
- [ ] 25. Revolving Account Flag = Marked for credit cards/lines

#### NARRATIVE & FLAGS (Points 26-33)
- [ ] 26. Special Comment Code = Accurate (if any)
- [ ] 27. Dispute Flag = "In Dispute" if actively disputed
- [ ] 28. Suppression Flag (C-Block) = Applied during investigation
- [ ] 29. Terms Met Flag = Correctly showing paid
- [ ] 30. D-Flag = Delete date if past 7 years
- [ ] 31. Cosigner Flag = Accurate if applicable
- [ ] 32. Ecoa Code = Correct responsibility (if applicable)
- [ ] 33. Data Furnisher Reference = Indicates chain of custody if transferred

---

## VIOLATION SEVERITY MATRIX

| Violation | Severity | FCRA Citation | Metro 2® Citation | Demand |
|-----------|----------|-------|---------|--------|
| Truncated Account # | CRITICAL | §1681g(a) | Field 1-9 | Delete/Furnish full |
| Missing DOFD | CRITICAL | §1681c, §1681g(a) | Field 25 | Delete or provide |
| Payment History "ND" | CRITICAL | §1681e(b) | Field 18 | Complete history or delete |
| Improper Delinquency Progression | HIGH | §1681e(b) | Field 18 / FAQ 31 | Correct or delete |
| Duplicate Account | CRITICAL | §1692c, FAQ 36 | Section C-2 | Delete duplicate |
| Status/Balance Mismatch | HIGH | §1681e(b) | FAQ 34, 35 | Correct status or delete |
| Charge-off with $0 Balance | HIGH | §1681e(b) | FAQ 35 | Status 64 or delete |
| Missing Credit Limit (Revolving) | MEDIUM | §1681e(b) | Field 16 | Provide or delete |
| Wrong Terms for Account Type | MEDIUM | §1681e(b) | Field 11-12 | Correct or delete |

---

## QUICK DISPUTE LETTER TEMPLATE FOR METRO 2® VIOLATION

```
VIOLATION #[X]: Metro 2® Field [#] Violation - [Account Name]

Legal Standard: Metro 2® Field [#] requires [requirement]. FCRA §1681e(b) requires maximum possible accuracy.

Your Report Shows: [exact data from report]

Violation: [specific technical error]

Impact: [why this harms consumer or prevents verification]

Demand: [specific correction or deletion]

Supporting Documentation: [Attached - original statement showing correct data]
```

---

## FILING THIS GUIDE

**File Name:** `Metro2_Field_Violation_Reference.pdf` or `.md`

**Add to Project Folder:** Primary reference for violation identification

**Use in:** Every dispute analysis—scan all 33 points for charge-offs, verify critical fields for all accounts