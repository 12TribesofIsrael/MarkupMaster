// Identity documents: the consumer's photo ID and proof of address.
//
// The Watts letter states on its face that a photo ID and a proof of address
// are enclosed. Until these are actually attached, that sentence is a promise
// the package does not keep — the consumer has to remember to stuff the
// envelope by hand, and a missing ID is exactly what triggers the bureaus'
// "we don't think this is really you" stall letter.
//
// This module normalizes whatever the consumer uploads (JPG/PNG/PDF) into
// plain PNG/JPG page images that docx can embed, and measures them so the
// exhibit pages scale to fit.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_PAGES = 4;   // front + back of a license, or a short bill

// ─── Image dimensions ────────────────────────────────────────────────────────
// docx needs pixel dimensions to lay an image out. Only PNG and JPEG reach
// here (PDFs are rendered to PNG first), so a header read beats a dependency.

function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off < buf.length - 9) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    // SOF0–SOF15 carry the frame dimensions; C4/C8/CC are other segments.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7), type: 'jpg' };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { off += 2; continue; }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return null;
}

function imageSize(bufOrPath) {
  const buf = Buffer.isBuffer(bufOrPath) ? bufOrPath : fs.readFileSync(bufOrPath);
  return pngSize(buf) || jpegSize(buf);
}

// ─── Upload normalization ────────────────────────────────────────────────────

// Turn one uploaded file into one or more embeddable page images in destDir.
// PDFs are rasterized through pymupdf; images are copied as-is.
function normalizeToImages(srcPath, destDir, prefix) {
  fs.mkdirSync(destDir, { recursive: true });
  const ext = path.extname(srcPath).toLowerCase();

  if (ext === '.pdf') {
    const raw = execFileSync('python',
      [path.join(__dirname, 'render_pdf_pages.py'), srcPath, destDir.replace(/\\/g, '/'), prefix, String(MAX_PAGES)],
      { encoding: 'utf8', timeout: 60000 });
    return JSON.parse(raw).map(p => path.normalize(p));
  }

  const dest = path.join(destDir, `${prefix}${ext === '.jpeg' ? '.jpg' : ext}`);
  fs.copyFileSync(srcPath, dest);
  return [dest];
}

// Replace a client's stored scans for one slot ('id' | 'proof'). Old files are
// removed — these are the most sensitive images in the app, so a replaced
// license should not linger on disk.
function storeClientDocs(clientDir, slot, uploadedFiles, previousPaths) {
  for (const p of (previousPaths || [])) fs.rmSync(p, { force: true });
  const out = [];
  uploadedFiles.forEach((f, i) => {
    try {
      out.push(...normalizeToImages(f.path, clientDir, `${slot}_${i + 1}`));
    } catch (err) {
      throw new Error(`Could not read "${f.originalname}": ${err.message}`);
    }
  });
  return out.slice(0, MAX_PAGES * 2);
}

module.exports = { imageSize, normalizeToImages, storeClientDocs, MAX_PAGES };
