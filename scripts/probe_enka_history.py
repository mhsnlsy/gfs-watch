#!/usr/bin/env python3
"""Temporary diagnostics for discovering ENKA Weather Display history exports."""
import base64
import re
import requests
from urllib.parse import urljoin

BASE = "https://w.enka.com/weather/"
CANDIDATES = [
    "wdfulldata.xml", "clientraw.txt", "clientrawextra.txt",
    "clientrawhour.txt", "clientrawdaily.txt", "OutsideTemp.gif",
    "OutsideTempHistory.gif", "NOAAMO.TXT", "NOAAPRMO.TXT",
]
session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
})
try:
    response = session.get(BASE, timeout=15)
    print(f"[BASE] status={response.status_code} type={response.headers.get('Content-Type')} bytes={len(response.content)} final={response.url}")
    html = response.text
    discovered = re.findall(r'''(?:src|href)\s*=\s*["']([^"']+)["']''', html, flags=re.I)
    for item in discovered:
        if re.search(r"(clientraw|fulldata|history|temp|data|noaa|today|log|csv|xml)", item, re.I):
            print("[PAGE LINK]", urljoin(BASE, item))
    for match in re.finditer(r"<(?:img|a)\b[^>]*(?:OutsideTemp|History)[^>]*>", html, flags=re.I):
        print("[HISTORY HTML TAG]", match.group(0)[:500])
except Exception as exc:
    print("[BASE ERROR]", repr(exc))

for path in CANDIDATES:
    url = urljoin(BASE, path)
    try:
        response = session.get(url, timeout=12)
        content_type = response.headers.get("Content-Type", "")
        sample = response.content[:360].decode("utf-8", errors="replace").replace("\r", " ").replace("\n", " ")
        print(f"[ENDPOINT] {path} status={response.status_code} type={content_type} bytes={len(response.content)} sample={sample[:220]!r}")
        if path == "OutsideTempHistory.gif" and response.status_code == 200 and response.content.startswith(b"GIF"):
            print("[OUTSIDETEMP HISTORY GIF BASE64]", base64.b64encode(response.content).decode("ascii"))
    except Exception as exc:
        print(f"[ENDPOINT] {path} ERROR {type(exc).__name__}: {exc}")
