#!/usr/bin/env python3
"""
Radar monitor for İstanbul (41.0904 N, 28.9438 E).
Checks RainViewer tiles and classifies detected echoes into four dBZ intensity levels within ~25 km radius.
Tracks motion (speed, direction, ETA) and alerts if approaching or on site.
"""
import os
import json
import math
from datetime import datetime, timezone
from io import BytesIO
import requests
from PIL import Image
import numpy as np

LAT = 41.0904
LON = 28.9438
RADIUS_KM = 25.0
THRESHOLD_DBZ = 10
THRESHOLD_DBZ_STRONG = 30
MIN_ALERT_PIXELS = 15
ZOOM = 7
TILE_SIZE = 256
PIXEL_KM = 0.55  # approx km per pixel at zoom 7
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")
STATE_PATH = os.getenv("RADAR_STATE_PATH", "/tmp/radar_state.json")
ALERT_STATE_PATH = os.getenv("RADAR_ALERT_STATE_PATH", "radar_alert_state.json")
CHECK_LOG_PATH = os.getenv("RADAR_CHECK_LOG_PATH", "radar_checks.jsonl")
ALERT_COOLDOWN_SECONDS = 3600
HISTORY_LEN = 4

HIGH_DBZ_HINTS = [
    (10, (0, 220, 220)), (15, (0, 190, 220)), (20, (0, 163, 224)),
    (25, (0, 119, 170)), (30, (0, 85, 136)), (35, (255, 238, 0)),
    (40, (255, 170, 0)), (45, (255, 68, 0)), (50, (193, 0, 0)),
    (55, (255, 170, 255)),
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
            dist_km = math.hypot(dx, dy) * PIXEL_KM
            point = {"dx": dx, "dy": dy, "dist_km": dist_km, "dbz": dbz}
            high.append(point)
            if dbz >= THRESHOLD_DBZ_STRONG:
                strong.append(point)
    if not high:
        return {"max_dbz": 0, "count": 0, "centroid_dist": None, "strong_count": 0, "strong_max": 0,
                "avg_dx": 0, "avg_dy": 0}
    avg_dx = sum(p["dx"] for p in high) / len(high)
    avg_dy = sum(p["dy"] for p in high) / len(high)
    centroid_dist = math.hypot(avg_dx, avg_dy) * PIXEL_KM
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

def append_check_log(status, **fields):
    """Append one durable record for every scheduled check, including empty/error frames."""
    record = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        **fields,
    }
    with open(CHECK_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"[RADAR] Check logged: {status}")


def load_state():
    try:
        with open(STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {"history": []}

def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f)

def load_alert_state():
    try:
        with open(ALERT_STATE_PATH) as f:
            return json.load(f)
    except Exception:
        return {}

def save_alert_state(state):
    with open(ALERT_STATE_PATH, "w") as f:
        json.dump(state, f)

def compute_motion(history):
    """Return speed_kmh, heading_deg, towards, eta_min from recent history."""
    if len(history) < 2:
        return None, None, False, None
    prev = history[-2]
    curr = history[-1]
    dt_sec = curr["ts"] - prev["ts"]
    if dt_sec < 60:
        return None, None, False, None
    dx = curr["avg_dx"] - prev["avg_dx"]
    dy = curr["avg_dy"] - prev["avg_dy"]
    dist_px = math.hypot(dx, dy)
    dist_km = dist_px * PIXEL_KM
    speed_kmh = (dist_km / dt_sec) * 3600
    heading = math.degrees(math.atan2(dx, -dy)) % 360
    to_target_dx = -curr["avg_dx"]
    to_target_dy = -curr["avg_dy"]
    to_target_len = math.hypot(to_target_dx, to_target_dy)
    if to_target_len < 1 or dist_px < 0.5:
        towards = False
    else:
        dot = (dx * to_target_dx + dy * to_target_dy) / (dist_px * to_target_len)
        towards = dot > 0.5
    eta_min = None
    if speed_kmh > 5 and curr["centroid_dist"] and towards:
        eta_min = (curr["centroid_dist"] / speed_kmh) * 60
    return round(speed_kmh, 0), round(heading, 0), towards, round(eta_min, 0) if eta_min else None

def is_approaching(prev, curr, threshold):
    if not curr or curr.get("centroid_dist") is None:
        return False
    max_key = "max_dbz" if threshold == THRESHOLD_DBZ else "strong_max"
    curr_max = curr.get(max_key, 0)
    if not prev or prev.get("centroid_dist") is None:
        return curr["centroid_dist"] < 20 and curr_max >= threshold
    return (curr["centroid_dist"] < prev.get("centroid_dist", 999) - 0.8 and
            curr["centroid_dist"] < RADIUS_KM and
            curr_max >= threshold)

def send_telegram(text):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("[TELEGRAM] Token/Chat missing, skipping")
        return False
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    response = requests.post(
        url,
        json={"chat_id": CHAT_ID, "text": text, "parse_mode": "HTML"},
        timeout=15,
    )
    response.raise_for_status()
    result = response.json()
    return bool(result.get("ok"))

def main():
    print("[RADAR] Checking RainViewer for 41.0904, 28.9438 ...")
    timeline = fetch_timeline()
    host = timeline.get("host", "https://tilecache.rainviewer.com")
    past = timeline.get("radar", {}).get("past", [])
    if not past:
        print("[RADAR] No past frames")
        append_check_log("no_past_frames")
        return
    latest = past[-1]
    path = latest["path"]
    ts = latest["time"]
    print(f"[RADAR] Latest frame: {path} @ {datetime.fromtimestamp(ts, timezone.utc)}")

    curr = analyze_frame(host, path)
    if curr is None:
        print("[RADAR] Tile download failed")
        append_check_log("tile_download_failed", frame_path=path, frame_ts=ts)
        return

    state = load_state()
    history = state.get("history", [])
    history.append({
        "ts": ts,
        "avg_dx": curr.get("avg_dx", 0),
        "avg_dy": curr.get("avg_dy", 0),
        "centroid_dist": curr.get("centroid_dist"),
        "max_dbz": curr.get("max_dbz", 0),
    })
    history = history[-HISTORY_LEN:]

    speed, heading, towards, eta = compute_motion(history)
    prev = history[-2] if len(history) >= 2 else None

    approaching = is_approaching(prev, curr, THRESHOLD_DBZ)
    centroid_dist = curr.get("centroid_dist")
    pixel_count = curr.get("count", 0)
    has_rain_echo = centroid_dist is not None and pixel_count > 0
    pixel_threshold_met = pixel_count >= MIN_ALERT_PIXELS
    max_dbz = curr.get("max_dbz", 0)

    # No detected echo means no on-site alert. Avoid comparing None with a number.
    on_site = (
        has_rain_echo
        and centroid_dist < 5
        and max_dbz >= THRESHOLD_DBZ
    )

    if towards and has_rain_echo and centroid_dist < RADIUS_KM:
        approaching = approaching or (max_dbz >= THRESHOLD_DBZ)

    # Require at least 15 detected rain pixels AND the existing approach/on-site logic.
    alert = pixel_threshold_met and (approaching or on_site)

    if max_dbz <= 10:
        intensity = "DÜŞÜK"
        intensity_emoji = "🌦️"
    elif max_dbz <= 20:
        intensity = "ORTA"
        intensity_emoji = "🌧️"
    elif max_dbz <= 30:
        intensity = "GÜÇLÜ"
        intensity_emoji = "⛈️"
    else:
        intensity = "ÇOK GÜÇLÜ"
        intensity_emoji = "⚠️"

    motion_txt = ""
    if speed is not None:
        motion_txt = f"Hız: ~{int(speed)} km/sa, yön: {int(heading)}°"
        if eta:
            motion_txt += f", tahmini varış: ~{int(eta)} dk"
        if towards:
            motion_txt += " (konuma doğru)"

    summary = (
        f"Şiddet: {intensity} ({max_dbz} dBZ), "
        f"merkez uzaklığı: {centroid_dist if centroid_dist is not None else '—'} km, "
        f"{curr.get('count', 0)} yağış pikseli"
    )
    print(f"[RADAR] {summary} | pixel_gate={pixel_count}/{MIN_ALERT_PIXELS} ({pixel_threshold_met}) | alert={alert} | {motion_txt}")
    append_check_log(
        "ok",
        frame_path=path,
        frame_ts=ts,
        max_dbz=max_dbz,
        intensity=intensity,
        centroid_dist_km=centroid_dist,
        echo_pixels=curr.get("count", 0),
        strong_echo_pixels=curr.get("strong_count", 0),
        approaching=bool(approaching),
        on_site=bool(on_site),
        alert=bool(alert),
        speed_kmh=speed,
        heading_deg=heading,
        eta_min=eta,
        pixel_threshold=MIN_ALERT_PIXELS,
        pixel_threshold_met=bool(pixel_threshold_met),
    )

    if alert:
        alert_state = load_alert_state()
        now_ts = datetime.now(timezone.utc).timestamp()
        last_alert_ts = float(alert_state.get("last_alert_ts", 0) or 0)
        seconds_since_alert = now_ts - last_alert_ts

        if seconds_since_alert >= ALERT_COOLDOWN_SECONDS:
            location_status = "Konuma ulaşıyor / üzerinde." if on_site else "Yaklaşıyor."
            msg = (
                f"{intensity_emoji} <b>{intensity} YAĞIŞ UYARISI — İstanbul</b>\\n"
                f"Konum: 41.0904 N, 28.9438 E\\n"
                f"{summary}\\n"
                f"{motion_txt}\\n"
                f"{location_status}\\n"
                f"https://www.google.com/maps?q=41.0904,28.9438"
            )
            if send_telegram(msg):
                alert_state["last_alert_ts"] = now_ts
                alert_state["last_alert_utc"] = datetime.now(timezone.utc).isoformat()
                alert_state["last_intensity"] = intensity
                save_alert_state(alert_state)
                print(f"[RADAR] {intensity} ALERT SENT; 60-minute cooldown started")
            else:
                print("[RADAR] Alert not sent; cooldown state unchanged")
        else:
            remaining = int(ALERT_COOLDOWN_SECONDS - seconds_since_alert)
            print(f"[RADAR] Telegram suppressed by 60-minute cooldown; {remaining}s remaining")

    state["history"] = history
    state["last"] = curr
    state["last_ts"] = ts
    state["checked_at"] = datetime.now(timezone.utc).isoformat()
    save_state(state)
    print("[RADAR] Done.")

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            append_check_log("error", error_type=type(exc).__name__, error=str(exc)[:500])
        except Exception as log_exc:
            print(f"[RADAR] Could not persist error log: {log_exc}")
        raise
