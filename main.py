# v9.5.0 - Istanbul Timezone Fix (UTC+3), 180h Forecast & 1.2x Speech
import os
import json
import sqlite3
import asyncio
import math
import tempfile
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo  # Türkiye saati için yerleşik kütüphane
import requests
import numpy as np
import eccodes
from google.cloud import texttospeech
from google.oauth2 import service_account
from telegram import Bot

# --- KONFİGÜRASYON ---
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")
GCP_SA_KEY = os.getenv("GCP_SA_KEY")

LAT = 41.014
LON = 28.950
GRID_LAT = round(LAT * 4.0) / 4.0
GRID_LON = round(LON * 4.0) / 4.0
LOCATION_NAME = f"İstanbul ({LAT:.3f}, {LON:.3f})"
TR_TZ = ZoneInfo("Europe/Istanbul")  # İstanbul saat dilimi
POLL_INTERVAL_SECONDS = max(60, int(os.getenv("POLL_INTERVAL_SECONDS", "600")))
DATA_DIR = "/data" if os.path.isdir("/data") else "."
DB_PATH = os.getenv("DB_PATH", os.path.join(DATA_DIR, "gfs_watch.db"))
MODEL_NAME = "ncep_gfs_global"
# Detect completed +180 GFS cycles directly from NOAA's public S3 inventory.
# A successful HEAD confirms the exact global GRIB2 f180 object is published,
# without downloading the hundreds-of-megabytes global file.
NOAA_GFS_S3_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
NOAA_CYCLE_LOOKBACK = 6
MIN_FORECAST_HOURS = 180
RETENTION_DAYS = 10
PUBLIC_DATA_DIR = os.getenv("PUBLIC_DATA_DIR", "public")
REGIONAL_PRESSURE_DIAMETER_KM = 2500.0
REGIONAL_PRESSURE_RADIUS_KM = REGIONAL_PRESSURE_DIAMETER_KM / 2.0
HIGH_PRESSURE_THRESHOLD_HPA = 1023.0
LOW_PRESSURE_THRESHOLD_HPA = 1015.0
TEMPERATURE_CHANGE_THRESHOLD_C = 2.0
PRECIPITATION_CHANGE_THRESHOLD_MM = 1.0
WIND_CHANGE_THRESHOLD_KMH = 10.0

TR_WEEKDAYS = (
    "Pazartesi", "Salı", "Çarşamba", "Perşembe",
    "Cuma", "Cumartesi", "Pazar",
)
TR_MONTHS = (
    "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
    "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
)


def _format_tr_date(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value).date()
    elif isinstance(value, datetime):
        value = value.date()
    return f"{TR_WEEKDAYS[value.weekday()]} {value.day} {TR_MONTHS[value.month - 1]}"


def _format_tr_datetime(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=TR_TZ)
    value = value.astimezone(TR_TZ)
    return (
        f"{_format_tr_date(value)} {value.year} "
        f"{value.hour:02d}:{value.minute:02d}"
    )

# --- VERİTABANI İŞLEMLERİ ---
def init_db():
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS gfs_runs_v3 (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                run_name TEXT,
                forecast_json TEXT
            )
        """)
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_gfs_runs_v3_timestamp
            ON gfs_runs_v3(timestamp)
        """)
        cursor.execute(
            "DELETE FROM gfs_runs_v3 WHERE timestamp < datetime('now', ?)",
            (f"-{RETENTION_DAYS} days",),
        )
        deleted = cursor.rowcount
        conn.commit()
        if deleted:
            print(f"[DB] {deleted} eski kayıt silindi; saklama süresi {RETENTION_DAYS} gün.")
    finally:
        conn.close()


def prune_old_runs():
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM gfs_runs_v3 WHERE timestamp < datetime('now', ?)",
            (f"-{RETENTION_DAYS} days",),
        )
        deleted = cursor.rowcount
        conn.commit()
        if deleted:
            print(f"[DB] {deleted} eski kayıt silindi; saklama süresi {RETENTION_DAYS} gün.")
        return deleted
    finally:
        conn.close()


def get_previous_runs():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        SELECT run_name, forecast_json 
        FROM gfs_runs_v3 ORDER BY id DESC LIMIT 2
    """)
    rows = cursor.fetchall()
    conn.close()
    return rows

def get_processed_run_ids():
    """Return all retained run IDs so older unprocessed cycles are not repeated."""
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT run_name FROM gfs_runs_v3")
        return {row[0] for row in cursor.fetchall()}
    finally:
        conn.close()

def save_run(run_name, forecast_dict):
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        serialized = json.dumps(forecast_dict)
        # Refresh an existing run in place without creating duplicates.
        cursor.execute("""
            UPDATE gfs_runs_v3
            SET timestamp = CURRENT_TIMESTAMP, forecast_json = ?
            WHERE run_name = ?
        """, (serialized, run_name))
        if cursor.rowcount == 0:
            cursor.execute("""
                INSERT INTO gfs_runs_v3 (run_name, forecast_json)
                VALUES (?, ?)
            """, (run_name, serialized))
        conn.commit()
    finally:
        conn.close()

def _write_json_atomically(path, document):
    """Write UTF-8 JSON atomically so readers never see a partial file."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            suffix=".tmp",
            prefix=".forecast-",
            dir=directory,
            delete=False,
        ) as temp_file:
            temp_path = temp_file.name
            json.dump(document, temp_file, ensure_ascii=False, indent=2, allow_nan=False)
            temp_file.write("\n")
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


def export_public_forecast_json(run_id, payload):
    """Export a stable latest.json plus an immutable file for this GFS run."""
    run_dt = _parse_utc_datetime(run_id)
    current = payload.get("current", {})
    daily = payload.get("daily", {})
    forecast = []

    for local_time, values in sorted(payload.get("timeline_180h", {}).items()):
        local_dt = datetime.strptime(local_time, "%Y-%m-%dT%H:%M").replace(tzinfo=TR_TZ)
        forecast.append({
            "forecast_hour": int(values.get("step_hour", 0)),
            "valid_time_utc": local_dt.astimezone(timezone.utc).isoformat(timespec="minutes"),
            "valid_time_istanbul": local_dt.isoformat(timespec="minutes"),
            "temperature_2m_c": values.get("temp"),
            "wind_speed_10m_kmh": values.get("wind"),
            "precipitation_6h_mm": values.get("precip"),
        })

    dates = daily.get("time", [])
    daily_summary = []
    for index, date_value in enumerate(dates):
        daily_summary.append({
            "date_istanbul": date_value,
            "temperature_min_c": daily.get("temp_min", [])[index],
            "temperature_max_c": daily.get("temp_max", [])[index],
            "precipitation_total_mm": daily.get("precip_sum", [])[index],
            "wind_speed_max_10m_kmh": daily.get("wind_max", [])[index],
        })

    model_metadata = payload.get("model_metadata", {})
    document = {
        "schema": "gfs-watch.forecast.v1",
        "model": MODEL_NAME,
        "run_id_utc": run_dt.isoformat(timespec="seconds"),
        "forecast_valid_until_utc": (
            run_dt + timedelta(hours=MIN_FORECAST_HOURS)
        ).isoformat(timespec="seconds"),
        "published_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "forecast_horizon_hours": MIN_FORECAST_HOURS,
        "location": {
            "name": "Istanbul",
            "latitude": LAT,
            "longitude": LON,
            "nearest_gfs_grid_latitude": GRID_LAT,
            "nearest_gfs_grid_longitude": GRID_LON,
        },
        "sources": {
            "forecast": payload.get("data_source", "NOAA/NCEP GFS 0.25° GRIB2"),
            "current_conditions": "Open-Meteo live current-conditions snapshot",
        },
        "noaa_source_file": {
            "f180_available": model_metadata.get("noaa_f180_available", True),
            "f180_last_modified_utc": model_metadata.get("last_modified_time"),
            "global_grib2_size_bytes": model_metadata.get("source_object_size_bytes"),
        },
        "current_conditions": {
            "temperature_2m_c": current.get("temp"),
            "precipitation_mm": current.get("precip"),
            "wind_speed_10m_kmh": current.get("wind"),
            "surface_pressure_hpa": current.get("pressure"),
        },
        "daily_summary": daily_summary,
        "regional_pressure_analysis": {
            "valid_time_utc": run_dt.isoformat(timespec="seconds"),
            "diameter_km": REGIONAL_PRESSURE_DIAMETER_KM,
            "findings": payload.get("synoptic_alerts", []),
        },
        "forecast_6_hourly": forecast,
    }

    run_filename = run_dt.strftime("%Y%m%dT%HZ") + ".json"
    _write_json_atomically(
        os.path.join(PUBLIC_DATA_DIR, "runs", run_filename), document
    )
    _write_json_atomically(os.path.join(PUBLIC_DATA_DIR, "latest.json"), document)
    print(
        f"[JSON EXPORT] public/latest.json ve public/runs/{run_filename} "
        f"yazıldı ({len(forecast)} tahmin noktası)."
    )


# --- NOAA GFS +180 DOSYA VARLIĞI ---
def _normalise_model_timestamp(value):
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)) or str(value).isdigit():
            parsed = datetime.fromtimestamp(float(value), tz=timezone.utc)
        else:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat(timespec="seconds")
    except (TypeError, ValueError, OverflowError):
        return str(value)


def _parse_utc_datetime(value):
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def fetch_regional_pressure_anomalies(session, filter_url, run_dt, headers, last_request_at):
    """Find the highest and lowest MSLP values inside a 2,500 km diameter circle."""
    elapsed = time.monotonic() - last_request_at
    if elapsed < 10.0:
        time.sleep(10.0 - elapsed)

    date_token = run_dt.strftime("%Y%m%d")
    cycle = run_dt.strftime("%H")
    filename = f"gfs.t{cycle}z.pgrb2.0p25.f000"
    lat_delta = REGIONAL_PRESSURE_RADIUS_KM / 111.32
    lon_delta = REGIONAL_PRESSURE_RADIUS_KM / (
        111.32 * math.cos(math.radians(LAT))
    )
    params = {
        "file": filename,
        "var_PRMSL": "on",
        "lev_mean_sea_level": "on",
        "subregion": "",
        "leftlon": f"{LON - lon_delta:.2f}",
        "rightlon": f"{LON + lon_delta:.2f}",
        "toplat": f"{LAT + lat_delta:.2f}",
        "bottomlat": f"{LAT - lat_delta:.2f}",
        "dir": f"/gfs.{date_token}/{cycle}/atmos",
    }

    try:
        response = session.get(
            filter_url, params=params, headers=headers, timeout=120
        )
        response.raise_for_status()
        grib_bytes = response.content
        if not grib_bytes.startswith(b"GRIB"):
            raise ValueError("Bölgesel basınç isteği GRIB2 yerine başka yanıt döndürdü.")

        pressure_values = None
        pressure_latitudes = None
        pressure_longitudes = None
        with tempfile.NamedTemporaryFile(suffix=".grib2") as temp_file:
            temp_file.write(grib_bytes)
            temp_file.flush()
            with open(temp_file.name, "rb") as grib_file:
                while True:
                    gid = eccodes.codes_grib_new_from_file(grib_file)
                    if gid is None:
                        break
                    try:
                        short_name = str(eccodes.codes_get(gid, "shortName"))
                        level_type = str(eccodes.codes_get(gid, "typeOfLevel"))
                        if short_name != "prmsl" or level_type != "meanSea":
                            continue
                        pressure_values = np.asarray(
                            eccodes.codes_get_values(gid), dtype=float
                        )
                        pressure_latitudes = np.asarray(
                            eccodes.codes_get_array(gid, "latitudes"), dtype=float
                        )
                        pressure_longitudes = np.asarray(
                            eccodes.codes_get_array(gid, "longitudes"), dtype=float
                        )
                        break
                    finally:
                        eccodes.codes_release(gid)

        if pressure_values is None:
            raise ValueError("GRIB2 içinde deniz seviyesi basınç alanı bulunamadı.")

        if not (
            len(pressure_values)
            == len(pressure_latitudes)
            == len(pressure_longitudes)
        ):
            raise ValueError("Basınç GRIB2 koordinat ve değer dizileri uyuşmuyor.")

        # Great-circle distance from the requested Istanbul coordinate.
        lat1 = math.radians(LAT)
        lat2 = np.radians(pressure_latitudes)
        delta_lat = lat2 - lat1
        delta_lon = np.radians(
            ((pressure_longitudes - LON + 180.0) % 360.0) - 180.0
        )
        haversine = (
            np.sin(delta_lat / 2.0) ** 2
            + math.cos(lat1) * np.cos(lat2) * np.sin(delta_lon / 2.0) ** 2
        )
        distance_km = 6371.0 * 2.0 * np.arcsin(
            np.sqrt(np.clip(haversine, 0.0, 1.0))
        )
        inside = (
            (distance_km <= REGIONAL_PRESSURE_RADIUS_KM)
            & np.isfinite(pressure_values)
        )
        if not np.any(inside):
            raise ValueError("2.500 km çaplı dairenin içinde geçerli basınç noktası bulunamadı.")

        regional_hpa = pressure_values[inside] / 100.0
        regional_lats = pressure_latitudes[inside]
        regional_lons = pressure_longitudes[inside]
        max_index = int(np.argmax(regional_hpa))
        min_index = int(np.argmin(regional_hpa))

        def coordinate_label(index):
            latitude = float(regional_lats[index])
            longitude = float(regional_lons[index])
            lat_hemi = "N" if latitude >= 0 else "S"
            lon_hemi = "E" if longitude >= 0 else "W"
            return (
                f"{abs(latitude):.1f}°{lat_hemi}, "
                f"{abs(longitude):.1f}°{lon_hemi}"
            )

        maximum = float(regional_hpa[max_index])
        minimum = float(regional_hpa[min_index])
        findings = []
        if maximum >= HIGH_PRESSURE_THRESHOLD_HPA:
            findings.append(
                f"Yüksek basınç merkezi: {maximum:.1f} hPa "
                f"({coordinate_label(max_index)})"
            )
        if minimum <= LOW_PRESSURE_THRESHOLD_HPA:
            findings.append(
                f"Alçak basınç merkezi: {minimum:.1f} hPa "
                f"({coordinate_label(min_index)})"
            )
        if not findings:
            findings.append(
                "Belirgin yüksek veya alçak basınç merkezi saptanmadı "
                f"(alan içindeki basınç aralığı {minimum:.1f}–{maximum:.1f} hPa)."
            )

        print(
            f"[BASINÇ] 2.500 km çaplı dairede {int(np.count_nonzero(inside))} "
            f"grid noktası incelendi; min {minimum:.1f}, max {maximum:.1f} hPa."
        )
        return findings
    except Exception as exc:
        print(f"[BASINÇ UYARI] Bölgesel basınç analizi yapılamadı: {exc}")
        return ["Bölgesel basınç verisi alınamadı; bu döngü için analiz yapılamadı."]


def fetch_noaa_available_runs():
    """Find recent GFS cycles by checking NOAA's public f180 GRIB2 S3 objects."""
    now = datetime.now(timezone.utc)
    latest_cycle_hour = (now.hour // 6) * 6
    latest_cycle = now.replace(
        hour=latest_cycle_hour, minute=0, second=0, microsecond=0
    )
    candidates = []
    errors = []
    session = requests.Session()
    session.headers.update({"User-Agent": "GFS-Watch/1.0"})

    for offset in range(NOAA_CYCLE_LOOKBACK):
        run_dt = latest_cycle - timedelta(hours=6 * offset)
        date_token = run_dt.strftime("%Y%m%d")
        cycle = run_dt.strftime("%H")
        filename = f"gfs.t{cycle}z.pgrb2.0p25.f{MIN_FORECAST_HOURS:03d}"
        object_url = (
            f"{NOAA_GFS_S3_BASE}/gfs.{date_token}/{cycle}/atmos/{filename}"
        )
        run_id = run_dt.isoformat(timespec="seconds")

        try:
            response = session.head(
                object_url,
                headers={"Cache-Control": "no-cache"},
                timeout=15,
                allow_redirects=True,
            )
            if response.status_code == 200:
                content_length = int(response.headers.get("Content-Length", "0") or 0)
                if content_length <= 0:
                    print(
                        f"[NOAA S3 UYARI] {run_id} f180 başlığı boş içerik uzunluğu döndürdü."
                    )
                    continue

                modified_at = _normalise_model_timestamp(
                    response.headers.get("Last-Modified")
                )
                candidates.append({
                    "model": MODEL_NAME,
                    "metadata_source": "NOAA/NCEP public S3 f180 GRIB2 object",
                    "run_id": run_id,
                    "last_run_initialisation_time": run_id,
                    "last_run_availability_time": modified_at,
                    "last_modified_time": modified_at,
                    "last_valid_time": (
                        run_dt + timedelta(hours=MIN_FORECAST_HOURS)
                    ).isoformat(timespec="minutes"),
                    "forecast_horizon_hours": MIN_FORECAST_HOURS,
                    "completed": True,
                    "noaa_f180_available": True,
                    "source_object_size_bytes": content_length,
                })
                print(
                    f"[NOAA READY] {run_id} +180 GRIB2 dosyası yayımlanmış; "
                    f"S3 nesne boyutu {content_length:,} byte."
                )
            elif response.status_code in (403, 404, 405):
                print(
                    f"[NOAA PENDING] {run_id} +180 GRIB2 dosyası henüz S3'te yok "
                    f"(HTTP {response.status_code})."
                )
            else:
                errors.append(
                    f"{run_id}: NOAA S3 HTTP {response.status_code}"
                )
        except requests.RequestException as exc:
            errors.append(f"{run_id}: {type(exc).__name__}: {exc}")

    if not candidates:
        suffix = " | ".join(errors) if errors else "Henüz yayımlanmış +180 dosyası yok."
        print("[NOAA S3 PENDING] " + suffix)
        return []

    return sorted(candidates, key=lambda item: item["run_id"])


# --- VERİ ÇEKME (+180 SAAT / FAST-FETCH) ---
def _parse_forecast_local_time(value):
    """Convert an API time string in Europe/Istanbul to an aware UTC datetime."""
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TR_TZ)
    return parsed.astimezone(timezone.utc)


def fetch_full_weather_data(run_id):
    """Fetch an exact GFS cycle directly from NOAA/NCEP NOMADS GRIB2 files."""
    print(f"[STEP 1] NOAA/NCEP GRIB2 verisi çekiliyor: {run_id}")
    try:
        run_dt = _parse_utc_datetime(run_id)
        date_token = run_dt.strftime("%Y%m%d")
        cycle = run_dt.strftime("%H")
        filter_url = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
        # Only retrieve the model grid cell nearest to the requested coordinate.
        # For 41.014N, 28.950E this is the GFS 0.25-degree node at 41.000N, 29.000E.
        points = {"Istanbul": (LAT, LON)}
        session = requests.Session()
        headers = {"User-Agent": "GFS-Watch/1.0"}

        # Probe the target horizon first. Metadata can report +180 while a
        # particular GRIB forecast file is still being published.
        lead_hours = list(range(0, MIN_FORECAST_HOURS + 1, 6))
        download_order = [MIN_FORECAST_HOURS] + [
            h for h in lead_hours if h != MIN_FORECAST_HOURS
        ]
        decoded_steps = {}
        last_request_at = 0.0

        for position, lead in enumerate(download_order):
            if position:
                elapsed = time.monotonic() - last_request_at
                if elapsed < 10.0:
                    time.sleep(10.0 - elapsed)

            filename = f"gfs.t{cycle}z.pgrb2.0p25.f{lead:03d}"
            params = {
                "file": filename,
                "var_TMP": "on",
                "lev_2_m_above_ground": "on",
                "var_APCP": "on",
                "lev_surface": "on",
                "var_UGRD": "on",
                "var_VGRD": "on",
                "lev_10_m_above_ground": "on",
                "subregion": "",
                "leftlon": f"{GRID_LON - 0.1:.2f}",
                "rightlon": f"{GRID_LON + 0.1:.2f}",
                "toplat": f"{GRID_LAT + 0.1:.2f}",
                "bottomlat": f"{GRID_LAT - 0.1:.2f}",
                "dir": f"/gfs.{date_token}/{cycle}/atmos",
            }

            print(f"[NOAA] {filename} indiriliyor ({position + 1}/{len(download_order)})...")
            try:
                response = session.get(
                    filter_url, params=params, headers=headers, timeout=75
                )
                last_request_at = time.monotonic()
            except requests.RequestException as exc:
                print(f"[PENDING] NOAA NOMADS bağlantı hatası f{lead:03d}: {exc}")
                return {
                    "_pending_noaa_gfs": True,
                    "_run_id": run_id,
                    "_forecast_hour": lead,
                    "_reason": str(exc),
                }

            if response.status_code in (404, 408, 425, 429, 500, 502, 503, 504):
                print(
                    f"[PENDING] NOAA GRIB dosyası f{lead:03d} henüz hazır değil "
                    f"(HTTP {response.status_code}); sonraki kontrolde tekrar denenecek."
                )
                return {
                    "_pending_noaa_gfs": True,
                    "_run_id": run_id,
                    "_forecast_hour": lead,
                    "_http_status": response.status_code,
                }
            response.raise_for_status()
            grib_bytes = response.content
            if not grib_bytes.startswith(b"GRIB"):
                preview = grib_bytes[:250].decode("utf-8", errors="replace")
                print(f"[NOAA HATA] f{lead:03d} GRIB2 yerine yanıt döndü: {preview}")
                return {
                    "_pending_noaa_gfs": True,
                    "_run_id": run_id,
                    "_forecast_hour": lead,
                    "_reason": "NOAA filter response is not GRIB2",
                }

            step_data = {
                "temperature": None,
                "wind_u": None,
                "wind_v": None,
                "precip_records": {},
            }

            # ecCodes reads GRIB messages from a file object. The filtered
            # area is small (typically tens of KB, not the 500+ MB global file).
            with tempfile.NamedTemporaryFile(suffix=".grib2") as temp_file:
                temp_file.write(grib_bytes)
                temp_file.flush()
                with open(temp_file.name, "rb") as grib_file:
                    while True:
                        gid = eccodes.codes_grib_new_from_file(grib_file)
                        if gid is None:
                            break
                        try:
                            short_name = str(eccodes.codes_get(gid, "shortName"))
                            try:
                                level_type = str(eccodes.codes_get(gid, "typeOfLevel"))
                                level = int(eccodes.codes_get(gid, "level"))
                                start_step = int(eccodes.codes_get(gid, "startStep"))
                                end_step = int(eccodes.codes_get(gid, "endStep"))
                            except Exception:
                                continue

                            is_target = (
                                (short_name == "2t" and level_type == "heightAboveGround" and level == 2)
                                or (short_name in ("10u", "10v") and level_type == "heightAboveGround" and level == 10)
                                or (short_name == "tp" and level_type == "surface")
                            )
                            if not is_target:
                                continue

                            values = eccodes.codes_get_values(gid)
                            latitudes = eccodes.codes_get_array(gid, "latitudes")
                            longitudes = eccodes.codes_get_array(gid, "longitudes")
                            if len(values) != len(latitudes) or len(values) != len(longitudes):
                                raise ValueError(f"GRIB grid mismatch in {filename}")

                            samples = {}
                            for point_name, (point_lat, point_lon) in points.items():
                                distances = (
                                    (latitudes - point_lat) ** 2
                                    + (((longitudes - point_lon + 180.0) % 360.0) - 180.0) ** 2
                                )
                                nearest_index = int(distances.argmin())
                                samples[point_name] = float(values[nearest_index])

                            if short_name == "2t":
                                step_data["temperature"] = samples
                            elif short_name == "10u":
                                step_data["wind_u"] = samples
                            elif short_name == "10v":
                                step_data["wind_v"] = samples
                            elif short_name == "tp":
                                # GFS may include both the 6-hour period total
                                # and the full-run cumulative total in one file.
                                # Key by interval to deduplicate repeated messages.
                                step_data["precip_records"][(start_step, end_step)] = samples
                        finally:
                            eccodes.codes_release(gid)

            if not step_data["temperature"]:
                print(f"[PENDING] NOAA f{lead:03d} içinde 2 m sıcaklık alanı bulunamadı.")
                return {
                    "_pending_noaa_gfs": True,
                    "_run_id": run_id,
                    "_forecast_hour": lead,
                    "_reason": "missing 2m temperature field",
                }
            decoded_steps[lead] = step_data
            print(
                f"[NOAA BAŞARILI] f{lead:03d}: "
                f"{len(step_data['precip_records'])} yağış alanı, "
                f"{len(grib_bytes)} byte GRIB2 çözüldü."
            )

        # Construct the canonical timeline in Istanbul local time so a 06Z run
        # and the previous 00Z run share identical valid-time comparison keys.
        forecast_timeline = {}
        daily_buckets = {}
        previous_cumulative_precip = {name: None for name in points}

        for lead in lead_hours:
            step_data = decoded_steps[lead]
            valid_utc = run_dt + timedelta(hours=lead)
            valid_local = valid_utc.astimezone(TR_TZ)
            time_key = valid_local.strftime("%Y-%m-%dT%H:%M")

            temperature = step_data["temperature"]
            wind_u = step_data["wind_u"] or {}
            wind_v = step_data["wind_v"] or {}
            # Pressure is not part of the requested point forecast payload.

            temp_c = {
                name: float(value) - 273.15
                for name, value in temperature.items()
            }
            wind_kmh = {}
            for name in points:
                u_value = wind_u.get(name)
                v_value = wind_v.get(name)
                if u_value is not None and v_value is not None:
                    wind_kmh[name] = math.hypot(float(u_value), float(v_value)) * 3.6

            # Select only the precipitation interval ending at this lead.
            # Prefer (lead-6, lead); if unavailable, difference cumulative
            # (0, lead) totals against the prior cumulative total.
            precip_by_point = {name: 0.0 for name in points}
            if lead > 0:
                records = step_data["precip_records"]
                interval_key = (lead - 6, lead)
                if interval_key in records:
                    precip_by_point = {
                        name: max(0.0, float(records[interval_key].get(name, 0.0)))
                        for name in points
                    }
                elif (0, lead) in records:
                    cumulative = records[(0, lead)]
                    for name in points:
                        current_total = float(cumulative.get(name, 0.0))
                        previous_total = previous_cumulative_precip[name]
                        if previous_total is None:
                            precip_by_point[name] = 0.0
                        else:
                            precip_by_point[name] = max(0.0, current_total - previous_total)
                else:
                    print(
                        f"[NOAA UYARI] f{lead:03d} için 6 saatlik yağış aralığı "
                        "bulunamadı; bu dilim 0 mm olarak alınacak."
                    )

            cumulative_key = (0, lead)
            if cumulative_key in step_data["precip_records"]:
                for name in points:
                    previous_cumulative_precip[name] = float(
                        step_data["precip_records"][cumulative_key].get(name, 0.0)
                    )

            istanbul_temp = round(temp_c["Istanbul"], 1)
            istanbul_precip = round(precip_by_point["Istanbul"], 2)
            istanbul_wind = round(wind_kmh.get("Istanbul", 0.0), 1)
            forecast_timeline[time_key] = {
                "step_hour": lead,
                "temp": istanbul_temp,
                "wind": istanbul_wind,
                # A 06Z/12Z/18Z run has no precipitation interval before its
                # own initialization; do not compare that lead-0 placeholder.
                "precip": None if lead == 0 else istanbul_precip,
            }

            day_key = valid_local.date().isoformat()
            bucket = daily_buckets.setdefault(
                day_key, {"temps": [], "precips": [], "winds": []}
            )
            bucket["temps"].append(istanbul_temp)
            if lead > 0:
                bucket["precips"].append(istanbul_precip)
            bucket["winds"].append(istanbul_wind)

        daily_dates = sorted(daily_buckets)
        daily = {
            "time": daily_dates,
            "temp_max": [
                round(max(daily_buckets[day]["temps"]), 1)
                for day in daily_dates
            ],
            "temp_min": [
                round(min(daily_buckets[day]["temps"]), 1)
                for day in daily_dates
            ],
            "precip_sum": [
                round(sum(daily_buckets[day]["precips"]), 1)
                for day in daily_dates
            ],
            "wind_max": [
                round(max(daily_buckets[day]["winds"]), 1)
                for day in daily_dates
            ],
        }

        # Current conditions remain a live observation/nowcast; the entire
        # forecast and all comparisons are sourced from this exact NOAA run.
        current = {}
        live_url = "https://api.open-meteo.com/v1/forecast"
        live_params = {
            "latitude": LAT,
            "longitude": LON,
            "current": "temperature_2m,precipitation,rain,snowfall,wind_speed_10m,surface_pressure",
            "models": "gfs_seamless",
            "timezone": "Europe/Istanbul",
        }
        try:
            live_res = requests.get(live_url, params=live_params, timeout=15)
            live_res.raise_for_status()
            live_current = live_res.json().get("current", {})
            current = {
                "temp": round(live_current.get("temperature_2m", 0.0), 1),
                "precip": round(live_current.get("precipitation", 0.0), 2),
                "wind": round(live_current.get("wind_speed_10m", 0.0), 1),
                "pressure": round(live_current.get("surface_pressure", 1013.0), 1),
            }
        except Exception as exc:
            print(f"[CURRENT UYARI] Canlı koşullar alınamadı; NOAA run başlangıcı kullanılacak: {exc}")
            current = {
                "temp": round(temp_c["Istanbul"], 1),
                "precip": 0.0,
                "wind": round(wind_kmh.get("Istanbul", 0.0), 1),
                "pressure": 1013.0,
            }

        # Regional pressure analysis is intentionally separate from the
        # point forecast: one MSLP GRIB2 subset, valid at model initialisation,
        # covering a 2,500 km diameter circle centred on the requested point.
        synoptic_alerts = fetch_regional_pressure_anomalies(
            session, filter_url, run_dt, headers, last_request_at
        )

        payload = {
            "current": current,
            "daily": daily,
            "timeline_180h": forecast_timeline,
            "forecast_horizon_hours": MIN_FORECAST_HOURS,
            "synoptic_alerts": synoptic_alerts,
            "data_source": (
                "NOAA/NCEP GFS 0.25° GRIB2 (NOMADS); "
                f"hedef {LAT:.3f}N, {LON:.3f}E; en yakın grid {GRID_LAT:.3f}N, {GRID_LON:.3f}E"
            ),
        }

        print(
            f"[STEP 1 BAŞARILI] NOAA/NCEP {run_id} GFS çalışması alındı; "
            f"+{MIN_FORECAST_HOURS} saat; {len(forecast_timeline)} zaman noktası."
        )
        return payload
    except Exception as exc:
        print(f"[STEP 1 HATA] NOAA/NCEP GRIB2 veri erişimi/çözümleme hatası: {exc}")
        return None


# --- RAPOR VE SES METNİ OLUŞTURUCU ---
def analyze_and_build_output(current_run_name, payload, previous_runs):
    print("[STEP 2] Rapor ve ses metni oluşturuluyor...")
    curr = payload["current"]
    daily = payload["daily"]
    timeline = payload["timeline_180h"]
    synoptic = payload.get("synoptic_alerts", [])

    curr_t = curr["temp"]
    curr_p = curr["precip"]
    curr_w = curr["wind"]

    # The voice script receives weekday/date names for each daily summary.
    # Other voice-format changes are intentionally left for a later pass.
    speech_parts = [f"İstanbul'da anlık sıcaklık {curr_t} derece."]
    speech_parts.append(
        f"Yağış {curr_p} milimetre." if curr_p > 0 else "Yağış beklenmiyor."
    )
    if curr_w > 20.0:
        speech_parts.append("Hava rüzgarlı.")

    speech_parts.append("Önümüzdeki üç günün özeti:")
    daily_indices = range(1, min(4, len(daily.get("time", []))))
    for i in daily_indices:
        day_label = _format_tr_date(daily["time"][i])
        t_max = round(daily["temp_max"][i], 1)
        t_min = round(daily["temp_min"][i], 1)
        p_sum = round(daily["precip_sum"][i], 1)
        w_max = round(daily["wind_max"][i], 1)

        day_text = f"{day_label}: En düşük {t_min}, en yüksek {t_max} derece."
        day_text += (
            f" Toplam yağış {p_sum} milimetre."
            if p_sum > 0 else " Yağış beklenmiyor."
        )
        if w_max > 20.0:
            day_text += " Rüzgâr hızı yüksek."
        speech_parts.append(day_text)

    temp_shifts = []
    precip_shifts = []
    comparison_events = []
    comparison_points = 0

    if previous_runs:
        try:
            prev_json = json.loads(previous_runs[0][1])
            prev_timeline = prev_json.get("timeline_180h", {})

            # Iterate by valid local time, then add all variable changes for
            # that timestamp together. The final list is chronological.
            for time_key in sorted(timeline):
                if time_key not in prev_timeline:
                    continue
                comparison_points += 1
                curr_data = timeline[time_key]
                prev_data = prev_timeline[time_key]
                valid_local = datetime.strptime(
                    time_key, "%Y-%m-%dT%H:%M"
                ).replace(tzinfo=TR_TZ)
                time_label = (
                    f"{_format_tr_date(valid_local)} "
                    f"{valid_local.hour:02d}:{valid_local.minute:02d}"
                )
                changes_at_time = []

                t_diff = round(
                    float(curr_data["temp"]) - float(prev_data["temp"]), 1
                )
                if abs(t_diff) >= TEMPERATURE_CHANGE_THRESHOLD_C:
                    direction = "daha yüksek" if t_diff > 0 else "daha düşük"
                    changes_at_time.append(
                        f"Sıcaklık {abs(t_diff):.1f}°C {direction}"
                    )
                    legacy_direction = "artış" if t_diff > 0 else "düşüş"
                    temp_shifts.append(
                        f"+{curr_data['step_hour']}. saatte "
                        f"{abs(t_diff):.1f} derece {legacy_direction}"
                    )

                current_precip = curr_data.get("precip")
                previous_precip = prev_data.get("precip")
                if current_precip is not None and previous_precip is not None:
                    p_diff = round(
                        float(current_precip) - float(previous_precip), 2
                    )
                    if abs(p_diff) >= PRECIPITATION_CHANGE_THRESHOLD_MM:
                        direction = "daha fazla" if p_diff > 0 else "daha az"
                        changes_at_time.append(
                            f"bu saatte biten 6 saatlik yağış "
                            f"{abs(p_diff):.2f} mm {direction}"
                        )
                        legacy_direction = "artış" if p_diff > 0 else "azalma"
                        precip_shifts.append(
                            f"+{curr_data['step_hour']}. saatte "
                            f"{abs(p_diff):.2f} milimetre {legacy_direction}"
                        )

                current_wind = curr_data.get("wind")
                previous_wind = prev_data.get("wind")
                if current_wind is not None and previous_wind is not None:
                    w_diff = round(
                        float(current_wind) - float(previous_wind), 1
                    )
                    if abs(w_diff) >= WIND_CHANGE_THRESHOLD_KMH:
                        direction = "daha hızlı" if w_diff > 0 else "daha yavaş"
                        changes_at_time.append(
                            f"10 m rüzgâr hızı {abs(w_diff):.1f} km/sa {direction}"
                        )

                if changes_at_time:
                    comparison_events.append(
                        f"• {time_label} TSİ — " + "; ".join(changes_at_time) + "."
                    )
        except Exception as exc:
            print(f"[UYARI] Kıyaslama yapılırken hata oluştu: {exc}")

    # Keep the existing comparison narration structure for now. The requested
    # detailed day/time voice redesign can be handled separately later.
    if temp_shifts or precip_shifts:
        speech_parts.append(
            "Önceki GFS çalışmasıyla kıyaslandığında ilerleyen saatlerde değişimler var."
        )
        if temp_shifts:
            speech_parts.append("Sıcaklıkta: " + ", ".join(temp_shifts[:2]) + ".")
        if precip_shifts:
            speech_parts.append("Yağışta: " + ", ".join(precip_shifts[:2]) + ".")
    elif previous_runs and comparison_points:
        speech_parts.append(
            "Önceki GFS çalışmasıyla kıyaslama yapıldı; belirlenen eşiklerin üzerinde "
            "sıcaklık veya yağış değişikliği yok."
        )
    elif previous_runs:
        speech_parts.append(
            "Önceki GFS çalışmasıyla ortak zaman dilimi bulunamadı; kıyaslama yapılamadı."
        )

    # Pressure findings are written to the text report only, never to speech.
    speech_text = " ".join(speech_parts)

    now_local = datetime.now(TR_TZ)
    run_utc = _parse_utc_datetime(current_run_name)
    run_local = run_utc.astimezone(TR_TZ)
    forecast_end_local = (
        run_utc + timedelta(hours=payload.get("forecast_horizon_hours", MIN_FORECAST_HOURS))
    ).astimezone(TR_TZ)

    text_report_lines = [
        "🌦 İSTANBUL GFS TAHMİN RAPORU",
        "📄 Çıktı: Yazılı tahmin raporu",
        f"🛰 Model döngüsü: {_format_tr_datetime(run_local)} TSİ ({run_utc:%H}Z UTC)",
        (
            f"🗓 Tahmin aralığı: {_format_tr_datetime(run_local)} – "
            f"{_format_tr_datetime(forecast_end_local)} TSİ "
            f"(+{payload.get('forecast_horizon_hours', MIN_FORECAST_HOURS)} saat)"
        ),
        f"🕒 Rapor zamanı: {_format_tr_datetime(now_local)} TSİ",
        f"📍 Koordinat: {LAT:.3f}°N, {LON:.3f}°E",
        "",
        f"🌡 Anlık sıcaklık: {curr_t}°C",
        f"🌧 Anlık yağış: {curr_p} mm",
        f"💨 Anlık rüzgâr: {curr_w} km/sa",
        "",
        "📅 ÖNÜMÜZDEKİ 3 GÜN",
    ]

    for i in daily_indices:
        day_label = _format_tr_date(daily["time"][i])
        t_max = round(daily["temp_max"][i], 1)
        t_min = round(daily["temp_min"][i], 1)
        p_sum = round(daily["precip_sum"][i], 1)
        w_max = round(daily["wind_max"][i], 1)
        wind_tag = " | Rüzgârlı" if w_max > 20.0 else ""
        text_report_lines.append(
            f"• {day_label}: {t_min}–{t_max}°C | Yağış: {p_sum} mm | "
            f"Maks. rüzgâr: {w_max} km/sa{wind_tag}"
        )

    if previous_runs:
        previous_run_utc = _parse_utc_datetime(previous_runs[0][0])
        previous_run_local = previous_run_utc.astimezone(TR_TZ)
        text_report_lines.extend([
            "",
            "🔁 ÖNCEKİ GFS DÖNGÜSÜYLE KIYAS",
            (
                f"Önceki döngü: {_format_tr_datetime(previous_run_local)} TSİ "
                f"({previous_run_utc:%H}Z UTC)"
            ),
            f"Ortak karşılaştırma zamanı: {comparison_points}",
        ])
        if comparison_events:
            text_report_lines.append("Değişiklikler (TSİ, kronolojik sırayla):")
            text_report_lines.extend(comparison_events)
        elif comparison_points:
            text_report_lines.append(
                "Belirlenen eşikleri aşan sıcaklık, yağış veya rüzgâr değişikliği yok."
            )
        else:
            text_report_lines.append(
                "İki döngü arasında karşılaştırılabilir ortak zaman bulunamadı."
            )

    if synoptic:
        text_report_lines.extend([
            "",
            "🌀 BASINÇ DURUMU | İstanbul merkezli 2.500 km çaplı alan",
            (
                f"Geçerlilik zamanı: {_format_tr_datetime(run_local)} TSİ "
                "(model başlangıç saati)"
            ),
        ])
        for syn_item in synoptic:
            text_report_lines.append(f"• {syn_item}")

    text_report_lines.append(f"\n🎙 Seslendirme metni:\n“{speech_text}”")
    full_text_report = "\n".join(text_report_lines)

    print("[STEP 2 BAŞARILI] Rapor ve ses metni hazırlandı.")
    return full_text_report, speech_text


# --- GOOGLE CLOUD TTS MOTORU (1.2X HIZ) ---
def generate_speech_gcp(text, output_file="summary.mp3"):
    """Synchronous TTS function; the caller runs it in a background thread."""
    print("[TTS] Google Cloud TTS ile 1.2x hızında ses dosyası üretiliyor...")
    if not GCP_SA_KEY:
        print("[TTS ATLANDI] GCP_SA_KEY bulunamadı; metin bildirimi yine gönderilecek.")
        return None
    try:
        key_dict = json.loads(GCP_SA_KEY)
        credentials = service_account.Credentials.from_service_account_info(key_dict)
        client = texttospeech.TextToSpeechClient(credentials=credentials)
        synthesis_input = texttospeech.SynthesisInput(text=text)
        voice = texttospeech.VoiceSelectionParams(
            language_code="tr-TR",
            name="tr-TR-Wavenet-C",
            ssml_gender=texttospeech.SsmlVoiceGender.MALE,
        )
        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=1.2,
        )
        response = client.synthesize_speech(
            input=synthesis_input, voice=voice, audio_config=audio_config
        )
        with open(output_file, "wb") as output:
            output.write(response.audio_content)
        print("[TTS BAŞARILI] Ses dosyası hazırlandı.")
        return output_file
    except Exception as e:
        print(f"[TTS HATA] Google Cloud TTS: {e}")
        return None


async def generate_speech_with_retry(text, max_attempts=3):
    """Generate audio in a worker thread, retrying transient TTS failures."""
    if not GCP_SA_KEY:
        print("[TTS ATLANDI] GCP_SA_KEY yok; metin bildirimi tek başına gönderilecek.")
        return None

    for attempt in range(1, max_attempts + 1):
        audio_file = await asyncio.to_thread(generate_speech_gcp, text)
        if audio_file:
            return audio_file
        if attempt < max_attempts:
            delay = 5 * attempt
            print(f"[TTS RETRY] {attempt}/{max_attempts}; {delay} saniye sonra tekrar.")
            await asyncio.sleep(delay)

    print("[TTS BAŞARISIZ] Ses üretilemedi; metin bildirimi gönderilmiş durumda.")
    return None

# --- TELEGRAM GÖNDERİCİ ---
async def send_telegram_text(text):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        raise RuntimeError("TELEGRAM_TOKEN veya CHAT_ID eksik.")
    async with Bot(token=TELEGRAM_TOKEN) as bot:
        await bot.send_message(chat_id=CHAT_ID, text=text)
    print("[TELEGRAM] Metin bildirimi gönderildi.")


async def send_telegram_voice(audio_path, max_attempts=3):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        raise RuntimeError("TELEGRAM_TOKEN veya CHAT_ID eksik.")
    if not audio_path or not os.path.exists(audio_path):
        return

    try:
        for attempt in range(1, max_attempts + 1):
            try:
                async with Bot(token=TELEGRAM_TOKEN) as bot:
                    with open(audio_path, "rb") as voice:
                        await bot.send_voice(chat_id=CHAT_ID, voice=voice)
                print("[TELEGRAM] Ses bildirimi gönderildi.")
                return
            except Exception as e:
                if attempt >= max_attempts:
                    raise
                delay = 5 * attempt
                print(
                    f"[VOICE RETRY] Gönderim denemesi {attempt}/{max_attempts} "
                    f"başarısız: {e}. {delay} saniye sonra tekrar."
                )
                await asyncio.sleep(delay)
    finally:
        if os.path.exists(audio_path):
            os.remove(audio_path)

# --- ANA ÇALIŞTIRICI ---
async def process_gfs_update(strict=False):
    await asyncio.to_thread(prune_old_runs)
    candidates = await asyncio.to_thread(fetch_noaa_available_runs)
    if not candidates:
        message = "NOAA S3 üzerinde henüz +180 GFS GRIB2 dosyası yayımlanmadı."
        print(f"[SKIP] {message}")
        if strict:
            raise RuntimeError(message)
        return

    previous_runs = get_previous_runs()
    processed_run_ids = await asyncio.to_thread(get_processed_run_ids)
    latest_processed_run = max(processed_run_ids) if processed_run_ids else None
    pending_runs = [
        item for item in candidates
        if item["run_id"] not in processed_run_ids
        and (
            latest_processed_run is None
            or item["run_id"] > latest_processed_run
        )
    ]

    if not pending_runs:
        # Backfill the public JSON once for runs processed before JSON publishing
        # was enabled. Do not rewrite it on every poll after both files exist.
        if previous_runs:
            latest_saved_run, latest_saved_json = previous_runs[0]
            latest_saved_dt = _parse_utc_datetime(latest_saved_run)
            archive_path = os.path.join(
                PUBLIC_DATA_DIR,
                "runs",
                latest_saved_dt.strftime("%Y%m%dT%HZ") + ".json",
            )
            latest_path = os.path.join(PUBLIC_DATA_DIR, "latest.json")
            expected_run_id = latest_saved_dt.isoformat(timespec="seconds")
            files_match_run = False
            try:
                with open(archive_path, "r", encoding="utf-8") as archive_file:
                    archive_document = json.load(archive_file)
                with open(latest_path, "r", encoding="utf-8") as latest_file:
                    latest_document = json.load(latest_file)
                files_match_run = (
                    archive_document.get("run_id_utc") == expected_run_id
                    and latest_document.get("run_id_utc") == expected_run_id
                )
            except (OSError, ValueError, TypeError):
                files_match_run = False

            if not files_match_run:
                try:
                    export_public_forecast_json(
                        latest_saved_run, json.loads(latest_saved_json)
                    )
                except Exception as exc:
                    print(f"[JSON BACKFILL HATA] Son kayıt dışa aktarılamadı: {exc}")
                    if strict:
                        raise

        latest_run = candidates[-1]["run_id"]
        print(f"[UNCHANGED] Son GFS çalışmaları zaten işlendi; en güncel run: {latest_run}")
        return

    eligible_runs = [
        item for item in pending_runs
        if int(item.get("forecast_horizon_hours", 0)) >= MIN_FORECAST_HOURS
    ]
    if not eligible_runs:
        newest_pending = pending_runs[-1]
        available_hours = int(newest_pending.get("forecast_horizon_hours", 0))
        print(
            f"[PENDING] GFS run {newest_pending['run_id']} şu an +{available_hours} saat; "
            f"bildirim için +{MIN_FORECAST_HOURS} saat gerekiyor. "
            "Tamamlanmış ve daha eski başka bir bekleyen run da bulunamadı."
        )
        return

    # Process the oldest eligible unprocessed run first. This ensures that
    # if two cycles become eligible between checks, comparisons remain
    # chronological and no run is skipped.
    metadata = eligible_runs[0]
    run_id = metadata["run_id"]
    available_hours = int(metadata["forecast_horizon_hours"])
    print(
        f"[MODEL] GFS run {run_id}; yayınlanan tahmin: +{available_hours} saat; "
        f"hedef: +{MIN_FORECAST_HOURS} saat."
    )

    # The S3 f180 object itself is the trigger. Its successful HEAD response
    # confirms the global +180 GRIB2 object has been published; fetch the
    # compact single-point NOMADS subset immediately and retry missing files
    # on the next scheduled check.
    print(
        f"[NOAA TRIGGER] {run_id} +180 dosyası NOAA S3'te hazır; "
        "tek koordinatlı NOMADS GRIB2 parçaları alınıyor."
    )

    print(f"[UPDATE] +180 saat eşiğine ulaşan GFS run alınıyor: {run_id}")
    payload = await asyncio.to_thread(fetch_full_weather_data, run_id)
    if payload and "_pending_noaa_gfs" in payload:
        print(
            f"[PENDING] {run_id} NOAA GRIB2 dosyası henüz tam olarak hazır değil; "
            f"sonraki kontrolde tekrar denenecek. Ayrıntı: {payload.get('_reason', 'dosya eksik')}"
        )
        return
    if not payload:
        message = f"{run_id} için NOAA/NCEP GRIB2 tahmini alınamadı."
        print(f"[RETRY] {message}")
        if strict:
            raise RuntimeError(message)
        return

    payload["model_metadata"] = metadata
    export_public_forecast_json(run_id, payload)
    full_text_report, speech_text = analyze_and_build_output(
        run_id, payload, previous_runs
    )
    audio_task = asyncio.create_task(generate_speech_with_retry(speech_text))
    try:
        await send_telegram_text(full_text_report)
    except Exception:
        try:
            audio_file = await audio_task
            if audio_file and os.path.exists(audio_file):
                os.remove(audio_file)
        except Exception:
            pass
        raise

    save_run(run_id, payload)
    audio_file = await audio_task
    if audio_file:
        try:
            await send_telegram_voice(audio_file)
        except Exception as e:
            print(f"[VOICE HATA] Ses gönderilemedi: {e}")
    else:
        print("[VOICE] Ses üretilemedi; metin bildirimi gönderilmiş durumda.")
    print(f"[COMPLETE] GFS run işlendi ve +180 saat bildirimi gönderildi: {run_id}")


async def run_manual_report(run_id):
    """Send one selected GFS run without changing processed-run history."""
    init_db()
    run_dt = _parse_utc_datetime(run_id)
    normalized_run_id = run_dt.isoformat(timespec="seconds")
    print(
        f"[MANUAL] {normalized_run_id} için tek seferlik rapor hazırlanıyor; "
        "GFS geçmişi güncellenmeyecek."
    )

    stored_runs = await asyncio.to_thread(get_previous_runs)
    earlier_runs = [
        row for row in stored_runs
        if _parse_utc_datetime(row[0]) < run_dt
    ]
    previous_runs = sorted(earlier_runs, key=lambda row: row[0], reverse=True)[:1]

    payload = await asyncio.to_thread(
        fetch_full_weather_data, normalized_run_id
    )
    if payload and "_pending_noaa_gfs" in payload:
        raise RuntimeError(
            f"{normalized_run_id} için NOAA verisi henüz alınamadı: "
            f"{payload.get('_reason', payload.get('_http_status', 'eksik GRIB2'))}"
        )
    if not payload:
        raise RuntimeError(
            f"{normalized_run_id} için NOAA/NCEP GRIB2 tahmini oluşturulamadı."
        )

    # This is a manual resend of an already processed model cycle. It does not
    # export JSON, save another DB row, or change the run's notification state.
    payload["model_metadata"] = {
        "manual_resend": True,
        "run_id": normalized_run_id,
    }
    full_text_report, speech_text = analyze_and_build_output(
        normalized_run_id, payload, previous_runs
    )

    audio_task = asyncio.create_task(generate_speech_with_retry(speech_text))
    try:
        await send_telegram_text(full_text_report)
    except Exception:
        try:
            audio_file = await audio_task
            if audio_file and os.path.exists(audio_file):
                os.remove(audio_file)
        except Exception:
            pass
        raise

    audio_file = await audio_task
    if audio_file:
        try:
            await send_telegram_voice(audio_file)
        except Exception as exc:
            print(f"[MANUAL VOICE HATA] Ses gönderilemedi: {exc}")
            raise
    else:
        print("[MANUAL VOICE] Ses üretilemedi; metin raporu gönderildi.")

    print(
        f"[MANUAL COMPLETE] {normalized_run_id} metin raporu gönderildi; "
        "işlenmiş GFS geçmişi değiştirilmedi."
    )


async def main():
    """Disable the legacy in-process polling mode."""
    print(
        "[STOP] Eski sürekli çalışma modu devre dışı. "
        "GFS Watch yalnızca GFS_WATCH_ONCE=1 ile tek-seferlik "
        "GitHub Actions kontrolü olarak çalıştırılır."
    )


async def run_once():
    """Run one GFS check and exit; used by scheduled GitHub Actions."""
    init_db()
    print(f"[START] GFS Watch tek kontrol modunda çalışıyor; model: {MODEL_NAME}.")
    await process_gfs_update(strict=True)


if __name__ == "__main__":
    try:
        manual_run_id = os.getenv("GFS_WATCH_MANUAL_RUN_ID", "").strip()
        if manual_run_id:
            asyncio.run(run_manual_report(manual_run_id))
        elif os.getenv("GFS_WATCH_ONCE", "").strip().lower() in {"1", "true", "yes"}:
            asyncio.run(run_once())
        else:
            asyncio.run(main())
    except KeyboardInterrupt:
        print("[STOP] GFS Watch kontrollü şekilde durduruldu.")
