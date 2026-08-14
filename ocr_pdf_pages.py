"""OCR helper for SCANNED credit report PDFs: prints per-page word boxes as JSON.

Usage: python ocr_pdf_pages.py <pdf_path> [dpi] [max_pages]
Output: {"pages": [{"page": 1, "width": 612.0, "height": 792.0,
                    "words": [{"t": word, "x": left, "y": top, "w": w, "h": h}]}]}

Coordinates are PDF POINTS with the origin at the page's TOP-LEFT, so the
caller can place boxes on the original PDF pages without knowing the render
resolution.

Some bureau reports (notably browser-printed Experian PDFs) are pure page
images with no text layer at all. pdf-annotator's normal path searches the
text layer to place its red boxes, so on those files it finds nothing and the
annotated copy comes out empty. This script gives that path an OCR'd stand-in
text layer covering every page.
"""
import json
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


def ocr_page(index):
    """Render + OCR one page. Each worker opens its own document handle
    because a fitz.Page is not safe to touch from another thread."""
    with fitz.open(pdf_path) as doc:
        page = doc[index]
        rect = page.rect
        pix = page.get_pixmap(matrix=fitz.Matrix(DPI / 72, DPI / 72))
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("L")

    # psm 6 (uniform text block) keeps the sparse payment-history columns that
    # the default page segmentation drops.
    d = pytesseract.image_to_data(
        img, config="--psm 6", output_type=pytesseract.Output.DICT
    )
    words = []
    for i, t in enumerate(d["text"]):
        t = t.strip()
        if not t or int(d["conf"][i]) < 0:
            continue
        words.append({
            "t": t,
            "x": d["left"][i] * PT_PER_PX,
            "y": d["top"][i] * PT_PER_PX,
            "w": d["width"][i] * PT_PER_PX,
            "h": d["height"][i] * PT_PER_PX,
        })
    return {"page": index + 1, "width": rect.width, "height": rect.height, "words": words}


with fitz.open(pdf_path) as d0:
    count = min(d0.page_count, MAX_PAGES)

# tesseract runs as a subprocess, so threads genuinely overlap here.
with ThreadPoolExecutor(max_workers=4) as pool:
    pages = list(pool.map(ocr_page, range(count)))

print(json.dumps({"pages": pages}))
