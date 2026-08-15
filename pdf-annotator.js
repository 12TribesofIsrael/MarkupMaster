// PDF annotator — draws red boxes (no numbering) on a COPY of the uploaded
// credit report. The original file is never modified. Locations come from each
// violation's markup[] entries (page + markText); text positions are found by
// searching the PDF's own text layer, so boxes land on the real field text.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument, rgb } = require('pdf-lib');

let pdfjsLib = null;
function getPdfjs() {
  if (!pdfjsLib) pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  return pdfjsLib;
}

const RED = rgb(0.85, 0.11, 0.11);

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[■□✓✗●]/g, ' ')
    .replace(/[$,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract every page's text grouped into visual lines (items sharing a baseline)
async function extractPageLines(pdfBuffer) {
  const doc = await getPdfjs().getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter(i => i.str && i.str.trim())
      .map(i => ({
        str: i.str,
        x: i.transform[4],
        y: i.transform[5],
        w: i.width || 0,
        h: i.height || Math.abs(i.transform[3]) || 9,
      }));

    pages.push({ lines: groupIntoLines(items, 3) });
  }
  return pages;
}

// Group text items into visual lines by baseline proximity, then build each
// line's normalized text with per-item character ranges, so a match can be
// mapped back to just the items (columns) it actually covers.
function groupIntoLines(items, tol) {
  const lines = [];
  for (const it of items) {
    const line = lines.find(L => Math.abs(L.y - it.y) < tol);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const L of lines) {
    L.items.sort((a, b) => a.x - b.x);
    let text = '';
    L.ranges = [];
    for (const it of L.items) {
      const n = normalize(it.str);
      if (text) text += ' ';
      L.ranges.push({ start: text.length, end: text.length + n.length, item: it });
      text += n;
    }
    L.text = text;
  }
  return lines;
}

// markText sometimes arrives as a description rather than a quote — with "..."
// ellipses, "■" placeholder squares, or bracketed notes like "[blank cell]"
// that never appear in the page text. Strip those before searching.
function sanitizeMarkText(markText) {
  return String(markText || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/…|\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build normalized search candidates from a markup entry's markText,
// strongest (most specific) first.
function candidatesFor(markText) {
  const cands = [];
  const full = normalize(markText);
  if (full.length >= 4) cands.push(full);
  // The report prints "Credit Limit    -" as a label column and a value column
  // with no colon between them, so the quoted "Credit Limit: -" only matches
  // once the colon is dropped. Without this the colon-less variant never runs
  // and the box lands on the bare label, leaving the disputed value outside it.
  const noColon = normalize(String(markText || '').replace(/:/g, ' '));
  if (noColon.length >= 4 && noColon !== full) cands.push(noColon);

  for (const part of String(markText || '').split(/[|]|—|–/)) {
    let n = normalize(part.replace(/:/g, ' '));
    // Descriptive suffixes ("...table", "...column", "...row") aren't on the page
    n = n.replace(/\b(table|column|row|section|cell|grid|field)$/g, '').trim();
    if (n.length >= 4) cands.push(n);
    const colon = part.indexOf(':');
    if (colon > 0) {
      const label = normalize(part.slice(0, colon));
      const value = normalize(part.slice(colon + 1));
      if (value.length >= 4) cands.push(value);
      if (label.length >= 4) cands.push(label);
    }
  }

  // Progressive fallbacks: leading words of each candidate (labels often wrap
  // across text runs in the PDF, so the full phrase may not sit on one line)
  for (const c of [...cands]) {
    const words = c.split(' ');
    if (words.length > 3) cands.push(words.slice(0, 3).join(' '));
    if (words.length > 2) cands.push(words.slice(0, 2).join(' '));
  }
  return [...new Set(cands)].filter(c => c.length >= 4 && !/^\d{1,4}$/.test(c));
}

// ── Account-block scoping ────────────────────────────────────────────────────
// A single report page routinely carries the tail of one account and the head
// of the next, and both print the same labels and the same payment-history
// year rows. Searching the whole page therefore boxes whichever copy comes
// first — usually the WRONG account's. These helpers find the account headings
// on a page so a mark can be confined to its own account's block.

// Every furnisher and account name in the audit, normalized — the report prints
// one of these as the heading that opens each account block.
function buildNameSet(violationsData) {
  const names = new Set();
  for (const f of (violationsData.furnishers || [])) {
    const n = normalize(f.name);
    if (n.length >= 4) names.add(n);
    for (const a of (f.accounts || [])) {
      const an = normalize(a.accountName);
      if (an.length >= 4) names.add(an);
    }
  }
  return names;
}

// Heading lines per page, ordered top-of-page first. A heading line IS the name
// (optionally followed by a status word like "potentially negative"); a label
// row that merely contains the name — "Account Name  AMERICAN EXPRESS  Balance"
// — is not a heading and must not split the block.
function buildAccountHeadings(pages, names) {
  return pages.map(pg => {
    const hs = [];
    for (const L of pg.lines) {
      for (const n of names) {
        if (L.text === n || L.text.startsWith(n + ' ')) { hs.push({ y: L.y, name: n }); break; }
      }
    }
    return hs.sort((a, b) => b.y - a.y);
  });
}

// The y-range this account occupies on a page: from its heading down to the
// next heading. When the account's heading isn't on the page, its content is
// the continuation above the first heading. null = don't restrict.
function accountBounds(headings, pageIndex, name) {
  const hs = headings[pageIndex] || [];
  if (hs.length === 0 || !name) return null;
  const idx = hs.findIndex(h => h.name === name || h.name.startsWith(name) || name.startsWith(h.name));
  if (idx < 0) return { yTop: Infinity, yBottom: hs[0].y };
  return { yTop: hs[idx].y, yBottom: idx + 1 < hs.length ? hs[idx + 1].y : -Infinity };
}

// A quoted status ("Account charged off. $1,418 written off. $1,418 past due
// as of Sep 2025.") wraps over several lines, but the text match only lands on
// the first one, so the box clips the sentence it is supposed to mark. Pull in
// the lines directly beneath that sit in the same column AND whose text is part
// of the same quote — the containment check is what stops the box from running
// on into the next field.
function wrappedContinuation(page, line, fullText, minX, maxX) {
  const below = page.lines
    .filter(L => L.y < line.y && line.y - L.y < 60)
    .sort((a, b) => b.y - a.y);
  const extra = [];
  for (const L of below) {
    const items = L.items.filter(i => i.x + i.w > minX - 4 && i.x < maxX + 4);
    // A line holding only the neighbouring column's text is not the end of the
    // quote — skip it and keep looking down; the y-window bounds the search.
    if (items.length === 0) continue;
    const txt = normalize(items.map(i => i.str).join(' '));
    if (txt.length < 4 || !fullText.includes(txt)) break;
    extra.push(...items);
  }
  return extra;
}

function linesIn(page, bounds) {
  if (!bounds) return page.lines;
  return page.lines.filter(L => L.y <= bounds.yTop && L.y > bounds.yBottom);
}

// Payment-history grid rows are described as "2020 row — ..." — locate them by
// the leading year on the stated page (or the next page) only, since every
// account section repeats the same year labels.
function findYearRow(pages, pageHint, year, boundsFor) {
  const tryPages = [];
  if (pageHint >= 1 && pageHint <= pages.length) tryPages.push(pageHint - 1);
  if (pageHint >= 1 && pageHint < pages.length) tryPages.push(pageHint);
  for (const pi of tryPages) {
    const lines = linesIn(pages[pi], boundsFor && boundsFor(pi));
    // Width reference: the widest fully-populated grid row on this page.
    // Rows made of "no data" squares have no text cells (the squares are drawn
    // shapes), so their only text item is the year label itself.
    let rowMaxX = 0;
    for (const L of lines) {
      if (/^(19|20)\d{2}( |$)/.test(L.text) && L.items.length >= 6) {
        rowMaxX = Math.max(rowMaxX, Math.max(...L.items.map(i => i.x + i.w)));
      }
    }
    // When no fully-populated grid row exists to copy the width from (sparse
    // OCR of a snapshot), extend to the rightmost text on the page instead of
    // the letter-page default of 540pt.
    const pageMaxX = Math.max(540, ...lines.flatMap(L => L.items.map(i => i.x + i.w)));
    for (const L of lines) {
      if (L.text === year || L.text.startsWith(year + ' ')) {
        if (L.items.length >= 6) return { pageIndex: pi, line: L, items: L.items };
        return { pageIndex: pi, line: L, items: L.items, extendToX: rowMaxX || pageMaxX };
      }
    }
  }
  return null;
}

// 24-month-history rows ("06/25 ■ ... 022") are findable by their leading
// MM/YY date even when the rest of the markText never matches the page text.
function findRowByLeadingToken(pages, pageHint, token, boundsFor) {
  const tok = normalize(token);
  if (!tok) return null;
  const hi = (pageHint || 0) - 1;
  const order = [hi, hi + 1, hi - 1].filter(pi => pi >= 0 && pi < pages.length);
  for (const pi of order) {
    for (const L of linesIn(pages[pi], boundsFor && boundsFor(pi))) {
      if (L.text === tok || L.text.startsWith(tok + ' ')) {
        return { pageIndex: pi, line: L, items: L.items };
      }
    }
  }
  return null;
}

// Search a SINGLE page for a text match (used by last-resort fallbacks, where
// searching the whole document would land on the wrong account's section).
function findOnPage(pages, pageIndex, text, bounds) {
  if (pageIndex < 0 || pageIndex >= pages.length) return null;
  const cand = normalize(text);
  if (!cand || cand.length < 3) return null;
  for (const line of linesIn(pages[pageIndex], bounds)) {
    const idx = line.text.indexOf(cand);
    if (idx < 0) continue;
    const matchEnd = idx + cand.length;
    const matched = line.ranges
      .filter(r => r.end > idx && r.start < matchEnd)
      .map(r => r.item);
    return { pageIndex, line, items: matched.length ? matched : line.items };
  }
  return null;
}

// Find the best line for a markup entry. The stated page is tried first,
// then its neighbors, then the whole document.
function findLine(pages, pageHint, cands, boundsFor) {
  const hintIdx = (pageHint >= 1 && pageHint <= pages.length) ? pageHint - 1 : -1;
  const near = [];
  if (hintIdx > 0) near.push(hintIdx - 1);
  if (hintIdx >= 0 && hintIdx < pages.length - 1) near.push(hintIdx + 1);
  const rest = [];
  for (let i = 0; i < pages.length; i++) if (i !== hintIdx && !near.includes(i)) rest.push(i);

  // Page proximity outranks candidate specificity. The model told us which page
  // the item is on, so exhaust every candidate THERE before widening — otherwise
  // a loose phrase match on an unrelated page beats the exact field on the
  // cited one, and the box lands pages away from the item it documents.
  const groups = [hintIdx >= 0 ? [hintIdx] : [], near, rest];

  for (const group of groups) {
    for (const cand of cands) {
      for (const pi of group) {
        for (const line of linesIn(pages[pi], boundsFor && boundsFor(pi))) {
          const idx = line.text.indexOf(cand);
          if (idx < 0) continue;
          // Box only the items (columns) the matched text actually covers
          const matchEnd = idx + cand.length;
          const matched = line.ranges
            .filter(r => r.end > idx && r.start < matchEnd)
            .map(r => r.item);
          return { pageIndex: pi, line, items: matched.length ? matched : line.items };
        }
      }
    }
  }
  return null;
}

// ── Rotated-scan support ─────────────────────────────────────────────────────
// Some scans embed the page image sideways (browser-printed Experian reports:
// landscape content on a portrait page). OCR runs on the rotated-upright
// rendering so text reads in order, which means every coordinate this module
// works with lives in UPRIGHT space. A finished box must be mapped back onto
// the unrotated page before it is drawn. `rotation` is the CCW angle that made
// the page upright; (pw, ph) are the real page's dimensions in points. Both
// spaces use PDF bottom-left origins.
function rectToPage(box, rotation, pw, ph) {
  switch (rotation) {
    case 90:
      return { x: box.y, y: ph - box.x - box.width, width: box.height, height: box.width };
    case 270:
      return { x: pw - box.y - box.height, y: box.x, width: box.height, height: box.width };
    case 180:
      return { x: pw - box.x - box.width, y: ph - box.y - box.height, width: box.width, height: box.height };
    default:
      return box;
  }
}

/**
 * Shared matching + drawing core. Finds each markup entry's text in the
 * extracted page lines and draws a red box over the matched items.
 * `markFilter(m)` returns the local 1-based page hint for a markup entry, or
 * null to skip it (used by snapshot mode, where entries reference other files).
 * `furnisherFilter(f)`, when given, skips a furnisher's violations entirely
 * (without counting them as missed) — item numbering still advances so it
 * stays in sync with the letter across sibling files.
 * Returns { totalItems, located, missed }.
 */
function drawMarkupBoxes(pages, pdfPages, violationsData, markFilter, style = {}, furnisherFilter = null) {
  const padX = style.padX != null ? style.padX : 2.5;
  const padTop = style.padTop != null ? style.padTop : 2.5;
  const padBottom = style.padBottom != null ? style.padBottom : 2.5;
  const borderWidth = style.lineWidth || 1.4;
  const fileName = style.fileName || null;

  let itemNo = 0;
  let located = 0;
  const missed = [];
  const markLog = []; // per-mark placement quality — see `strategy` below
  const drawnBoxes = []; // {p, x, y, width, height} — to nest coinciding boxes
  const headings = buildAccountHeadings(pages, buildNameSet(violationsData));

  for (const f of (violationsData.furnishers || [])) {
    const fOk = !furnisherFilter || furnisherFilter(f);
    for (const v of (f.violations || [])) {
      itemNo++;
      if (!fOk) continue; // this furnisher's marks live on a sibling file
      const allMarks = v.markup || [];
      if (allMarks.length === 0) {
        missed.push({ item: itemNo, reason: 'no markup data', text: v.title || '' });
        continue;
      }
      // Sweep marks carry exact page + rectangle from the deterministic
      // unpopulated-field sweep, plus the name of the file they were measured
      // on — they draw only there, bypassing the printed-page mapping.
      const sweepOk = (m) => m.sweep && Number.isFinite(m.sweep.page) && m.sweep.rect &&
        (!m.sweep.file || !fileName || m.sweep.file === fileName);
      const marks = allMarks.filter(m => (m.sweep ? sweepOk(m) : markFilter(m) != null));
      if (marks.length === 0) continue; // this violation's marks live on another file

      let anyHit = false;
      for (const m of marks) {
        if (m.sweep) {
          const pi = m.sweep.page - 1;
          if (pi < 0 || pi >= pdfPages.length) continue;
          const r = m.sweep.rect;
          let grow = 0;
          let box;
          do {
            box = { x: r.x - grow, y: r.y - grow, width: r.width + grow * 2, height: r.height + grow * 2 };
            grow += 3;
          } while (drawnBoxes.some(b => b.p === pi &&
            Math.abs(b.x - box.x) < 2 && Math.abs(b.y - box.y) < 2 &&
            Math.abs(b.width - box.width) < 4 && Math.abs(b.height - box.height) < 4));
          drawnBoxes.push({ p: pi, ...box });
          const pg = pdfPages[pi];
          pg.drawRectangle({
            ...rectToPage(box, (pages[pi] && pages[pi].rotation) || 0, pg.getWidth(), pg.getHeight()),
            borderColor: RED, borderWidth,
          });
          markLog.push({ item: itemNo, page: m.sweep.page, markText: String(m.markText || ''), strategy: 'sweep', placedOnPage: m.sweep.page });
          anyHit = true;
          continue;
        }
        const hint = markFilter(m);
        const clean = sanitizeMarkText(m.markText);
        // Confine the search to this account's block, but only on the page the
        // model actually cited — that's the page we know the item is on. The
        // neighbor/whole-document fallbacks stay unscoped so a mark whose page
        // hint is off by one can still be found.
        const acctName = normalize(v.accountName || f.name);
        const hintIdx = (hint >= 1 && hint <= pages.length) ? hint - 1 : -1;
        const boundsFor = (pi) => (pi === hintIdx ? accountBounds(headings, pi, acctName) : null);
        let hit = null;
        // `strategy` records HOW the box was placed. Only the first three are
        // real matches on the disputed text; the two fallbacks box a heading
        // near it, which is a pointer, not a markup of the field itself.
        let strategy = 'none';
        const yearRow = clean.match(/^((?:19|20)\d{2})\b/);
        if (yearRow) { hit = findYearRow(pages, hint, yearRow[1], boundsFor); if (hit) strategy = 'year-row'; }
        if (!hit) {
          const cands = candidatesFor(clean);
          hit = cands.length ? findLine(pages, hint, cands, boundsFor) : null;
          if (hit) strategy = 'text';
        }
        if (!hit) {
          const lead = clean.match(/^(\d{2}\/\d{2})\b/);
          if (lead) { hit = findRowByLeadingToken(pages, hint, lead[1], boundsFor); if (hit) strategy = 'leading-token'; }
        }
        // Guaranteed fallbacks: every dispute item must show at least one box.
        // Box the section heading, else the account heading, on the stated page
        // — then its neighbors, since an account block spans pages and the
        // heading often sits on the page before the disputed field.
        const nearby = [hintIdx, hintIdx - 1, hintIdx + 1].filter(pi => pi >= 0 && pi < pages.length);
        for (const pi of nearby) {
          if (hit) break;
          hit = findOnPage(pages, pi, m.section, boundsFor(pi));
          if (hit) strategy = 'section-fallback';
        }
        for (const pi of nearby) {
          if (hit) break;
          hit = findOnPage(pages, pi, acctName) || findOnPage(pages, pi, f.name);
          if (hit) strategy = 'furnisher-fallback';
        }
        markLog.push({ item: itemNo, page: Number(m.page) || null, markText: String(m.markText || ''), strategy, placedOnPage: hit ? hit.pageIndex + 1 : null });
        if (!hit) continue;
        anyHit = true;

        const pg = pdfPages[hit.pageIndex];
        const L = hit.line;
        let boxItems = hit.items && hit.items.length ? hit.items : L.items;
        let minX = Math.min(...boxItems.map(i => i.x));
        let maxX = Math.max(hit.extendToX || 0, ...boxItems.map(i => i.x + i.w));
        const maxH = Math.max(...boxItems.map(i => i.h));
        // Only quoted text wraps; year rows and heading fallbacks are single-line.
        if (strategy === 'text') {
          const fullNorm = normalize(clean);
          // Each pass widens the column, which lets the next one reach a word
          // that started just past the old edge; it settles in two or three.
          for (let pass = 0; pass < 3; pass++) {
            const extra = wrappedContinuation(pages[hit.pageIndex], L, fullNorm, minX, maxX);
            if (!extra.length) break;
            // The quote runs on, so take the whole first line within the column
            // too — matching stopped at the candidate, and leaving the rest of
            // that line outside would clip the box mid-sentence.
            const wideMaxX = Math.max(maxX, ...extra.map(i => i.x + i.w));
            const next = L.items.filter(i => i.x + i.w > minX - 4 && i.x < wideMaxX + 4).concat(extra);
            const nextMinX = Math.min(...next.map(i => i.x));
            const nextMaxX = Math.max(hit.extendToX || 0, ...next.map(i => i.x + i.w));
            const grew = nextMaxX > maxX + 0.5 || nextMinX < minX - 0.5;
            boxItems = next; minX = nextMinX; maxX = nextMaxX;
            if (!grew) break;
          }
        }
        // Bottom of the lowest item, so a wrapped quote is enclosed, not clipped.
        const minY = Math.min(...boxItems.map(i => i.y));
        // If this box lands where one was already drawn (two items sharing a
        // field, or fallbacks sharing a heading), grow the padding so the boxes
        // nest visibly instead of overprinting as one.
        let grow = 0;
        let box;
        do {
          box = {
            x: minX - padX - grow,
            y: minY - padBottom - grow,
            width: (maxX - minX) + (padX + grow) * 2,
            height: (L.y + maxH - minY) + padTop + padBottom + grow * 2,
          };
          grow += 3;
        } while (drawnBoxes.some(b => b.p === hit.pageIndex &&
          Math.abs(b.x - box.x) < 2 && Math.abs(b.y - box.y) < 2 &&
          Math.abs(b.width - box.width) < 4 && Math.abs(b.height - box.height) < 4));
        drawnBoxes.push({ p: hit.pageIndex, ...box });
        // Boxes are computed in upright (reading-order) space; map onto the
        // real page, which a sideways scan stores rotated.
        pg.drawRectangle({
          ...rectToPage(box, (pages[hit.pageIndex] && pages[hit.pageIndex].rotation) || 0, pg.getWidth(), pg.getHeight()),
          borderColor: RED, borderWidth,
        });
      }

      if (anyHit) located++;
      else missed.push({ item: itemNo, text: (marks[0] && marks[0].markText) || v.title || '' });
    }
  }

  return { totalItems: itemNo, located, missed, marks: markLog, boxes: drawnBoxes.length };
}

// Printed page labels ("Page 8 of 26" in the footer) are the page numbers the
// model actually cites in markup entries. Single-account extracts keep their
// original footer, so a 1-page upload of report page 8 maps {8 → local 1}.
// The lowest text line on each page is checked first — that's where footers live.
function buildPrintedPageMap(pages) {
  const map = new Map();
  pages.forEach((pg, i) => {
    const byY = [...pg.lines].sort((a, b) => a.y - b.y);
    for (const L of byY) {
      const m = L.text.match(/(?:^|\s)page (\d{1,4}) of \d{1,4}(?:\s|$)/);
      if (!m) continue;
      const printed = Number(m[1]);
      if (!map.has(printed)) map.set(printed, i + 1);
      break;
    }
  });
  return map;
}

/**
 * Scanned-PDF fallback. Some bureau reports (browser-printed Experian files in
 * particular) are pure page images with no text layer, so extractPageLines
 * returns nothing and every box misses. OCR every page and hand back the same
 * { lines } shape the text layer produces, in PDF points with the origin at the
 * bottom-left, so the whole downstream path — printed page map, findLine,
 * findYearRow, the fallbacks — behaves exactly as it does on a text PDF.
 * Throws if python/tesseract are unavailable; the caller reports the miss.
 */
function ocrPageLines(inputPdfPath, pageCount) {
  const raw = execFileSync('python', [path.join(__dirname, 'ocr_pdf_pages.py'), inputPdfPath],
    { maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000 }).toString();
  const parsed = JSON.parse(raw);
  const byIndex = new Map((parsed.pages || []).map(p => [p.page - 1, p]));

  const pages = [];
  let words = 0;
  for (let i = 0; i < pageCount; i++) {
    const p = byIndex.get(i);
    if (!p || !p.words || p.words.length === 0) { pages.push({ lines: [], rotation: 0 }); continue; }
    words += p.words.length;
    // OCR gives origin top-left; the drawing code works in PDF space.
    // width/height (and therefore these coordinates) are UPRIGHT-space when the
    // scan was sideways — `rotation` records the CCW angle that fixed it, and
    // rectToPage maps finished boxes back onto the real page at draw time.
    const items = p.words.map(w => ({
      str: w.t, x: w.x, y: p.height - (w.y + w.h), w: w.w, h: w.h,
    }));
    // OCR baselines jitter more than PDF text runs, so group lines loosely —
    // 5pt is under half a line of report body text.
    pages.push({ lines: groupIntoLines(items, 5), rotation: p.rotation || 0, width: p.width, height: p.height });
  }
  if (words === 0) throw new Error('OCR returned no words');
  return pages;
}

/**
 * Extract the searchable line structure for every page of a report PDF: the
 * text layer when one exists, OCR otherwise (matching annotateCreditReportPdf's
 * fallback rule exactly). Exported so the server can run the deterministic
 * unpopulated-field sweep on the same lines the annotator will draw from, and
 * hand the result back via opts.precomputed — the expensive OCR then runs once
 * per file instead of twice.
 */
async function getPageLines(inputPdfPath) {
  const buffer = fs.readFileSync(inputPdfPath);
  let pages = await extractPageLines(buffer);
  let method = 'text-layer';
  let ocrError = null;
  if (pages.every(p => p.lines.length === 0)) {
    try {
      pages = ocrPageLines(inputPdfPath, pages.length);
      method = 'ocr';
    } catch (e) {
      ocrError = e.message;
    }
  }
  return { pages, method, ocrError };
}

/**
 * Annotate a copy of the credit report PDF with red boxes only — no numbering.
 * (Numbered callouts were removed on purpose: they drifted out of sync with the
 * Factual Dispute Letter's item numbers. The box location itself identifies the
 * disputed field.) Returns { totalItems, located, missed }.
 *
 * `opts.scoped` (multi-file uploads): each uploaded PDF is a partial extract of
 * the same report, so a mark must only be drawn on the file that actually
 * contains its page — otherwise every generic label ("Date Closed:") gets boxed
 * on every sibling file, stacking duplicate and misplaced boxes.
 */
async function annotateCreditReportPdf(inputPdfPath, violationsData, outputPath, opts = {}) {
  const buffer = fs.readFileSync(inputPdfPath);
  // Scanned report: no text layer anywhere in the file, so there is nothing to
  // search — getPageLines falls back to OCR. `opts.precomputed` (the server's
  // sweep already extracted the lines) skips doing that work a second time.
  const { pages, method, ocrError } = opts.precomputed || await getPageLines(inputPdfPath);

  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pdfPages = pdfDoc.getPages();

  const pageMap = buildPrintedPageMap(pages);
  const clamp = (p) => Math.min(Math.max(1, p), pages.length);
  let markFilter;
  let furnisherFilter = null;
  if (opts.scoped && pageMap.size > 0) {
    // Draw ONLY marks whose printed page lives in this file, at that page's
    // local index. Marks citing other printed pages belong to sibling uploads.
    markFilter = (m) => pageMap.get(Number(m.page)) || null;
  } else if (opts.scoped) {
    // No printed page labels to scope by — fall back to furnisher-level
    // scoping: skip a furnisher entirely when neither its account numbers nor
    // its name appear anywhere in this file's text (e.g. bureau header pages).
    const docText = pages.flatMap(pg => pg.lines.map(L => L.text)).join('\n');
    furnisherFilter = (f) => {
      const nums = (f.accounts || [])
        .map(a => String(a.accountNumber || '').replace(/\D/g, ''))
        .filter(d => d.length >= 3);
      if (nums.some(d => docText.includes(d))) return true;
      const name = normalize(f.name);
      return name.length >= 4 && docText.includes(name);
    };
    markFilter = (m) => clamp(Number(m.page) || 1);
  } else {
    // Single full-report upload: translate printed page → local page when the
    // footer labels are offset from the physical order; clamp stray hints so
    // year-row and 24-month-row lookups still run on a real page.
    markFilter = (m) => {
      const p = Number(m.page) || 1;
      return pageMap.get(p) || clamp(p);
    };
  }

  // OCR word boxes hug the glyphs tighter and wobble a little, so give the
  // boxes a touch more room than the text-layer path uses.
  const style = method === 'ocr' ? { padX: 3.5, padTop: 3.5, padBottom: 4 } : {};
  style.fileName = opts.fileName || path.basename(inputPdfPath);
  const stats = drawMarkupBoxes(pages, pdfPages, violationsData, markFilter, style, furnisherFilter);

  fs.writeFileSync(outputPath, await pdfDoc.save());
  return { ...stats, method, ocrError };
}

/**
 * Snapshot mode, OCR path (preferred): tesseract reads the image's words with
 * exact pixel positions, and boxes are then placed by the same text-search
 * logic the PDF mode uses — no model coordinates involved. Throws if the OCR
 * engine is unavailable; callers fall back to annotateImageSnapshot.
 */
async function annotateImageSnapshotOcr(imagePath, violationsData, outputPath, imageIndex = 1, opts = {}) {
  const bytes = fs.readFileSync(imagePath);
  const pdfDoc = await PDFDocument.create();
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const img = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  const { width, height } = img.scale(1);
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(img, { x: 0, y: 0, width, height });

  const pages = (opts.precomputed && opts.precomputed.pages) || getImageLines(imagePath, height).pages;

  const stats = drawMarkupBoxes(pages, [page], violationsData,
    m => ((m.page || 1) === imageIndex ? 1 : null),
    {
      padX: Math.max(4, width * 0.004), padTop: 4, padBottom: 5, lineWidth: Math.max(1.5, width / 450),
      fileName: opts.fileName || path.basename(imagePath),
    });

  fs.writeFileSync(outputPath, await pdfDoc.save());
  return stats;
}

/**
 * OCR a snapshot image into the same { pages } line structure getPageLines
 * produces, in image-pixel units with a bottom-left origin (the snapshot is
 * embedded at native size, so pixels ARE page points). Throws when the OCR
 * engine is unavailable — image-sweep callers treat that as "no findings".
 */
function getImageLines(imagePath, imageHeight) {
  const raw = execFileSync('python', [path.join(__dirname, 'ocr_words.py'), imagePath],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }).toString();
  const words = JSON.parse(raw);
  if (!Array.isArray(words) || words.length === 0) throw new Error('OCR returned no words');
  // OCR pixel coords (origin top-left) → page coords (origin bottom-left).
  // OCR baselines jitter more than PDF text runs, so group lines loosely.
  const items = words.map(w => ({ str: w.t, x: w.x, y: imageHeight - (w.y + w.h), w: w.w, h: w.h }));
  return { pages: [{ lines: groupIntoLines(items, 7), rotation: 0 }], method: 'ocr' };
}

/**
 * Snapshot mode — the upload is an image, so there is no text layer to search.
 * Boxes come from each markup entry's model-supplied bbox ([x0,y0,x1,y1] on a
 * 0–1000 grid, origin top-left). The image is embedded on a PDF page at its
 * native size and red rectangles are drawn over it. `imageIndex` is the 1-based
 * position of this image among the uploaded files (markup.page refers to it).
 * Returns { totalItems, located, missed } like annotateCreditReportPdf.
 */
async function annotateImageSnapshot(imagePath, violationsData, outputPath, imageIndex = 1) {
  const bytes = fs.readFileSync(imagePath);
  const pdfDoc = await PDFDocument.create();
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const img = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  const { width, height } = img.scale(1);
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(img, { x: 0, y: 0, width, height });

  const lineW = Math.max(1.5, width / 450);
  let itemNo = 0;
  let located = 0;
  const missed = [];
  const drawn = [];

  for (const f of (violationsData.furnishers || [])) {
    for (const v of (f.violations || [])) {
      itemNo++;
      let anyHit = false;
      let onThisImage = false;
      for (const m of (v.markup || [])) {
        if ((m.page || 1) !== imageIndex) continue;
        onThisImage = true;
        const b = m.bbox;
        if (!Array.isArray(b) || b.length !== 4) continue;
        let [x0, y0, x1, y1] = b.map(Number);
        if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
        if (x1 < x0) [x0, x1] = [x1, x0];
        if (y1 < y0) [y0, y1] = [y1, y0];
        // Reject degenerate slivers and whole-page boxes
        if ((x1 - x0) < 5 || (y1 - y0) < 3) continue;
        if ((x1 - x0) > 980 && (y1 - y0) > 980) continue;
        anyHit = true;
        // 0–1000 grid with origin top-left → PDF points with origin bottom-left.
        // Model bboxes trend a few pixels high, so pad the bottom harder than
        // the top to keep the field fully enclosed instead of struck through.
        // If a box lands where one already is, grow it so the two nest visibly.
        // Model coordinates jitter ~half a text line vertically, so the boxes
        // are padded a full half-line both ways: roomy beats struck-through.
        const padX = Math.max(4, width * 0.005);
        const padTop = Math.max(6, height * 0.011);
        const padBottom = Math.max(8, height * 0.013);
        let grow = 0;
        let box;
        do {
          box = {
            x: (x0 / 1000) * width - padX - grow,
            y: height - (y1 / 1000) * height - padBottom - grow,
            width: ((x1 - x0) / 1000) * width + (padX + grow) * 2,
            height: ((y1 - y0) / 1000) * height + padTop + padBottom + grow * 2,
          };
          grow += 4;
        } while (drawn.some(d => Math.abs(d.x - box.x) < 3 && Math.abs(d.y - box.y) < 3 &&
          Math.abs(d.width - box.width) < 6 && Math.abs(d.height - box.height) < 6));
        drawn.push(box);
        page.drawRectangle({ ...box, borderColor: RED, borderWidth: lineW });
      }
      if (anyHit) located++;
      else if (onThisImage) missed.push({ item: itemNo, text: (v.markup && v.markup[0] && v.markup[0].markText) || v.title || '' });
    }
  }

  fs.writeFileSync(outputPath, await pdfDoc.save());
  return { totalItems: itemNo, located, missed };
}

/**
 * Self-correction pass for snapshot boxes. Renders the annotated PDF (via
 * pymupdf — python must be on PATH), shows the model the original AND the
 * boxed render with the bbox list, and asks for corrected coordinates for any
 * box that missed its target. Mutates the markup entries' bbox values in
 * violationsData and returns how many were corrected (0 = nothing to redraw).
 */
async function refineSnapshotBoxes(anthropic, imagePath, annotatedPdfPath, violationsData, imageIndex = 1) {
  const items = [];
  for (const f of (violationsData.furnishers || [])) {
    for (const v of (f.violations || [])) {
      for (const m of (v.markup || [])) {
        if ((m.page || 1) !== imageIndex) continue;
        items.push({ id: items.length, markText: String(m.markText || ''), bbox: m.bbox || null, _m: m });
      }
    }
  }
  if (items.length === 0) return 0;

  const tmpPng = path.join(os.tmpdir(), `bmb_refine_${Date.now()}.png`);
  execFileSync('python', [
    '-c',
    'import fitz,sys\nd=fitz.open(sys.argv[1])\np=d[0].get_pixmap(matrix=fitz.Matrix(1.5,1.5))\np.save(sys.argv[2])',
    annotatedPdfPath,
    tmpPng,
  ], { timeout: 30000 });

  const imgBlock = (p, mediaType) => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: fs.readFileSync(p).toString('base64') },
  });
  const origType = /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg';

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'IMAGE 1 — original credit report snapshot:' },
        imgBlock(imagePath, origType),
        { type: 'text', text: 'IMAGE 2 — same snapshot with red boxes drawn from the bbox list below:' },
        imgBlock(tmpPng, 'image/png'),
        {
          type: 'text',
          text: `Each item below drew one red box on IMAGE 2. bbox = [x0,y0,x1,y1] on a 0–1000 normalized grid over the ORIGINAL image, origin at the TOP-LEFT, x0,y0 = box top-left, x1,y1 = box bottom-right. Many boxes sit too high, strike through their text, or float over blank space.\n\nFor EACH item, compare IMAGE 2 against IMAGE 1 and decide whether the red box TIGHTLY encloses the exact text named in markText. Reply with ONLY a JSON array of corrections — [{"id": <id>, "bbox": [x0,y0,x1,y1]}] — giving corrected coordinates for every box that is off (coordinates of where the TARGET TEXT actually is, not where the current box is). Items whose box is already correct are omitted. Reply [] if every box is correct. No text outside the JSON array.\n\n${JSON.stringify(items.map(({ id, markText, bbox }) => ({ id, markText, bbox })))}`,
        },
      ],
    }],
  });
  fs.rmSync(tmpPng, { force: true });

  const textBlock = resp.content.find((b) => b.type === 'text');
  const match = textBlock && textBlock.text.match(/\[[\s\S]*\]/);
  if (!match) return 0;
  let corrections;
  try { corrections = JSON.parse(match[0]); } catch { return 0; }

  let applied = 0;
  for (const c of (Array.isArray(corrections) ? corrections : [])) {
    const item = items[c.id];
    if (!item || !Array.isArray(c.bbox) || c.bbox.length !== 4) continue;
    const nums = c.bbox.map(Number);
    if (!nums.every(Number.isFinite)) continue;
    item._m.bbox = nums;
    applied++;
  }
  return applied;
}

module.exports = {
  annotateCreditReportPdf, annotateImageSnapshot, annotateImageSnapshotOcr, refineSnapshotBoxes,
  // Shared plumbing for the deterministic unpopulated-field sweep
  getPageLines, getImageLines, normalize, groupIntoLines, buildNameSet, buildAccountHeadings, accountBounds, linesIn,
};
