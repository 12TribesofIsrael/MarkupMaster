"""Render PDF pages to PNG so they can be embedded in a .docx exhibit page.

Usage: python render_pdf_pages.py <pdf_path> <out_dir> <out_prefix> [max_pages]
Output: JSON array of the PNG paths written, in page order.

Used for identity documents (a driver's license or utility bill the consumer
uploads as a PDF). docx can only embed raster images, so a PDF has to become
one PNG per page before it can be attached to the letter.
"""
import json
import sys

import fitz  # pymupdf

pdf_path, out_dir, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
max_pages = int(sys.argv[4]) if len(sys.argv) > 4 else 4

# 150 dpi is plenty for a legible ID/bill scan without producing a 20MB docx.
zoom = 150 / 72
matrix = fitz.Matrix(zoom, zoom)

written = []
with fitz.open(pdf_path) as doc:
    for i, page in enumerate(doc):
        if i >= max_pages:
            break
        out = f"{out_dir}/{prefix}_p{i + 1}.png"
        page.get_pixmap(matrix=matrix).save(out)
        written.append(out)

print(json.dumps(written))
