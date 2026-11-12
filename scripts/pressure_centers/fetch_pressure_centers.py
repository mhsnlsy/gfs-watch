#!/usr/bin/env python3
import json
import os
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

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
        "download_bytes": total_bytes,
        "download_url": build_url(cycle, 0),
    }


def main():
    errors = []
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
