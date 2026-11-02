#!/usr/bin/env python3
"""
Radar monitor for İstanbul (41.015 N, 28.950 E).
Checks RainViewer tiles for ≥20 dBZ and ≥30 dBZ masses within ~25 km radius
that are approaching the target location. Sends Telegram alerts.
"""
import os
import json
import math
from datetime import datetime, timezone
from io import BytesIO
import requests
from PIL import Image
import numpy as np

LAT = 41.015
LON = 28.950
RADIUS_KM = 25.0
THRESHOLD_DBZ = 20
THRESHOLD_DBZ_STRONG = 30
ZOOM = 7
TILE_SIZE = 256
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")
STATE_PATH = os.getenv("RADAR_STATE_PATH", "/tmp/radar_state.json")

HIGH_DBZ_HINTS = [
    (20, (0, 163, 224)), (25, (0, 119, 170)), (30, (0, 85, 136)),
    (35, (255, 238, 0)), (40, (255, 170, 0)), (45, (255, 68, 0)),
    (50, (193, 0, 0)), (55, (255, 170, 255)),
]

def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlmb/2)**2
    return 2 * R * math.asin(math.sqrt(a))

def latlon_to_pixel(lat, lon, z):
    lat_rad = math.radians(lat)
    n = 2.0 ** z
    x = int((lon + 180.0) / 360.0 * n * TILE_SIZE)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n * TILE_SIZE)
    return x, y

def fetch_timeline():
    r = requests.get("https://api.rainviewer.com/public/weather-maps.json", timeout=15)
    r.raise_for_status()
    return r.json()

def download_tile(host, path, z, x, y, color=2, options="1_1"):
    url = f"{host}{path}/{TILE_SIZE}/{z}/{x}/{y}/{color}/{options}.png"
    r = requests.get(url, timeout=20)
    if r.status_code != 200:
        return None
    return Image.open(BytesIO(r.content)).convert("RGBA")

def sample_area(img, center_x, center_y, radius_px):
    arr = np.array(img)
    h, w = arr.shape[:2]
    points = []
    for dy in range(-radius_px, radius_px + 1):
        for dx in range(-radius_px, radius_px + 1):
            if dx*dx + dy*dy > radius_px*radius_px:
                continue
            px, py = center_x + dx, center_y + dy
            if 0 <= px < w and 0 <= py < h:
                r, g, b, a = arr[py, px]
                if a > 40:
                    points.append((dx, dy, int(r), int(g), int(b), int(a)))
    return points

def estimate_dbz(r, g, b):
    best = 0
    best_dist = 999
    for dbz, (tr, tg, tb) in HIGH_DBZ_HINTS:
        dist = abs(r - tr) + abs(g - tg) + abs(b - tb)
        if dist < best_dist:
            best_dist = dist
            best = dbz
    return best if best_dist < 80 else 0

def analyze_frame(host, path):
    px, py = latlon_to_pixel(LAT, LON, ZOOM)
    tx, ty = px // TILE_SIZE, py // TILE_SIZE
    img = download_tile(host, path, ZOOM, tx, ty)
    if img is None:
        return None
    local_x = px % TILE_SIZE
    local_y = py % TILE_SIZE
    radius_px = 45
    samples = sample_area(img, local_x, local_y, radius_px)
    high = []
    strong = []
    for dx, dy, r, g, b, a in samples:
        dbz = estimate_dbz(r, g, b)
        if dbz >= THRESHOLD_DBZ:
            dist_km = math.hypot(dx, dy) * 0.55
            point = {"dx": dx, "dy": dy, "dist_km": dist_km, "dbz": dbz}
            high.append(point)
            if dbz >= THRESHOLD_DBZ_STRONG:
                strong.append(point)
    if not high:
        return {"max_dbz": 0, "count": 0, "centroid_dist": None, "strong_count": 0, "strong_max": 0}
    avg_dx = sum(p["dx"] for p in high) / len(high)
    avg_dy = sum(p["dy"] for p in high) / len(high)
    centroid_dist = math.hypot(avg_dx, avg_dy) * 0.55
    max_dbz = max(p["dbz"] for p in high)
    strong_max = max((p["dbz"] for p in strong), default=0)
    return {
        "max_dbz": max_dbz,
        "count": len(high),
        "centroid_dist": round(centroid_dist, 1),
        "avg_dx": avg_dx,
        "avg_dy": avg_dy,
        "strong_count": len(strong),
        "strong_max": strong_max,
    }

def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f)

def is_approaching(prev, curr, threshold):
    if not prev or not curr or curr.get("centroid_dist") is None:
        return False
    prev_dist = prev.get("centroid_dist")
    max_key = "max_dbz" if threshold == THRESHOLD_DBZ else "strong_max"
    curr_max = curr.get(max_key, 0)
    if prev_dist is None:
        return curr["centroid_dist"] < 20 and curr_max >= threshold
    return (curr["centroid_dist"] < prev_dist - 1.0 and
            curr["centroid_dist"] < RADIUS_KM and
            curr_max >= threshold)

def send_telegram(text):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("[TELEGRAM] Token/Chat missing, skipping")
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    requests.post(url, json={"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML"}, timeout=15)

def main():
    print("[RADAR] Checking RainViewer for 41.015, 28.950 ...")
    timeline = fetch_timeline()
    host = timeline.get("host", "https://tilecache.rainviewer.com")
    past = timeline.get("radar", {}).get("past", [])
    if not past:
        print("[RADAR] No past frames")
        return
    latest = past[-1]
    path = latest["path"]
    ts = latest["time"]
    print(f"[RADAR] Latest frame: {path} @ {datetime.fromtimestamp(ts, timezone.utc)}")

    curr = analyze_frame(host, path)
    if curr is None:
        print("[RADAR] Tile download failed")
        return

    state = load_state()
    prev = state.get("last")

    approaching_20 = is_approaching(prev, curr, THRESHOLD_DBZ)
    approaching_30 = is_approaching(prev, curr, THRESHOLD_DBZ_STRONG)
    on_site_20 = curr.get("centroid_dist", 999) < 5 and curr.get("max_dbz", 0) >= THRESHOLD_DBZ
    on_site_30 = curr.get("centroid_dist", 999) < 5 and curr.get("strong_max", 0) >= THRESHOLD_DBZ_STRONG

    alert_20 = approaching_20 or on_site_20
    alert_30 = approaching_30 or on_site_30

    summary = (
        f"max {curr.get('max_dbz', 0)} dBZ, "
        f"centroid {curr.get('centroid_dist', '—')} km, "
        f"{curr.get('count', 0)} high pixels"
    )
    print(f"[RADAR] {summary} | alert20={alert_20} alert30={alert_30}")

    if alert_30:
        msg = (
            f"⚠️ <b>GÜÇLÜ Radar Uyarısı — İstanbul (≥30 dBZ)</b>\n"
            f"Konum: 41.015 N, 28.950 E\n"
            f"{summary}\n"
            f"Güçlü kütle: max {curr.get('strong_max', 0)} dBZ ({curr.get('strong_count', 0)} piksel)\n"
            f"{'Konuma ulaşıyor / üzerinde.' if on_site_30 else 'Yaklaşıyor.'}\n"
            f"https://mhsnlsy.github.io/gfs-watch/#radar"
        )
        send_telegram(msg)
        print("[RADAR] STRONG ALERT (≥30) SENT")
    elif alert_20:
        msg = (
            f"🌧️ <b>Radar Uyarısı — İstanbul (≥20 dBZ)</b>\n"
            f"Konum: 41.015 N, 28.950 E\n"
            f"{summary}\n"
            f"{'Konuma ulaşıyor / üzerinde.' if on_site_20 else 'Yaklaşıyor.'}\n"
            f"https://mhsnlsy.github.io/gfs-watch/#radar"
        )
        send_telegram(msg)
        print("[RADAR] ALERT (≥20) SENT")

    state["last"] = curr
    state["last_ts"] = ts
    state["checked_at"] = datetime.now(timezone.utc).isoformat()
    save_state(state)
    print("[RADAR] Done.")

if __name__ == "__main__":
    main()
