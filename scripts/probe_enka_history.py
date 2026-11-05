#!/usr/bin/env python3
"""Temporary diagnostics for discovering ENKA Weather Display history exports."""
import io
import re
import requests
import pytesseract
from PIL import Image, ImageStat
from urllib.parse import urljoin

BASE = "https://w.enka.com/weather/"
URL = urljoin(BASE, "OutsideTempHistory.gif")
session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
})
try:
    page = session.get(BASE, timeout=15)
    print(f"[BASE] status={page.status_code} bytes={len(page.content)}")
    for m in re.finditer(r"<(?:img|a)\b[^>]*(?:OutsideTemp|History)[^>]*>", page.text, flags=re.I):
        print("[HISTORY HTML TAG]", m.group(0)[:500])
    response = session.get(URL, timeout=15)
    response.raise_for_status()
    print(f"[HISTORY GIF] status={response.status_code} type={response.headers.get('Content-Type')} bytes={len(response.content)}")
    image = Image.open(io.BytesIO(response.content)).convert("RGB")
    print("[IMAGE SIZE]", image.size)
    print("[OCR TEXT]")
    print(pytesseract.image_to_string(image, config="--psm 11", lang="eng"))
    data = image.getdata()
    from collections import Counter
    counts = Counter(data)
    print("[DOMINANT COLORS]", counts.most_common(18))
    # Coarse luminance/colour map for visual inspection without storing a binary artifact.
    w,h=image.size
    out=[]
    for yy in range(0,h,4):
        row=[]
        for xx in range(0,w,2):
            r,g,b=image.getpixel((xx,yy))
            if r>220 and g>220 and b>220: ch=" "
            elif r>180 and g<120 and b<120: ch="R"
            elif r<100 and g>150 and b<150: ch="G"
            elif r<100 and g<100 and b<100: ch="."
            else: ch="*"
            row.append(ch)
        out.append("".join(row))
    print("[ASCII MAP]")
    print("\n".join(out))
except Exception as exc:
    print("[PROBE ERROR]", type(exc).__name__, str(exc))
