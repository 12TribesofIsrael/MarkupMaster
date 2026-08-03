"""OCR helper for snapshot annotation: prints word boxes as JSON.

Usage: python ocr_words.py <image_path>
Output: [{"t": word, "x": left, "y": top, "w": width, "h": height}, ...]
Pixel coordinates, origin at the image's top-left.
"""
import json
import shutil
import sys

import pytesseract
from PIL import Image

pytesseract.pytesseract.tesseract_cmd = (
    shutil.which("tesseract") or r"C:\Program Files\Tesseract-OCR\tesseract.exe"
)

# Screenshots have small text that tesseract garbles at native size — upscale
# before recognition and scale the coordinates back down afterward.
SCALE = 3
img = Image.open(sys.argv[1]).convert("L")
img = img.resize((img.width * SCALE, img.height * SCALE), Image.LANCZOS)

# psm 6 (uniform text block) keeps sparse table columns — the default page
# segmentation drops the small MM/YY date column entirely.
d = pytesseract.image_to_data(img, config="--psm 6", output_type=pytesseract.Output.DICT)
words = []
for i, t in enumerate(d["text"]):
    t = t.strip()
    if not t or int(d["conf"][i]) < 0:
        continue
    words.append({
        "t": t,
        "x": d["left"][i] / SCALE,
        "y": d["top"][i] / SCALE,
        "w": d["width"][i] / SCALE,
        "h": d["height"][i] / SCALE,
    })
print(json.dumps(words))
