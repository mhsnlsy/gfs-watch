import math

ISTANBUL_LAT = 41.014
ISTANBUL_LON = 28.950
RADIUS_KM = 1250.0
LOW_HPA = 1013.0
HIGH_HPA = 1023.0

def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2-lat1)
    dlon = math.radians(lon2-lon1)
    a = math.sin(dlat/2)**2 + math.cos(p1)*math.cos(p2)*math.sin(dlon/2)**2
    return 2*r*math.asin(min(1.0, math.sqrt(a)))

def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2-lon1)
    y = math.sin(dl)*math.cos(p2)
    x = math.cos(p1)*math.sin(p2)-math.sin(p1)*math.cos(p2)*math.cos(dl)
    return (math.degrees(math.atan2(y, x))+360)%360

def direction(deg):
    names = ['K','KKD','KD','DKD','D','DGD','GD','GGB','G','GBG','BGB','B','BKB','KB','KKB','K']
    return names[int((deg+11.25)//22.5)%16]

def detect_centers(values, lats, lons, radius_km=RADIUS_KM, low_hpa=LOW_HPA, high_hpa=HIGH_HPA, neighborhood=2, min_separation_km=150):
    import numpy as np
    v = np.asarray(values, dtype=float)
    la = np.asarray(lats, dtype=float)
    lo = np.asarray(lons, dtype=float)
    if v.shape != (len(la), len(lo)):
        raise ValueError(f'grid shape {v.shape} != ({len(la)},{len(lo)})')
    candidates=[]
    n=neighborhood
    for iy in range(n, len(la)-n):
        for ix in range(n, len(lo)-n):
            lat=float(la[iy]); lon=float(lo[ix]); p=float(v[iy,ix])
            if not math.isfinite(p): continue
            d=haversine_km(ISTANBUL_LAT, ISTANBUL_LON, lat, lon)
            if d>radius_km: continue
            win=v[iy-n:iy+n+1, ix-n:ix+n+1]
            if p <= low_hpa and p == np.nanmin(win):
                candidates.append({'type':'low','pressure_hpa':round(p,1),'latitude':round(lat,3),'longitude':round(lon,3),'distance_km':round(d,1)})
            if p >= high_hpa and p == np.nanmax(win):
                candidates.append({'type':'high','pressure_hpa':round(p,1),'latitude':round(lat,3),'longitude':round(lon,3),'distance_km':round(d,1)})
    candidates.sort(key=lambda c: c['pressure_hpa'] if c['type']=='low' else -c['pressure_hpa'])
    kept=[]
    for c in candidates:
        if any(c['type']==k['type'] and haversine_km(c['latitude'],c['longitude'],k['latitude'],k['longitude'])<min_separation_km for k in kept):
            continue
        b=bearing_deg(ISTANBUL_LAT, ISTANBUL_LON, c['latitude'], c['longitude'])
        c['bearing_deg']=round(b,0); c['direction']=direction(b)
        kept.append(c)
    return kept