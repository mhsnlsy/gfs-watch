import json
import sys
from pathlib import Path

import numpy as np
from eccodes import (
    codes_grib_new_from_file,
    codes_get,
    codes_get_array,
    codes_release,
)

from detector import detect_centers

def read_mslp(path):
    with open(path, "rb") as handle:
        while True:
            gid = codes_grib_new_from_file(handle)
            if gid is None:
                break
            try:
                short_name = str(codes_get(gid, "shortName"))
                name = str(codes_get(gid, "name"))
                if short_name not in ("prmsl", "mslet") and "mean sea level pressure" not in name.lower():
                    continue

                values = np.asarray(codes_get_array(gid, "values"), dtype=float)
                ni = int(codes_get(gid, "Ni"))
                nj = int(codes_get(gid, "Nj"))

                latitudes = np.asarray(codes_get_array(gid, "latitudes"), dtype=float).reshape(nj, ni)
                longitudes = np.asarray(codes_get_array(gid, "longitudes"), dtype=float).reshape(nj, ni)
                values = (values.reshape(nj, ni) / 100.0)

                lats = latitudes[:, 0]
                lons = longitudes[0, :]

                if lats[0] > lats[-1]:
                    pass
                else:
                    values = values[::-1, :]
                    lats = lats[::-1]

                return values, lats, lons, {
                    "shortName": short_name,
                    "name": name,
                    "Ni": ni,
                    "Nj": nj,
                    "lat_min": round(float(np.nanmin(lats)), 3),
                    "lat_max": round(float(np.nanmax(lats)), 3),
                    "lon_min": round(float(np.nanmin(lons)), 3),
                    "lon_max": round(float(np.nanmax(lons)), 3),
                }
            finally:
                codes_release(gid)

    raise RuntimeError("MSLP/prmsl field not found in GRIB2")

def analyze_file(path):
    values, lats, lons, grid = read_mslp(path)
    centers = detect_centers(values, lats, lons)
    return {
        "status": "ok",
        "source": "NOAA GFS 0.25° GRIB2",
        "analysis": {
            "center_latitude": 41.014,
            "center_longitude": 28.950,
            "diameter_km": 2500,
            "radius_km": 1250,
            "thresholds": {"low_hpa": 1013, "high_hpa": 1023},
            "centers": centers,
        },
        "grid": grid,
    }

if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python analyze_grib2.py FILE")
    print(json.dumps(analyze_file(Path(sys.argv[1])), ensure_ascii=False, indent=2))
