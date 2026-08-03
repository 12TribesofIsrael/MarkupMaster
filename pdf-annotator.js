// PDF annotator — draws red boxes (no numbering) on a COPY of the uploaded
// credit report. The original file is never modified. Locations come from each
// violation's markup[] entries (page + markText); text positions are found by
// searching the PDF's own text layer, so boxes land on the real field text.
const fs = require('fs');
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

    // Group items into lines by baseline proximity
    const lines = [];
    for (const it of items) {
      const line = lines.find(L => Math.abs(L.y - it.y) < 3);
      if (line) line.items.push(it);
      else lines.push({ y: it.y, items: [it] });
    }
    for (const L of lines) {
      L.items.sort((a, b) => a.x - b.x);
      // Normalized line text with per-item character ranges, so a match can be
      // mapped back to just the items (columns) it actually covers.
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
    pages.push({ lines });
  }
  return pages;
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

  for (const part of String(markText || '').split(/[|]|—|–/)) {
    let n = normalize(part);
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

// Payment-history grid rows are described as "2020 row — ..." — locate them by
// the leading year on the stated page (or the next page) only, since every
// account section repeats the same year labels.
function findYearRow(pages, pageHint, year) {
  const tryPages = [];
  if (pageHint >= 1 && pageHint <= pages.length) tryPages.push(pageHint - 1);
  if (pageHint >= 1 && pageHint < pages.length) tryPages.push(pageHint);
  for (const pi of tryPages) {
    const lines = pages[pi].lines;
    // Width reference: the widest fully-populated grid row on this page.
    // Rows made of "no data" squares have no text cells (the squares are drawn
    // shapes), so their only text item is the year label itself.
    let rowMaxX = 0;
    for (const L of lines) {
      if (/^(19|20)\d{2}( |$)/.test(L.text) && L.items.length >= 6) {
        rowMaxX = Math.max(rowMaxX, Math.max(...L.items.map(i => i.x + i.w)));
      }
    }
    for (const L of lines) {
      if (L.text === year || L.text.startsWith(year + ' ')) {
        if (L.items.length >= 6) return { pageIndex: pi, line: L, items: L.items };
        return { pageIndex: pi, line: L, items: L.items, extendToX: rowMaxX || 540 };
      }
    }
  }
  return null;
}

// 24-month-history rows ("06/25 ■ ... 022") are findable by their leading
// MM/YY date even when the rest of the markText never matches the page text.
function findRowByLeadingToken(pages, pageHint, token) {
  const tok = normalize(token);
  if (!tok) return null;
  const hi = (pageHint || 0) - 1;
  const order = [hi, hi + 1, hi - 1].filter(pi => pi >= 0 && pi < pages.length);
  for (const pi of order) {
    for (const L of pages[pi].lines) {
      if (L.text === tok || L.text.startsWith(tok + ' ')) {
        return { pageIndex: pi, line: L, items: L.items };
      }
    }
  }
  return null;
}

// Search a SINGLE page for a text match (used by last-resort fallbacks, where
// searching the whole document would land on the wrong account's section).
function findOnPage(pages, pageIndex, text) {
  if (pageIndex < 0 || pageIndex >= pages.length) return null;
  const cand = normalize(text);
  if (!cand || cand.length < 3) return null;
  for (const line of pages[pageIndex].lines) {
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
function findLine(pages, pageHint, cands) {
  const order = [];
  const hintIdx = (pageHint >= 1 && pageHint <= pages.length) ? pageHint - 1 : -1;
  if (hintIdx >= 0) {
    order.push(hintIdx);
    if (hintIdx > 0) order.push(hintIdx - 1);
    if (hintIdx < pages.length - 1) order.push(hintIdx + 1);
  }
  for (let i = 0; i < pages.length; i++) if (!order.includes(i)) order.push(i);

  for (const cand of cands) {
    for (const pi of order) {
      for (const line of pages[pi].lines) {
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
  return null;
}

/**
 * Annotate a copy of the credit report PDF with red boxes only — no numbering.
 * (Numbered callouts were removed on purpose: they drifted out of sync with the
 * Factual Dispute Letter's item numbers. The box location itself identifies the
 * disputed field.) Returns { totalItems, located, missed }.
 */
async function annotateCreditReportPdf(inputPdfPath, violationsData, outputPath) {
  const buffer = fs.readFileSync(inputPdfPath);
  const pages = await extractPageLines(buffer);

  const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pdfPages = pdfDoc.getPages();

  let itemNo = 0;
  let located = 0;
  const missed = [];
  const drawnBoxes = []; // {p, x, y, width, height} — to nest coinciding boxes

  for (const f of (violationsData.furnishers || [])) {
    for (const v of (f.violations || [])) {
      itemNo++;
      const marks = (v.markup && v.markup.length > 0) ? v.markup : [];
      if (marks.length === 0) {
        missed.push({ item: itemNo, reason: 'no markup data', text: v.title || '' });
        continue;
      }

      let anyHit = false;
      for (const m of marks) {
        const clean = sanitizeMarkText(m.markText);
        let hit = null;
        const yearRow = clean.match(/^((?:19|20)\d{2})\b/);
        if (yearRow) hit = findYearRow(pages, m.page, yearRow[1]);
        if (!hit) {
          const cands = candidatesFor(clean);
          hit = cands.length ? findLine(pages, m.page, cands) : null;
        }
        if (!hit) {
          const lead = clean.match(/^(\d{2}\/\d{2})\b/);
          if (lead) hit = findRowByLeadingToken(pages, m.page, lead[1]);
        }
        // Guaranteed fallbacks: every dispute item must show at least one box.
        // Box the section heading, else the furnisher heading, on the stated page.
        if (!hit) hit = findOnPage(pages, (m.page || 0) - 1, m.section);
        if (!hit) hit = findOnPage(pages, (m.page || 0) - 1, f.name);
        if (!hit) continue;
        anyHit = true;

        const pg = pdfPages[hit.pageIndex];
        const L = hit.line;
        const boxItems = hit.items && hit.items.length ? hit.items : L.items;
        const minX = Math.min(...boxItems.map(i => i.x));
        const maxX = Math.max(hit.extendToX || 0, ...boxItems.map(i => i.x + i.w));
        const maxH = Math.max(...boxItems.map(i => i.h));
        // If this box lands where one was already drawn (two items sharing a
        // field, or fallbacks sharing a heading), grow the padding so the boxes
        // nest visibly instead of overprinting as one.
        let pad = 2.5;
        let box;
        do {
          box = {
            x: minX - pad,
            y: L.y - pad,
            width: (maxX - minX) + pad * 2,
            height: maxH + pad * 2,
          };
          pad += 3;
        } while (drawnBoxes.some(b => b.p === hit.pageIndex &&
          Math.abs(b.x - box.x) < 2 && Math.abs(b.y - box.y) < 2 &&
          Math.abs(b.width - box.width) < 4 && Math.abs(b.height - box.height) < 4));
        drawnBoxes.push({ p: hit.pageIndex, ...box });
        pg.drawRectangle({ ...box, borderColor: RED, borderWidth: 1.4 });
      }

      if (anyHit) located++;
      else missed.push({ item: itemNo, text: (marks[0] && marks[0].markText) || v.title || '' });
    }
  }

  fs.writeFileSync(outputPath, await pdfDoc.save());
  return { totalItems: itemNo, located, missed };
}

module.exports = { annotateCreditReportPdf };
