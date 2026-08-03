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
 * Shared matching + drawing core. Finds each markup entry's text in the
 * extracted page lines and draws a red box over the matched items.
 * `markFilter(m)` returns the local 1-based page hint for a markup entry, or
 * null to skip it (used by snapshot mode, where entries reference other files).
 * Returns { totalItems, located, missed }.
 */
function drawMarkupBoxes(pages, pdfPages, violationsData, markFilter, style = {}) {
  const padX = style.padX != null ? style.padX : 2.5;
  const padTop = style.padTop != null ? style.padTop : 2.5;
  const padBottom = style.padBottom != null ? style.padBottom : 2.5;
  const borderWidth = style.lineWidth || 1.4;

  let itemNo = 0;
  let located = 0;
  const missed = [];
  const drawnBoxes = []; // {p, x, y, width, height} — to nest coinciding boxes

  for (const f of (violationsData.furnishers || [])) {
    for (const v of (f.violations || [])) {
      itemNo++;
      const allMarks = v.markup || [];
      if (allMarks.length === 0) {
        missed.push({ item: itemNo, reason: 'no markup data', text: v.title || '' });
        continue;
      }
      const marks = allMarks.filter(m => markFilter(m) != null);
      if (marks.length === 0) continue; // this violation's marks live on another file

      let anyHit = false;
      for (const m of marks) {
        const hint = markFilter(m);
        const clean = sanitizeMarkText(m.markText);
        let hit = null;
        const yearRow = clean.match(/^((?:19|20)\d{2})\b/);
        if (yearRow) hit = findYearRow(pages, hint, yearRow[1]);
        if (!hit) {
          const cands = candidatesFor(clean);
          hit = cands.length ? findLine(pages, hint, cands) : null;
        }
        if (!hit) {
          const lead = clean.match(/^(\d{2}\/\d{2})\b/);
          if (lead) hit = findRowByLeadingToken(pages, hint, lead[1]);
        }
        // Guaranteed fallbacks: every dispute item must show at least one box.
        // Box the section heading, else the furnisher heading, on the stated page.
        if (!hit) hit = findOnPage(pages, (hint || 0) - 1, m.section);
        if (!hit) hit = findOnPage(pages, (hint || 0) - 1, f.name);
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
        let grow = 0;
        let box;
        do {
          box = {
            x: minX - padX - grow,
            y: L.y - padBottom - grow,
            width: (maxX - minX) + (padX + grow) * 2,
            height: maxH + padTop + padBottom + grow * 2,
          };
          grow += 3;
        } while (drawnBoxes.some(b => b.p === hit.pageIndex &&
          Math.abs(b.x - box.x) < 2 && Math.abs(b.y - box.y) < 2 &&
          Math.abs(b.width - box.width) < 4 && Math.abs(b.height - box.height) < 4));
        drawnBoxes.push({ p: hit.pageIndex, ...box });
        pg.drawRectangle({ ...box, borderColor: RED, borderWidth });
      }

      if (anyHit) located++;
      else missed.push({ item: itemNo, text: (marks[0] && marks[0].markText) || v.title || '' });
    }
  }

  return { totalItems: itemNo, located, missed };
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

  const stats = drawMarkupBoxes(pages, pdfPages, violationsData, m => m.page);

  fs.writeFileSync(outputPath, await pdfDoc.save());
  return stats;
}

/**
 * Snapshot mode, OCR path (preferred): tesseract reads the image's words with
 * exact pixel positions, and boxes are then placed by the same text-search
 * logic the PDF mode uses — no model coordinates involved. Throws if the OCR
 * engine is unavailable; callers fall back to annotateImageSnapshot.
 */
async function annotateImageSnapshotOcr(imagePath, violationsData, outputPath, imageIndex = 1) {
  const raw = execFileSync('python', [path.join(__dirname, 'ocr_words.py'), imagePath],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60000 }).toString();
  const words = JSON.parse(raw);
  if (!Array.isArray(words) || words.length === 0) throw new Error('OCR returned no words');

  const bytes = fs.readFileSync(imagePath);
  const pdfDoc = await PDFDocument.create();
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const img = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
  const { width, height } = img.scale(1);
  const page = pdfDoc.addPage([width, height]);
  page.drawImage(img, { x: 0, y: 0, width, height });

  // OCR pixel coords (origin top-left) → page coords (origin bottom-left).
  // OCR baselines jitter more than PDF text runs, so group lines loosely.
  const items = words.map(w => ({ str: w.t, x: w.x, y: height - (w.y + w.h), w: w.w, h: w.h }));
  const pages = [{ lines: groupIntoLines(items, 7) }];

  const stats = drawMarkupBoxes(pages, [page], violationsData,
    m => ((m.page || 1) === imageIndex ? 1 : null),
    { padX: Math.max(4, width * 0.004), padTop: 4, padBottom: 5, lineWidth: Math.max(1.5, width / 450) });

  fs.writeFileSync(outputPath, await pdfDoc.save());
  return stats;
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

module.exports = { annotateCreditReportPdf, annotateImageSnapshot, annotateImageSnapshotOcr, refineSnapshotBoxes };
