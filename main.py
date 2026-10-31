# v9.5.0 - Istanbul Timezone Fix (UTC+3), 180h Forecast & 1.2x Speech
import os
import json
import sqlite3
import asyncio
import io
import math
import tempfile
import time
import shutil
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo  # Türkiye saati için yerleşik kütüphane
import requests
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import Rectangle
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
NOAA_NOMADS_FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
NOAA_CYCLE_LOOKBACK = 6
MIN_FORECAST_HOURS = 180
RETENTION_DAYS = 10
PUBLIC_DATA_DIR = os.getenv("PUBLIC_DATA_DIR", "public")
NOAA_CACHE_DIR = os.getenv("NOAA_CACHE_DIR", "noaa_cache")
NOAA_REQUEST_INTERVAL_SECONDS = max(
    1.0, float(os.getenv("NOAA_REQUEST_INTERVAL_SECONDS", "10"))
)
NOAA_PREFETCH_FILES_PER_CHECK = max(
    1, int(os.getenv("NOAA_PREFETCH_FILES_PER_CHECK", "4"))
)
NOAA_PREFETCH_MIN_AGE_HOURS = max(
    0.0, float(os.getenv("NOAA_PREFETCH_MIN_AGE_HOURS", "2"))
)
NOAA_CACHE_RETENTION_HOURS = max(
    12.0, float(os.getenv("NOAA_CACHE_RETENTION_HOURS", "48"))
)
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

def get_run_payload(run_id):
    """Read one exact stored forecast without modifying the SQLite history."""
    target = _parse_utc_datetime(run_id)
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT run_name, forecast_json FROM gfs_runs_v3"
        ).fetchall()
        for stored_run_id, forecast_json in rows:
            if _parse_utc_datetime(stored_run_id) == target:
                return stored_run_id, json.loads(forecast_json)
        return None
    finally:
        conn.close()


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


def _noaa_run_cache_dir(run_id):
    run_dt = _parse_utc_datetime(run_id)
    return os.path.join(
        NOAA_CACHE_DIR, run_dt.strftime("%Y%m%dT%HZ")
    )


def _noaa_cache_file(run_id, lead):
    return os.path.join(
        _noaa_run_cache_dir(run_id), f"f{int(lead):03d}.grib2"
    )


def _mark_noaa_cache_updated():
    """Expose cache changes to the GitHub Actions cache-save step."""
    output_path = os.getenv("GITHUB_OUTPUT")
    if output_path:
        try:
            with open(output_path, "a", encoding="utf-8") as output_file:
                output_file.write("noaa_cache_updated=true\\n")
        except OSError as exc:
            print(f"[NOAA CACHE UYARI] GitHub output yazılamadı: {exc}")


def _read_noaa_cache_file(run_id, lead):
    cache_path = _noaa_cache_file(run_id, lead)
    try:
        with open(cache_path, "rb") as cache_file:
            grib_bytes = cache_file.read()
    except FileNotFoundError:
        return None
    except OSError as exc:
        print(f"[NOAA CACHE UYARI] {cache_path} okunamadı: {exc}")
        return None

    if not grib_bytes.startswith(b"GRIB"):
        print(f"[NOAA CACHE INVALID] {cache_path} geçerli GRIB2 değil; siliniyor.")
        try:
            os.remove(cache_path)
            _mark_noaa_cache_updated()
        except OSError:
            pass
        return None
    return grib_bytes


def _write_noaa_cache_file(run_id, lead, grib_bytes):
    cache_path = _noaa_cache_file(run_id, lead)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    temporary_path = cache_path + f".{os.getpid()}.tmp"
    with open(temporary_path, "wb") as cache_file:
        cache_file.write(grib_bytes)
        cache_file.flush()
        os.fsync(cache_file.fileno())
    os.replace(temporary_path, cache_path)
    _mark_noaa_cache_updated()


def _noaa_filter_request(run_dt, lead):
    date_token = run_dt.strftime("%Y%m%d")
    cycle = run_dt.strftime("%H")
    filename = f"gfs.t{cycle}z.pgrb2.0p25.f{int(lead):03d}"
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
    return filename, params


def _download_noaa_grib_file(session, run_dt, lead, headers):
    filename, params = _noaa_filter_request(run_dt, lead)
    try:
        response = session.get(
            NOAA_NOMADS_FILTER_URL,
            params=params,
            headers=headers,
            timeout=75,
        )
    except requests.RequestException as exc:
        return None, f"{type(exc).__name__}: {exc}", filename

    if response.status_code in (404, 408, 425, 429, 500, 502, 503, 504):
        return None, f"HTTP {response.status_code}", filename
    try:
        response.raise_for_status()
    except requests.RequestException as exc:
        return None, f"{type(exc).__name__}: {exc}", filename

    grib_bytes = response.content
    if not grib_bytes.startswith(b"GRIB"):
        preview = grib_bytes[:250].decode("utf-8", errors="replace")
        return None, f"GRIB2 yerine başka yanıt: {preview}", filename
    return grib_bytes, None, filename


def prune_noaa_cache():
    """Remove abandoned cycle caches; active cycles are kept until processed."""
    if not os.path.isdir(NOAA_CACHE_DIR):
        return 0

    now = datetime.now(timezone.utc)
    cutoff = timedelta(hours=NOAA_CACHE_RETENTION_HOURS)
    removed = 0
    for entry in os.scandir(NOAA_CACHE_DIR):
        if not entry.is_dir():
            continue
        try:
            run_dt = datetime.strptime(
                entry.name, "%Y%m%dT%HZ"
            ).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        if now - run_dt > cutoff:
            try:
                shutil.rmtree(entry.path)
                removed += 1
                _mark_noaa_cache_updated()
                print(f"[NOAA CACHE PRUNE] Eski önbellek silindi: {entry.name}")
            except OSError as exc:
                print(f"[NOAA CACHE UYARI] {entry.name} silinemedi: {exc}")
    return removed


def clear_noaa_run_cache(run_id):
    cache_dir = _noaa_run_cache_dir(run_id)
    if os.path.isdir(cache_dir):
        try:
            shutil.rmtree(cache_dir)
            _mark_noaa_cache_updated()
            print(f"[NOAA CACHE CLEAR] İşlenen döngünün geçici önbelleği temizlendi: {run_id}")
        except OSError as exc:
            print(f"[NOAA CACHE UYARI] İşlenen önbellek temizlenemedi: {exc}")


def prefetch_latest_noaa_cycle(skip_run_ids=None):
    """Fetch a small batch of early forecast files before the cycle reaches +180h."""
    skip_run_ids = set(skip_run_ids or ())
    now = datetime.now(timezone.utc)
    cycle_hour = (now.hour // 6) * 6
    run_dt = now.replace(
        hour=cycle_hour, minute=0, second=0, microsecond=0
    )
    run_id = run_dt.isoformat(timespec="seconds")
    age_hours = (now - run_dt).total_seconds() / 3600.0

    if run_id in skip_run_ids:
        print(f"[NOAA PREFETCH SKIP] {run_id} zaten NOAA +180 envanterinde.")
        return 0
    if age_hours < NOAA_PREFETCH_MIN_AGE_HOURS:
        print(
            f"[NOAA PREFETCH SKIP] {run_id} döngüsü henüz {age_hours:.1f} saatlik; "
            f"ön indirme eşiği {NOAA_PREFETCH_MIN_AGE_HOURS:.1f} saat."
        )
        return 0

    os.makedirs(NOAA_CACHE_DIR, exist_ok=True)
    leads = list(range(0, MIN_FORECAST_HOURS, 6))
    missing = [
        lead for lead in leads
        if _read_noaa_cache_file(run_id, lead) is None
    ]
    cached_count = len(leads) - len(missing)
    if not missing:
        print(f"[NOAA PREFETCH READY] {run_id}: 30/30 tahmin dosyası önbellekte.")
        return 0

    batch = missing[:NOAA_PREFETCH_FILES_PER_CHECK]
    session = requests.Session()
    headers = {"User-Agent": "GFS-Watch/1.0"}
    last_request_at = 0.0
    downloaded = 0

    print(
        f"[NOAA PREFETCH] {run_id}: {cached_count}/30 hazır; "
        f"bu kontrolde en fazla {len(batch)} dosya indirilecek."
    )
    try:
        for lead in batch:
            if last_request_at:
                elapsed = time.monotonic() - last_request_at
                if elapsed < NOAA_REQUEST_INTERVAL_SECONDS:
                    time.sleep(NOAA_REQUEST_INTERVAL_SECONDS - elapsed)

            filename, _ = _noaa_filter_request(run_dt, lead)
            print(f"[NOAA PREFETCH] {filename} indiriliyor...")
            grib_bytes, error, _ = _download_noaa_grib_file(
                session, run_dt, lead, headers
            )
            last_request_at = time.monotonic()
            if error:
                print(
                    f"[NOAA PREFETCH PENDING] {filename} henüz alınamadı: {error}; "
                    "sonraki kontrolde tekrar denenecek."
                )
                break

            _write_noaa_cache_file(run_id, lead, grib_bytes)
            downloaded += 1
            print(
                f"[NOAA PREFETCH OK] {filename}: "
                f"{len(grib_bytes)} byte önbelleğe alındı."
            )
    finally:
        session.close()

    print(
        f"[NOAA PREFETCH BATCH] {run_id}: bu kontrolde {downloaded} yeni dosya; "
        f"önbellekte toplam {cached_count + downloaded}/30."
    )
    return downloaded


def fetch_full_weather_data(run_id, min_request_interval=10.0):
    """Fetch an exact GFS cycle; keep polite NOAA pacing configurable for one-off tools."""
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
            # Cached forecast slices require no NOMADS request and therefore
            # must not incur the network pacing delay.
            grib_bytes = _read_noaa_cache_file(run_id, lead)
            if grib_bytes is not None:
                print(
                    f"[NOAA CACHE HIT] f{lead:03d}: "
                    f"{len(grib_bytes)} byte önbellekten alındı."
                )
            else:
                if last_request_at:
                    elapsed = time.monotonic() - last_request_at
                    if elapsed < min_request_interval:
                        time.sleep(min_request_interval - elapsed)

                filename, _ = _noaa_filter_request(run_dt, lead)
                print(
                    f"[NOAA] {filename} indiriliyor "
                    f"({position + 1}/{len(download_order)})..."
                )
                grib_bytes, error, _ = _download_noaa_grib_file(
                    session, run_dt, lead, headers
                )
                last_request_at = time.monotonic()
                if error:
                    print(
                        f"[PENDING] NOAA GRIB dosyası f{lead:03d} alınamadı: "
                        f"{error}; sonraki kontrolde tekrar denenecek."
                    )
                    return {
                        "_pending_noaa_gfs": True,
                        "_run_id": run_id,
                        "_forecast_hour": lead,
                        "_reason": error,
                    }
                _write_noaa_cache_file(run_id, lead, grib_bytes)

            filename = f"gfs.t{cycle}z.pgrb2.0p25.f{lead:03d}"
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

    # Run-to-run changes are shown only in the four-cycle comparison image,
    # not repeated in the text report or voice script.

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


def create_comparison_chart(current_run_id, payload, previous_runs):
    """Build a four-cycle, multi-series comparison image for the common forecast dates."""
    if not previous_runs:
        print("[KIYAS GÖRSELİ] Önceki GFS kaydı yok; ilk çalışma için görsel atlandı.")
        return None

    try:
        entries = []
        for run_id, forecast_json in previous_runs:
            forecast_payload = (
                forecast_json if isinstance(forecast_json, dict)
                else json.loads(forecast_json)
            )
            entries.append((run_id, forecast_payload))
        entries.append((current_run_id, payload))
        entries.sort(key=lambda item: _parse_utc_datetime(item[0]))

        def daily_values(daily):
            dates = daily.get("time", [])
            keys = ("temp_min", "temp_max", "precip_sum", "wind_max")
            if any(len(daily.get(key, [])) != len(dates) for key in keys):
                raise ValueError("Günlük özet dizilerinin uzunlukları uyuşmuyor.")
            return {
                day: {
                    "temp_min": float(daily["temp_min"][i]),
                    "temp_max": float(daily["temp_max"][i]),
                    "precip": float(daily["precip_sum"][i]),
                    "wind": float(daily["wind_max"][i]),
                }
                for i, day in enumerate(dates)
            }

        series = []
        for run_id, forecast_payload in entries:
            daily = daily_values(forecast_payload.get("daily", {}))
            if not daily:
                raise ValueError(f"{run_id} için günlük tahmin verisi bulunamadı.")
            run_utc = _parse_utc_datetime(run_id)
            run_local = run_utc.astimezone(TR_TZ)
            cycle_label = (
                f"{run_utc:%H}Z | {run_local:%d.%m %H:%M} TSİ"
            )
            if run_id == current_run_id:
                cycle_label = "YENİ · " + cycle_label
            series.append({
                "run_id": run_id,
                "label": cycle_label,
                "daily": daily,
                "timeline": forecast_payload.get("timeline_180h", {}),
            })

        common_dates = set(series[0]["daily"])
        for item in series[1:]:
            common_dates.intersection_update(item["daily"])
        dates = sorted(common_dates)
        if not dates:
            print("[KIYAS GÖRSELİ] Dört döngünün ortak tahmin günü bulunamadı; görsel atlandı.")
            return None

        def temperature_ohlc(forecast, day):
            samples = [
                (key, values) for key, values in forecast.items()
                if key[:10] == day and values.get("temp") is not None
            ]
            samples.sort(key=lambda item: item[0])
            if not samples:
                return None
            temps = [float(item[1]["temp"]) for item in samples]
            return temps[0], temps[-1], max(temps), min(temps)

        colors = ["#3977A8", "#2A9D8F", "#8E6CBE", "#E58A32"]
        count = len(series)
        offsets = [
            (index - (count - 1) / 2) * min(0.20, 0.80 / count)
            for index in range(count)
        ]
        group_width = min(0.20, 0.80 / count)
        candle_width = group_width * 0.72
        bar_width = group_width * 0.90

        fig, axes = plt.subplots(
            3, 1, figsize=(17, 12), sharex=True,
            gridspec_kw={"height_ratios": [1.5, 1, 1]},
        )
        fig.suptitle(
            f"İSTANBUL GFS | SON {count} DÖNGÜ KARŞILAŞTIRMASI",
            fontsize=18, fontweight="bold", y=0.985,
        )
        x_positions = list(range(len(dates)))

        ax = axes[0]
        legend_handles = []
        for series_index, item in enumerate(series):
            color = colors[series_index % len(colors)]
            legend_handles.append(
                Line2D([0], [0], color=color, linewidth=5, label=item["label"])
            )
            ohlc = [
                temperature_ohlc(item["timeline"], day) for day in dates
            ]
            for index, values in enumerate(ohlc):
                if values is None:
                    continue
                open_value, close_value, high_value, low_value = values
                x = x_positions[index] + offsets[series_index]
                ax.vlines(x, low_value, high_value, color=color, linewidth=1.6)
                body_bottom = min(open_value, close_value)
                body_height = max(abs(close_value - open_value), 0.12)
                ax.add_patch(Rectangle(
                    (x - candle_width / 2, body_bottom),
                    candle_width, body_height,
                    facecolor=color, edgecolor=color, alpha=0.82,
                ))
        ax.set_title(
            "Sıcaklık | Günlük mum: ilk–son örnek, fitil: min–maks (°C)",
            loc="left",
        )
        ax.set_ylabel("°C")
        ax.grid(axis="y", alpha=0.25)
        ax.legend(
            handles=legend_handles,
            loc="upper left", ncol=min(4, count), fontsize=8, frameon=False,
        )

        for ax, metric, title, ylabel in (
            (axes[1], "precip", "Günlük toplam yağış", "mm"),
            (axes[2], "wind", "Günlük en yüksek rüzgâr", "km/sa"),
        ):
            for series_index, item in enumerate(series):
                color = colors[series_index % len(colors)]
                values = [item["daily"][day][metric] for day in dates]
                ax.bar(
                    [x + offsets[series_index] for x in x_positions],
                    values,
                    width=bar_width,
                    color=color,
                )
            ax.set_title(title, loc="left")
            ax.set_ylabel(ylabel)
            ax.grid(axis="y", alpha=0.25)

        turkish_weekdays = (
            "Pazartesi", "Salı", "Çarşamba", "Perşembe",
            "Cuma", "Cumartesi", "Pazar",
        )
        date_labels = []
        for day in dates:
            local_date = datetime.strptime(day, "%Y-%m-%d")
            date_labels.append(
                f"{local_date:%d.%m}\n{turkish_weekdays[local_date.weekday()]}"
            )

        # Shared x-axes hide labels on upper panels by default. Re-enable them
        # so every metric can be read with its own date and Turkish weekday.
        for axis in axes:
            axis.set_xticks(x_positions)
            axis.set_xticklabels(date_labels, fontsize=9)
        for axis in axes[:-1]:
            axis.tick_params(axis="x", labelbottom=True)
        axes[-1].set_xlabel("İstanbul yerel tarihi")
        fig.text(
            0.01, 0.012,
            "Renkler her panelde aynı GFS döngüsünü gösterir | "
            "Kaynak: NOAA/NCEP GFS 0.25° | Yalnızca tüm döngülerde ortak günler",
            fontsize=9, color="#555555",
        )
        fig.tight_layout(rect=(0, 0.035, 1, 0.95))

        image_buffer = io.BytesIO()
        fig.savefig(image_buffer, format="png", dpi=150, bbox_inches="tight")
        image_buffer.seek(0)
        print(
            f"[KIYAS GÖRSELİ] {count} GFS döngüsü, {len(dates)} ortak gün "
            "için grafik hazırlandı: "
            + " -> ".join(item["run_id"] for item in series)
        )
        return image_buffer
    except Exception as exc:
        print(f"[KIYAS GÖRSELİ HATA] Grafik oluşturulamadı: {exc}")
        return None
    finally:
        if "fig" in locals():
            plt.close(fig)


async def load_previous_three_runs_for_comparison(current_run_id):
    """Load the exact three preceding six-hour cycles, using NOAA read-only as fallback."""
    current_dt = _parse_utc_datetime(current_run_id)
    previous_runs = []

    for hours_back in (6, 12, 18):
        previous_dt = current_dt - timedelta(hours=hours_back)
        previous_run_id = previous_dt.isoformat(timespec="seconds")
        stored_record = await asyncio.to_thread(
            get_run_payload, previous_run_id
        )

        if stored_record:
            stored_run_id, stored_payload = stored_record
            print(
                f"[KIYAS GEÇMİŞİ] {stored_run_id} SQLite geçmişinden salt okunur alındı."
            )
            previous_runs.append((
                stored_run_id,
                json.dumps(stored_payload, ensure_ascii=False),
            ))
            continue

        print(
            f"[KIYAS GEÇMİŞİ] {previous_run_id} DB'de bulunamadı; "
            "NOAA/NCEP'den salt okunur tamamlanıyor."
        )
        fetched_payload = await asyncio.to_thread(
            fetch_full_weather_data, previous_run_id
        )
        if not fetched_payload or "_pending_noaa_gfs" in fetched_payload:
            raise RuntimeError(
                f"{previous_run_id} karşılaştırma tahmini NOAA'dan alınamadı: "
                f"{(fetched_payload or {}).get('_reason', 'veri bulunamadı')}"
            )
        previous_runs.append((
            previous_run_id,
            json.dumps(fetched_payload, ensure_ascii=False),
        ))

    return previous_runs


async def send_telegram_photo(photo, caption, max_attempts=3):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        raise RuntimeError("TELEGRAM_TOKEN veya CHAT_ID eksik.")
    if not photo:
        return
    for attempt in range(1, max_attempts + 1):
        try:
            photo.seek(0)
            async with Bot(token=TELEGRAM_TOKEN) as bot:
                await bot.send_photo(chat_id=CHAT_ID, photo=photo, caption=caption)
            print("[TELEGRAM] GFS karşılaştırma görseli gönderildi.")
            return
        except Exception as exc:
            if attempt >= max_attempts:
                raise
            delay = 5 * attempt
            print(
                f"[KIYAS GÖRSELİ RETRY] {attempt}/{max_attempts} başarısız: "
                f"{exc}. {delay} saniye sonra tekrar."
            )
            await asyncio.sleep(delay)


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
    await asyncio.to_thread(prune_noaa_cache)
    candidates = await asyncio.to_thread(fetch_noaa_available_runs)
    if not candidates:
        await asyncio.to_thread(prefetch_latest_noaa_cycle)
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
        await asyncio.to_thread(
            prefetch_latest_noaa_cycle,
            {item["run_id"] for item in candidates},
        )
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
        await asyncio.to_thread(
            prefetch_latest_noaa_cycle,
            {item["run_id"] for item in candidates},
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

    # Compare the current cycle with the exact three prior six-hour cycles.
    # Missing history is fetched from NOAA in read-only mode; DB/JSON state is untouched.
    chart_buffer = None
    try:
        comparison_runs = await load_previous_three_runs_for_comparison(run_id)
        chart_buffer = create_comparison_chart(run_id, payload, comparison_runs)
        if chart_buffer:
            ordered_run_ids = sorted(
                [item[0] for item in comparison_runs] + [run_id],
                key=_parse_utc_datetime,
            )
            cycle_labels = []
            for comparison_run_id in ordered_run_ids:
                comparison_utc = _parse_utc_datetime(comparison_run_id)
                comparison_local = comparison_utc.astimezone(TR_TZ)
                cycle_labels.append(
                    f"{comparison_utc:%H}Z ({comparison_local:%d.%m} TSİ)"
                )
            caption = (
                "📊 İstanbul GFS | Dört döngü karşılaştırması\n"
                "Eski → yeni: " + " → ".join(cycle_labels)
            )
            await send_telegram_photo(chart_buffer, caption)
    except Exception as exc:
        print(f"[KIYAS GÖRSELİ GÖNDERİM HATASI] {exc}")
    finally:
        if chart_buffer:
            chart_buffer.close()

    audio_file = await audio_task
    if audio_file:
        try:
            await send_telegram_voice(audio_file)
        except Exception as e:
            print(f"[VOICE HATA] Ses gönderilemedi: {e}")
    else:
        print("[VOICE] Ses üretilemedi; metin bildirimi gönderilmiş durumda.")
    print(f"[COMPLETE] GFS run işlendi ve +180 saat bildirimi gönderildi: {run_id}")
    await asyncio.to_thread(clear_noaa_run_cache, run_id)


async def run_manual_multi_comparison(run_ids):
    """Send one temporary multi-run chart without writing DB, JSON, or run state."""
    normalized = [
        _parse_utc_datetime(run_id).isoformat(timespec="seconds")
        for run_id in run_ids
    ]
    if len(normalized) != 4:
        raise ValueError("Dört döngülü geçici kıyas için tam dört run ID gerekli.")
    run_datetimes = [_parse_utc_datetime(run_id) for run_id in normalized]
    if run_datetimes != sorted(run_datetimes) or len(set(normalized)) != 4:
        raise ValueError("GFS döngüleri benzersiz ve eskiden yeniye sıralı olmalı.")
    if any(
        (run_datetimes[index + 1] - run_datetimes[index]) != timedelta(hours=6)
        for index in range(3)
    ):
        raise ValueError("Dört karşılaştırma döngüsü arasında tam 6 saat olmalı.")

    print(
        "[MANUAL FOUR-CYCLE] " + " -> ".join(normalized)
        + "; SQLite ve NOAA erişimi salt okunur."
    )

    loaded = []
    for run_id in normalized:
        stored_record = await asyncio.to_thread(get_run_payload, run_id)
        if stored_record:
            stored_run_id, forecast_payload = stored_record
            print(f"[MANUAL FOUR-CYCLE] {stored_run_id} SQLite geçmişinden alındı.")
        else:
            print(
                f"[MANUAL FOUR-CYCLE] {run_id} SQLite'da yok; "
                "NOAA/NCEP'den salt okunur alınıyor (bu geçici işlemde 1 sn istek aralığı)."
            )
            forecast_payload = await asyncio.to_thread(
                fetch_full_weather_data, run_id, 1.0
            )
            if not forecast_payload or "_pending_noaa_gfs" in forecast_payload:
                reason = (forecast_payload or {}).get(
                    "_reason", "NOAA forecast data unavailable"
                )
                raise RuntimeError(f"{run_id} tahmini alınamadı: {reason}")
            stored_run_id = run_id
        loaded.append((stored_run_id, forecast_payload))

    previous_runs = [
        (run_id, json.dumps(forecast_payload, ensure_ascii=False))
        for run_id, forecast_payload in loaded[:-1]
    ]
    current_run_id, current_payload = loaded[-1]
    chart = create_comparison_chart(
        current_run_id, current_payload, previous_runs
    )
    if not chart:
        raise RuntimeError("Dört döngülü karşılaştırma görseli üretilemedi.")

    try:
        labels = []
        for run_id, _ in loaded:
            run_utc = _parse_utc_datetime(run_id)
            run_local = run_utc.astimezone(TR_TZ)
            labels.append(f"{run_utc:%H}Z ({run_local:%d.%m} TSİ)")
        caption = (
            "📊 İstanbul GFS | Tek seferlik dört döngü karşılaştırması\n"
            "Eski → yeni: " + " → ".join(labels) + "\n"
            "Sıcaklık, günlük toplam yağış ve günlük maksimum rüzgâr."
        )
        await send_telegram_photo(chart, caption)
    finally:
        chart.close()

    print(
        "[MANUAL FOUR-CYCLE COMPLETE] Görsel Telegram'a gönderildi; "
        "SQLite, JSON ve bildirim geçmişinde değişiklik yapılmadı."
    )


async def run_manual_comparison(previous_run_id, current_run_id):
    """Send a one-off comparison image; never writes DB, JSON, or run state."""
    previous_dt = _parse_utc_datetime(previous_run_id)
    current_dt = _parse_utc_datetime(current_run_id)
    if previous_dt >= current_dt:
        raise ValueError("Karşılaştırma için önceki run, yeni run'dan eski olmalı.")

    print(
        f"[MANUAL COMPARE] {previous_dt.isoformat()} -> {current_dt.isoformat()}; "
        "GFS geçmişi salt okunur kullanılacak."
    )

    previous_record = await asyncio.to_thread(
        get_run_payload, previous_dt.isoformat(timespec="seconds")
    )
    current_record = await asyncio.to_thread(
        get_run_payload, current_dt.isoformat(timespec="seconds")
    )

    if previous_record:
        previous_stored_id, previous_payload = previous_record
        print(f"[MANUAL COMPARE] Önceki tahmin SQLite geçmişinden alındı: {previous_stored_id}")
    else:
        print("[MANUAL COMPARE] Önceki kayıt DB'de yok; NOAA'dan salt okunur çekiliyor.")
        previous_payload = await asyncio.to_thread(
            fetch_full_weather_data, previous_dt.isoformat(timespec="seconds")
        )
        if not previous_payload or "_pending_noaa_gfs" in previous_payload:
            raise RuntimeError("00Z tahmini NOAA'dan alınamadı veya henüz hazır değil.")
        previous_stored_id = previous_dt.isoformat(timespec="seconds")

    if current_record:
        current_stored_id, current_payload = current_record
        print(f"[MANUAL COMPARE] Yeni tahmin SQLite geçmişinden alındı: {current_stored_id}")
    else:
        print("[MANUAL COMPARE] Yeni kayıt DB'de yok; NOAA'dan salt okunur çekiliyor.")
        current_payload = await asyncio.to_thread(
            fetch_full_weather_data, current_dt.isoformat(timespec="seconds")
        )
        if not current_payload or "_pending_noaa_gfs" in current_payload:
            raise RuntimeError("06Z tahmini NOAA'dan alınamadı veya henüz hazır değil.")
        current_stored_id = current_dt.isoformat(timespec="seconds")

    chart = create_comparison_chart(
        current_stored_id,
        current_payload,
        [(previous_stored_id, json.dumps(previous_payload, ensure_ascii=False))],
    )
    if not chart:
        raise RuntimeError("Karşılaştırma görseli üretilemedi.")

    try:
        caption = (
            "📊 İstanbul GFS | 00Z → 06Z karşılaştırması\n"
            f"Önceki: {_format_tr_datetime(previous_dt.astimezone(TR_TZ))} TSİ\n"
            f"Yeni: {_format_tr_datetime(current_dt.astimezone(TR_TZ))} TSİ\n"
            "Sıcaklık mumları, günlük toplam yağış ve günlük maksimum rüzgâr."
        )
        await send_telegram_photo(chart, caption)
    finally:
        chart.close()

    print(
        "[MANUAL COMPARE COMPLETE] Tek karşılaştırma görseli Telegram'a gönderildi; "
        "SQLite ve JSON geçmişinde değişiklik yapılmadı."
    )


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
        compare_run_ids = os.getenv("GFS_WATCH_COMPARE_RUN_IDS", "").strip()
        compare_previous = os.getenv("GFS_WATCH_COMPARE_PREVIOUS_RUN_ID", "").strip()
        compare_current = os.getenv("GFS_WATCH_COMPARE_CURRENT_RUN_ID", "").strip()
        if compare_run_ids:
            run_ids = [item.strip() for item in compare_run_ids.split(",") if item.strip()]
            asyncio.run(run_manual_multi_comparison(run_ids))
        elif compare_previous and compare_current:
            asyncio.run(run_manual_comparison(compare_previous, compare_current))
        else:
            manual_run_id = os.getenv("GFS_WATCH_MANUAL_RUN_ID", "").strip()
            if manual_run_id:
                asyncio.run(run_manual_report(manual_run_id))
            elif os.getenv("GFS_WATCH_ONCE", "").strip().lower() in {"1", "true", "yes"}:
                asyncio.run(run_once())
            else:
                asyncio.run(main())
    except KeyboardInterrupt:
        print("[STOP] GFS Watch kontrollü şekilde durduruldu.")
