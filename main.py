"""Shared publication helpers for the MeteoPT-canonical GFS site.

The live Istanbul GFS workflow does not use main.py as a collector or Telegram
poller. This module is retained as a compatibility library for report/chart
rendering used by the canonical publisher.
"""
import os
import json
import sqlite3
import asyncio
import io
import math
import tempfile
import time
import shutil
import traceback
import re
from html import unescape
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo  # Türkiye saati için yerleşik kütüphane
import requests
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patheffects as patheffects
from matplotlib.lines import Line2D
from matplotlib.patches import FancyBboxPatch, Rectangle
from google.cloud import texttospeech
from google.oauth2 import service_account
from telegram import Bot

# --- KONFİGÜRASYON ---
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")
GCP_SA_KEY = os.getenv("GCP_SA_KEY")
APP_NAME, APP_VERSION = None, None


def _read_app_identity():
    """Read the one version shared by the website and every Telegram report."""
    version_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "site", "version.json")
    try:
        with open(version_path, encoding="utf-8") as handle:
            document = json.load(handle)
        name = str(document.get("name", "")).strip()
        version = str(document.get("version", "")).strip()
    except (OSError, ValueError, TypeError):
        name, version = "", ""
    if not name or not version:
        return "İstanbul'un Havası", "1.4.3"
    return name, version


APP_NAME, APP_VERSION = _read_app_identity()
APP_LABEL = f"{APP_NAME} {APP_VERSION}"

LAT = 41.014
LON = 28.950
GRID_LAT = round(LAT * 4.0) / 4.0
GRID_LON = round(LON * 4.0) / 4.0
TR_TZ = ZoneInfo("Europe/Istanbul")  # İstanbul saat dilimi
DATA_DIR = "/data" if os.path.isdir("/data") else "."
DB_PATH = os.getenv("DB_PATH", os.path.join(DATA_DIR, "gfs_watch.db"))
MODEL_NAME = "ncep_gfs_global"
# Detect completed +180 GFS cycles directly from NOAA's public S3 inventory.
# Selected GRIB2 messages are fetched from the same S3 objects via .idx ranges,
# avoiding the hundreds-of-megabytes full global file and all weather APIs.
NOAA_GFS_S3_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
NOAA_NOMADS_GFS_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"
NOAA_RANGE_DOWNLOAD_WORKERS = max(2, int(os.getenv("NOAA_RANGE_DOWNLOAD_WORKERS", "8")))
NOAA_CYCLE_LOOKBACK = 6
MIN_FORECAST_HOURS = 180
RETENTION_DAYS = 10
PUBLIC_DATA_DIR = os.getenv("PUBLIC_DATA_DIR", "public")
NOAA_CACHE_DIR = os.getenv("NOAA_CACHE_DIR", "noaa_cache_v2")
NOAA_PREFETCH_FILES_PER_CHECK = max(
    1, int(os.getenv("NOAA_PREFETCH_FILES_PER_CHECK", "141"))
)
NOAA_CACHE_RETENTION_HOURS = max(
    12.0, float(os.getenv("NOAA_CACHE_RETENTION_HOURS", "48"))
)
REGIONAL_PRESSURE_DIAMETER_KM = 2500.0
REGIONAL_PRESSURE_RADIUS_KM = REGIONAL_PRESSURE_DIAMETER_KM / 2.0
HIGH_PRESSURE_THRESHOLD_HPA = 1023.0
LOW_PRESSURE_THRESHOLD_HPA = 1015.0

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
        _ensure_telegram_ledger(conn)
        conn.commit()
    finally:
        conn.close()


# 12Z ve öncesi Telegram'a bir kez gitti. Defterde yoksa bile tekrarlanmaz.
TELEGRAM_ALREADY_SENT_THROUGH = "2026-11-02T12:00:00+00:00"


def _ensure_telegram_ledger(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS gfs_telegram_sent (
            run_name TEXT PRIMARY KEY,
            sent_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # A processed GFS row is NOT proof that Telegram delivery succeeded.
    # Keep the ledger strictly limited to cycles whose Telegram text was accepted.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS gfs_telegram_migrations (
            migration_id TEXT PRIMARY KEY,
            applied_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    migration_id = "remove_false_sent_mark_2026_11_03_00z"
    migrated = conn.execute(
        "SELECT 1 FROM gfs_telegram_migrations WHERE migration_id = ?",
        (migration_id,),
    ).fetchone()
    if not migrated:
        conn.execute(
            "DELETE FROM gfs_telegram_sent WHERE run_name = ?",
            ("2026-11-03T00:00:00+00:00",),
        )
        conn.execute(
            "INSERT INTO gfs_telegram_migrations (migration_id) VALUES (?)",
            (migration_id,),
        )
    conn.execute(
        "INSERT OR IGNORE INTO gfs_telegram_sent (run_name) VALUES (?)",
        (TELEGRAM_ALREADY_SENT_THROUGH,),
    )


def telegram_already_sent(run_id):
    """True when this cycle already produced its one Telegram report."""
    normalized = _parse_utc_datetime(run_id).isoformat(timespec="seconds")
    if normalized <= TELEGRAM_ALREADY_SENT_THROUGH:
        return True
    conn = sqlite3.connect(DB_PATH)
    try:
        _ensure_telegram_ledger(conn)
        row = conn.execute(
            "SELECT 1 FROM gfs_telegram_sent WHERE run_name = ?",
            (normalized,),
        ).fetchone()
        conn.commit()
        return row is not None
    finally:
        conn.close()


def mark_telegram_sent(run_id):
    normalized = _parse_utc_datetime(run_id).isoformat(timespec="seconds")
    conn = sqlite3.connect(DB_PATH)
    try:
        _ensure_telegram_ledger(conn)
        conn.execute(
            "INSERT OR IGNORE INTO gfs_telegram_sent (run_name) VALUES (?)",
            (normalized,),
        )
        conn.commit()
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


def _write_bytes_atomically(path, content):
    """Write binary media atomically so Pages never receives a partial file."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            suffix=".tmp",
            prefix=".media-",
            dir=directory,
            delete=False,
        ) as temp_file:
            temp_path = temp_file.name
            temp_file.write(content)
        os.replace(temp_path, path)
    finally:
        if temp_path and os.path.exists(temp_path):
            os.remove(temp_path)


def save_public_notification_image(run_id, chart_buffer):
    """Archive the comparison image for the public notification feed."""
    if not chart_buffer:
        return None
    run_dt = _parse_utc_datetime(run_id)
    run_key = run_dt.strftime("%Y%m%dT%HZ")
    notification_dir = os.path.join(PUBLIC_DATA_DIR, "notifications")
    media_dir = os.path.join(notification_dir, "media")
    filename = f"gfs-{run_key}-comparison.png"
    content = chart_buffer.getvalue()
    if not content:
        return None
    _write_bytes_atomically(os.path.join(media_dir, filename), content)
    print(f"[WEB NOTIFICATION] Karşılaştırma görseli arşivlendi: {filename}")
    return f"media/{filename}"


def save_public_notification_svg_image(run_id, chart_buffer):
    """Archive the vector SVG used by the public four-panel report."""
    if not chart_buffer:
        return None
    run_dt = _parse_utc_datetime(run_id)
    run_key = run_dt.strftime("%Y%m%dT%HZ")
    notification_dir = os.path.join(PUBLIC_DATA_DIR, "notifications")
    media_dir = os.path.join(notification_dir, "media")
    filename = f"gfs-{run_key}-comparison.svg"
    content = chart_buffer.getvalue()
    if not content or b"<svg" not in content[:4096]:
        return None
    _write_bytes_atomically(os.path.join(media_dir, filename), content)
    print(f"[WEB NOTIFICATION] Vektör karşılaştırma SVG arşivlendi: {filename}")
    return f"media/{filename}"


def save_public_notification_images(run_id, chart_buffers):
    """Archive four independent charts for the public Pages report."""
    if not isinstance(chart_buffers, dict) or not chart_buffers:
        return []
    run_dt = _parse_utc_datetime(run_id)
    run_key = run_dt.strftime("%Y%m%dT%HZ")
    media_dir = os.path.join(PUBLIC_DATA_DIR, "notifications", "media")
    labels = {
        "temperature": "Sıcaklık",
        "precipitation": "Yağış",
        "temperature_850": "Sıcaklık · 850 hPa",
        "wind_10m": "Rüzgâr hızı + yönü · 10 m",
    }
    images = []
    for metric in ("temperature", "temperature_850", "precipitation", "wind_10m"):
        buffer = chart_buffers.get(metric)
        if not buffer:
            continue
        content = buffer.getvalue()
        if not content:
            continue
        filename = f"gfs-{run_key}-{metric}.png"
        _write_bytes_atomically(os.path.join(media_dir, filename), content)
        images.append({"label": labels[metric], "path": f"media/{filename}"})
        print(f"[PAGES GÖRSEL] {labels[metric]} arşivlendi: {filename}")
    return images


def publish_public_notification(
    run_id, full_text_report, speech_text, image_path=None, audio_file=None, images=None
):
    """Publish one GFS report with optional image/audio; retain the latest four."""
    run_dt = _parse_utc_datetime(run_id)
    run_key = run_dt.strftime("%Y%m%dT%HZ")
    notification_dir = os.path.join(PUBLIC_DATA_DIR, "notifications")
    media_dir = os.path.join(notification_dir, "media")
    os.makedirs(media_dir, exist_ok=True)

    audio_path = None
    if audio_file and os.path.isfile(audio_file):
        audio_filename = f"gfs-{run_key}-voice.mp3"
        with open(audio_file, "rb") as source_file:
            audio_content = source_file.read()
        if audio_content:
            _write_bytes_atomically(
                os.path.join(media_dir, audio_filename), audio_content
            )
            audio_path = f"media/{audio_filename}"

    run_local = run_dt.astimezone(TR_TZ)
    # Pages summaries must remain available even when voice reports are disabled.
    # Prefer spoken copy when present; otherwise derive a concise summary from the
    # written report so the notification feed never publishes an empty summary.
    summary_source = speech_text.strip() or full_text_report.strip()
    summary = (
        summary_source
        .replace("ENKA Balmumcu istasyonunda", "yerel istasyonda")
        .replace("ENKA BALMUMCU", "yerel istasyon")
    )
    if not speech_text.strip():
        summary_lines = [
            line.strip()
            for line in summary.splitlines()
            if line.strip()
            and not line.startswith(("🌦", "İSTANBUL GFS TAHMİN RAPORU", "📄", "🛰", "🗓", "🕒", "📍"))
        ]
        summary = "\n".join(summary_lines[:6]).strip()
    if not summary:
        raise ValueError("Pages notification summary could not be derived from the written report.")
    web_report = (
        full_text_report
        .replace("ENKA BALMUMCU", "YEREL İSTASYON")
        .replace("ENKA Balmumcu", "Yerel istasyon")
        .replace("ENKA Vantage PRO", "meteoroloji istasyonu")
    )
    entry = {
        "id": run_key,
        "title": "İstanbul GFS tahmin raporu",
        "run_id_utc": run_dt.isoformat(timespec="seconds"),
        "published_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "published_at_istanbul": _format_tr_datetime(datetime.now(TR_TZ)),
        "cycle_label": f"{run_dt:%H}Z · {run_dt:%d.%m.%Y %H:%M} UTC",
        "summary": summary,
        "report_text": web_report,
        "image_path": image_path,
        "images": images if isinstance(images, list) else [],
        "audio_path": audio_path,
    }

    manifest_path = os.path.join(notification_dir, "latest.json")
    try:
        with open(manifest_path, "r", encoding="utf-8") as manifest_file:
            existing = json.load(manifest_file)
        previous_items = existing.get("items", [])
        if not isinstance(previous_items, list):
            previous_items = []
    except (OSError, ValueError, TypeError):
        previous_items = []

    retained = [item for item in previous_items if item.get("id") != run_key]
    retained.append(entry)
    retained.sort(
        key=lambda item: item.get("run_id_utc", ""),
        reverse=True,
    )
    retained = retained[:4]

    # SVG is the vector source displayed on Pages; image_path remains a PNG
    # rendered from the same figure for Telegram's single-photo endpoint.
    for retained_item in retained:
        legacy_image = retained_item.get("image_path")
        if isinstance(legacy_image, str) and legacy_image.lower().endswith(".svg"):
            retained_item["image_path"] = None
        retained_item["images"] = [
            image for image in retained_item.get("images", [])
            if isinstance(image, dict)
            and isinstance(image.get("path"), str)
            and image["path"].lower().endswith((".png", ".svg"))
        ]

    _write_json_atomically(
        manifest_path,
        {
            "schema": "gfs-watch.notifications.v1",
            "updated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "items": retained,
        },
    )

    keep_files = set()
    for item in retained:
        for field in ("image_path", "audio_path"):
            relative_path = item.get(field)
            if relative_path:
                keep_files.add(os.path.basename(relative_path))
        for image in item.get("images", []):
            relative_path = image.get("path") if isinstance(image, dict) else image
            if relative_path:
                keep_files.add(os.path.basename(relative_path))
    for filename in os.listdir(media_dir):
        if filename.startswith("gfs-") and filename not in keep_files:
            try:
                os.remove(os.path.join(media_dir, filename))
            except OSError as exc:
                print(f"[WEB NOTIFICATION UYARI] Eski medya silinemedi: {exc}")

    print(
        f"[WEB NOTIFICATION] {run_key} web akışına eklendi; "
        f"son {len(retained)} rapor tutuluyor."
    )
    return entry


def _forecast_points_from_payload(payload):
    """Turn one model payload into the public 3-hour point list."""
    forecast = []
    for local_time, values in sorted(payload.get("timeline_180h", {}).items()):
        local_dt = datetime.strptime(local_time, "%Y-%m-%dT%H:%M").replace(tzinfo=TR_TZ)
        forecast.append({
            "forecast_hour": int(values.get("step_hour", 0)),
            "valid_time_utc": local_dt.astimezone(timezone.utc).isoformat(timespec="minutes"),
            "valid_time_istanbul": local_dt.isoformat(timespec="minutes"),
            "temperature_2m_c": values.get("temp"),
            "temperature_850hpa_c": values.get("temp_850"),
            "wind_speed_10m_kmh": values.get("wind"),
            "wind_direction_10m_deg": values.get("wind_direction_deg"),
            "wind_speed_850hpa_kmh": values.get("wind_850"),
            "precipitation_6h_mm": values.get("precip"),
        })
    return forecast


def _comparison_entry_from_payload(run_id, payload):
    """One cycle inside the single public bundle. Same points the page charts use."""
    run_dt = _parse_utc_datetime(run_id)
    return {
        "run_id_utc": run_dt.isoformat(timespec="seconds"),
        "forecast_source": "meteopt" if "MeteoPT" in str(payload.get("data_source", "")) else payload.get("forecast_source", "noaa"),
        "forecast_6_hourly": _forecast_points_from_payload(payload),
    }


def export_public_forecast_json(
    run_id, payload, update_latest=True, comparison_payloads=None, report=None
):
    """Write one run archive. latest.json is the single page bundle when requested."""
    run_dt = _parse_utc_datetime(run_id)
    current = payload.get("current", {})
    daily = payload.get("daily", {})
    forecast = _forecast_points_from_payload(payload)
    dates = daily.get("time", [])
    daily_summary = []
    for index, date_value in enumerate(dates):
        daily_summary.append({
            "date_istanbul": date_value,
            "temperature_min_c": daily.get("temp_min", [])[index],
            "temperature_max_c": daily.get("temp_max", [])[index],
            "temperature_850hpa_min_c": daily.get("temp_850_min", [None] * len(dates))[index],
            "temperature_850hpa_max_c": daily.get("temp_850_max", [None] * len(dates))[index],
            "precipitation_total_mm": daily.get("precip_sum", [])[index],
            "wind_speed_max_10m_kmh": daily.get("wind_max", [])[index],
            "wind_speed_max_850hpa_kmh": daily.get("wind_850_max", [None] * len(dates))[index],
        })

    model_metadata = payload.get("model_metadata", {})
    forecast_source = (
        "meteopt" if "MeteoPT" in str(payload.get("data_source", "")) else "noaa"
    )
    document = {
        "schema": "gfs-watch.forecast.v1",
        "model": MODEL_NAME,
        "forecast_source": forecast_source,
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
            "model_initial_conditions": payload.get(
                "initial_source",
                "NOAA/NCEP GFS f000 native GRIB2 initial fields",
            ),
        },
        "noaa_source_file": {
            "f180_available": model_metadata.get("noaa_f180_available", True),
            "f180_last_modified_utc": model_metadata.get("last_modified_time"),
            "f180_source_name": model_metadata.get("source_name"),
            "f180_source_url": model_metadata.get("source_url"),
            "global_grib2_size_bytes": model_metadata.get("source_object_size_bytes"),
        },
        "current_conditions": {
            "temperature_2m_c": current.get("temp"),
            "precipitation_mm": current.get("precip"),
            "wind_speed_10m_kmh": current.get("wind"),
            "mean_sea_level_pressure_hpa": current.get("pressure"),
        },
        "station_observation": payload.get("station_observation"),
        "daily_summary": daily_summary,
        "regional_pressure_analysis": {
            "valid_time_utc": run_dt.isoformat(timespec="seconds"),
            "diameter_km": REGIONAL_PRESSURE_DIAMETER_KM,
            "findings": payload.get("synoptic_alerts", []),
        },
        "forecast_6_hourly": forecast,
        # Dedicated raw MeteoPT arrays consumed only by the bottom model table.
        "meteopt_table": payload.get("meteopt_table_raw") or {},
    }

    run_filename = run_dt.strftime("%Y%m%dT%HZ") + ".json"
    run_path = os.path.join(PUBLIC_DATA_DIR, "runs", run_filename)
    _write_json_atomically(run_path, document)
    if update_latest:
        published = dict(document)
        if comparison_payloads:
            entries = [
                _comparison_entry_from_payload(cycle_id, cycle_payload)
                for cycle_id, cycle_payload in comparison_payloads
                if cycle_payload and "_pending_noaa_gfs" not in cycle_payload
            ]
            entries.sort(key=lambda item: item["run_id_utc"])
            published["comparison_runs"] = entries[-4:]
        else:
            published["comparison_runs"] = _load_gfs_850_comparison_runs()
        if isinstance(report, dict):
            published["report"] = report
        _write_json_atomically(os.path.join(PUBLIC_DATA_DIR, "latest.json"), published)
        print(
            f"[JSON EXPORT] public/latest.json ve public/runs/{run_filename} "
            f"yazıldı ({len(forecast)} tahmin noktası, "
            f"{len(published['comparison_runs'])} adet aynı kaynaklı çevrim)."
        )
    else:
        print(
            f"[JSON ARCHIVE] Yalnızca public/runs/{run_filename} yazıldı; "
            f"public/latest.json değiştirilmedi ({len(forecast)} tahmin noktası)."
        )


def _load_gfs_850_comparison_runs():
    """Last four published cycles that actually contain 850 hPa temperature."""
    runs_dir = os.path.join(PUBLIC_DATA_DIR, "runs")
    entries = []
    if not os.path.isdir(runs_dir):
        return entries
    for name in sorted(os.listdir(runs_dir)):
        if not name.endswith(".json"):
            continue
        path = os.path.join(runs_dir, name)
        try:
            with open(path, encoding="utf-8") as handle:
                stored = json.load(handle)
        except (OSError, ValueError, TypeError):
            continue
        points = []
        for point in stored.get("forecast_6_hourly") or []:
            if not isinstance(point, dict):
                continue
            value = point.get("temperature_850hpa_c")
            if not isinstance(value, (int, float)):
                continue
            points.append({
                "forecast_hour": point.get("forecast_hour"),
                "valid_time_utc": point.get("valid_time_utc"),
                "temperature_850hpa_c": value,
                "temperature_2m_c": point.get("temperature_2m_c"),
                "precipitation_6h_mm": point.get("precipitation_6h_mm"),
            })
        if points and stored.get("run_id_utc"):
            if (
                os.getenv("GFS_SOURCE", "meteopt").strip().lower() != "noaa"
                and stored.get("forecast_source") != "meteopt"
            ):
                continue
            entries.append({
                "run_id_utc": stored["run_id_utc"],
                "forecast_source": stored.get("forecast_source"),
                "forecast_6_hourly": points,
            })
    return entries[-4:]


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
    raw_value = str(value).strip()
    try:
        parsed = datetime.fromisoformat(raw_value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError(
            f"Geçersiz GFS döngü zamanı: {raw_value!r}. "
            "manual_run_id alanına Telegram blob bağlantısı değil, "
            "2026-11-03T00:00:00+00:00 biçiminde UTC tarih/saat girin."
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _point_in_pressure_region(latitude, longitude, polygon):
    """Return whether a lat/lon point is inside a coarse geographic region polygon."""
    x = float(longitude)
    y = float(latitude)
    inside = False
    previous = len(polygon) - 1
    for current in range(len(polygon)):
        yi, xi = polygon[current]
        yj, xj = polygon[previous]
        if ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / (yj - yi) + xi
        ):
            inside = not inside
        previous = current
    return inside


def pressure_region_name(latitude, longitude):
    """Translate a GFS pressure-extreme grid point into a readable Turkish place name."""
    latitude = float(latitude)
    longitude = ((float(longitude) + 180.0) % 360.0) - 180.0

    # Approximate regional polygons are intentionally broad: the report names
    # the geographic area/country, not a city or a false-precision address.
    regions = [
        (
            "Kırım Yarımadası, Ukrayna",
            [(44.0, 32.2), (45.0, 32.0), (46.2, 33.2), (46.3, 35.6),
             (45.8, 36.8), (45.0, 36.7), (44.4, 36.0), (44.0, 34.8)],
        ),
        (
            "Kuzeybatı Ukrayna (Volın bölgesi)",
            [(50.0, 22.0), (52.5, 22.0), (52.5, 28.5), (50.0, 28.5)],
        ),
        (
            "Romanya",
            [(43.6, 20.2), (45.2, 20.2), (47.0, 22.0), (48.2, 23.0),
             (48.2, 26.8), (47.8, 28.5), (45.4, 29.7), (44.0, 29.7),
             (43.7, 27.8), (43.6, 24.0)],
        ),
        (
            "Bulgaristan, Balkanlar",
            [(41.2, 22.3), (44.2, 22.3), (44.2, 28.2), (41.2, 28.1)],
        ),
        (
            "Moldova",
            [(46.4, 26.5), (48.5, 26.5), (48.5, 30.2), (46.4, 30.2)],
        ),
        (
            "Güney Rusya (Rostov ve Krasnodar çevresi)",
            [(43.0, 37.0), (45.0, 36.5), (47.8, 37.8), (49.1, 41.0),
             (48.7, 48.5), (43.0, 48.5), (43.0, 44.0)],
        ),
        (
            "Güney Ukrayna",
            [(46.2, 29.5), (47.0, 29.5), (49.8, 32.0), (52.4, 34.0),
             (52.4, 40.3), (46.2, 40.3)],
        ),
        (
            "Gürcistan, Güney Kafkasya",
            [(41.0, 40.0), (43.7, 40.0), (43.7, 46.8), (41.0, 46.8)],
        ),
        (
            "Ermenistan, Güney Kafkasya",
            [(38.8, 43.4), (41.3, 43.4), (41.3, 46.7), (38.8, 46.7)],
        ),
        (
            "Azerbaycan, Güney Kafkasya",
            [(38.4, 44.5), (41.9, 44.5), (41.9, 50.5), (38.4, 50.5)],
        ),
        (
            "Sırbistan, Batı Balkanlar",
            [(42.2, 18.8), (46.2, 18.8), (46.2, 23.0), (42.2, 23.0)],
        ),
        (
            "Bosna-Hersek, Batı Balkanlar",
            [(42.5, 15.7), (45.3, 15.7), (45.3, 19.7), (42.5, 19.7)],
        ),
        (
            "Hırvatistan, Batı Balkanlar",
            [(42.3, 13.4), (46.6, 13.4), (46.6, 19.5), (42.3, 19.5)],
        ),
        (
            "Karadağ, Batı Balkanlar",
            [(41.8, 18.4), (43.6, 18.4), (43.6, 20.4), (41.8, 20.4)],
        ),
        (
            "Arnavutluk, Batı Balkanlar",
            [(39.6, 19.2), (42.7, 19.2), (42.7, 21.2), (39.6, 21.2)],
        ),
        (
            "Kosova, Batı Balkanlar",
            [(41.9, 20.0), (43.3, 20.0), (43.3, 21.8), (41.9, 21.8)],
        ),
        (
            "Kuzey Makedonya, Balkanlar",
            [(40.8, 20.4), (42.4, 20.4), (42.4, 23.0), (40.8, 23.0)],
        ),
        (
            "Batı Yunanistan ve İyon Denizi açıkları",
            [(35.0, 19.0), (41.0, 19.0), (41.0, 23.0), (35.0, 23.0)],
        ),
        (
            "Kuzeydoğu Yunanistan (Trakya ve Makedonya)",
            [(39.0, 20.0), (41.8, 20.0), (41.8, 26.6), (39.0, 26.6)],
        ),
        (
            "Doğu Yunanistan ve Kuzey Ege",
            [(35.0, 23.0), (39.0, 23.0), (39.0, 28.5), (35.0, 28.5)],
        ),
        (
            "Marmara ve Trakya, Türkiye",
            [(40.0, 26.0), (42.3, 26.0), (42.3, 30.5), (40.0, 30.5)],
        ),
        (
            "Ege Bölgesi, Türkiye",
            [(36.5, 26.0), (40.0, 26.0), (40.0, 30.0), (36.5, 30.0)],
        ),
        (
            "İç Anadolu, Türkiye",
            [(37.0, 30.0), (40.8, 30.0), (40.8, 36.5), (37.0, 36.5)],
        ),
        (
            "Karadeniz Bölgesi, Türkiye",
            [(40.0, 30.0), (42.5, 30.0), (42.5, 42.0), (40.0, 42.0)],
        ),
        (
            "Akdeniz Bölgesi, Türkiye",
            [(35.0, 26.0), (37.5, 26.0), (37.5, 36.5), (35.0, 36.5)],
        ),
        (
            "Doğu Anadolu, Türkiye",
            [(37.0, 36.5), (40.5, 36.5), (40.5, 44.5), (37.0, 44.5)],
        ),
        (
            "Kuzey Suriye",
            [(35.0, 35.5), (37.5, 35.5), (37.5, 42.0), (35.0, 42.0)],
        ),
        (
            "Kuzey Irak",
            [(34.0, 40.0), (37.5, 40.0), (37.5, 46.0), (34.0, 46.0)],
        ),
        (
            "Kıbrıs Adası, Doğu Akdeniz",
            [(34.4, 32.0), (35.8, 32.0), (35.8, 34.8), (34.4, 34.8)],
        ),
    ]
    for label, polygon in regions:
        if _point_in_pressure_region(latitude, longitude, polygon):
            return label

    # Sea areas are checked after nearby land regions so coastal countries keep
    # their country names when the point is on land.
    if 40.5 <= latitude <= 47.5 and 27.0 <= longitude <= 42.5:
        if longitude < 33.0:
            return "Batı Karadeniz"
        if longitude < 37.0:
            return "Orta Karadeniz"
        return "Doğu Karadeniz"
    if 35.0 <= latitude <= 41.5 and 23.0 <= longitude <= 30.0:
        return "Ege Denizi (Doğu Yunanistan ile Batı Türkiye arasında)"
    if 30.0 <= latitude < 36.5 and 27.0 <= longitude <= 37.5:
        return "Doğu Akdeniz"
    if 39.0 <= latitude <= 46.0 and 13.0 <= longitude <= 20.0:
        return "Adriyatik Denizi ve Batı Balkan kıyıları"
    if latitude >= 45.0 and longitude < 32.0:
        return "Doğu Avrupa (Romanya-Ukrayna çevresi)"
    if latitude >= 42.0 and longitude >= 37.0:
        return "Güney Rusya ve Kafkasya çevresi"
    return "İstanbul çevresindeki bölgesel analiz alanı"


def pressure_point_relative_to_istanbul(latitude, longitude):
    """Return an approximate distance and compass direction without coordinates."""
    lat1 = math.radians(LAT)
    lat2 = math.radians(float(latitude))
    delta_lon = math.radians(
        ((float(longitude) - LON + 180.0) % 360.0) - 180.0
    )
    delta_lat = lat2 - lat1
    haversine = (
        math.sin(delta_lat / 2.0) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2.0) ** 2
    )
    distance_km = 6371.0 * 2.0 * math.asin(
        math.sqrt(max(0.0, min(1.0, haversine)))
    )
    bearing = math.degrees(
        math.atan2(
            math.sin(delta_lon) * math.cos(lat2),
            math.cos(lat1) * math.sin(lat2)
            - math.sin(lat1) * math.cos(lat2) * math.cos(delta_lon),
        )
    ) % 360.0
    directions = (
        "kuzey", "kuzeydoğu", "doğu", "güneydoğu",
        "güney", "güneybatı", "batı", "kuzeybatı",
    )
    direction = directions[int((bearing + 22.5) // 45.0) % 8]
    if distance_km < 50.0:
        return "İstanbul'un yakın çevresinde"
    return f"İstanbul'un yaklaşık {distance_km:.0f} km {direction} yönünde"


def analyse_regional_pressure_grid(pressure_grid):
    """Report the geographic positions of the regional high/low pressure extremes."""
    try:
        if not pressure_grid:
            raise ValueError("f000 GRIB2 içinde deniz seviyesi basınç alanı yok.")

        pressure_values, pressure_latitudes, pressure_longitudes = (
            np.asarray(array, dtype=float).reshape(-1)
            for array in pressure_grid
        )
        if not (pressure_values.size == pressure_latitudes.size == pressure_longitudes.size):
            raise ValueError("Basınç GRIB2 koordinat ve değer dizileri uyuşmuyor.")

        lat1 = math.radians(LAT)
        lat2 = np.radians(pressure_latitudes)
        delta_lat = lat2 - lat1
        delta_lon = np.radians(((pressure_longitudes - LON + 180.0) % 360.0) - 180.0)
        haversine = (
            np.sin(delta_lat / 2.0) ** 2
            + math.cos(lat1) * np.cos(lat2) * np.sin(delta_lon / 2.0) ** 2
        )
        distance_km = 6371.0 * 2.0 * np.arcsin(np.sqrt(np.clip(haversine, 0.0, 1.0)))
        inside = (distance_km <= REGIONAL_PRESSURE_RADIUS_KM) & np.isfinite(pressure_values)
        if not np.any(inside):
            raise ValueError("2.500 km çaplı alanın içinde geçerli basınç noktası bulunamadı.")

        regional_hpa = pressure_values[inside] / 100.0
        regional_latitudes = pressure_latitudes[inside]
        regional_longitudes = pressure_longitudes[inside]
        max_index = int(np.argmax(regional_hpa))
        min_index = int(np.argmin(regional_hpa))
        maximum = float(regional_hpa[max_index])
        minimum = float(regional_hpa[min_index])
        high_place = pressure_region_name(regional_latitudes[max_index], regional_longitudes[max_index])
        low_place = pressure_region_name(regional_latitudes[min_index], regional_longitudes[min_index])
        high_relative = pressure_point_relative_to_istanbul(regional_latitudes[max_index], regional_longitudes[max_index])
        low_relative = pressure_point_relative_to_istanbul(regional_latitudes[min_index], regional_longitudes[min_index])

        findings = [
            f"Bölgesel yüksek basınç odağı: {maximum:.1f} hPa — {high_place}; {high_relative}.",
            f"Bölgesel alçak basınç odağı: {minimum:.1f} hPa — {low_place}; {low_relative}.",
        ]
        nearest_index = int((
            (pressure_latitudes - LAT) ** 2
            + (((pressure_longitudes - LON + 180.0) % 360.0) - 180.0) ** 2
        ).argmin())
        centre_pressure_hpa = float(pressure_values[nearest_index]) / 100.0
        findings.append(
            f"İstanbul başlangıç basıncı: {centre_pressure_hpa:.1f} hPa; "
            f"bölgesel basınç farkı: {maximum - minimum:.1f} hPa."
        )
        print(
            f"[BASINÇ GRIB2] 2.500 km çaplı alanda {int(np.count_nonzero(inside))} grid noktası; "
            f"yüksek {maximum:.1f} hPa ({high_place}); alçak {minimum:.1f} hPa ({low_place}); "
            f"İstanbul {centre_pressure_hpa:.1f} hPa."
        )
        return findings, round(centre_pressure_hpa, 1)
    except Exception as exc:
        print(f"[BASINÇ UYARI] GRIB2 bölgesel basınç analizi yapılamadı: {type(exc).__name__}: {exc}")
        traceback.print_exc()
        raise

def _enka_clean_html(fragment):
    fragment = re.sub(
        r"<script\b[^>]*>.*?</script>", " ", fragment, flags=re.I | re.S
    )
    fragment = re.sub(
        r"<style\b[^>]*>.*?</style>", " ", fragment, flags=re.I | re.S
    )
    fragment = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", unescape(fragment)).strip()


def _enka_first_number(value):
    match = re.search(r"[-+]?\d+(?:[.,]\d+)?", value or "")
    if not match:
        return None
    try:
        number = float(match.group(0).replace(",", "."))
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def fetch_enka_station_observation():
    """Fetch current measured values from ENKA's Balmumcu Vantage PRO station."""
    current_url = "https://w.enka.com/weather/currentvalues.html"
    home_url = "https://w.enka.com/weather/index.html"
    headers = {
        "User-Agent": "Mozilla/5.0 (compatible; GFS-Watch/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Referer": home_url,
    }
    try:
        response = requests.get(current_url, headers=headers, timeout=25)
        response.raise_for_status()
        response.encoding = response.apparent_encoding or "utf-8"
        page = response.text
        page_text = _enka_clean_html(page)

        timestamp_match = re.search(
            r"As\s+of\s*:?\s*(\d{1,2}/\d{1,2}/\d{2,4})\s+(\d{1,2}:\d{2})",
            page_text,
            flags=re.I,
        )
        if not timestamp_match:
            raise ValueError("ENKA sayfasında ölçüm zaman damgası bulunamadı.")

        timestamp_text = (
            f"{timestamp_match.group(1)} {timestamp_match.group(2)}"
        )
        observed_local = None
        for date_format in (
            "%d/%m/%y %H:%M",
            "%d/%m/%Y %H:%M",
            "%m/%d/%y %H:%M",
        ):
            try:
                observed_local = datetime.strptime(
                    timestamp_text, date_format
                ).replace(tzinfo=TR_TZ)
                break
            except ValueError:
                continue
        if observed_local is None:
            raise ValueError(
                f"ENKA zaman damgası çözümlenemedi: {timestamp_text}"
            )
        observed_utc = observed_local.astimezone(timezone.utc)

        rows = []
        for row_html in re.findall(
            r"<tr\b[^>]*>(.*?)</tr>", page, flags=re.I | re.S
        ):
            cells = re.findall(
                r"<t[dh]\b[^>]*>(.*?)</t[dh]>",
                row_html,
                flags=re.I | re.S,
            )
            cleaned = [_enka_clean_html(cell) for cell in cells]
            if len(cleaned) >= 2:
                rows.append(cleaned)

        temperature = None
        humidity = None
        wind_speed_knots = None
        wind_direction = None
        daily_rain = None
        pressure = None
        for cells in rows:
            label = cells[0].strip().lower()
            if "day temperature" in label or label == "temperature":
                temperature = _enka_first_number(cells[1])
            elif label == "humidity":
                humidity = _enka_first_number(cells[1])
            elif "wind - 10 min avg" in label or "wind – 10 min avg" in label:
                wind_speed_knots = _enka_first_number(cells[1])
            elif label == "wind":
                wind_text = cells[1]
                direction_match = re.match(
                    r"\s*(NNE|ENE|ESE|SSE|SSW|WSW|WNW|NNW|N|NE|E|SE|S|SW|W|NW)\b",
                    wind_text,
                    flags=re.I,
                )
                if direction_match:
                    wind_direction = direction_match.group(1).upper()
                if wind_speed_knots is None:
                    wind_speed_knots = _enka_first_number(wind_text)
            elif label == "daily rain":
                daily_rain = _enka_first_number(cells[1])
            elif label.startswith("barometer (hpa)"):
                pressure = _enka_first_number(cells[1])

        if temperature is None or wind_speed_knots is None or daily_rain is None:
            raise ValueError(
                "ENKA anlık tablosunda sıcaklık/rüzgâr/günlük yağış "
                f"alanları eksik: T={temperature}, wind_kt={wind_speed_knots}, "
                f"daily_rain={daily_rain}"
            )

        age_minutes = max(
            0.0,
            (datetime.now(timezone.utc) - observed_utc).total_seconds() / 60.0,
        )
        result = {
            "station_name": "ENKA Balmumcu",
            "station_id": "ENKA-BALMUMCU-VANTAGE-PRO",
            "source": "ENKA Balmumcu Vantage PRO weather station",
            "source_url": current_url,
            "station_home_url": home_url,
            "latitude": 41.1,
            "longitude": 28.9,
            "elevation_m": 107,
            "observed_at_utc": observed_utc.isoformat(timespec="seconds"),
            "age_minutes": round(age_minutes, 1),
            "is_stale": age_minutes > 90,
            "temperature_2m_c": temperature,
            "wind_speed_10m_kmh": round(wind_speed_knots * 1.852, 1),
            "wind_speed_10m_knots": wind_speed_knots,
            "wind_direction_cardinal": wind_direction,
            "precipitation_1h_mm": None,
            "precipitation_daily_mm": daily_rain,
            "humidity_percent": humidity,
            "station_pressure_hpa": pressure,
        }
        state = "STALE" if result["is_stale"] else "LIVE"
        print(
            f"[ENKA {state}] Balmumcu Vantage PRO | "
            f"{temperature}°C | günlük yağış {daily_rain} mm | "
            f"rüzgâr {result['wind_speed_10m_kmh']} km/sa | "
            f"ölçüm {result['observed_at_utc']}"
        )
        return result
    except Exception as exc:
        print(
            f"[ENKA STATION WARNING] Balmumcu verisi alınamadı: "
            f"{type(exc).__name__}: {exc}"
        )
        return None



def fetch_noaa_available_runs():
    """Find recent completed GFS cycles by checking NOAA NOMADS then AWS S3 f180 objects."""
    now = datetime.now(timezone.utc)
    latest_cycle_hour = (now.hour // 6) * 6
    latest_cycle = now.replace(
        hour=latest_cycle_hour, minute=0, second=0, microsecond=0
    )
    candidates = []
    errors = []
    session = requests.Session()
    session.headers.update({"User-Agent": "GFS-Watch/1.0"})

    try:
        for offset in range(NOAA_CYCLE_LOOKBACK):
            run_dt = latest_cycle - timedelta(hours=6 * offset)
            run_id = run_dt.isoformat(timespec="seconds")
            filename = f"gfs.t{run_dt:%H}z.pgrb2.0p25.f{MIN_FORECAST_HOURS:03d}"
            ready_metadata = None

            for source_name, object_url, _ in _noaa_grib_source_urls(
                run_dt, MIN_FORECAST_HOURS
            ):
                try:
                    response = session.head(
                        object_url,
                        headers={"Cache-Control": "no-cache"},
                        timeout=15,
                        allow_redirects=True,
                    )
                    if response.status_code != 200:
                        print(
                            f"[NOAA PENDING] {run_id} f180 {source_name}: "
                            f"HTTP {response.status_code}; sonraki kaynak deneniyor."
                        )
                        continue

                    content_length = int(
                        response.headers.get("Content-Length", "0") or 0
                    )
                    if content_length <= 0:
                        errors.append(
                            f"{run_id} {source_name}: boş/ geçersiz Content-Length"
                        )
                        continue

                    modified_at = _normalise_model_timestamp(
                        response.headers.get("Last-Modified")
                    )
                    ready_metadata = {
                        "model": MODEL_NAME,
                        "metadata_source": f"NOAA/NCEP {source_name} f180 GRIB2 object",
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
                        "source_name": source_name,
                        "source_url": object_url,
                    }
                    print(
                        f"[NOAA READY] {run_id} f180 {source_name}: "
                        f"{content_length:,} byte; hedef dosya doğrulandı."
                    )
                    break
                except requests.RequestException as exc:
                    errors.append(
                        f"{run_id} {source_name}: {type(exc).__name__}: {exc}"
                    )
                    print(
                        f"[NOAA SOURCE ERROR] {run_id} {source_name}: {exc}; "
                        "sonraki kaynak deneniyor."
                    )

            if ready_metadata:
                candidates.append(ready_metadata)
            else:
                print(
                    f"[NOAA PENDING] {run_id} f180 henüz NOMADS veya AWS S3 "
                    "üzerinden doğrulanamadı."
                )
    finally:
        session.close()

    if not candidates:
        suffix = " | ".join(errors) if errors else "Henüz yayımlanmış +180 dosyası yok."
        print("[NOAA GFS PENDING] " + suffix)
        return []

    return sorted(candidates, key=lambda item: item["run_id"])


# --- VERİ ÇEKME (+180 SAAT / FAST-FETCH) ---
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
                output_file.write("noaa_cache_updated=true\n")
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


def _noaa_decoded_cache_file(run_id, lead):
    return os.path.join(
        _noaa_run_cache_dir(run_id), f"f{int(lead):03d}.decoded.json"
    )


def _read_noaa_decoded_cache_file(run_id, lead):
    cache_path = _noaa_decoded_cache_file(run_id, lead)
    try:
        with open(cache_path, "r", encoding="utf-8") as cache_file:
            document = json.load(cache_file)
        precip_records = {
            (int(item["start_step"]), int(item["end_step"])): item["samples"]
            for item in document.get("precip_records", [])
        }
        if not isinstance(document.get("temperature"), dict):
            raise ValueError("decoded temperature field is missing")
        if "temperature_850" not in document:
            raise ValueError("decoded 850 hPa temperature field is missing")
        return {
            "temperature": document["temperature"],
            "temperature_850": document.get("temperature_850") or {},
            "wind_u": document.get("wind_u") or {},
            "wind_v": document.get("wind_v") or {},
            "wind_850_u": document["wind_850_u"],
            "wind_850_v": document["wind_850_v"],
            "precip_records": precip_records,
            "pressure_analysis": document.get("pressure_analysis"),
        }
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(f"[NOAA DECODED CACHE INVALID] {cache_path}: {exc}; yeniden oluşturulacak.")
        try:
            os.remove(cache_path)
            _mark_noaa_cache_updated()
        except OSError:
            pass
        return None


def _write_noaa_decoded_cache_file(run_id, lead, step_data):
    cache_path = _noaa_decoded_cache_file(run_id, lead)
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    document = {
        "temperature": step_data.get("temperature") or {},
        "temperature_850": step_data.get("temperature_850") or {},
        "wind_u": step_data.get("wind_u") or {},
        "wind_v": step_data.get("wind_v") or {},
        "wind_850_u": step_data.get("wind_850_u") or {},
        "wind_850_v": step_data.get("wind_850_v") or {},
        "precip_records": [
            {
                "start_step": int(interval[0]),
                "end_step": int(interval[1]),
                "samples": samples,
            }
            for interval, samples in step_data.get("precip_records", {}).items()
        ],
        "pressure_analysis": step_data.get("pressure_analysis"),
    }
    temporary_path = cache_path + f".{os.getpid()}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as cache_file:
        json.dump(document, cache_file, ensure_ascii=False, separators=(",", ":"))
        cache_file.flush()
        os.fsync(cache_file.fileno())
    os.replace(temporary_path, cache_path)
    _mark_noaa_cache_updated()


def _noaa_grib_source_urls(run_dt, lead):
    """Return exact GRIB2 object URLs in preferred order: NOMADS, then AWS S3."""
    date_token = run_dt.strftime("%Y%m%d")
    cycle = run_dt.strftime("%H")
    filename = f"gfs.t{cycle}z.pgrb2.0p25.f{int(lead):03d}"
    nomads_url = (
        f"{NOAA_NOMADS_GFS_BASE}/gfs.{date_token}/{cycle}/atmos/{filename}"
    )
    s3_url = (
        f"{NOAA_GFS_S3_BASE}/gfs.{date_token}/{cycle}/atmos/{filename}"
    )
    return [
        ("NOMADS", nomads_url, filename),
        ("AWS S3", s3_url, filename),
    ]


def _noaa_s3_object_url(run_dt, lead):
    """Compatibility helper for the canonical AWS S3 object URL."""
    for source_name, object_url, filename in _noaa_grib_source_urls(run_dt, lead):
        if source_name == "AWS S3":
            return object_url, filename
    raise RuntimeError("AWS S3 GFS source URL is not configured.")


def _noaa_index_record_matches(parts, lead):
    if len(parts) < 6:
        return False
    variable = parts[3].strip().upper()
    level = parts[4].strip().lower()
    if variable == "TMP" and level in ("2 m above ground", "850 mb"):
        return True
    if variable in ("UGRD", "VGRD") and level in ("10 m above ground", "850 mb"):
        return True
    if variable == "APCP" and level == "surface":
        return True
    if lead == 0 and variable == "PRMSL" and level == "mean sea level":
        return True
    return False


def _download_noaa_grib_file(session, run_dt, lead, headers):
    """Fetch required GRIB2 messages from the exact lead file, trying NOMADS then AWS S3."""
    source_errors = []
    filename = f"gfs.t{_parse_utc_datetime(run_dt):%H}z.pgrb2.0p25.f{int(lead):03d}"

    for source_name, object_url, filename in _noaa_grib_source_urls(run_dt, lead):
        print(f"[NOAA SOURCE TRY] f{int(lead):03d} için {source_name}: {object_url}")
        try:
            index_response = session.get(
                object_url + ".idx",
                headers=headers,
                timeout=30,
            )
            if index_response.status_code != 200:
                source_errors.append(
                    f"{source_name} IDX HTTP {index_response.status_code}"
                )
                print(
                    f"[NOAA SOURCE MISS] {source_name} {filename}.idx "
                    f"HTTP {index_response.status_code}; diğer kaynak deneniyor."
                )
                continue

            head_response = session.head(
                object_url,
                headers={"Cache-Control": "no-cache", **headers},
                timeout=30,
                allow_redirects=True,
            )
            if head_response.status_code != 200:
                source_errors.append(
                    f"{source_name} GRIB2 HEAD HTTP {head_response.status_code}"
                )
                print(
                    f"[NOAA SOURCE MISS] {source_name} {filename} "
                    f"HTTP {head_response.status_code}; diğer kaynak deneniyor."
                )
                continue

            try:
                object_size = int(
                    head_response.headers.get("Content-Length", "0") or 0
                )
            except (TypeError, ValueError):
                object_size = 0
            if object_size <= 0:
                source_errors.append(
                    f"{source_name} geçersiz Content-Length"
                )
                continue

            records = []
            all_offsets = set()
            for line in index_response.text.splitlines():
                parts = line.strip().split(":")
                if len(parts) < 6:
                    continue
                try:
                    offset = int(parts[1])
                except (TypeError, ValueError):
                    continue
                all_offsets.add(offset)
                if _noaa_index_record_matches(parts, int(lead)):
                    records.append((offset, parts[3].strip().upper(), parts[4].strip()))

            if not records:
                source_errors.append(
                    f"{source_name} IDX içinde gerekli TMP/UGRD/VGRD/APCP alanları yok"
                )
                continue

            # Fetch each required GRIB message only once, even when IDX has
            # multiple submessage entries pointing to the same byte offset.
            selected_offsets = sorted({item[0] for item in records})
            sorted_offsets = sorted(all_offsets)
            next_offset = {
                offset: (
                    sorted_offsets[position + 1]
                    if position + 1 < len(sorted_offsets)
                    else object_size
                )
                for position, offset in enumerate(sorted_offsets)
            }
            ranges = []
            invalid_range = False
            for offset in selected_offsets:
                end = next_offset[offset] - 1
                if end < offset or end >= object_size:
                    source_errors.append(
                        f"{source_name} geçersiz IDX aralığı {offset}-{end}"
                    )
                    invalid_range = True
                    break
                ranges.append((offset, end))
            if invalid_range:
                continue

            def fetch_range(byte_range):
                start, end = byte_range
                response = requests.get(
                    object_url,
                    headers={
                        **headers,
                        "Range": f"bytes={start}-{end}",
                    },
                    timeout=75,
                )
                if response.status_code != 206:
                    return None, f"Range HTTP {response.status_code} ({start}-{end})"
                content = response.content
                expected_size = end - start + 1
                if len(content) != expected_size:
                    return None, (
                        f"Range boyutu uyuşmuyor ({start}-{end}): "
                        f"{len(content)} / {expected_size} byte"
                    )
                if not content.startswith(b"GRIB"):
                    return None, f"Range GRIB2 başlangıcı taşımıyor ({start}-{end})"
                return (start, content), None

            downloaded_ranges = []
            range_errors = []
            workers = min(NOAA_RANGE_DOWNLOAD_WORKERS, len(ranges))
            with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
                futures = [
                    executor.submit(fetch_range, byte_range)
                    for byte_range in ranges
                ]
                for future in as_completed(futures):
                    item, error = future.result()
                    if error:
                        range_errors.append(error)
                    else:
                        downloaded_ranges.append(item)

            if range_errors:
                source_errors.append(
                    f"{source_name}: " + "; ".join(range_errors[:3])
                )
                print(
                    f"[NOAA SOURCE MISS] {source_name} byte-range indirmesi "
                    "eksik; diğer kaynak deneniyor."
                )
                continue

            downloaded_ranges.sort(key=lambda item: item[0])
            grib_bytes = b"".join(
                item_content for _, item_content in downloaded_ranges
            )
            if not grib_bytes.startswith(b"GRIB"):
                source_errors.append(
                    f"{source_name} indirilen mesajlar geçerli GRIB2 oluşturmadı"
                )
                continue

            print(
                f"[NOAA SOURCE OK] {filename} kaynağı={source_name}; "
                f"{len(downloaded_ranges)} GRIB2 mesajı, "
                f"{len(grib_bytes):,} byte / {object_size:,} byte."
            )
            return grib_bytes, None, filename

        except requests.RequestException as exc:
            source_errors.append(
                f"{source_name}: {type(exc).__name__}: {exc}"
            )
            print(
                f"[NOAA SOURCE ERROR] {source_name} {filename}: {exc}; "
                "diğer kaynak deneniyor."
            )
        except Exception as exc:
            source_errors.append(
                f"{source_name}: {type(exc).__name__}: {exc}"
            )
            print(
                f"[NOAA SOURCE ERROR] {source_name} {filename}: {exc}; "
                "diğer kaynak deneniyor."
            )

    return (
        None,
        " | ".join(source_errors) if source_errors else "NOAA kaynakları yanıt vermedi",
        filename,
    )


def _decode_noaa_grib_step(run_id, lead, grib_bytes):
    """Decode one native GRIB2 lead into compact Istanbul values before final assembly."""
    filename = f"gfs.t{_parse_utc_datetime(run_id):%H}z.pgrb2.0p25.f{int(lead):03d}"
    points = {"Istanbul": (LAT, LON)}
    step_data = {
        "temperature": None,
        "temperature_850": None,
        "wind_u": None,
        "wind_v": None,
        "wind_850_u": None,
        "wind_850_v": None,
        "precip_records": {},
        "pressure_analysis": None,
        "pressure_grid": None,
    }

    try:
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
                            or (short_name == "t" and level_type == "isobaricInhPa" and level == 850)
                            or (short_name in ("10u", "10v") and level_type == "heightAboveGround" and level == 10)
                            or (short_name in ("u", "v") and level_type == "isobaricInhPa" and level == 850)
                            or (short_name == "tp" and level_type == "surface")
                            or (short_name == "prmsl" and level_type == "meanSea")
                        )
                        if not is_target:
                            continue

                        values = np.asarray(eccodes.codes_get_values(gid), dtype=float)
                        latitudes = np.asarray(eccodes.codes_get_array(gid, "latitudes"), dtype=float)
                        longitudes = np.asarray(eccodes.codes_get_array(gid, "longitudes"), dtype=float)
                        if len(values) != len(latitudes) or len(values) != len(longitudes):
                            raise ValueError(f"GRIB grid mismatch in {filename}")

                        if short_name == "prmsl":
                            step_data["pressure_grid"] = (values, latitudes, longitudes)
                            continue

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
                        elif short_name == "t" and level_type == "isobaricInhPa" and level == 850:
                            step_data["temperature_850"] = samples
                        elif short_name == "10u":
                            step_data["wind_u"] = samples
                        elif short_name == "10v":
                            step_data["wind_v"] = samples
                        elif short_name == "u" and level_type == "isobaricInhPa" and level == 850:
                            step_data["wind_850_u"] = samples
                        elif short_name == "v" and level_type == "isobaricInhPa" and level == 850:
                            step_data["wind_850_v"] = samples
                        elif short_name == "tp":
                            step_data["precip_records"][(start_step, end_step)] = samples
                    finally:
                        eccodes.codes_release(gid)

        if not step_data["temperature"]:
            return None, "missing 2m temperature field"
        if not step_data["wind_850_u"] or not step_data["wind_850_v"]:
            return None, "missing 850 hPa U/V wind fields"

        if int(lead) == 0:
            alerts, centre_pressure_hpa = analyse_regional_pressure_grid(
                step_data.pop("pressure_grid")
            )
            step_data["pressure_analysis"] = {
                "alerts": alerts,
                "centre_pressure_hpa": centre_pressure_hpa,
            }
        else:
            step_data.pop("pressure_grid", None)

        return step_data, None
    except Exception as exc:
        return None, f"{type(exc).__name__}: {exc}"


def prune_noaa_cache():
    """NOAA GRIB önbelleği kapatıldı. Eski dosyalar artık yazılmıyor."""
    return None

def clear_noaa_run_cache(run_id):
    cache_dir = _noaa_run_cache_dir(run_id)
    if os.path.isdir(cache_dir):
        try:
            shutil.rmtree(cache_dir)
            _mark_noaa_cache_updated()
            print(f"[NOAA CACHE CLEAR] İşlenen döngünün geçici önbelleği temizlendi: {run_id}")
        except OSError as exc:
            print(f"[NOAA CACHE UYARI] İşlenen önbellek temizlenemedi: {exc}")


def gfs_forecast_hours(max_hour=MIN_FORECAST_HOURS):
    """Return native GFS 0.25-degree lead hours: hourly to 120h, then every 3h."""
    max_hour = max(0, int(max_hour))
    hours = list(range(0, min(max_hour, 120) + 1))
    if max_hour >= 123:
        hours.extend(range(123, max_hour + 1, 3))
    return hours


def missing_noaa_cache_leads(run_id, max_hour=MIN_FORECAST_HOURS - 3):
    """List forecast leads that must be cached before the final f180 trigger."""
    return [
        lead for lead in gfs_forecast_hours(max_hour)
        if _read_noaa_decoded_cache_file(run_id, lead) is None
    ]


def prefetch_noaa_cycle_if_due(skip_run_ids=None, target_run_id=None):
    """Run one incremental prefetch for this poll; the watch loop owns the cadence."""
    return prefetch_latest_noaa_cycle(skip_run_ids, target_run_id)


def prefetch_latest_noaa_cycle(skip_run_ids=None, target_run_id=None):
    """Cache every available GFS input file through f177 for the latest or selected cycle."""
    skip_run_ids = set(skip_run_ids or ())
    now = datetime.now(timezone.utc)

    if target_run_id:
        run_dt = _parse_utc_datetime(target_run_id)
    else:
        cycle_hour = (now.hour // 6) * 6
        run_dt = now.replace(
            hour=cycle_hour, minute=0, second=0, microsecond=0
        )

    run_id = run_dt.isoformat(timespec="seconds")
    if run_id in skip_run_ids:
        print(f"[NOAA PREFETCH SKIP] {run_id} zaten NOAA +180 envanterinde.")
        return 0

    os.makedirs(NOAA_CACHE_DIR, exist_ok=True)
    # f000-f120 are hourly; after f120, 0.25-degree GFS files are 3-hourly.
    # f177 is the final predecessor of the f180 completion trigger.
    leads = gfs_forecast_hours(MIN_FORECAST_HOURS - 3)
    missing = [
        lead for lead in leads
        if _read_noaa_decoded_cache_file(run_id, lead) is None
    ]
    cached_count = len(leads) - len(missing)
    if not missing:
        print(f"[NOAA PREFETCH READY] {run_id}: {len(leads)}/{len(leads)} GRIB2 dosyası önbellekte.")
        return 0

    batch = missing[:NOAA_PREFETCH_FILES_PER_CHECK]
    session = requests.Session()
    headers = {"User-Agent": "GFS-Watch/1.0"}
    downloaded = 0

    print(
        f"[NOAA PREFETCH] {run_id}: {cached_count}/{len(leads)} hazır; "
        f"bu kontrolde en fazla {len(batch)} dosya indirilecek (NOMADS öncelikli, AWS S3 yedekli byte-range)."
    )
    try:
        for lead in batch:
            _, _, filename = _noaa_grib_source_urls(run_dt, lead)[0]
            print(f"[NOAA PREFETCH] {filename} gerekli alanları NOMADS/AWS S3 hedefinden byte-range ile alınıyor...")
            grib_bytes = _read_noaa_cache_file(run_id, lead)
            if grib_bytes is None:
                grib_bytes, error, _ = _download_noaa_grib_file(
                    session, run_dt, lead, headers
                )
                if error:
                    print(
                        f"[NOAA PREFETCH PENDING] {filename} henüz alınamadı: {error}; "
                        "sonraki kontrolde tekrar denenecek."
                    )
                    break
                _write_noaa_cache_file(run_id, lead, grib_bytes)

            step_data, decode_error = _decode_noaa_grib_step(
                run_id, lead, grib_bytes
            )
            if decode_error:
                print(
                    f"[NOAA PREFETCH DECODE PENDING] {filename}: {decode_error}; "
                    "sonraki taramada tekrar denenecek."
                )
                break
            _write_noaa_decoded_cache_file(run_id, lead, step_data)
            downloaded += 1
            print(
                f"[NOAA PREFETCH OK] {filename}: "
                f"{len(grib_bytes)} byte GRIB2 indirildi ve Istanbul verileri "
                "önceden çözümlenerek önbelleğe alındı."
            )
    finally:
        session.close()

    print(
        f"[NOAA PREFETCH BATCH] {run_id}: bu kontrolde {downloaded} yeni GRIB2 lead "
        f"önceden çözüldü; hazır veri {cached_count + downloaded}/{len(leads)}."
    )
    return downloaded


def _meteopt_number(value):
    """Return a finite float from a MeteoPT cell, or None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def fetch_meteopt_document(run_dt=None):
    """Fetch the newest GFS cycle exposed by MeteoPT, or an explicitly requested cycle.

    The website's currently updating run is the source of truth. The API's run
    token is checked against the requested hour when a fixed cycle is supplied.
    """
    params = {
        "lat": f"{LAT:.4f}",
        "lon": f"{LON:.4f}",
        "lang": "en",
    }
    if run_dt is not None:
        params["run"] = _parse_utc_datetime(run_dt).strftime("%H")
    response = requests.get(
        "https://api.meteopt.com/gfs/json",
        params=params,
        headers={"User-Agent": "GFS-Watch/1.0"},
        timeout=40,
    )
    response.raise_for_status()
    document = response.json()
    token = str(document.get("run") or "").strip()
    if len(token) != 10 or not token.isdigit():
        raise ValueError(f"MeteoPT geçerli run kimliği döndürmedi: {token or 'boş'}")
    actual_run = datetime.strptime(token, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    if run_dt is not None:
        expected = _parse_utc_datetime(run_dt)
        if actual_run != expected:
            raise ValueError(
                f"MeteoPT {token} döndü, istenen {expected:%Y%m%d%H}"
            )
    print(
        f"[METEOPT DISCOVERY] Kaynağın bildirdiği aktif döngü: "
        f"{actual_run.isoformat(timespec='seconds')}"
    )
    return document


def _meteopt_max_step(document):
    steps = (document.get("steps") or {}).get("values") or []
    numbers = []
    for step in steps:
        try:
            numbers.append(int(step))
        except (TypeError, ValueError):
            continue
    return max(numbers) if numbers else 0


def _meteopt_rows_through_f180(document):
    """Positive 3-hour steps up to f180. Sixty of these is the publish trigger."""
    rows = []
    for step in (document.get("steps") or {}).get("values") or []:
        try:
            hour = int(step)
        except (TypeError, ValueError):
            continue
        if 0 < hour <= MIN_FORECAST_HOURS:
            rows.append(hour)
    return rows


def _meteopt_f180_ready(document):
    rows = _meteopt_rows_through_f180(document)
    return MIN_FORECAST_HOURS in rows and len(rows) >= 60


METEOPT_PACKAGE_HOURS = (40, 120, 170, 180)


def _staging_file(run_id):
    key = _parse_utc_datetime(run_id).strftime("%Y%m%dT%HZ")
    directory = os.path.join(PUBLIC_DATA_DIR, "staging")
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, key + ".json")


def _load_stage(run_id):
    try:
        with open(_staging_file(run_id), encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError, TypeError):
        pass
    return {
        "run_id": run_id,
        "max_hour": 0,
        "row_count": 0,
        "milestones": [],
        "comparison_ready": False,
    }


def _save_stage(run_id, stage):
    _write_json_atomically(_staging_file(run_id), stage)


def _payload_reaches_f180(payload):
    timeline = payload.get("timeline_180h") if isinstance(payload, dict) else None
    if not isinstance(timeline, dict):
        return False
    for values in timeline.values():
        if isinstance(values, dict) and int(values.get("step_hour") or 0) >= MIN_FORECAST_HOURS:
            return True
    return False


def scheduled_istanbul_gfs_run(now=None):
    """Return the GFS cycle whose f180 publication window is currently active.

    MeteoPT's four daily GFS outputs are published on the Istanbul schedule:
    00Z -> 07:20, 06Z -> 13:20, 12Z -> 19:20, 18Z -> 01:20.
    The monitor therefore checks the cycle assigned to the current window on
    every 10-minute invocation instead of trusting MeteoPT's generic 'active'
    run token, which may remain on an older cycle while the next run is updating.
    """
    local_now = (now or datetime.now(TR_TZ)).astimezone(TR_TZ)
    minute = local_now.hour * 60 + local_now.minute

    if minute >= 7 * 60 + 20 and minute < 13 * 60 + 20:
        day, hour = local_now.date(), 0
    elif minute >= 13 * 60 + 20 and minute < 19 * 60 + 20:
        day, hour = local_now.date(), 6
    elif minute >= 19 * 60 + 20:
        day, hour = local_now.date(), 12
    elif minute < 1 * 60 + 20:
        day, hour = local_now.date() - timedelta(days=1), 12
    else:
        day, hour = local_now.date() - timedelta(days=1), 18

    return datetime(day.year, day.month, day.day, hour, tzinfo=timezone.utc)


def meteopt_expected_cycle(now=None):
    """Return the cycle that should be checked at this Istanbul time."""
    return scheduled_istanbul_gfs_run(now)


async def stage_open_meteopt_cycle(processed_run_ids):
    """Track the active MeteoPT cycle on each poll; publish its f72 as soon as available.

    Full report/Telegram publication is still gated on f180 and is handled by
    process_gfs_update once the active cycle reaches that threshold.
    """
    if os.getenv("GFS_SOURCE", "meteopt").strip().lower() == "noaa":
        return None
    expected_run_dt = meteopt_expected_cycle()
    print(
        f"[METEOPT WINDOW] İstanbul {datetime.now(TR_TZ):%H:%M} TSİ -> "
        f"{expected_run_dt:%Y-%m-%d %HZ} döngüsü kontrol ediliyor."
    )
    try:
        document = await asyncio.to_thread(fetch_meteopt_document, expected_run_dt)
    except Exception as exc:
        print(
            f"[METEOPT STAGE ERROR] Beklenen {expected_run_dt:%Y%m%d%H} döngüsü "
            f"henüz kaynaktan doğrulanamadı: {type(exc).__name__}: {exc}"
        )
        return False

    token = str(document.get("run") or "").strip()
    run_dt = datetime.strptime(token, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    run_id = run_dt.isoformat(timespec="seconds")
    if run_id in processed_run_ids:
        print(f"[METEOPT STAGE] {run_id} was already published.")
        return None

    rows = _meteopt_rows_through_f180(document)
    max_hour = max(rows) if rows else _meteopt_max_step(document)
    stage = _load_stage(run_id)
    previous = int(stage.get("max_hour") or 0)
    milestones = [int(hour) for hour in stage.get("milestones") or []]
    if max_hour > previous:
        crossed = [
            hour for hour in METEOPT_PACKAGE_HOURS
            if previous < hour <= max_hour and hour not in milestones
        ]
        stage.update({
            "run_id": run_id,
            "max_hour": max_hour,
            "row_count": len(rows),
            "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        })
        stage["milestones"] = milestones + crossed
        _save_stage(run_id, stage)
        for hour in crossed:
            print(f"[METEOPT STAGE] {run_id}: +{hour}h reached; {len(rows)} steps cached.")
    else:
        print(f"[METEOPT STAGE] {run_id}: latest step +{max_hour}h; {len(rows)} usable steps.")

    # The first-72-hour data table is a separate, early product. Refresh it
    # every time the active cycle advances beyond f72.
    if max_hour >= 72:
        data = document.get("data") or {}
        raw_steps = (document.get("steps") or {}).get("values") or []
        fields = {
            "temperature_2m_c": ((data.get("tmp2m") or {}).get("values") or []),
            "temperature_850hpa_c": ((data.get("tmp850mb") or {}).get("values") or []),
            "wind_speed_10m_kmh": ((data.get("wind10m") or {}).get("values") or []),
            "wind_speed_850hpa_kmh": ((data.get("wind850") or {}).get("values") or []),
            "precipitation_6h_mm": ((data.get("apcp") or {}).get("values") or []),
        }
        table_points = []
        for index, raw_step in enumerate(raw_steps):
            try:
                lead = int(raw_step)
            except (TypeError, ValueError):
                continue
            if lead <= 0 or lead > 72:
                continue
            valid = run_dt + timedelta(hours=lead)
            point = {
                "forecast_hour": lead,
                "valid_time_utc": valid.isoformat(timespec="minutes"),
            }
            for field, values in fields.items():
                point[field] = _meteopt_number(values[index]) if index < len(values) else None
            if point["temperature_2m_c"] is not None:
                table_points.append(point)
        if table_points and max(p["forecast_hour"] for p in table_points) >= 72:
            _write_json_atomically(
                os.path.join(PUBLIC_DATA_DIR, "meteopt-gfs-first72.json"),
                {
                    "schema": "gfs-watch.meteopt-first72.v1",
                    "forecast_source": "meteopt",
                    "run_id_utc": run_id,
                    "published_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    "forecast_6_hourly": table_points,
                },
            )
            print(f"[METEOPT STAGE] {run_id}: first 72-hour table refreshed.")

    if max_hour >= 40 and max_hour < MIN_FORECAST_HOURS and not stage.get("comparison_ready"):
        try:
            await load_previous_three_runs_for_comparison(run_id)
            stage["comparison_ready"] = True
            _save_stage(run_id, stage)
        except Exception as exc:
            print(f"[METEOPT STAGE] Comparison warm-up deferred: {exc}")

    return _meteopt_f180_ready(document)


def fetch_meteopt_available_runs():
    """Discover the active MeteoPT run and publish it only once its f180 exists."""
    expected_run_dt = meteopt_expected_cycle()
    print(
        f"[METEOPT DISCOVERY] İstanbul {datetime.now(TR_TZ):%H:%M} TSİ -> "
        f"{expected_run_dt:%Y-%m-%d %HZ} döngüsü için f180 kontrolü."
    )
    try:
        document = fetch_meteopt_document(expected_run_dt)
    except Exception as exc:
        print(
            f"[METEOPT DISCOVERY ERROR] Beklenen {expected_run_dt:%Y%m%d%H} "
            f"döngüsü henüz doğrulanamadı: {type(exc).__name__}: {exc}"
        )
        return []

    token = str(document.get("run") or "").strip()
    run_dt = datetime.strptime(token, "%Y%m%d%H").replace(tzinfo=timezone.utc)
    run_id = run_dt.isoformat(timespec="seconds")
    rows = _meteopt_rows_through_f180(document)
    max_step = max(rows) if rows else _meteopt_max_step(document)

    if not _meteopt_f180_ready(document):
        print(
            f"[METEOPT PENDING] Aktif döngü {run_id}; "
            f"son adım +{max_step} saat, f180 için 60 adım bekleniyor. "
            "On dakika sonraki taramada aynı kaynak yeniden sorgulanacak."
        )
        return []

    now_utc = datetime.now(timezone.utc).isoformat(timespec="seconds")
    candidate = {
        "model": MODEL_NAME,
        "metadata_source": "MeteoPT GFS 3-hourly point",
        "run_id": run_id,
        "last_run_initialisation_time": run_id,
        "last_run_availability_time": now_utc,
        "last_modified_time": now_utc,
        "last_valid_time": (
            run_dt + timedelta(hours=MIN_FORECAST_HOURS)
        ).isoformat(timespec="minutes"),
        "forecast_horizon_hours": MIN_FORECAST_HOURS,
        "completed": True,
        "noaa_f180_available": False,
        "source_name": "MeteoPT",
        "source_url": (
            "https://api.meteopt.com/gfs/json"
            f"?lat={LAT:.4f}&lon={LON:.4f}&run={run_dt:%H}"
        ),
        "meteopt_steps": len(rows),
    }
    print(
        f"[METEOPT F180 READY] {run_id}: +180 dahil {len(rows)} satır hazır. "
        "Aynı paket Pages ve Telegram raporuna aktarılacak."
    )
    return [candidate]


def fetch_meteopt_weather_data(run_id):
    """Build the forecast payload from MeteoPT's native 3-hour GFS point."""
    print(f"[STEP 1] MeteoPT GFS 3 saatlik nokta alınıyor: {run_id}")
    run_dt = _parse_utc_datetime(run_id)
    try:
        document = fetch_meteopt_document(run_dt)
    except Exception as exc:
        print(f"[STEP 1 HATA] MeteoPT erişilemedi: {type(exc).__name__}: {exc}")
        return None

    if not _meteopt_f180_ready(document):
        rows = _meteopt_rows_through_f180(document)
        reason = (
            f"MeteoPT f180 satırı henüz yok; şu an {len(rows)} satır. "
            "60 satır dolunca basılacak, serinin sonrası beklenmeyecek."
        )
        print(f"[PENDING] {reason}")
        return {
            "_pending_noaa_gfs": True,
            "_run_id": run_id,
            "_reason": reason,
        }

    data = document.get("data") or {}
    steps = []
    for step in (document.get("steps") or {}).get("values") or []:
        try:
            steps.append(int(step))
        except (TypeError, ValueError):
            steps.append(None)

    def series(name):
        return ((data.get(name) or {}).get("values") or [])

    temperature = series("tmp2m")
    temperature_850 = series("tmp850mb")
    precipitation = series("apcp")
    wind = series("wind10m")
    wind_direction = series("wind10mdir")
    wind_850 = series("wind850")
    pressure = series("prmsl")
    forecast_timeline = {}
    daily_buckets = {}

    for index, lead in enumerate(steps):
        if lead is None or lead <= 0 or lead > MIN_FORECAST_HOURS or index >= len(temperature):
            continue
        temp = _meteopt_number(temperature[index])
        if temp is None:
            continue
        valid_utc = run_dt + timedelta(hours=lead)
        valid_local = valid_utc.astimezone(TR_TZ)
        precip = _meteopt_number(precipitation[index]) if index < len(precipitation) else None
        wind_value = _meteopt_number(wind[index]) if index < len(wind) else None
        direction = _meteopt_number(wind_direction[index]) if index < len(wind_direction) else None
        temp_850 = _meteopt_number(temperature_850[index]) if index < len(temperature_850) else None
        wind_850_value = _meteopt_number(wind_850[index]) if index < len(wind_850) else None
        forecast_timeline[valid_local.strftime("%Y-%m-%dT%H:%M")] = {
            "step_hour": lead,
            "temp": round(temp, 1),
            "temp_850": round(temp_850, 1) if temp_850 is not None else None,
            "wind": round(wind_value, 1) if wind_value is not None else None,
            "wind_850": round(wind_850_value, 1) if wind_850_value is not None else None,
            "wind_direction_deg": round(direction, 1) if direction is not None else None,
            "precip": round(max(0.0, precip), 2) if precip is not None else None,
        }
        bucket = daily_buckets.setdefault(
            valid_local.date().isoformat(),
            {"temps": [], "temps_850": [], "precips": [], "winds": [], "winds_850": []},
        )
        bucket["temps"].append(round(temp, 1))
        if temp_850 is not None:
            bucket["temps_850"].append(round(temp_850, 1))
        if precip is not None:
            bucket["precips"].append(max(0.0, precip))
        if wind_value is not None:
            bucket["winds"].append(wind_value)
        if wind_850_value is not None:
            bucket["winds_850"].append(wind_850_value)

    if len(forecast_timeline) < 40:
        print(f"[STEP 1 HATA] MeteoPT +{MIN_FORECAST_HOURS} saat için yetersiz nokta.")
        return None

    daily_dates = sorted(daily_buckets)
    daily = {
        "time": daily_dates,
        "temp_max": [round(max(daily_buckets[day]["temps"]), 1) for day in daily_dates],
        "temp_min": [round(min(daily_buckets[day]["temps"]), 1) for day in daily_dates],
        "temp_850_max": [
            round(max(daily_buckets[day]["temps_850"]), 1) if daily_buckets[day]["temps_850"] else None
            for day in daily_dates
        ],
        "temp_850_min": [
            round(min(daily_buckets[day]["temps_850"]), 1) if daily_buckets[day]["temps_850"] else None
            for day in daily_dates
        ],
        "precip_sum": [round(sum(daily_buckets[day]["precips"]), 1) for day in daily_dates],
        "wind_max": [
            round(max(daily_buckets[day]["winds"]), 1) if daily_buckets[day]["winds"] else None
            for day in daily_dates
        ],
        "wind_850_max": [
            round(max(daily_buckets[day]["winds_850"]), 1) if daily_buckets[day]["winds_850"] else None
            for day in daily_dates
        ],
    }
    first = next(iter(forecast_timeline.values()))
    place = (document.get("geodata") or {}).get("place") or "Istanbul"
    payload = {
        "current": {
            "temp": first["temp"],
            "precip": 0.0,
            "wind": first["wind"],
            "pressure": _meteopt_number(pressure[0]) if pressure else None,
        },
        "daily": daily,
        "timeline_180h": forecast_timeline,
        # Keep MeteoPT's native point series for the isolated raw-model table.
        # Existing forecast consumers continue using the unchanged timeline fields.
        "meteopt_table_raw": {
            "steps": steps,
            "series": {
                str(name): [
                    _meteopt_number(value)
                    for value in ((entry or {}).get("values") or [])
                ]
                for name, entry in data.items()
                if isinstance(entry, dict) and isinstance(entry.get("values"), list)
            },
        },
        "forecast_horizon_hours": MIN_FORECAST_HOURS,
        "synoptic_alerts": [],
        "initial_source": "MeteoPT GFS noktası +3 saatten başlar; ayrı analiz saati yok",
        "data_source": (
            f"MeteoPT GFS 3 saatlik nokta ({place}); "
            f"hedef {LAT:.3f}N, {LON:.3f}E; adımlar +3…+{MIN_FORECAST_HOURS}"
        ),
    }
    print(
        f"[STEP 1 BAŞARILI] MeteoPT {document.get('run')} alındı; "
        f"{len(forecast_timeline)} adet 3 saatlik nokta."
    )
    return payload


def fetch_full_weather_data(run_id):
    """Assemble one GFS cycle. MeteoPT's 3-hour point is the default source."""
    if os.getenv("GFS_SOURCE", "meteopt").strip().lower() != "noaa":
        return fetch_meteopt_weather_data(run_id)
    print(f"[STEP 1] NOAA/NCEP GRIB2 verisi çekiliyor: {run_id}")
    try:
        run_dt = _parse_utc_datetime(run_id)
        date_token = run_dt.strftime("%Y%m%d")
        cycle = run_dt.strftime("%H")
        # Required native GRIB2 messages are fetched from NOMADS, then the AWS S3 mirror.
        # Only retrieve the model grid cell nearest to the requested coordinate.
        # For 41.014N, 28.950E this is the GFS 0.25-degree node at 41.000N, 29.000E.
        points = {"Istanbul": (LAT, LON)}
        session = requests.Session()
        headers = {"User-Agent": "GFS-Watch/1.0"}

        # Probe the target horizon first. Metadata can report +180 while a
        # particular GRIB forecast file is still being published.
        # Build the native GFS 0.25-degree timeline: hourly to +120h,
        # then +123h, +126h, ... +180h. This explicitly includes f177 and f180.
        lead_hours = gfs_forecast_hours(MIN_FORECAST_HOURS)
        download_order = [MIN_FORECAST_HOURS] + [
            h for h in lead_hours if h != MIN_FORECAST_HOURS
        ]
        decoded_steps = {}
        previous_lead_by_lead = {
            lead: (lead_hours[index - 1] if index > 0 else None)
            for index, lead in enumerate(lead_hours)
        }

        for position, lead in enumerate(download_order):
            step_data = _read_noaa_decoded_cache_file(run_id, lead)
            if step_data is not None:
                print(f"[NOAA DECODED CACHE HIT] f{lead:03d}: önceden çözümlenmiş İstanbul verisi kullanılıyor.")
            else:
                grib_bytes = _read_noaa_cache_file(run_id, lead)
                if grib_bytes is not None:
                    print(
                        f"[NOAA GRIB2 CACHE HIT] f{lead:03d}: "
                        f"{len(grib_bytes)} byte ham GRIB2 önbellekten alındı."
                    )
                else:
                    _, _, filename = _noaa_grib_source_urls(run_dt, lead)[0]
                    print(
                        f"[NOAA FILE] {filename} NOMADS/AWS S3 hedefinden gerekli "
                        f"GRIB2 alanlarıyla alınıyor ({position + 1}/{len(download_order)})..."
                    )
                    grib_bytes, error, _ = _download_noaa_grib_file(
                        session, run_dt, lead, headers
                    )
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

                step_data, decode_error = _decode_noaa_grib_step(
                    run_id, lead, grib_bytes
                )
                if decode_error:
                    print(
                        f"[PENDING] NOAA f{lead:03d} GRIB2 çözümlenemedi: "
                        f"{decode_error}"
                    )
                    return {
                        "_pending_noaa_gfs": True,
                        "_run_id": run_id,
                        "_forecast_hour": lead,
                        "_reason": decode_error,
                    }
                _write_noaa_decoded_cache_file(run_id, lead, step_data)

            decoded_steps[lead] = step_data
            print(
                f"[NOAA BAŞARILI] f{lead:03d}: "
                f"{len(step_data['precip_records'])} yağış aralığı; "
                "önceden çözümlenmiş veri hazır."
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
            wind_850_u = step_data["wind_850_u"] or {}
            wind_850_v = step_data["wind_850_v"] or {}

            temp_c = {
                name: float(value) - 273.15
                for name, value in temperature.items()
            }
            temperature_850 = step_data.get("temperature_850") or {}
            temp_850_c = {name: float(value) - 273.15 for name, value in temperature_850.items()}
            wind_kmh = {}
            wind_850_kmh = {}
            wind_direction_deg = {}
            for name in points:
                u_value = wind_u.get(name)
                v_value = wind_v.get(name)
                if u_value is not None and v_value is not None:
                    wind_kmh[name] = math.hypot(float(u_value), float(v_value)) * 3.6
                    # Meteorological direction: compass direction the wind comes FROM.
                    if math.hypot(float(u_value), float(v_value)) >= 0.2:
                        wind_direction_deg[name] = (math.degrees(math.atan2(-float(u_value), -float(v_value))) + 360.0) % 360.0
                u850_value = wind_850_u.get(name)
                v850_value = wind_850_v.get(name)
                if u850_value is not None and v850_value is not None:
                    wind_850_kmh[name] = math.hypot(float(u850_value), float(v850_value)) * 3.6

            # Select only the precipitation interval ending at this lead.
            # GFS 0.25-degree output is hourly through +120h and 3-hourly after.
            # Prefer the exact interval since the preceding available lead;
            # otherwise difference the cumulative (0, lead) field.
            precip_by_point = {name: 0.0 for name in points}
            if lead > 0:
                records = step_data["precip_records"]
                interval_start = previous_lead_by_lead[lead]
                interval_key = (interval_start, lead)
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
                        f"[NOAA UYARI] f{lead:03d} için beklenen yağış aralığı "
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
            istanbul_wind_850 = round(wind_850_kmh["Istanbul"], 1)
            forecast_timeline[time_key] = {
                "step_hour": lead,
                "temp": istanbul_temp,
                "temp_850": round(temp_850_c["Istanbul"], 1) if "Istanbul" in temp_850_c else None,
                "wind": istanbul_wind,
                "wind_850": istanbul_wind_850,
                "wind_direction_deg": round(wind_direction_deg["Istanbul"], 1) if "Istanbul" in wind_direction_deg else None,
                # A 06Z/12Z/18Z run has no precipitation interval before its
                # own initialization; do not compare that lead-0 placeholder.
                "precip": None if lead == 0 else istanbul_precip,
            }

            day_key = valid_local.date().isoformat()
            bucket = daily_buckets.setdefault(
                day_key, {"temps": [], "temps_850": [], "precips": [], "winds": [], "winds_850": []}
            )
            bucket["temps"].append(istanbul_temp)
            if "Istanbul" in temp_850_c:
                bucket["temps_850"].append(round(temp_850_c["Istanbul"], 1))
            if lead > 0:
                bucket["precips"].append(istanbul_precip)
            bucket["winds"].append(istanbul_wind)
            bucket["winds_850"].append(istanbul_wind_850)

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
            "temp_850_max": [round(max(daily_buckets[day]["temps_850"]), 1) if daily_buckets[day]["temps_850"] else None for day in daily_dates],
            "temp_850_min": [round(min(daily_buckets[day]["temps_850"]), 1) if daily_buckets[day]["temps_850"] else None for day in daily_dates],
            "precip_sum": [
                round(sum(daily_buckets[day]["precips"]), 1)
                for day in daily_dates
            ],
            "wind_max": [
                round(max(daily_buckets[day]["winds"]), 1)
                for day in daily_dates
            ],
            "wind_850_max": [
                round(max(daily_buckets[day]["winds_850"]), 1)
                for day in daily_dates
            ],
        }

        # Current snapshot and regional MSLP diagnostics are both decoded from
        # the same f000 native NOAA GRIB2 file. No weather API is called.
        initial = decoded_steps[0]
        initial_temp = initial["temperature"]
        initial_wind_u = initial["wind_u"] or {}
        initial_wind_v = initial["wind_v"] or {}
        current_wind = math.hypot(
            float(initial_wind_u.get("Istanbul", 0.0)),
            float(initial_wind_v.get("Istanbul", 0.0)),
        ) * 3.6
        pressure_analysis = initial.get("pressure_analysis") or {}
        synoptic_alerts = pressure_analysis.get("alerts", [])
        initial_pressure_hpa = pressure_analysis.get("centre_pressure_hpa")
        current = {
            "temp": round(float(initial_temp["Istanbul"]) - 273.15, 1),
            "precip": 0.0,
            "wind": round(current_wind, 1),
            "pressure": initial_pressure_hpa,
        }

        payload = {
            "current": current,
            "daily": daily,
            "timeline_180h": forecast_timeline,
            "forecast_horizon_hours": MIN_FORECAST_HOURS,
            "synoptic_alerts": synoptic_alerts,
            "data_source": (
                "NOAA/NCEP GFS 0.25° native GRIB2 (NOMADS/AWS S3 indexed byte-range); "
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
    curr_w = curr["wind"]

    # The station reading and the three-day spoken summary are not part of the report.
    station = payload.get("station_observation")
    speech_text = ""
    daily_indices = range(1, min(4, len(daily.get("time", []))))

    now_local = datetime.now(TR_TZ)
    run_utc = _parse_utc_datetime(current_run_name)
    run_local = run_utc.astimezone(TR_TZ)
    forecast_end_utc = run_utc + timedelta(hours=payload.get("forecast_horizon_hours", MIN_FORECAST_HOURS))

    text_report_lines = [
        f"🌦 {APP_LABEL}",
        "İSTANBUL GFS TAHMİN RAPORU",
        f"🛰 Model döngüsü: {run_utc:%d.%m.%Y %H:%M} UTC ({run_utc:%H}Z)",
        f"🕒 Rapor zamanı: {_format_tr_datetime(now_local)} TSİ",
        "📍 Konum: İstanbul, Türkiye",
        "",
        "",
    ]
    if station:
        observed_local = _parse_utc_datetime(
            station["observed_at_utc"]
        ).astimezone(TR_TZ)
        freshness_label = "GECİKMELİ ÖLÇÜM" if station.get("is_stale") else "SON İSTASYON ÖLÇÜMÜ"
        text_report_lines.extend([
            f"📡 ENKA BALMUMCU İSTASYON GÖZLEMİ · {freshness_label}",
            f"🕒 Ölçüm zamanı: {_format_tr_datetime(observed_local)} TSİ",
        ])
        if station.get("temperature_2m_c") is not None:
            text_report_lines.append(
                f"🌡 İstasyon sıcaklığı: {station['temperature_2m_c']:.1f}°C"
            )
        if station.get("precipitation_daily_mm") is not None:
            text_report_lines.append(
                f"🌧 Günlük toplam yağış: {station['precipitation_daily_mm']:.1f} mm"
            )
        if station.get("wind_speed_10m_kmh") is not None:
            direction = station.get("wind_direction_cardinal")
            direction_text = f" · yön: {direction}" if direction else ""
            text_report_lines.append(
                f"💨 İstasyon rüzgârı: {station['wind_speed_10m_kmh']:.1f} km/sa"
                f"{direction_text}"
            )
        text_report_lines.append("")
    else:
        text_report_lines.extend([
            "📡 ENKA BALMUMCU İSTASYON GÖZLEMİ: Bu rapor hazırlanırken ENKA verisi alınamadı.",
            "",
        ])
    # Kalan gün özeti: yalnızca rapor anından gece yarısına kadar olan
    # MeteoPT 3 saatlik tahmin noktaları hesaba katılır.
    today_points = []
    for local_time, values in sorted(timeline.items()):
        try:
            point_time = datetime.strptime(local_time, "%Y-%m-%dT%H:%M").replace(tzinfo=TR_TZ)
        except (TypeError, ValueError):
            continue
        if point_time.date() != now_local.date() or point_time <= now_local:
            continue
        if point_time.hour == 0 and point_time.minute == 0:
            continue
        today_points.append((point_time, values))

    midnight = (now_local + timedelta(days=1)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    remaining_points = [
        (point_time, values) for point_time, values in today_points
        if point_time < midnight
    ]
    remaining_rain = [
        (point_time, max(0.0, float(values["precip"])))
        for point_time, values in remaining_points
        if values.get("precip") is not None
    ]
    remaining_total = sum(value for _, value in remaining_rain)
    text_report_lines.extend([
        "🌆 GÜNÜN KALANINDA",
        (
            f"⏳ Süre: {_format_tr_datetime(now_local)} – "
            f"{_format_tr_datetime(midnight)} TSİ"
        ),
    ])
    if remaining_points:
        temps = [
            float(values["temp"]) for _, values in remaining_points
            if values.get("temp") is not None
        ]
        winds = [
            float(values["wind"]) for _, values in remaining_points
            if values.get("wind") is not None
        ]
        if temps:
            text_report_lines.append(
                f"🌡 Sıcaklık: {min(temps):.1f}–{max(temps):.1f}°C"
            )
        if winds:
            text_report_lines.append(
                f"💨 Rüzgâr: en fazla {max(winds):.1f} km/sa"
            )
        text_report_lines.append(f"🌧 Beklenen yağış: {remaining_total:.1f} mm")
        if remaining_rain and remaining_total > 0:
            peak_time, peak_value = max(remaining_rain, key=lambda item: item[1])
            # MeteoPT/GFS geçerlilik saatleri UTC'dir; raporda UTC olarak göster.
            peak_time_utc = peak_time - timedelta(hours=3)
            peak_start_utc = peak_time_utc - timedelta(hours=3)
            text_report_lines.append(
                f"📈 En belirgin yağış aralığı: "
                f"{peak_start_utc:%H:%M}–{peak_time_utc:%H:%M} UTC "
                f"(model noktası: {peak_value:.1f} mm / 3 saat)"
            )
    else:
        text_report_lines.append("Bu gece yarısına kadar kullanılabilir tahmin noktası bulunmuyor.")
    text_report_lines.extend(["", "📅 ÖNÜMÜZDEKİ 3 GÜN"])

    for i in daily_indices:
        day_key = daily["time"][i]
        day_label = _format_tr_date(day_key)
        t_max = round(daily["temp_max"][i], 1)
        t_min = round(daily["temp_min"][i], 1)
        p_sum = round(daily["precip_sum"][i], 1)
        w_max = round(daily["wind_max"][i], 1)
        wind_tag = " | Rüzgârlı" if w_max > 20.0 else ""
        text_report_lines.append(
            f"• {day_label}: {t_min}–{t_max}°C | Yağış: {p_sum} mm | "
            f"Maks. rüzgâr: {w_max} km/sa{wind_tag}"
        )

        # MeteoPT'nin 3 saatlik yağış noktalarını İstanbul yerel saatine göre
        # gün bazında grupla. Her nokta, bitiş saatinden önceki 3 saatlik
        # birikimi temsil eder; saatlik ara değer türetilmez.
        rain_points = []
        for local_time, values in timeline.items():
            if not str(local_time).startswith(day_key + "T"):
                continue
            raw_rain = values.get("precip")
            if raw_rain is None:
                continue
            try:
                amount = max(0.0, float(raw_rain))
                end_time = datetime.strptime(local_time, "%Y-%m-%dT%H:%M")
            except (TypeError, ValueError):
                continue
            if amount > 0:
                rain_points.append((end_time, amount))

        rain_points.sort(key=lambda item: item[0])
        if rain_points:
            # Ardışık 3 saatlik yağış noktalarını tek bir yağış periyodu yap.
            periods = []
            for end_time, amount in rain_points:
                if periods and end_time - periods[-1][-1][0] == timedelta(hours=3):
                    periods[-1].append((end_time, amount))
                else:
                    periods.append([(end_time, amount)])

            period_summaries = []
            for period in periods:
                peak_end, peak_amount = max(period, key=lambda item: item[1])
                start_time = period[0][0] - timedelta(hours=3)
                end_time = period[-1][0]
                period_total = sum(value for _, value in period)
                period_summaries.append({
                    "start": start_time,
                    "end": end_time,
                    "total": period_total,
                    "peak_end": peak_end,
                    "peak_amount": peak_amount,
                })

            # Günün en yüksek 3 saatlik birikimlerini göster; eşit zirveleri
            # koru, ancak uzun raporu önlemek için en fazla iki aralık yaz.
            highest = max(item["peak_amount"] for item in period_summaries)
            peak_periods = [
                item for item in period_summaries
                if item["peak_amount"] >= highest - 0.01
            ][:2]
            windows = []
            for item in peak_periods:
                # Timeline anahtarları İstanbul saatinde tutulur; GFS saatini UTC'ye çevir.
                peak_end_utc = item["peak_end"] - timedelta(hours=3)
                windows.append(
                    f"{peak_end_utc - timedelta(hours=3):%H:%M}–"
                    f"{peak_end_utc:%H:%M} UTC "
                    f"({item['peak_amount']:.1f} mm/3 sa)"
                )
            text_report_lines.append(
                "  ↳ Yağışın yoğunlaştığı saatler: " + " ve ".join(windows)
            )
        elif p_sum <= 0:
            text_report_lines.append("  ↳ Belirgin yağış beklenmiyor.")

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

    full_text_report = "\n".join(text_report_lines)

    print("[STEP 2 BAŞARILI] Rapor ve ses metni hazırlandı.")
    return full_text_report, speech_text


# --- GOOGLE CLOUD TTS MOTORU (1.27X HIZ) ---
def generate_speech_gcp(text, output_file="summary.mp3"):
    """Synchronous TTS function; the caller runs it in a background thread."""
    print("[TTS] Google Cloud TTS ile 1.27x hızında ses dosyası üretiliyor...")
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
            speaking_rate=1.27,
        )
        response = client.synthesize_speech(
            input=synthesis_input, voice=voice, audio_config=audio_config,
            timeout=20,
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
    if not text or not str(text).strip():
        print("[TTS ATLANDI] Seslendirilecek metin yok.")
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

def _telegram_enabled():
    """Yeni bir çıktı bir kez gider. GFS_TELEGRAM=0 ile tamamen kapanır."""
    return os.getenv("GFS_TELEGRAM", "1").strip().lower() in {"1", "true", "yes"}


async def _no_speech():
    return None


# --- TELEGRAM GÖNDERİCİ ---
async def send_telegram_text(text):
    if not _telegram_enabled():
        print("[TELEGRAM KAPALI] Metin gönderilmedi.")
        return
    if not TELEGRAM_TOKEN or not CHAT_ID:
        raise RuntimeError("TELEGRAM_TOKEN veya CHAT_ID eksik.")
    async with Bot(token=TELEGRAM_TOKEN) as bot:
        await bot.send_message(chat_id=CHAT_ID, text=text)
    print("[TELEGRAM] Metin bildirimi gönderildi.")


def _comparison_valid_time_key(local_key, values):
    """Return a canonical UTC key for a forecast valid time.

    The canonical Istanbul publisher stores the UTC timestamp alongside each
    local timeline key. Older compatibility payloads may lack that field, in
    which case the naive timeline key is interpreted as Europe/Istanbul.
    """
    raw_utc = values.get("valid_time_utc") if isinstance(values, dict) else None
    if raw_utc:
        parsed = _parse_utc_datetime(raw_utc)
    else:
        parsed = datetime.fromisoformat(str(local_key))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=TR_TZ)
        parsed = parsed.astimezone(timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat(timespec="minutes")


def _prepare_comparison_chart_data(current_run_id, payload, previous_runs):
    """Build four-cycle chart series aligned on identical forecast valid times."""
    entries = []
    for run_id, forecast_json in previous_runs:
        forecast_payload = (
            forecast_json if isinstance(forecast_json, dict)
            else json.loads(forecast_json)
        )
        entries.append((run_id, forecast_payload))
    entries.append((current_run_id, payload))
    entries.sort(key=lambda item: _parse_utc_datetime(item[0]))

    series = []
    for run_id, forecast_payload in entries:
        raw_timeline = forecast_payload.get("timeline_180h", {})
        if not isinstance(raw_timeline, dict) or not raw_timeline:
            raise ValueError(f"{run_id} için geçerlilik zamanı çizelgesi bulunamadı.")

        timeline_by_valid_time = {}
        for local_key, values in raw_timeline.items():
            if not isinstance(values, dict):
                continue
            valid_key = _comparison_valid_time_key(local_key, values)
            timeline_by_valid_time[valid_key] = (str(local_key), values)
        if not timeline_by_valid_time:
            raise ValueError(f"{run_id} için geçerli tahmin zamanı bulunamadı.")

        run_utc = _parse_utc_datetime(run_id)
        cycle_label = f"{run_utc:%H}Z | {run_utc:%d.%m %H:%M} UTC"
        if run_id == current_run_id:
            cycle_label = "YENİ · " + cycle_label
        series.append({
            "run_id": run_id,
            "label": cycle_label,
            "timeline_by_valid_time": timeline_by_valid_time,
            "timeline": {},
            "daily": {},
        })

    # The newest cycle defines the reference timeline. Older cycles are looked
    # up by exact UTC valid time, so different F-hour numbers can represent the
    # same Istanbul forecast instant (e.g. latest F54 vs older F60/F66/F72).
    common_valid_times = set(series[-1]["timeline_by_valid_time"])
    for item in series[:-1]:
        common_valid_times.intersection_update(item["timeline_by_valid_time"])
    ordered_valid_times = sorted(common_valid_times)
    if len(ordered_valid_times) < 2:
        raise ValueError("Dört döngünün ortak geçerlilik saati bulunamadı.")

    reference_timeline = series[-1]["timeline_by_valid_time"]
    for valid_key in ordered_valid_times:
        reference_local_key = reference_timeline[valid_key][0]
        for item in series:
            _, values = item["timeline_by_valid_time"][valid_key]
            # Re-key every cycle to the newest run's common TSİ timeline.
            item["timeline"][reference_local_key] = values

    dates = sorted({key[:10] for key in series[-1]["timeline"]})
    if not dates:
        raise ValueError("Dört döngünün ortak tahmin günü bulunamadı.")

    def numeric_values(timeline, day, field):
        values = []
        for local_key, point in timeline.items():
            if local_key[:10] != day:
                continue
            value = point.get(field)
            if value is None:
                continue
            try:
                value = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value):
                values.append(value)
        return values

    # Recalculate daily extrema from the same matched valid-time samples.
    # This keeps temperature candles, 850 hPa ranges and wind maxima on the
    # exact same set of timestamps rather than each run's private day window.
    for item in series:
        for day in dates:
            timeline = item["timeline"]
            temp = numeric_values(timeline, day, "temp")
            temp_850 = numeric_values(timeline, day, "temp_850")
            precip = numeric_values(timeline, day, "precip")
            wind = numeric_values(timeline, day, "wind")
            wind_850 = numeric_values(timeline, day, "wind_850")
            item["daily"][day] = {
                "temp_min": min(temp) if temp else None,
                "temp_max": max(temp) if temp else None,
                "precip": sum(max(0.0, value) for value in precip),
                "wind": max(wind) if wind else None,
                "temp_850_min": min(temp_850) if temp_850 else None,
                "temp_850_max": max(temp_850) if temp_850 else None,
                "wind_850": max(wind_850) if wind_850 else None,
            }

    missing_850 = [
        item["label"] for item in series
        if any(item["daily"][day].get("temp_850_min") is None for day in dates)
    ]
    if missing_850:
        print(
            "[850 HPA KIYAS UYARISI] Eksik seri bulunan döngüler grafikte boş bırakılacak: "
            + ", ".join(missing_850)
        )

    # Deep-navy report canvas with four color-blind-friendly, high-contrast cycle accents.
    colors = ["#55D6D2", "#7EB8FF", "#FFC66D", "#C3A5FF"]
    count = len(series)
    offsets = [
        (index - (count - 1) / 2) * min(0.20, 0.80 / count)
        for index in range(count)
    ]
    group_width = min(0.20, 0.80 / count)
    return {
        "series": series,
        "dates": dates,
        "valid_times": ordered_valid_times,
        "valid_time_count": len(ordered_valid_times),
        "colors": colors,
        "offsets": offsets,
        "candle_width": group_width * 0.72,
        "bar_width": group_width * 0.90,
    }

def _comparison_temperature_ohlc(forecast, day):
    samples = [
        (key, values) for key, values in forecast.items()
        if key[:10] == day and values.get("temp") is not None
    ]
    samples.sort(key=lambda item: item[0])
    if not samples:
        return None
    temperatures = [float(item[1]["temp"]) for item in samples]
    return temperatures[0], temperatures[-1], max(temperatures), min(temperatures)


GFS_REPORT_FIGURE_BG = "#0A1B29"
GFS_REPORT_AXIS_BG = "#102A3A"
GFS_REPORT_PANEL_BG = "#153448"
GFS_REPORT_TEXT = "#FFFFFF"
GFS_REPORT_MUTED = "#E7F2F6"
GFS_REPORT_GRID = "#456579"
GFS_REPORT_SPINE = "#416174"
GFS_REPORT_LEGEND_EDGE = "#36586C"


def _apply_dark_report_theme():
    """Default every new chart label to white before Matplotlib creates it."""
    plt.rcParams.update({
        "text.color": GFS_REPORT_TEXT,
        "axes.labelcolor": GFS_REPORT_TEXT,
        "axes.titlecolor": GFS_REPORT_TEXT,
        "xtick.color": GFS_REPORT_MUTED,
        "ytick.color": GFS_REPORT_MUTED,
        "xtick.labelcolor": GFS_REPORT_MUTED,
        "ytick.labelcolor": GFS_REPORT_MUTED,
        "axes.edgecolor": GFS_REPORT_SPINE,
        "figure.facecolor": GFS_REPORT_FIGURE_BG,
        "axes.facecolor": GFS_REPORT_AXIS_BG,
        "savefig.facecolor": GFS_REPORT_FIGURE_BG,
        "savefig.edgecolor": GFS_REPORT_FIGURE_BG,
    })


def _whiten_dark_text(fig):
    """Catch labels created after the theme, which otherwise stay Matplotlib black."""
    from matplotlib.colors import to_rgb
    from matplotlib.text import Text

    for text in fig.findobj(match=lambda artist: isinstance(artist, Text)):
        try:
            red, green, blue = to_rgb(text.get_color())
        except (ValueError, TypeError):
            continue
        if red < 0.25 and green < 0.25 and blue < 0.25:
            text.set_color(GFS_REPORT_TEXT)


def _style_dark_comparison_axis(axis):
    """Apply the same high-contrast dark palette to Telegram and Pages charts."""
    axis.set_facecolor(GFS_REPORT_AXIS_BG)
    axis.set_axisbelow(True)
    axis.grid(axis="y", color=GFS_REPORT_GRID, alpha=0.42, linewidth=0.9)
    axis.tick_params(
        axis="both", which="both",
        colors=GFS_REPORT_MUTED,
        labelcolor=GFS_REPORT_MUTED,
        width=0.9, length=3,
    )
    axis.xaxis.label.set_color(GFS_REPORT_TEXT)
    axis.yaxis.label.set_color(GFS_REPORT_TEXT)
    axis.title.set_color(GFS_REPORT_TEXT)
    for spine in axis.spines.values():
        spine.set_color(GFS_REPORT_SPINE)
        spine.set_linewidth(0.9)


def _comparison_legend_handles(series, colors):
    return [
        Line2D([0], [0], color=colors[index % len(colors)], linewidth=5, label=item["label"])
        for index, item in enumerate(series)
    ]


def _draw_comparison_temperature_axis(axis, chart_data):
    series = chart_data["series"]
    dates = chart_data["dates"]
    colors = chart_data["colors"]
    offsets = chart_data["offsets"]
    candle_width = chart_data["candle_width"]
    x_positions = list(range(len(dates)))
    for series_index, item in enumerate(series):
        color = colors[series_index % len(colors)]
        values_by_day = [
            _comparison_temperature_ohlc(item["timeline"], day) for day in dates
        ]
        for index, values in enumerate(values_by_day):
            if values is None:
                continue
            open_value, close_value, high_value, low_value = values
            x = x_positions[index] + offsets[series_index]
            axis.vlines(x, low_value, high_value, color=color, linewidth=1.6)
            body_bottom = min(open_value, close_value)
            body_height = max(abs(close_value - open_value), 0.12)
            axis.add_patch(Rectangle(
                (x - candle_width / 2, body_bottom),
                candle_width, body_height,
                facecolor=color, edgecolor=color, alpha=0.82,
            ))
    axis.set_title("Sıcaklık | Günlük mum: ilk–son örnek, fitil: min–maks", loc="left", fontsize=11)
    axis.set_ylabel("°C", fontsize=10)
    axis.grid(axis="y", alpha=0.25)


def _draw_comparison_850_temperature_axis(axis, chart_data):
    """Daily min/max range for 850 hPa temperature, using the same cycle colors."""
    for series_index, item in enumerate(chart_data["series"]):
        color = chart_data["colors"][series_index % len(chart_data["colors"])]
        for index, day in enumerate(chart_data["dates"]):
            values = item["daily"][day]
            low, high = values.get("temp_850_min"), values.get("temp_850_max")
            if low is None or high is None:
                continue
            x = index + chart_data["offsets"][series_index]
            axis.vlines(x, low, high, color=color, linewidth=2.4, alpha=0.95)
            axis.scatter([x, x], [low, high], color=color, s=24, zorder=3)
    axis.set_title("850 hPa sıcaklığı | Günlük min–maks aralığı", loc="left", fontsize=11)
    axis.set_ylabel("°C", fontsize=10)


def _daily_wind_direction(item, day):
    """GFS 10 m direction at the hour of that day's strongest wind.

    The bar is the daily maximum speed, so the arrow uses that same hour's
    meteorological FROM bearing instead of a day-long average.
    """
    best_speed = None
    best_direction = None
    for key, values in item.get("timeline", {}).items():
        if key[:10] != day:
            continue
        direction, speed = values.get("wind_direction_deg"), values.get("wind")
        if direction is None or speed is None:
            continue
        speed = float(speed)
        if best_speed is None or speed > best_speed:
            best_speed = speed
            best_direction = float(direction) % 360.0
    return best_direction


def _wind_cardinal(direction_deg):
    names = ("K", "KD", "D", "GD", "G", "GB", "B", "KB")
    return names[int((float(direction_deg) + 22.5) % 360.0 // 45)]


def _draw_wind_direction_marker(axis, x, speed, direction_deg, label_offset=20):
    """White arrow above the bar: it points where the wind is going.

    The letter is the GFS FROM bearing (K = rüzgâr kuzeyden geliyor).
    """
    radians = math.radians(float(direction_deg))
    length = 12.0
    downwind_x = -math.sin(radians) * length
    downwind_y = -math.cos(radians) * length
    for color, width, scale, order in (
        ("#041018", 3.4, 16, 6),
        ("#FFFFFF", 1.7, 13, 7),
    ):
        axis.annotate(
            "",
            xy=(x, speed),
            xytext=(-downwind_x, -downwind_y),
            textcoords="offset points",
            arrowprops={
                "arrowstyle": "-|>",
                "color": color,
                "lw": width,
                "mutation_scale": scale,
                "shrinkA": 0,
                "shrinkB": 0,
            },
            zorder=order,
            annotation_clip=False,
        )
    label = axis.annotate(
        _wind_cardinal(direction_deg),
        xy=(x, speed),
        xytext=(0, label_offset),
        textcoords="offset points",
        ha="center",
        va="bottom",
        fontsize=9,
        fontweight="bold",
        color="#FFFFFF",
        zorder=8,
        annotation_clip=False,
    )
    label.set_path_effects([
        patheffects.withStroke(linewidth=2.6, foreground="#041018"),
    ])


def _comparison_precip_times(chart_data):
    """Valid times present in every cycle, so the lines share one clock."""
    maps = []
    for item in chart_data["series"]:
        points = {}
        for key, values in (item.get("timeline") or {}).items():
            if not isinstance(values, dict) or values.get("precip") is None:
                continue
            points[str(key)] = max(0.0, float(values["precip"]))
        maps.append(points)
    if not maps:
        return []
    common = set(maps[0])
    for points in maps[1:]:
        common &= set(points)
    return sorted(common)


def _draw_comparison_precip_line_axis(axis, chart_data):
    """3-hour precipitation trend. Daily bars hide when the rain actually falls."""
    times = _comparison_precip_times(chart_data)
    if len(times) < 2:
        axis.set_title("3 saatlik yağış | ortak saat yok", loc="left", fontsize=11)
        axis.set_ylabel("mm", fontsize=10)
        return
    xs = list(range(len(times)))
    for series_index, item in enumerate(chart_data["series"]):
        color = chart_data["colors"][series_index % len(chart_data["colors"])]
        timeline = item.get("timeline") or {}
        ys = [max(0.0, float(timeline[key]["precip"])) for key in times]
        axis.plot(
            xs, ys, color=color, linewidth=2.2,
            marker="o", markersize=3.4, markerfacecolor=color,
        )
    axis.set_ylim(bottom=0)
    axis.set_xlim(-0.5, len(times) - 0.5)
    step = 8 if len(times) > 24 else 4
    tick_index = list(range(0, len(times), step))
    if tick_index[-1] != len(times) - 1:
        tick_index.append(len(times) - 1)
    labels = []
    for index in tick_index:
        stamp = datetime.strptime(times[index], "%Y-%m-%dT%H:%M")
        labels.append(f"{stamp:%d.%m}\n{stamp:%H:%M}")
    axis.set_xticks(tick_index)
    axis.set_xticklabels(labels, fontsize=9, color=GFS_REPORT_TEXT)
    axis.set_title("3 saatlik yağış | çizgi trend", loc="left", fontsize=11)
    axis.set_ylabel("mm / 3 saat", fontsize=10)
    axis.set_xlabel("İstanbul yerel saati · 3 saat", fontsize=9.5, color=GFS_REPORT_TEXT)
    _apply_precip_hour_grid(axis)


def _apply_precip_hour_grid(axis):
    """Vertical line on every 3-hour step. Horizontal line on every mm, odd and even."""
    import matplotlib.ticker as ticker
    axis.yaxis.set_major_locator(ticker.MultipleLocator(1))
    axis.xaxis.set_minor_locator(ticker.MultipleLocator(1))
    axis.set_axisbelow(True)
    axis.grid(which="major", axis="y", color=GFS_REPORT_GRID, alpha=0.5, linewidth=0.8)
    axis.grid(which="minor", axis="x", color=GFS_REPORT_GRID, alpha=0.38, linewidth=0.6)
    axis.tick_params(axis="x", which="minor", length=0)
    axis.tick_params(axis="y", which="major", labelcolor=GFS_REPORT_MUTED, colors=GFS_REPORT_MUTED)


def _draw_comparison_bar_axis(axis, chart_data, metric, title, ylabel):
    series = chart_data["series"]
    dates = chart_data["dates"]
    colors = chart_data["colors"]
    offsets = chart_data["offsets"]
    bar_width = chart_data["bar_width"]
    x_positions = list(range(len(dates)))
    for series_index, item in enumerate(series):
        color = colors[series_index % len(colors)]
        bar_positions = []
        bar_values = []
        for index, day in enumerate(dates):
            value = item["daily"][day].get(metric)
            if value is None:
                continue
            bar_positions.append(x_positions[index] + offsets[series_index])
            bar_values.append(float(value))
        if bar_positions:
            axis.bar(bar_positions, bar_values, width=bar_width, color=color)
    if metric == "wind":
        low, high = axis.get_ylim()
        axis.set_ylim(0, max(high, 1) * 1.52)
        for series_index, item in enumerate(series):
            for index, day in enumerate(dates):
                direction = _daily_wind_direction(item, day)
                speed = item["daily"][day].get("wind")
                if direction is None or speed is None:
                    continue
                _draw_wind_direction_marker(
                    axis,
                    x_positions[index] + offsets[series_index],
                    float(speed),
                    direction,
                    label_offset=16 + series_index * 12,
                )
    axis.set_title(title, loc="left", fontsize=11)
    axis.set_ylabel(ylabel, fontsize=10)
    axis.grid(axis="y", alpha=0.25)
    if metric == "wind_850":
        available = sum(
            any(item["daily"][day].get("wind_850") is not None for day in dates)
            for item in series
        )
        if available < len(series):
            axis.text(
                0.5, 0.52,
                f"850 hPa verisi yalnızca {available}/{len(series)} döngüde mevcut\\n"
                "Kayıtlı tahminlerde eksik değer var; sütunlar uydurulmadı.",
                transform=axis.transAxes, ha="center", va="center",
                fontsize=12, fontweight="bold", color="#FFE2AE",
                bbox={"boxstyle": "round,pad=0.7", "facecolor": "#3A3023", "edgecolor": "#A77B43"},
            )


def _format_comparison_date_axis(axis, dates):
    turkish_weekdays = (
        "Pazartesi", "Salı", "Çarşamba", "Perşembe",
        "Cuma", "Cumartesi", "Pazar",
    )
    labels = []
    for day in dates:
        local_date = datetime.strptime(day, "%Y-%m-%d")
        labels.append(f"{local_date:%d.%m}\n{turkish_weekdays[local_date.weekday()]}")
    positions = list(range(len(dates)))
    axis.set_xlim(-0.5, max(len(dates) - 0.5, 0.5))
    axis.set_xticks(positions)
    axis.set_xticklabels(labels, fontsize=9.5, color=GFS_REPORT_TEXT)
    axis.set_xlabel("İstanbul yerel tarihi", fontsize=9.5, color=GFS_REPORT_TEXT)
    axis.xaxis.label.set_color(GFS_REPORT_TEXT)


def create_valid_time_comparison_assets(current_run_id, payload, previous_runs):
    """Create one 2x2 vector comparison report and its Telegram photo from one figure.

    All four panels use the exact shared UTC valid-time keys prepared by
    _prepare_comparison_chart_data. The newest cycle defines a 72-hour window;
    each older cycle is plotted at those same valid instants, even when its F
    hour is different.
    """
    if not previous_runs:
        print("[SVG KIYAS] Önceki GFS kaydı yok; karşılaştırma görseli atlandı.")
        return {}

    fig = None
    svg_buffer = None
    png_buffer = None
    try:
        _apply_dark_report_theme()
        chart_data = _prepare_comparison_chart_data(
            current_run_id, payload, previous_runs
        )
        series = chart_data["series"]
        if len(series) < 2:
            raise ValueError("En az iki GFS döngüsü olmadan karşılaştırma çizilemez.")

        newest_timeline = series[-1].get("timeline") or {}
        ordered_keys = sorted(newest_timeline)
        if len(ordered_keys) < 2:
            raise ValueError("Karşılaştırma için yeterli ortak geçerlilik zamanı yok.")

        first_local = datetime.fromisoformat(ordered_keys[0])
        last_local = first_local + timedelta(hours=72)
        valid_keys = [
            key for key in ordered_keys
            if first_local <= datetime.fromisoformat(key) <= last_local
        ]
        if len(valid_keys) < 2:
            raise ValueError("İlk 72 saatte yeterli ortak geçerlilik zamanı yok.")

        local_times = [datetime.fromisoformat(key) for key in valid_keys]
        first_time = local_times[0]
        x_values = [
            (value - first_time).total_seconds() / 3600.0
            for value in local_times
        ]

        # Series are oldest -> newest. Reverse the shared web palette so the
        # newest line is lilac, then amber, blue, and turquoise.
        cycle_palette = ["#7DD3D7", "#8ABCE8", "#F1C98B", "#B38BE8"]
        active_palette = cycle_palette[-len(series):]
        metrics = (
            ("temp", "Sıcaklık", "°C"),
            ("temp_850", "850 hPa sıcaklık", "°C"),
            ("precip", "Yağış", "mm / 3 saat"),
            ("wind", "10 m rüzgâr hızı", "km/sa"),
        )

        fig, axes = plt.subplots(2, 2, figsize=(16, 10.8))
        fig.patch.set_facecolor(GFS_REPORT_FIGURE_BG)
        fig.text(
            0.055, 0.965, "GFS · İSTANBUL",
            fontsize=12, fontweight="bold", color="#7DD3D7",
            ha="left", va="top",
        )
        fig.text(
            0.055, 0.925, "Son GFS raporu · 4'lü döngü karşılaştırması",
            fontsize=22, fontweight="bold", color=GFS_REPORT_TEXT,
            ha="left", va="top",
        )
        fig.text(
            0.055, 0.885,
            "Dört GFS çıktısı aynı geçerlilik saatlerinde (TSİ) üst üste karşılaştırılır.",
            fontsize=12.5, color=GFS_REPORT_MUTED,
            ha="left", va="top",
        )
        fig.text(
            0.945, 0.958, f"{len(series)} GFS döngüsü karşılaştırılıyor",
            fontsize=10.5, color="#B8D7DF", ha="right", va="top",
            bbox={
                "boxstyle": "round,pad=0.65",
                "facecolor": GFS_REPORT_FIGURE_BG,
                "edgecolor": GFS_REPORT_SPINE,
                "linewidth": 1.0,
            },
        )

        legend_handles = []
        for series_index in reversed(range(len(series))):
            item = series[series_index]
            color = active_palette[series_index]
            is_latest = series_index == len(series) - 1
            legend_handles.append(Line2D(
                [], [],
                color=color,
                linewidth=3.2 if is_latest else 1.8,
                linestyle="-" if is_latest else (0, (4, 3)),
                label=item["label"],
            ))
        fig.legend(
            handles=legend_handles,
            loc="upper center",
            bbox_to_anchor=(0.5, 0.835),
            ncol=2,
            fontsize=10.5,
            frameon=True,
            facecolor=GFS_REPORT_PANEL_BG,
            edgecolor=GFS_REPORT_LEGEND_EDGE,
            framealpha=0.98,
            labelcolor=GFS_REPORT_TEXT,
            borderpad=0.75,
            handlelength=2.4,
            columnspacing=2.8,
            labelspacing=0.75,
            handletextpad=0.8,
        )

        fig.subplots_adjust(
            left=0.075, right=0.985, bottom=0.085, top=0.755,
            wspace=0.18, hspace=0.36,
        )

        tick_indices = [
            index for index, hour in enumerate(x_values)
            if index == 0 or abs(hour % 12.0) < 0.01
        ]
        if tick_indices[-1] != len(x_values) - 1:
            tick_indices.append(len(x_values) - 1)
        tick_labels = [
            local_times[index].strftime("%d/%m %H:%M")
            for index in tick_indices
        ]

        svg_panel_metadata = []
        for panel_index, (axis, (field, title, unit)) in enumerate(zip(axes.flat, metrics)):
            axis.set_facecolor(GFS_REPORT_AXIS_BG)
            axis.set_zorder(1)
            axis.set_title(
                title, loc="left", fontsize=17,
                fontweight="bold", color=GFS_REPORT_TEXT, pad=15,
            )
            axis.set_ylabel(
                unit, fontsize=11.5, fontweight="bold",
                color=GFS_REPORT_TEXT, labelpad=8,
            )
            axis.grid(
                axis="y", color=GFS_REPORT_GRID,
                linestyle=(0, (2, 4)), alpha=0.55, linewidth=0.8,
            )
            axis.set_axisbelow(True)
            axis.tick_params(
                axis="both", which="major", colors=GFS_REPORT_MUTED,
                labelcolor=GFS_REPORT_MUTED, labelsize=10.5,
                width=0.8, length=3, pad=6,
            )
            for spine in axis.spines.values():
                spine.set_color(GFS_REPORT_SPINE)
                spine.set_linewidth(0.9)

            finite_values = []
            for series_index, item in enumerate(series):
                timeline = item.get("timeline") or {}
                y_values = []
                for key in valid_keys:
                    raw_value = (timeline.get(key) or {}).get(field)
                    try:
                        value = float(raw_value)
                    except (TypeError, ValueError):
                        value = math.nan
                    if not math.isfinite(value):
                        value = math.nan
                    else:
                        finite_values.append(value)
                    y_values.append(value)

                is_latest = series_index == len(series) - 1
                axis.plot(
                    x_values,
                    y_values,
                    color=active_palette[series_index],
                    linewidth=3.2 if is_latest else 1.8,
                    linestyle="-" if is_latest else (0, (4, 3)),
                    marker="o" if is_latest else None,
                    markersize=3.0 if is_latest else 0,
                    markeredgewidth=0,
                    solid_capstyle="round",
                    solid_joinstyle="round",
                    zorder=5 if is_latest else 3,
                )

            if not finite_values:
                axis.text(
                    0.5, 0.5, "Bu değişken için veri yok",
                    transform=axis.transAxes, ha="center", va="center",
                    fontsize=11, color=GFS_REPORT_MUTED,
                )
            elif field in ("temp", "temp_850"):
                low, high = min(finite_values), max(finite_values)
                span = high - low
                if span < 4:
                    center = (low + high) / 2
                    low, high = center - 2, center + 2
                else:
                    margin = max(0.5, span * 0.08)
                    low, high = low - margin, high + margin
                axis.set_ylim(low, high)
            else:
                axis.set_ylim(bottom=0)
                high = max(finite_values)
                axis.set_ylim(0, max(1.0, high * 1.18))

            axis.set_xlim(
                min(x_values) - 1.0,
                max(x_values) + max(1.0, (max(x_values) - min(x_values)) * 0.015),
            )
            axis.set_xticks([x_values[index] for index in tick_indices])
            axis.set_xticklabels(
                tick_labels, fontsize=10, color=GFS_REPORT_MUTED,
                fontweight="semibold",
            )
            axis.margins(x=0.01)

            # Save exact point values and SVG coordinates for the browser tooltip.
            # The timestamps are shared across all four cycles; only each
            # cycle's F-hour differs.
            axis_meta = axis.get_window_extent()
            scale = 72.0 / fig.dpi
            canvas_height_px = fig.get_figheight() * fig.dpi

            def to_svg_point(display_x, display_y):
                return (
                    round(display_x * scale, 3),
                    round((canvas_height_px - display_y) * scale, 3),
                )

            plot_x = round(axis_meta.x0 * scale, 3)
            plot_y = round((canvas_height_px - axis_meta.y1) * scale, 3)
            plot_width = round(axis_meta.width * scale, 3)
            plot_height = round(axis_meta.height * scale, 3)
            x_positions = []
            for x_value in x_values:
                display_x, display_y = axis.transData.transform(
                    (x_value, axis.get_ylim()[0])
                )
                svg_x, _ = to_svg_point(display_x, display_y)
                x_positions.append(svg_x)

            panel_series = []
            for series_index, item in enumerate(series):
                timeline = item.get("timeline") or {}
                values = []
                y_positions = []
                leads = []
                directions = []
                for index, key in enumerate(valid_keys):
                    point = timeline.get(key) or {}
                    raw_value = point.get(field)
                    try:
                        value = float(raw_value)
                        if not math.isfinite(value):
                            value = None
                    except (TypeError, ValueError):
                        value = None
                    values.append(value)
                    lead = point.get("step_hour")
                    try:
                        lead = int(lead) if lead is not None else None
                    except (TypeError, ValueError):
                        lead = None
                    leads.append(lead)
                    direction = point.get("wind_direction_deg") if field == "wind" else None
                    try:
                        direction = float(direction) % 360.0 if direction is not None else None
                    except (TypeError, ValueError):
                        direction = None
                    directions.append(direction)
                    if value is None:
                        y_positions.append(None)
                    else:
                        display_x, display_y = axis.transData.transform(
                            (x_values[index], value)
                        )
                        _, svg_y = to_svg_point(display_x, display_y)
                        y_positions.append(svg_y)
                panel_series.append({
                    "label": item["label"],
                    "color": active_palette[series_index],
                    "lead_hours": leads,
                    "values": values,
                    "y_positions": y_positions,
                    "directions_deg": directions,
                })

            valid_time_records = []
            for key in valid_keys:
                point = newest_timeline.get(key) or {}
                raw_utc = point.get("valid_time_utc")
                if raw_utc:
                    valid_dt = _parse_utc_datetime(raw_utc).astimezone(TR_TZ)
                    local_label = valid_dt.strftime("%d.%m.%Y %H:%M")
                    utc_label = _parse_utc_datetime(raw_utc).strftime("%Y-%m-%d %H:%M UTC")
                else:
                    local_dt = datetime.fromisoformat(key).replace(tzinfo=TR_TZ)
                    local_label = local_dt.strftime("%d.%m.%Y %H:%M")
                    utc_label = local_dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
                valid_time_records.append({
                    "local_key": key,
                    "label": local_label + " TSİ",
                    "utc_label": utc_label,
                })

            svg_panel_metadata.append({
                "id": ("temperature", "temperature_850", "precipitation", "wind_10m")[panel_index],
                "title": title,
                "unit": unit,
                "plot": {
                    "x": plot_x, "y": plot_y,
                    "width": plot_width, "height": plot_height,
                },
                "x_positions": x_positions,
                "valid_times": valid_time_records,
                "series": panel_series,
            })

        # Rounded card frames echo the 72-hour dashboard's two chart cards.
        for axis in axes.flat:
            position = axis.get_position()
            card = FancyBboxPatch(
                (position.x0 - 0.018, position.y0 - 0.035),
                position.width + 0.036,
                position.height + 0.075,
                boxstyle="round,pad=0.004,rounding_size=0.014",
                transform=fig.transFigure,
                facecolor=GFS_REPORT_AXIS_BG,
                edgecolor=GFS_REPORT_SPINE,
                linewidth=1.0,
                zorder=0,
            )
            fig.add_artist(card)
            axis.set_facecolor("none")
            axis.set_zorder(1)

        fig.text(
            0.055, 0.025,
            f"Aynı geçerlilik saatleri (TSİ) · {len(valid_keys)} ortak nokta",
            fontsize=9.5, color=GFS_REPORT_MUTED, ha="left",
        )
        fig.text(
            0.945, 0.025,
            "Kaynak: MeteoPT GFS · İstanbul nokta tahmini",
            fontsize=9.5, color=GFS_REPORT_MUTED, ha="right",
        )
        _whiten_dark_text(fig)

        # Keep the SVG viewBox equal to the figure canvas so the hit areas,
        # crosshairs and data-point markers share exact coordinates.
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        svg_buffer = io.BytesIO()
        png_buffer = io.BytesIO()
        with plt.rc_context({"svg.fonttype": "none"}):
            fig.savefig(
                svg_buffer, format="svg", bbox_inches=None,
                facecolor=GFS_REPORT_FIGURE_BG,
                edgecolor=GFS_REPORT_FIGURE_BG,
                metadata={
                    "Title": "İstanbul GFS · Dört döngü valid-time karşılaştırması",
                    "Description": "Dört GFS çıktısı aynı TSİ geçerlilik saatlerinde hizalanmıştır.",
                },
            )
        fig.savefig(
            png_buffer, format="png", dpi=140, bbox_inches=None,
            facecolor=GFS_REPORT_FIGURE_BG,
            edgecolor=GFS_REPORT_FIGURE_BG,
        )

        # Append browser-only transparent hit areas and a compact data manifest.
        # They are added after PNG export, so Telegram keeps the clean static art.
        interaction_metadata = {
            "version": 1,
            "panels": svg_panel_metadata,
        }
        metadata_json = json.dumps(
            interaction_metadata, ensure_ascii=False, separators=(",", ":")
        ).replace("]]>", "]]\\u003e")
        interaction_parts = [
            '<metadata id="gfs-interactive-data"><![CDATA[' + metadata_json + ']]></metadata>',
            '<g id="gfs-interaction-layer">',
        ]
        for panel in svg_panel_metadata:
            plot = panel["plot"]
            x_start = panel["x_positions"][0]
            x_end = panel["x_positions"][-1]
            interaction_parts.append(
                '<g class="gfs-panel-interaction" data-panel-id="' + panel["id"] + '">'
                '<rect class="gfs-hit-area" data-panel-id="' + panel["id"] + '" '
                'x="' + str(plot["x"]) + '" y="' + str(plot["y"]) + '" '
                'width="' + str(plot["width"]) + '" height="' + str(plot["height"]) + '" '
                'fill="transparent" pointer-events="all" tabindex="0" role="group" '
                'aria-label="' + panel["title"] + ' grafiği; ok tuşlarıyla geçerlilik saatleri arasında gezinin"/>'
                '<line class="gfs-tooltip-crosshair" x1="' + str(x_start) + '" '
                'x2="' + str(x_start) + '" y1="' + str(plot["y"]) + '" '
                'y2="' + str(plot["y"] + plot["height"]) + '" '
                'stroke="#EAF5F8" stroke-width="1.1" stroke-dasharray="4 4" '
                'opacity=".78" visibility="hidden" pointer-events="none"/>'
                '<g class="gfs-tooltip-markers" pointer-events="none"></g>'
                '</g>'
            )
        interaction_parts.append("</g>")
        svg_text = svg_buffer.getvalue().decode("utf-8")
        closing = "</svg>"
        if closing not in svg_text:
            raise RuntimeError("SVG closing element is missing.")
        svg_text = svg_text.replace(
            closing, "".join(interaction_parts) + closing, 1
        )
        svg_buffer = io.BytesIO(svg_text.encode("utf-8"))
        svg_buffer.seek(0)
        png_buffer.seek(0)
        print(
            f"[GFS SVG KIYAS] {len(series)} döngü; {len(valid_keys)} ortak TSİ zamanı; "
            "2x2 SVG + aynı figürden tek Telegram PNG hazır."
        )
        return {
            "svg": svg_buffer,
            "png": png_buffer,
            "valid_time_count": len(valid_keys),
            "series_count": len(series),
        }
    except Exception as exc:
        for buffer in (svg_buffer, png_buffer):
            if buffer:
                buffer.close()
        print(f"[GFS SVG KIYAS HATA] Dört panelli karşılaştırma oluşturulamadı: {exc}")
        return {}
    finally:
        if fig is not None:
            plt.close(fig)


def create_comparison_chart(current_run_id, payload, previous_runs):
    """Build one Telegram image with temperature, precipitation and both wind levels."""
    if not previous_runs:
        print("[KIYAS GÖRSELİ] Önceki GFS kaydı yok; ilk çalışma için görsel atlandı.")
        return None
    fig = None
    try:
        _apply_dark_report_theme()
        chart_data = _prepare_comparison_chart_data(current_run_id, payload, previous_runs)
        series = chart_data["series"]
        dates = chart_data["dates"]
        count = len(series)
        fig, axes = plt.subplots(
            4, 1, figsize=(18, 15), sharex=False,
            gridspec_kw={"height_ratios": [1.5, 1, 1, 1]},
        )
        fig.suptitle(
            f"İSTANBUL GFS | SON {count} DÖNGÜ KARŞILAŞTIRMASI",
            fontsize=19, fontweight="bold", y=0.99,
            color=GFS_REPORT_TEXT,
        )
        _draw_comparison_temperature_axis(axes[0], chart_data)
        axes[0].legend(
            handles=_comparison_legend_handles(series, chart_data["colors"]),
            loc="upper left", ncol=min(4, count), fontsize=8.5, frameon=True,
            facecolor=GFS_REPORT_PANEL_BG, edgecolor=GFS_REPORT_LEGEND_EDGE,
            framealpha=0.98, labelcolor=GFS_REPORT_TEXT,
        )
        _draw_comparison_850_temperature_axis(axes[1], chart_data)
        _draw_comparison_precip_line_axis(axes[2], chart_data)
        _draw_comparison_bar_axis(axes[3], chart_data, "wind", "Yüzey rüzgârı | ok gittiği yön, harf GFS geldiği yön", "km/sa")
        fig.patch.set_facecolor(GFS_REPORT_FIGURE_BG)
        for index, axis in enumerate(axes):
            _style_dark_comparison_axis(axis)
            if index == 2:
                _apply_precip_hour_grid(axis)
                axis.tick_params(axis="x", labelbottom=True, labelcolor=GFS_REPORT_TEXT, colors=GFS_REPORT_TEXT)
                continue
            _format_comparison_date_axis(axis, dates)
            if index != len(axes) - 1:
                axis.set_xlabel("")
            axis.tick_params(axis="x", labelbottom=True, labelcolor=GFS_REPORT_TEXT, colors=GFS_REPORT_TEXT)
        fig.text(
            0.01, 0.012,
            "Renkler her panelde aynı GFS döngüsünü gösterir | "
            f"Aynı geçerlilik saatleri (TSİ) · {chart_data['valid_time_count']} ortak nokta | "
            "Kaynak: NOAA/NCEP GFS 0.25°",
            fontsize=9.5, color=GFS_REPORT_MUTED,
        )
        fig.tight_layout(rect=(0, 0.035, 1, 0.95))
        _whiten_dark_text(fig)
        image_buffer = io.BytesIO()
        fig.savefig(
            image_buffer, format="png", dpi=150, bbox_inches="tight",
            facecolor=GFS_REPORT_FIGURE_BG, edgecolor=GFS_REPORT_FIGURE_BG,
        )
        image_buffer.seek(0)
        print(
            f"[TELEGRAM KIYAS GÖRSELİ] {count} GFS döngüsü, {len(dates)} ortak gün; "
            "2 m ve 850 hPa sıcaklık, yağış, hız+yön panelleri hazır.",
        )
        return image_buffer
    except Exception as exc:
        print(f"[KIYAS GÖRSELİ HATA] Telegram birleşik grafik oluşturulamadı: {exc}")
        return None
    finally:
        if fig is not None:
            plt.close(fig)


def create_pages_comparison_charts(current_run_id, payload, previous_runs):
    """Build four separate comparison images for the Pages report card only."""
    if not previous_runs:
        print("[PAGES GÖRSELLERİ] Önceki GFS kaydı yok; ilk çalışma için görseller atlandı.")
        return {}
    charts = {}
    specifications = (
        ("temperature", "2 m Sıcaklık", "2 m sıcaklık | Günlük mum: ilk–son, fitil: min–maks", "°C"),
        ("temperature_850", "850 hPa Sıcaklık", "850 hPa sıcaklığı | Günlük min–maks aralığı", "°C"),
        ("precipitation", "Yağış", "3 saatlik yağış · çizgi trend", "mm"),
        ("wind_10m", "Rüzgâr hız + yön", "10 m rüzgâr | ok gittiği yön, harf GFS geldiği yön", "km/sa"),
    )
    try:
        _apply_dark_report_theme()
        chart_data = _prepare_comparison_chart_data(current_run_id, payload, previous_runs)
        series = chart_data["series"]
        dates = chart_data["dates"]
        legend = _comparison_legend_handles(series, chart_data["colors"])
        for metric, label, title, ylabel in specifications:
            fig, axis = plt.subplots(1, 1, figsize=(16, 7))
            try:
                fig.suptitle(
                    f"İSTANBUL GFS | {label.upper()} · SON {len(series)} DÖNGÜ",
                    fontsize=20, fontweight="bold", y=0.97,
                    color=GFS_REPORT_TEXT,
                )
                if metric == "temperature":
                    _draw_comparison_temperature_axis(axis, chart_data)
                elif metric == "temperature_850":
                    _draw_comparison_850_temperature_axis(axis, chart_data)
                elif metric == "precipitation":
                    _draw_comparison_precip_line_axis(axis, chart_data)
                elif metric == "wind_10m":
                    _draw_comparison_bar_axis(axis, chart_data, "wind", title, ylabel)
                # Stronger typography and contrast for readable numeric values on desktop and mobile.
                axis.set_facecolor(GFS_REPORT_AXIS_BG)
                fig.patch.set_facecolor(GFS_REPORT_FIGURE_BG)
                _style_dark_comparison_axis(axis)
                # Put every metric heading in a dedicated figure-level band.
                # The title never shares the plotting axes with the 12Z/18Z legend.
                # Pages chart: clear the axis-level title added by shared
                # drawing helpers; it otherwise duplicates and collides with
                # the dedicated metric heading above the plot.
                axis.title.set_text("")
                axis.title.set_visible(False)
                fig.text(
                    0.085, 0.675, title, ha="left", va="bottom",
                    fontsize=18, fontweight="bold", color=GFS_REPORT_TEXT,
                )
                axis.set_ylabel(ylabel, fontsize=16, fontweight="bold", color=GFS_REPORT_TEXT, labelpad=7)
                axis.tick_params(
                    axis="y", which="major", labelsize=15, labelcolor=GFS_REPORT_MUTED,
                    width=1.0, length=4, colors=GFS_REPORT_MUTED, pad=5,
                )
                axis.tick_params(
                    axis="x", which="major", labelsize=14, labelcolor=GFS_REPORT_MUTED,
                    width=0.9, length=3, colors=GFS_REPORT_MUTED, pad=5,
                    labelbottom=True,
                )
                for tick_label in axis.get_yticklabels():
                    tick_label.set_fontweight("bold")
                for tick_label in axis.get_xticklabels():
                    tick_label.set_fontweight("semibold")
                axis.grid(axis="y", color=GFS_REPORT_GRID, alpha=0.42, linewidth=0.9)
                if metric == "precipitation":
                    _apply_precip_hour_grid(axis)
                axis.set_axisbelow(True)
                # Rebuild a predictable full-width plotting area for every metric.
                # Do not manually reposition the Axes after Matplotlib lays it out.
                axis.set_aspect("auto", adjustable="box")
                if metric != "precipitation":
                    axis.set_xlim(-0.5, max(0.5, len(dates) - 0.5))
                    axis.set_xticks(list(range(len(dates))))
                    weekday_names = ("Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz")
                    date_labels = []
                    for day in dates:
                        date_value = datetime.strptime(day, "%Y-%m-%d")
                        date_labels.append(f"{date_value:%d.%m} {weekday_names[date_value.weekday()]}")
                    axis.set_xticklabels(date_labels, fontsize=14, fontweight="semibold", color=GFS_REPORT_TEXT)
                for tick_label in axis.get_xticklabels():
                    tick_label.set_fontsize(12 if metric == "precipitation" else 14)
                    tick_label.set_fontweight("semibold")
                    tick_label.set_color(GFS_REPORT_TEXT)
                axis.tick_params(axis="x", labelsize=14, labelbottom=True, pad=7, labelcolor=GFS_REPORT_TEXT, colors=GFS_REPORT_TEXT)
                axis.margins(x=0.015)
                # Put the four run labels in a dedicated, figure-level 2x2 legend.
                # This prevents long cycle names from colliding in a four-column row.
                fig.legend(
                    handles=legend, loc="upper center", bbox_to_anchor=(0.5, 0.925),
                    ncol=2, fontsize=12, frameon=True, facecolor=GFS_REPORT_PANEL_BG,
                    edgecolor=GFS_REPORT_LEGEND_EDGE, framealpha=0.98, labelcolor=GFS_REPORT_TEXT,
                    borderpad=0.75, handlelength=2.0, columnspacing=3.0,
                    labelspacing=0.9, handletextpad=0.8,
                )
                fig.text(
                    0.01, 0.012,
                    f"Renkler her panelde aynı GFS döngüsünü gösterir | Aynı geçerlilik saatleri (TSİ) · {chart_data['valid_time_count']} ortak nokta | Kaynak: MeteoPT GFS · İstanbul nokta tahmini",
                    fontsize=10.5, color=GFS_REPORT_MUTED,
                )
                # Keep three non-overlapping vertical bands: report title,
                # two-row cycle legend, metric heading, then plotting area.
                fig.subplots_adjust(left=0.085, right=0.985, bottom=0.19, top=0.59)
                _whiten_dark_text(fig)
                buffer = io.BytesIO()
                fig.savefig(
                    buffer, format="png", dpi=150,
                    facecolor=GFS_REPORT_FIGURE_BG, edgecolor=GFS_REPORT_FIGURE_BG,
                )
                buffer.seek(0)
                charts[metric] = buffer
            finally:
                plt.close(fig)
        print("[PAGES GÖRSELLERİ] Dört ayrı karşılaştırma görseli hazırlandı: " + ", ".join(charts))
        return charts
    except Exception as exc:
        for buffer in charts.values():
            buffer.close()
        print(f"[PAGES GÖRSELLERİ HATA] Ayrı görseller oluşturulamadı: {exc}")
        return {}

def _has_complete_850_wind_daily_series(payload):
    """Return true only when every daily bucket has a finite 850 hPa wind value."""
    if not isinstance(payload, dict):
        return False
    daily = payload.get("daily", {})
    if not isinstance(daily, dict):
        return False
    dates = daily.get("time", [])
    values = daily.get("wind_850_max", [])
    if not isinstance(dates, list) or not dates or not isinstance(values, list):
        return False
    if len(values) != len(dates):
        return False
    try:
        return all(value is not None and math.isfinite(float(value)) for value in values)
    except (TypeError, ValueError, OverflowError):
        return False


async def load_previous_three_runs_for_comparison(current_run_id):
    """Load the three preceding cycles from the same source as the current run."""
    current_dt = _parse_utc_datetime(current_run_id)
    previous_runs = []
    use_meteopt = os.getenv("GFS_SOURCE", "meteopt").strip().lower() != "noaa"

    for hours_back in (6, 12, 18):
        previous_dt = current_dt - timedelta(hours=hours_back)
        previous_run_id = previous_dt.isoformat(timespec="seconds")
        if not use_meteopt:
            stored_record = await asyncio.to_thread(get_run_payload, previous_run_id)
            if stored_record and _has_complete_850_wind_daily_series(stored_record[1]):
                stored_run_id, stored_payload = stored_record
                print(f"[KIYAS GEÇMİŞİ] {stored_run_id} SQLite kaydı kullanılıyor.")
                previous_runs.append((
                    stored_run_id,
                    json.dumps(stored_payload, ensure_ascii=False),
                ))
                continue

        fetched_payload = await asyncio.to_thread(fetch_full_weather_data, previous_run_id)
        if not fetched_payload or "_pending_noaa_gfs" in fetched_payload:
            raise RuntimeError(
                f"{previous_run_id} karşılaştırma tahmini alınamadı: "
                f"{(fetched_payload or {}).get('_reason', 'veri bulunamadı')}"
            )
        if not use_meteopt and not _has_complete_850_wind_daily_series(fetched_payload):
            raise RuntimeError(
                f"{previous_run_id} 850 hPa günlük rüzgâr serisi eksik."
            )
        await asyncio.to_thread(save_run, previous_run_id, fetched_payload)
        await asyncio.to_thread(
            export_public_forecast_json, previous_run_id, fetched_payload, False
        )
        print(f"[KIYAS ARŞİV] {previous_run_id} aynı kaynaktan yazıldı.")
        previous_runs.append((
            previous_run_id,
            json.dumps(fetched_payload, ensure_ascii=False),
        ))

    return previous_runs


async def send_telegram_photo(photo, caption, max_attempts=3):
    if not _telegram_enabled():
        print("[TELEGRAM KAPALI] Görsel gönderilmedi.")
        return
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


async def send_telegram_voice(audio_path, max_attempts=3, cleanup=True):
    if not _telegram_enabled():
        print("[TELEGRAM KAPALI] Ses gönderilmedi.")
        if cleanup and audio_path and os.path.exists(audio_path):
            os.remove(audio_path)
        return
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
        if cleanup and os.path.exists(audio_path):
            os.remove(audio_path)

# --- ANA ÇALIŞTIRICI ---
async def process_gfs_update(strict=False, target_run_id=None):
    if target_run_id is None:
        target_run_id = os.getenv("GFS_WATCH_TARGET_RUN_ID", "").strip() or None
    if target_run_id:
        target_run_id = _parse_utc_datetime(target_run_id).isoformat(timespec="seconds")
        print(f"[TARGET LOCK] Yalnızca {target_run_id} GFS döngüsü izlenecek.")

    await asyncio.to_thread(prune_old_runs)
    await asyncio.to_thread(prune_noaa_cache)
    processed_run_ids = await asyncio.to_thread(get_processed_run_ids)
    if target_run_id and target_run_id in processed_run_ids:
        print(f"[TARGET COMPLETE] {target_run_id} daha önce işlendi; yeni rapor gönderilmeyecek.")
        return

    use_meteopt = os.getenv("GFS_SOURCE", "meteopt").strip().lower() != "noaa"
    # MeteoPT returns the active run itself. A slot-pinned target may point
    # at an older cycle and silently prevent the currently updating run from
    # ever reaching the F180 publisher.
    if use_meteopt:
        target_run_id = None
        os.environ.pop("GFS_WATCH_TARGET_RUN_ID", None)
    candidates = await asyncio.to_thread(
        fetch_meteopt_available_runs if use_meteopt else fetch_noaa_available_runs
    )
    if target_run_id:
        candidates = [
            item for item in candidates
            if _parse_utc_datetime(item["run_id"]).isoformat(timespec="seconds") == target_run_id
        ]

    if not candidates:
        if not use_meteopt:
            await asyncio.to_thread(
                prefetch_noaa_cycle_if_due,
                processed_run_ids if target_run_id else None,
                target_run_id,
            )
        message = (
            f"MeteoPT üzerinde {target_run_id or 'son döngü'} için +{MIN_FORECAST_HOURS} saatlik seri henüz yok."
            if use_meteopt
            else (
                f"NOAA S3 üzerinde {target_run_id} için +180 GFS GRIB2 dosyası "
                "henüz yayımlanmadı."
                if target_run_id
                else "NOAA S3 üzerinde henüz +180 GFS GRIB2 dosyası yayımlanmadı."
            )
        )
        print(f"[SKIP] {message}")
        if strict:
            raise RuntimeError(message)
        return

    previous_runs = get_previous_runs()
    latest_processed_run = max(processed_run_ids) if processed_run_ids else None
    pending_runs = [
        item for item in candidates
        if item["run_id"] not in processed_run_ids
        and (
            target_run_id is not None
            or latest_processed_run is None
            or item["run_id"] > latest_processed_run
        )
    ]

    if use_meteopt and not pending_runs and candidates:
        newest = candidates[0]
        published_run = None
        published_source = None
        comparison_ok = False
        try:
            with open(os.path.join(PUBLIC_DATA_DIR, "latest.json"), encoding="utf-8") as handle:
                published = json.load(handle)
            published_run = published.get("run_id_utc")
            published_source = published.get("forecast_source")
            comparison = published.get("comparison_runs") or []
            comparison_ok = (
                len(comparison) >= 4
                and all(item.get("forecast_source") == "meteopt" for item in comparison)
                and isinstance(published.get("report"), dict)
            )
        except (OSError, ValueError, TypeError):
            comparison_ok = False
        if published_source != "meteopt" or published_run != newest["run_id"] or not comparison_ok:
            print(
                "[METEOPT REPUBLISH] Sayfa paketi tek MeteoPT kaynağında değil; "
                f"{newest['run_id']} yeniden yazılacak."
            )
            pending_runs = [newest]

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
        if not use_meteopt:
            await asyncio.to_thread(
                prefetch_noaa_cycle_if_due,
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
        if not use_meteopt:
            await asyncio.to_thread(
                prefetch_noaa_cycle_if_due,
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

    # The S3 f180 GRIB2 object itself is the trigger. Once its HEAD request
    # succeeds, fetch the selected native GRIB2 messages by .idx byte ranges.
    # No weather API or NOMADS filtering endpoint is involved.
    print(
        f"[NOAA TRIGGER] {run_id} +180 dosyası NOAA {metadata.get('source_name', 'kaynağında')} üzerinde hazır; "
        "gerekli GRIB2 mesajları önce NOMADS, gerekirse AWS S3 üzerinden byte-range ile alınıyor."
    )

    # MeteoPT already returns the finished 3-hour series. The GRIB cache wait
    # only applies when GFS_SOURCE=noaa.
    if not use_meteopt:
        missing_cache_leads = await asyncio.to_thread(
            missing_noaa_cache_leads, run_id, MIN_FORECAST_HOURS - 3
        )
        if missing_cache_leads:
            print(
                f"[FINAL CACHE WAIT] {run_id}: f180 öncesi "
                f"{len(missing_cache_leads)} GRIB2 dosyası eksik; "
                f"ilk eksik f{missing_cache_leads[0]:03d}. "
                "Önce önbellek tamamlanacak, sonra f180 ile birleştirilecek."
            )
            await asyncio.to_thread(prefetch_latest_noaa_cycle, None, run_id)
            missing_cache_leads = await asyncio.to_thread(
                missing_noaa_cache_leads, run_id, MIN_FORECAST_HOURS - 3
            )
            if missing_cache_leads:
                print(
                    f"[FINAL CACHE WAIT] {run_id}: önbellekte hâlâ "
                    f"{len(missing_cache_leads)} dosya eksik; "
                    f"ilk eksik f{missing_cache_leads[0]:03d}. "
                    "Sonraki beş dakikalık kontrolde tekrar denenecek."
                )
                return

        print(
            f"[FINAL CACHE READY] {run_id}: f000-f177 arasındaki "
            "140 GRIB2 girdisinin İstanbul değerleri önceden çözüldü; "
            "yalnızca f180 son dosyası işlenip birleştirilecek."
        )
    print(f"[UPDATE] +{MIN_FORECAST_HOURS} saat eşiğine ulaşan GFS run alınıyor: {run_id}")
    payload = await asyncio.to_thread(fetch_full_weather_data, run_id)
    if payload and "_pending_noaa_gfs" in payload:
        print(
            f"[PENDING] {run_id} NOAA GRIB2 dosyası henüz tam olarak hazır değil; "
            f"sonraki kontrolde tekrar denenecek. Ayrıntı: {payload.get('_reason', 'dosya eksik')}"
        )
        # The f180 inventory may be published while one or more preceding
        # lead files are still unavailable. Keep completing the same GRIB2
        # cache; the next five-minute check retries the final assembly.
        await asyncio.to_thread(
            prefetch_latest_noaa_cycle, None, run_id
        )
        return
    if not payload:
        message = f"{run_id} için NOAA/NCEP GRIB2 tahmini alınamadı."
        print(f"[RETRY] {message}")
        if strict:
            raise RuntimeError(message)
        return

    payload["model_metadata"] = metadata
    payload["station_observation"] = await asyncio.to_thread(
        fetch_enka_station_observation
    )
    export_public_forecast_json(run_id, payload, update_latest=False)
    full_text_report, speech_text = analyze_and_build_output(
        run_id, payload, previous_runs
    )
    audio_task = asyncio.create_task(generate_speech_with_retry(speech_text))

    # Compare the current cycle with the exact three prior six-hour cycles.
    # Missing history is fetched from NOAA in read-only mode; DB/JSON state is untouched.
    chart_buffer = None
    pages_chart_buffers = {}
    notification_images = []
    try:
        comparison_runs = await load_previous_three_runs_for_comparison(run_id)
    except Exception as exc:
        comparison_runs = []
        print(f"[KIYAS VERİSİ HATA] Önceki döngüler yüklenemedi: {exc}")

    # Pages receives four independent images; Telegram keeps one composite image.
    try:
        pages_chart_buffers = create_pages_comparison_charts(run_id, payload, comparison_runs)
        if pages_chart_buffers:
            notification_images = await asyncio.to_thread(
                save_public_notification_images, run_id, pages_chart_buffers
            )
    except Exception as media_exc:
        print(f"[PAGES GÖRSEL ARŞİV HATASI] {media_exc}")
    finally:
        for image_buffer in pages_chart_buffers.values():
            image_buffer.close()

    telegram_caption = None
    try:
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
            telegram_caption = (
                f"📊 {APP_LABEL} | Dört döngü karşılaştırması\n"
                "Eski → yeni: " + " → ".join(cycle_labels)
            )
    except Exception as exc:
        print(f"[KIYAS GÖRSELİ HAZIRLAMA HATASI] {exc}")

    audio_file = await audio_task

    # Commit the forecast cycle once the report payload is complete. This is
    # the shared trigger for both delivery channels; a channel outage must not
    # make the other channel wait or cause the GFS cycle to be processed twice.
    await asyncio.to_thread(save_run, run_id, payload)
    print(f"[GFS CYCLE COMMITTED] {run_id}; Telegram and Pages deliveries start independently.")

    async def deliver_telegram_report():
        try:
            await send_telegram_text(full_text_report)
        except Exception as telegram_exc:
            print(f"[TELEGRAM TEXT UYARI] Metin gönderilemedi: {telegram_exc}")

        if chart_buffer:
            try:
                await send_telegram_photo(
                    chart_buffer,
                    telegram_caption or f"📊 {APP_LABEL} | Dört döngü karşılaştırması",
                )
            except Exception as exc:
                print(f"[TELEGRAM IMAGE ERROR] Karşılaştırma görseli gönderilemedi: {exc}")

        if audio_file:
            try:
                # Pages archives the same file concurrently. Keep it until both
                # channel tasks finish; the owner below removes it exactly once.
                await send_telegram_voice(audio_file, cleanup=False)
            except Exception as exc:
                print(f"[TELEGRAM VOICE ERROR] Ses gönderilemedi: {exc}")
        else:
            print("[TELEGRAM VOICE] Ses üretilemedi; metin/görsel gönderimi ayrıca denendi.")

    report_entry = await asyncio.to_thread(
        publish_public_notification,
        run_id,
        full_text_report,
        speech_text,
        None,
        audio_file,
        notification_images,
    )
    bundle = [(run_id, payload)]
    for cycle_id, raw_payload in comparison_runs:
        try:
            bundle.append((cycle_id, json.loads(raw_payload)))
        except (TypeError, ValueError):
            print(f"[PAKET] {cycle_id} kıyas kaydı okunamadı; pakete alınmadı.")
    export_public_forecast_json(
        run_id,
        payload,
        update_latest=True,
        comparison_payloads=bundle,
        report=report_entry if isinstance(report_entry, dict) else None,
    )
    try:
        await deliver_telegram_report()
        print(f"[TELEGRAM REPORT ATTEMPTED] {run_id} gönderim adımları tamamlandı.")
    except Exception as telegram_exc:
        print(f"[TELEGRAM REPORT ERROR] {type(telegram_exc).__name__}: {telegram_exc}")
    finally:
        if chart_buffer:
            chart_buffer.close()
        if audio_file and os.path.exists(audio_file):
            os.remove(audio_file)

    print(f"[COMPLETE] GFS run işlendi; Telegram ve Pages ayrı ayrı denendi: {run_id}")
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


async def run_manual_report(run_id, media_only=False, image_only=False):
    """Regenerate one report for Telegram and Pages without changing run history."""
    init_db()
    run_dt = _parse_utc_datetime(run_id)
    normalized_run_id = run_dt.isoformat(timespec="seconds")
    mode_label = "yalnızca düzeltme görseli" if image_only else ("yalnızca görsel" if media_only else "metin + görsel; ses kapalı")
    print(f"[MANUAL] {normalized_run_id} için {mode_label} hazırlanıyor; geçmiş değişmeyecek.")

    comparison_runs = []
    for hours_back in (18, 12, 6):
        previous_id = (run_dt - timedelta(hours=hours_back)).isoformat(timespec="seconds")
        stored_record = await asyncio.to_thread(get_run_payload, previous_id)
        if not stored_record:
            raise RuntimeError(
                f"{previous_id} karşılaştırma verisi geçmişte bulunamadı; "
                "manuel medya gönderimi geçmiş kayıtları değiştirmeden durduruldu."
            )
        comparison_runs.append((
            stored_record[0],
            json.dumps(stored_record[1], ensure_ascii=False),
        ))

    payload = await asyncio.to_thread(fetch_full_weather_data, normalized_run_id)
    if payload and "_pending_noaa_gfs" in payload:
        raise RuntimeError(
            f"{normalized_run_id} için veri henüz alınamadı: "
            f"{payload.get('_reason', payload.get('_http_status', 'eksik veri'))}"
        )
    if not payload:
        raise RuntimeError(f"{normalized_run_id} için GFS tahmini oluşturulamadı.")

    payload["model_metadata"] = {"manual_resend": True, "run_id": normalized_run_id}
    payload["station_observation"] = await asyncio.to_thread(fetch_enka_station_observation)
    full_text_report, speech_text = analyze_and_build_output(
        normalized_run_id, payload, comparison_runs
    )
    chart = create_comparison_chart(normalized_run_id, payload, comparison_runs)
    if not chart:
        raise RuntimeError("Telegram için karşılaştırma görseli üretilemedi.")

    pages_charts = create_pages_comparison_charts(
        normalized_run_id, payload, comparison_runs
    )
    try:
        image_paths = await asyncio.to_thread(
            save_public_notification_images, normalized_run_id, pages_charts
        ) if pages_charts else []
        image_path = await asyncio.to_thread(
            save_public_notification_image, normalized_run_id, chart
        )
        report_entry = await asyncio.to_thread(
            publish_public_notification,
            normalized_run_id,
            full_text_report,
            speech_text,
            image_path,
            None,
            image_paths,
        )
        bundle = [(normalized_run_id, payload)]
        for cycle_id, forecast_json in comparison_runs:
            bundle.append((cycle_id, json.loads(forecast_json)))
        await asyncio.to_thread(
            export_public_forecast_json,
            normalized_run_id,
            payload,
            True,
            bundle,
            report_entry,
        )

        # One-time resend intentionally contains no voice: Telegram text and
        # the Pages written report are generated from this exact same string.
        if not media_only and not image_only:
            await send_telegram_text(full_text_report)
        await send_telegram_photo(
            chart,
            f"📊 İstanbul GFS | Dört döngü karşılaştırması · {run_dt:%Y-%m-%d %HZ} UTC"
        )
    finally:
        chart.close()
        for image_buffer in (pages_charts or {}).values():
            try:
                image_buffer.close()
            except Exception:
                pass

    print(
        f"[MANUAL COMPLETE] {normalized_run_id}: "
        "Telegram metin/görsel ve Pages yazılı raporu aynı rapor metniyle güncellendi; "
        "ses gönderilmedi, SQLite çalışma geçmişi değiştirilmedi."
    )


def main():
    """Compatibility library entrypoint; live Istanbul GFS is MeteoPT-canonical.

    The legacy NOAA polling, in-process Telegram delivery, and manual resend
    modes remain only as inert compatibility functions for historical tooling.
    They are not part of the live Istanbul GFS workflow and are never invoked
    by GitHub Actions.
    """
    print(
        "[INERT] Legacy main.py runtime is disabled. "
        "Live Istanbul GFS is produced only by the MeteoPT canonical bundle."
    )


if __name__ == "__main__":
    main()
