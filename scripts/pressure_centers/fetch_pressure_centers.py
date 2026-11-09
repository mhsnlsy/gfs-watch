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

def candidate_cycles(now):
    cycle_hour = (now.hour // 6) * 6
    base = now.replace(hour=cycle_hour, minute=0, second=0, microsecond=0)
    return [base - timedelta(hours=6 * i) for i in range(5)]

def build_url(cycle):
    day = cycle.strftime("%Y%m%d")
    hh = cycle.strftime("%H")
    params = {
        "file": f"gfs.t{hh}z.pgrb2.0p25.f000",
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
            "User-Agent": "istanbulunhavasi-gfs-pressure-centers/1.0",
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

def main():
    errors = []
    for cycle in candidate_cycles(datetime.now(timezone.utc)):
        url = build_url(cycle)
        try:
            with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as tmp:
                path = tmp.name
            try:
                size = download(url, path)
                result = analyze_file(path)
                result["source"] = "NOAA GFS 0.25° GRIB2 · NOMADS"
                result["cycle_utc"] = cycle.strftime("%Y-%m-%dT%H:%M:%SZ")
                result["forecast_hour"] = 0
                result["download_bytes"] = size
                result["download_url"] = url
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return
            finally:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        except Exception as exc:
            errors.append(f"{cycle:%Y-%m-%d %H}Z: {exc}")

    raise RuntimeError("No recent GFS GRIB2 cycle succeeded: " + " | ".join(errors))

if __name__ == "__main__":
    main()
