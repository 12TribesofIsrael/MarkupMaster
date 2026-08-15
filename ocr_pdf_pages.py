"""OCR helper for SCANNED credit report PDFs: prints per-page word boxes as JSON.

Usage: python ocr_pdf_pages.py <pdf_path> [dpi] [max_pages]
Output: {"pages": [{"page": 1, "width": 612.0, "height": 792.0, "rotation": 0,
                    "words": [{"t": word, "x": left, "y": top, "w": w, "h": h}]}]}

Coordinates are PDF POINTS with the origin at the page's TOP-LEFT, so the
caller can place boxes on the original PDF pages without knowing the render
resolution.

Some scans embed the page image SIDEWAYS (browser-printed Experian reports in
particular print landscape content on a portrait page). Tesseract reads almost
nothing from those, so when the upright pass yields too few words the page is
retried at 90/180/270 degrees and the best orientation wins. In that case
"rotation" is the counter-clockwise angle that made the text upright, and
"width"/"height"/word coordinates are all in the UPRIGHT space — the caller
maps its finished boxes back onto the unrotated page (see pdf-annotator's
rectToPage) so text search and box geometry can stay in reading order.

Some bureau reports (notably browser-printed Experian PDFs) are pure page
images with no text layer at all. pdf-annotator's normal path searches the
text layer to place its red boxes, so on those files it finds nothing and the
annotated copy comes out empty. This script gives that path an OCR'd stand-in
text layer covering every page.
"""
import json
import re
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor

import fitz  # pymupdf
import pytesseract
from PIL import Image

# tesseract is installed but not on PATH on some machines — same fallback as
# ocr_words.py uses.
pytesseract.pytesseract.tesseract_cmd = (
    shutil.which("tesseract") or r"C:\Program Files\Tesseract-OCR\tesseract.exe"
)

pdf_path = sys.argv[1]
DPI = int(sys.argv[2]) if len(sys.argv) > 2 else 200
MAX_PAGES = int(sys.argv[3]) if len(sys.argv) > 3 else 300

# Points per rendered pixel — used to scale OCR pixel coords back to PDF points.
PT_PER_PX = 72.0 / DPI


def run_tess(img, psm):
    d = pytesseract.image_to_data(
        img, config=f"--psm {psm}", output_type=pytesseract.Output.DICT
    )
    words = []
    for i, t in enumerate(d["text"]):
        t = t.strip()
        if not t or int(d["conf"][i]) < 0:
            continue
        words.append({
            "t": t,
            "x": d["left"][i],
            "y": d["top"][i],
            "w": d["width"][i],
            "h": d["height"][i],
        })
    return words


def ocr_words(img):
    """OCR a PIL image, word boxes in rendered pixels. psm 6 (uniform block)
    reads dense report text best, but silently drops faint isolated words —
    a blank field's bare label ("Phone" with nothing after it) is exactly the
    text the unpopulated-field sweep needs. psm 11 (sparse text) catches
    those, so run both and merge psm 11 words that psm 6 missed."""
    words = run_tess(img, 6)
    try:
        sparse = run_tess(img, 11)
    except Exception:
        sparse = []
    # psm 11 re-reads much of what psm 6 already saw, at slightly offset
    # boxes. Any overlap at all marks a duplicate — only genuinely new words
    # (text sitting in whitespace psm 6 skipped) may join.
    for w in sparse:
        covered = any(
            w["x"] < b["x"] + b["w"] + 3 and b["x"] < w["x"] + w["w"] + 3 and
            w["y"] < b["y"] + b["h"] + 3 and b["y"] < w["y"] + w["h"] + 3
            for b in words
        )
        if not covered:
            words.append(w)
    return words


# Words that look like report text — a sideways page OCRs into hundreds of
# one-and-two-glyph shards, so count only plausible tokens.
REAL_WORD = re.compile(r"[a-zA-Z0-9$.,/%*#-]{3,}$")


def real_score(words):
    return sum(1 for w in words if REAL_WORD.match(w["t"]))


# Tesseract OSD reports the CLOCKWISE rotation that uprights the image; PIL
# transpose constants are counter-clockwise. Track rotation CCW because that
# is what pdf-annotator's rectToPage expects.
CW_TO_CCW = {90: 270, 180: 180, 270: 90}
CCW_OP = {90: Image.ROTATE_90, 180: Image.ROTATE_180, 270: Image.ROTATE_270}


def detect_rotation(img):
    """CCW degrees that upright this page, per tesseract's orientation
    detector; 0 when OSD fails or finds it already upright."""
    try:
        osd = pytesseract.image_to_osd(img)
        cw = int(next(l.split(":")[1] for l in osd.splitlines() if l.startswith("Rotate:")))
        return CW_TO_CCW.get(cw, 0)
    except Exception:
        return 0


def ocr_page(index):
    """Render + OCR one page. Each worker opens its own document handle
    because a fitz.Page is not safe to touch from another thread."""
    with fitz.open(pdf_path) as doc:
        page = doc[index]
        rect = page.rect
        pix = page.get_pixmap(matrix=fitz.Matrix(DPI / 72, DPI / 72))
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("L")

    # Sideways scan (browser-printed Experian: landscape content on a portrait
    # page): OSD names the correction; OCR the uprighted image and keep it if
    # it actually reads better than the raw page did.
    rotation = detect_rotation(img)
    if rotation:
        words = ocr_words(img.transpose(CCW_OP[rotation]))
        upright_words = ocr_words(img)
        if real_score(upright_words) > real_score(words):
            rotation, words = 0, upright_words
    else:
        words = ocr_words(img)
        # OSD said upright but the page reads like noise — try the rotations.
        if real_score(words) < 12:
            best = (real_score(words), 0, words)
            for deg, op in CCW_OP.items():
                w2 = ocr_words(img.transpose(op))
                s2 = real_score(w2)
                if s2 > best[0] * 1.5 and s2 >= 12:
                    best = (s2, deg, w2)
            _, rotation, words = best

    # Report the dimensions OF THE SPACE THE COORDINATES LIVE IN: the upright
    # (possibly rotated) rendering, converted to PDF points.
    if rotation in (90, 270):
        width_pt, height_pt = rect.height, rect.width
    else:
        width_pt, height_pt = rect.width, rect.height
    out = []
    for w in words:
        out.append({
            "t": w["t"],
            "x": w["x"] * PT_PER_PX,
            "y": w["y"] * PT_PER_PX,
            "w": w["w"] * PT_PER_PX,
            "h": w["h"] * PT_PER_PX,
        })
    return {"page": index + 1, "width": width_pt, "height": height_pt,
            "rotation": rotation, "words": out}


with fitz.open(pdf_path) as d0:
    count = min(d0.page_count, MAX_PAGES)

# tesseract runs as a subprocess, so threads genuinely overlap here.
with ThreadPoolExecutor(max_workers=4) as pool:
    pages = list(pool.map(ocr_page, range(count)))

print(json.dumps({"pages": pages}))
