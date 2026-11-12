#!/usr/bin/env python3
import json
import math
import os
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from analyze_grib2 import analyze_file

BASE = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
LEFT_LON, RIGHT_LON = 12, 48
BOTTOM_LAT, TOP_LAT = 29, 53
FORECAST_HOURS = list(range(0, 121, 6))


def candidate_cycles(now):
    cycle_hour = (now.hour // 6) * 6
    base = now.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)
    return [base - timedelta(hours=6 * i) for i in range(5)]


def build_url(cycle, forecast_hour):
    day = cycle.strftime("%Y%m%d")
    hh = cycle.strftime("%H")
    params = {
        "file": f"gfs.t{hh}z.pgrb2.0p25.f{forecast_hour:03d}",
        "var_PRMSL": "on",
        "lev_mean_sea_level": "on",
        "subregion": "",
        "leftlon": LEFT_LON,
        "rightlon": RIGHT_LON,
        "toplat": TOP_LAT,
        "bottomlat": BOTTOM_LAT,
        "dir": f"/gfs.{day}/{hh}/atmos",
    }
    return BASE + "?" + urllib.parse.urlencode(params)


def download(url, path):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "istanbulunhavasi-gfs-pressure-centers/2.0",
            "Accept": "application/octet-stream",
        },
    )
    with urllib.request.urlopen(request, timeout=180) as response, open(path, "wb") as out:
        total = 0
        first = response.read(16)
        if not first.startswith(b"GRIB"):
            raise RuntimeError("NOMADS did not return GRIB2 data")
        out.write(first)
        total = len(first)
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            total += len(chunk)
    if total < 1024:
        raise RuntimeError(f"GRIB2 response too small: {total} bytes")
    return total


def analyze_cycle(cycle):
    steps = []
    total_bytes = 0
    for forecast_hour in FORECAST_HOURS:
        url = build_url(cycle, forecast_hour)
        with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
            path = tmp.name
        try:
            size = download(url, path)
            result = analyze_file(path)
            valid_time = cycle + timedelta(hours=forecast_hour)
            steps.append({
                "forecast_hour": forecast_hour,
                "valid_time_utc": valid_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "centers": result["analysis"]["centers"],
                "download_bytes": size,
            })
            total_bytes += size
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass

    first = steps[0]
    tracks = build_tracks(steps)
    return {
        "status": "ok",
        "source": "NOAA GFS 0.25° GRIB2 · NOMADS",
        "analysis": {
            "center_latitude": 41.014,
            "center_longitude": 28.950,
            "diameter_km": 2500,
            "radius_km": 1250,
            "thresholds": {"low_hpa": 1013, "high_hpa": 1023},
            "centers": first["centers"],
        },
        "forecast_steps": steps,
        "cycle_utc": cycle.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "forecast_hour": 0,
        "forecast_max_hour": 120,
        "forecast_interval_hours": 6,
        "tracks": tracks,
        "checkpoint_hours": [0, 12, 24, 48, 72, 96, 120],
        "download_bytes": total_bytes,
        "download_url": build_url(cycle, 0),
    }


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def direction(deg):
    names = ["K", "KKD", "KD", "DKD", "D", "DGD", "GD", "GGD", "G", "GGB", "GB", "BGB", "B", "BKB", "KB", "KKB"]
    return names[round(deg / 22.5) % 16]


def build_tracks(steps):
    tracks = []
    next_id = 1
    for step in steps:
        candidates = list(step.get("centers", []))
        used = set()
        for track in tracks:
            if not track["points"]:
                continue
            last = track["points"][-1]
            same = [
                (haversine_km(last["latitude"], last["longitude"], c["latitude"], c["longitude"]), idx, c)
                for idx, c in enumerate(candidates)
                if idx not in used and c.get("type") == track["type"]
            ]
            if same:
                distance, idx, c = min(same, key=lambda x: x[0])
                if distance <= 700:
                    used.add(idx)
                    track["points"].append({
                        "forecast_hour": step["forecast_hour"],
                        "valid_time_utc": step["valid_time_utc"],
                        "pressure_hpa": c["pressure_hpa"],
                        "latitude": c["latitude"],
                        "longitude": c["longitude"],
                    })
        for idx, c in enumerate(candidates):
            if idx in used:
                continue
            tracks.append({
                "id": f"{c.get('type', 'center')}-{next_id}",
                "type": c.get("type"),
                "points": [{
                    "forecast_hour": step["forecast_hour"],
                    "valid_time_utc": step["valid_time_utc"],
                    "pressure_hpa": c["pressure_hpa"],
                    "latitude": c["latitude"],
                    "longitude": c["longitude"],
                }],
            })
            next_id += 1
    enriched = []
    for track in tracks:
        points = track["points"]
        if len(points) < 2:
            continue

        # Lifecycle is a property of each valid time, not of the whole track.
        # For a low: falling pressure = strengthening, rising pressure = weakening.
        # For a high: rising pressure = strengthening, falling pressure = weakening.
        # "olgunlaşıyor" marks the local pressure minimum/maximum where the
        # tendency changes sign. A 1 hPa / 6 h threshold avoids reacting to
        # insignificant model noise.
        tendency_threshold_hpa = 1.0
        for i, point in enumerate(points):
            current = float(point["pressure_hpa"])
            previous = float(points[i - 1]["pressure_hpa"]) if i > 0 else None
            following = float(points[i + 1]["pressure_hpa"]) if i + 1 < len(points) else None
            prev_delta = current - previous if previous is not None else None
            next_delta = following - current if following is not None else None

            if track["type"] == "low":
                if prev_delta is not None and next_delta is not None and prev_delta <= -tendency_threshold_hpa and next_delta >= tendency_threshold_hpa:
                    lifecycle = "olgunlaşıyor"
                elif next_delta is not None and next_delta <= -tendency_threshold_hpa:
                    lifecycle = "güçleniyor"
                elif prev_delta is not None and prev_delta >= tendency_threshold_hpa and (next_delta is None or next_delta >= 0):
                    lifecycle = "zayıflıyor"
                elif prev_delta is not None and prev_delta <= -tendency_threshold_hpa and (next_delta is None or next_delta <= 0):
                    lifecycle = "güçleniyor"
                elif next_delta is not None and next_delta >= tendency_threshold_hpa:
                    lifecycle = "zayıflıyor"
                else:
                    lifecycle = "aktif"
            else:
                if prev_delta is not None and next_delta is not None and prev_delta >= tendency_threshold_hpa and next_delta <= -tendency_threshold_hpa:
                    lifecycle = "olgunlaşıyor"
                elif next_delta is not None and next_delta >= tendency_threshold_hpa:
                    lifecycle = "güçleniyor"
                elif prev_delta is not None and prev_delta <= -tendency_threshold_hpa and (next_delta is None or next_delta <= 0):
                    lifecycle = "zayıflıyor"
                elif prev_delta is not None and prev_delta >= tendency_threshold_hpa and (next_delta is None or next_delta >= 0):
                    lifecycle = "güçleniyor"
                elif next_delta is not None and next_delta <= -tendency_threshold_hpa:
                    lifecycle = "zayıflıyor"
                else:
                    lifecycle = "aktif"

            point["lifecycle"] = lifecycle
        a, b = points[0], points[-1]
        move = haversine_km(a["latitude"], a["longitude"], b["latitude"], b["longitude"])
        bearing = bearing_deg(a["latitude"], a["longitude"], b["latitude"], b["longitude"])
        pressures = [float(p["pressure_hpa"]) for p in points]
        min_index = min(range(len(points)), key=lambda i: float(points[i]["pressure_hpa"])) if track["type"] == "low" else max(range(len(points)), key=lambda i: float(points[i]["pressure_hpa"]))
        min_point = points[min_index]
        start_pressure = float(a["pressure_hpa"])
        end_pressure = float(b["pressure_hpa"])
        peak_pressure = float(min_point["pressure_hpa"])
        if track["type"] == "low":
            if min_index == 0:
                lifecycle = "zayıflıyor" if end_pressure >= start_pressure + 2 else "aktif"
            elif min_index == len(points) - 1 and peak_pressure <= start_pressure - 2:
                lifecycle = "derinleşiyor"
            elif min_index > 0 and min_index < len(points) - 1:
                before = float(points[min_index - 1]["pressure_hpa"])
                after = float(points[min_index + 1]["pressure_hpa"])
                lifecycle = "olgunlaşıyor" if after > peak_pressure + 1 and before > peak_pressure + 1 else "aktif"
            else:
                lifecycle = "aktif"
        else:
            if min_index == 0:
                lifecycle = "zayıflıyor" if end_pressure <= start_pressure - 2 else "aktif"
            elif min_index == len(points) - 1 and peak_pressure >= start_pressure + 2:
                lifecycle = "güçleniyor"
            elif min_index > 0 and min_index < len(points) - 1:
                before = float(points[min_index - 1]["pressure_hpa"])
                after = float(points[min_index + 1]["pressure_hpa"])
                lifecycle = "olgunlaşıyor" if after < peak_pressure - 1 and before < peak_pressure - 1 else "aktif"
            else:
                lifecycle = "aktif"
        track.update({
            "movement_km": round(move, 1),
            "movement_bearing_deg": round(bearing, 0),
            "movement_direction": direction(bearing),
            "pressure_change_hpa": round(end_pressure - start_pressure, 1),
            "min_pressure_hpa": round(min(pressures), 1),
            "max_pressure_hpa": round(max(pressures), 1),
            "lifecycle": lifecycle,
            "peak_forecast_hour": int(min_point["forecast_hour"]),
        })
        enriched.append(track)
    return enriched


def main():
    errors = []
    state_path = Path(__file__).resolve().parents[2] / "site" / "data" / "gfs-pressure-centers.json"
    current_cycle = candidate_cycles(datetime.now(timezone.utc))[0]
    if state_path.exists():
        try:
            existing = json.loads(state_path.read_text(encoding="utf-8"))
            if existing.get("status") == "ok" and existing.get("cycle_utc") == current_cycle.strftime("%Y-%m-%dT%H:%M:%SZ") and len(existing.get("forecast_steps", [])) == len(FORECAST_HOURS):
                print(json.dumps(existing, ensure_ascii=False, indent=2))
                return
        except Exception:
            pass
    for cycle in candidate_cycles(datetime.now(timezone.utc)):
        try:
            result = analyze_cycle(cycle)
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return
        except Exception as exc:
            errors.append(f"{cycle:%Y-%m-%d %H}Z: {exc}")

    raise RuntimeError(
        "No recent complete GFS 0-120h GRIB2 cycle succeeded: " + " | ".join(errors)
    )


if __name__ == "__main__":
    main()
