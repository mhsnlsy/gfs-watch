#!/usr/bin/env python3
"""Temporary diagnostics for discovering ENKA Weather Display history exports."""
import re
import requests
from urllib.parse import urljoin, urlparse

BASE = "https://w.enka.com/weather/"
CANDIDATES = [
    "wdfulldata.xml",
    "clientraw.txt",
    "clientrawextra.txt",
    "clientrawhour.txt",
    "clientrawdaily.txt",
    "clientrawdaily.csv",
    "clientrawhour.csv",
    "data.htm",
    "datahtm0.txt",
    "datahtm1.txt",
    "today.htm",
    "today.csv",
    "history.htm",
    "history.csv",
    "OutsideTemp.gif",
    "OutsideTemp.png",
    "NOAAMO.TXT",
]
session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
})
try:
    r = session.get(BASE, timeout=20)
    print(f"[BASE] status={r.status_code} type={r.headers.get('Content-Type')} bytes={len(r.content)} final={r.url}")
    html = r.text
    discovered = re.findall(r'''(?:src|href)\s*=\s*["']([^"']+)["']''', html, flags=re.I)
    for item in discovered:
        if re.search(r"(clientraw|fulldata|history|temp|data|noaa|today|log|csv|xml)", item, re.I):
            print("[PAGE LINK]", urljoin(BASE, item))
except Exception as exc:
    print("[BASE ERROR]", repr(exc))

seen = set()
for path in CANDIDATES:
    url = urljoin(BASE, path)
    if url in seen:
        continue
    seen.add(url)
    try:
        r = session.get(url, timeout=18)
        ctype = r.headers.get("Content-Type", "")
        sample = r.content[:360].decode("utf-8", errors="replace").replace("\r", " ").replace("\n", " ")
        print(f"[ENDPOINT] {path} status={r.status_code} type={ctype} bytes={len(r.content)} sample={sample[:220]!r}")
    except Exception as exc:
        print(f"[ENDPOINT] {path} ERROR {type(exc).__name__}: {exc}")
