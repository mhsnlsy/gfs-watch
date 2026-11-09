import math

ISTANBUL_LAT = 41.014
ISTANBUL_LON = 28.950
RADIUS_KM = 1250.0
LOW_HPA = 1013.0
HIGH_HPA = 1023.0

def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))

def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlon = math.radians(lon2 - lon1)
    y = math.sin(dlon) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360

def direction(deg):
    names = ["K","KKD","KD","DKD","D","DGD","GD","GGB","G","GBG","BGB","B","BKB","KB","KKB","K"]
    return names[int((deg + 11.25) // 22.5) % 16]

def detect_centers(values, lats, lons, neighborhood=2, min_separation_km=300, prominence_hpa=1.5, max_centers_per_type=6):
    import numpy as np
    v = np.asarray(values, dtype=float)
    la = np.asarray(lats, dtype=float)
    lo = np.asarray(lons, dtype=float)
    if v.shape != (len(la), len(lo)):
        raise ValueError(f"grid shape {v.shape} != ({len(la)},{len(lo)})")

    candidates = []
    n = neighborhood
    for iy in range(n, len(la) - n):
        for ix in range(n, len(lo) - n):
            p = float(v[iy, ix])
            if not math.isfinite(p):
                continue
            lat = float(la[iy])
            lon = float(lo[ix])
            distance = haversine_km(ISTANBUL_LAT, ISTANBUL_LON, lat, lon)
            if distance > RADIUS_KM:
                continue

            window = v[iy-n:iy+n+1, ix-n:ix+n+1]
            ring = window.copy()
            ring[n, n] = np.nan
            ring_mean = float(np.nanmean(ring))
            if p <= LOW_HPA and (ring_mean - p) >= prominence_hpa and p <= float(np.nanmin(window)):
                candidates.append({
                    "type": "low",
                    "pressure_hpa": round(p, 1),
                    "latitude": round(lat, 3),
                    "longitude": round(lon, 3),
                    "distance_km": round(distance, 1),
                })
            if p >= HIGH_HPA and p >= float(np.nanmax(window)) and (p - ring_mean) >= prominence_hpa:
                candidates.append({
                    "type": "high",
                    "pressure_hpa": round(p, 1),
                    "latitude": round(lat, 3),
                    "longitude": round(lon, 3),
                    "distance_km": round(distance, 1),
                })

    candidates.sort(key=lambda c: c["pressure_hpa"] if c["type"] == "low" else -c["pressure_hpa"])
    kept = []
    for center in candidates:
        if any(
            center["type"] == other["type"]
            and haversine_km(
                center["latitude"], center["longitude"],
                other["latitude"], other["longitude"]
            ) < min_separation_km
            for other in kept
        ):
            continue
        bearing = bearing_deg(
            ISTANBUL_LAT, ISTANBUL_LON,
            center["latitude"], center["longitude"]
        )
        center["bearing_deg"] = round(bearing)
        center["direction"] = direction(bearing)
        kept.append(center)
    kept = [c for c in kept if c["type"] in ("low", "high")]
    lows = [c for c in kept if c["type"] == "low"][:max_centers_per_type]
    highs = [c for c in kept if c["type"] == "high"][:max_centers_per_type]
    return lows + highs
