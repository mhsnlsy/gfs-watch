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
LOCATION_NAME = "İstanbul"
TR_TZ = ZoneInfo("Europe/Istanbul")  # İstanbul saat dilimi
POLL_INTERVAL_SECONDS = max(60, int(os.getenv("POLL_INTERVAL_SECONDS", "600")))
DATA_DIR = "/data" if os.path.isdir("/data") else "."
DB_PATH = os.getenv("DB_PATH", os.path.join(DATA_DIR, "gfs_watch.db"))
MODEL_NAME = "ncep_gfs_global"
# Open-Meteo publishes GFS progress metadata separately from its completed
# time-series metadata. This lets us track the active 00/06/12/18 UTC run.
MODEL_METADATA_URLS = (
    "https://openmeteo.s3.amazonaws.com/data_spatial/ncep_gfs013/in-progress.json",
    "https://openmeteo.s3.amazonaws.com/data_spatial/ncep_gfs013/latest.json",
)
SINGLE_RUNS_URL = "https://single-runs-api.open-meteo.com/v1/forecast"
MIN_FORECAST_HOURS = 180
RETENTION_DAYS = 10

SYNOPTIC_POINTS = {
    "Balkanlar": (45.0, 18.0),
    "Karadeniz / Kırım çevresi": (46.0, 35.0),
    "Orta Akdeniz": (38.0, 15.0),
    "Doğu Akdeniz": (34.0, 30.0)
}

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

def save_run(run_name, forecast_dict):
    conn = sqlite3.connect(DB_PATH)
    try:
        cursor = conn.cursor()
        serialized = json.dumps(forecast_dict)
        # Refresh an existing run in place (used to migrate the first
        # baseline to exact Single Runs API data without creating duplicates).
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

# --- GFS MODEL SÜRÜMÜ METADATA ---
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


def fetch_model_update_metadata():
    candidates = []
    errors = []
    for metadata_url in MODEL_METADATA_URLS:
        try:
            response = requests.get(
                metadata_url,
                headers={"Cache-Control": "no-cache"},
                timeout=15,
            )
            response.raise_for_status()
            record = response.json()
            if not isinstance(record, dict):
                raise ValueError(f"Beklenmeyen metadata yanıtı: {record}")

            reference_time = record.get("reference_time")
            valid_times = record.get("valid_times") or []
            if not reference_time or not valid_times:
                raise ValueError(
                    "Metadata içinde reference_time veya valid_times bulunamadı."
                )

            run_dt = _parse_utc_datetime(reference_time)
            valid_datetimes = [_parse_utc_datetime(value) for value in valid_times]
            last_valid_dt = max(valid_datetimes)
            available_hours = max(
                0, int((last_valid_dt - run_dt).total_seconds() // 3600)
            )
            run_id = run_dt.isoformat(timespec="seconds")
            modified_at = record.get("last_modified_time")

            candidates.append({
                "model": MODEL_NAME,
                "metadata_source": metadata_url,
                "run_id": run_id,
                "last_run_initialisation_time": run_id,
                "last_run_availability_time": _normalise_model_timestamp(modified_at),
                "last_modified_time": _normalise_model_timestamp(modified_at),
                "last_valid_time": last_valid_dt.isoformat(timespec="minutes"),
                "forecast_horizon_hours": available_hours,
                "completed": bool(record.get("completed", False)),
            })
        except Exception as e:
            errors.append(f"{metadata_url}: {type(e).__name__}: {e}")

    if not candidates:
        print("[METADATA HATA] GFS ilerleme bilgisi alınamadı. " + " | ".join(errors))
        return []

    # The active run and most recently completed run are both important:
    # while a new cycle is still below +180h, the preceding completed cycle
    # may already be eligible and must not be hidden by in-progress.json.
    by_run = {}
    for candidate in candidates:
        current = by_run.get(candidate["run_id"])
        if current is None or (
            candidate["forecast_horizon_hours"] > current["forecast_horizon_hours"]
        ):
            by_run[candidate["run_id"]] = candidate

    return sorted(by_run.values(), key=lambda item: item["run_id"])


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
        points = {
            "Istanbul": (LAT, LON),
            **SYNOPTIC_POINTS,
        }
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
                "var_PRMSL": "on",
                "lev_mean_sea_level": "on",
                "subregion": "",
                "leftlon": "10",
                "rightlon": "42",
                "toplat": "50",
                "bottomlat": "30",
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
                "pressure": None,
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
                                or (short_name == "prmsl" and level_type == "meanSea")
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
                            elif short_name == "prmsl":
                                step_data["pressure"] = samples
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
            if lead > 0 and not step_data["pressure"]:
                print(f"[PENDING] NOAA f{lead:03d} içinde basınç alanı bulunamadı.")
                return {
                    "_pending_noaa_gfs": True,
                    "_run_id": run_id,
                    "_forecast_hour": lead,
                    "_reason": "missing mean sea level pressure field",
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
        regional_pressures = {}

        for lead in lead_hours:
            step_data = decoded_steps[lead]
            valid_utc = run_dt + timedelta(hours=lead)
            valid_local = valid_utc.astimezone(TR_TZ)
            time_key = valid_local.strftime("%Y-%m-%dT%H:%M")

            temperature = step_data["temperature"]
            wind_u = step_data["wind_u"] or {}
            wind_v = step_data["wind_v"] or {}
            pressure = step_data["pressure"] or {}

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

            if lead == 0:
                regional_pressures = {
                    name: float(value) / 100.0
                    for name, value in pressure.items()
                }

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
                "pressure": round(regional_pressures.get("Istanbul", 1013.0), 1),
            }

        synoptic_alerts = []
        for region in SYNOPTIC_POINTS:
            pressure_value = regional_pressures.get(region)
            if pressure_value is None:
                continue
            if pressure_value <= 1015.0:
                synoptic_alerts.append(
                    f"{region} üzerinde alçak basınç ({pressure_value:.1f} hPa)"
                )
            elif pressure_value >= 1023.0:
                synoptic_alerts.append(
                    f"{region} üzerinde yüksek basınç ({pressure_value:.1f} hPa)"
                )

        payload = {
            "current": current,
            "daily": daily,
            "timeline_180h": forecast_timeline,
            "forecast_horizon_hours": MIN_FORECAST_HOURS,
            "synoptic_alerts": synoptic_alerts,
            "data_source": "NOAA/NCEP GFS 0.25° GRIB2 (NOMADS)",
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
    synoptic = payload["synoptic_alerts"]

    curr_t = curr["temp"]
    curr_p = curr["precip"]
    curr_w = curr["wind"]

    speech_parts = [f"İstanbul'da anlık sıcaklık {curr_t} derece."]
    speech_parts.append(f"Yağış {curr_p} milimetre." if curr_p > 0 else "Yağış beklenmiyor.")
    if curr_w > 20.0:
        speech_parts.append("Hava rüzgarlı.")

    speech_parts.append("Önümüzdeki 3 günlük özete baktığımızda:")
    day_labels = ["Yarın", "Sonraki gün", "3. gün"]
    
    for idx, i in enumerate(range(1, min(4, len(daily.get("time", []))))):
        label = day_labels[idx] if idx < len(day_labels) else f"{idx+1}. gün"
        t_max = round(daily["temp_max"][i], 1) if i < len(daily["temp_max"]) else 0.0
        t_min = round(daily["temp_min"][i], 1) if i < len(daily["temp_min"]) else 0.0
        p_sum = round(daily["precip_sum"][i], 1) if i < len(daily["precip_sum"]) else 0.0
        w_max = round(daily["wind_max"][i], 1) if i < len(daily["wind_max"]) else 0.0

        day_text = f"{label}: En düşük {t_min}, en yüksek {t_max} derece."
        day_text += f" Toplam yağış {p_sum} milimetre." if p_sum > 0 else " Yağışsız."
        if w_max > 20.0:
            day_text += " Hava rüzgarlı."

        speech_parts.append(day_text)

    temp_shifts = []
    precip_shifts = []
    comparison_points = 0

    if previous_runs and len(previous_runs) > 0:
        try:
            prev_json = json.loads(previous_runs[0][1])
            prev_timeline = prev_json.get("timeline_180h", {})

            for time_key, curr_data in timeline.items():
                if time_key in prev_timeline:
                    comparison_points += 1
                    p_data = prev_timeline[time_key]
                    step = curr_data["step_hour"]

                    t_diff = round(curr_data["temp"] - p_data["temp"], 1)
                    if abs(t_diff) >= 2.0:
                        direction = "artış" if t_diff > 0 else "düşüş"
                        temp_shifts.append(f"+{step}. saatte {abs(t_diff)} derece {direction}")

                    current_precip = curr_data.get("precip")
                    previous_precip = p_data.get("precip")
                    if current_precip is not None and previous_precip is not None:
                        p_diff = round(current_precip - previous_precip, 2)
                        if abs(p_diff) >= 1.00:
                            p_dir = "artış" if p_diff > 0 else "azalma"
                            precip_shifts.append(f"+{step}. saatte {abs(p_diff)} milimetre {p_dir}")
        except Exception as e:
            print(f"[UYARI] Kıyaslama yapılırken hata oluştu: {e}")

    if temp_shifts or precip_shifts:
        speech_parts.append("Önceki GFS çalışmasıyla kıyaslandığında ilerleyen saatlerde değişimler var.")
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

    if synoptic:
        speech_parts.append("Bölgesel basınç haritasında: " + ", ".join(synoptic) + " tespit edildi.")

    speech_text = " ".join(speech_parts)

    now_tr_str = datetime.now(TR_TZ).strftime('%Y-%m-%d %H:%M')

    text_report_lines = [
        f"🌐 MODEL GÜNCELLEME RAPORU",
        f"🛰 GFS run: {current_run_name} UTC | Tahmin kapsamı: +{payload.get('forecast_horizon_hours', MIN_FORECAST_HOURS)} saat",
        f"📡 Veri kaynağı: {payload.get('data_source', 'NOAA/NCEP GFS 0.25° GRIB2')}\n",
        f"📍 Konum: {LOCATION_NAME} | ⏱ Zaman: {now_tr_str}\n",
        f"🌡 Anlık Sıcaklık: {curr_t} °C",
        f"🌧 Anlık Yağış: {curr_p} mm",
        f"💨 Anlık Rüzgar: {curr_w} km/s {'(Rüzgarlı 🌬️)' if curr_w > 20.0 else ''}\n",
        f"📅 ÖNÜMÜZDEKİ 3 GÜNLÜK ÖZET:"
    ]

    for idx, i in enumerate(range(1, min(4, len(daily.get("time", []))))):
        label = day_labels[idx] if idx < len(day_labels) else f"{idx+1}. gün"
        t_max = round(daily["temp_max"][i], 1) if i < len(daily["temp_max"]) else 0.0
        t_min = round(daily["temp_min"][i], 1) if i < len(daily["temp_min"]) else 0.0
        p_sum = round(daily["precip_sum"][i], 1) if i < len(daily["precip_sum"]) else 0.0
        w_max = round(daily["wind_max"][i], 1) if i < len(daily["wind_max"]) else 0.0

        wind_tag = " | 🌬️ Rüzgarlı" if w_max > 20.0 else ""
        text_report_lines.append(f"• {label}: {t_min}°C / {t_max}°C | Yağış: {p_sum} mm{wind_tag}")

    if previous_runs:
        text_report_lines.append(
            f"\\n🔁 GFS KIYASLAMASI | Önceki run: {previous_runs[0][0]}"
        )
        text_report_lines.append(
            f"• Karşılaştırılan ortak 6 saatlik dilim: {comparison_points}"
        )
        if temp_shifts or precip_shifts:
            text_report_lines.append("⚡ +180 Saate Kadar 6 Saatlik Dilim Değişiklikleri:")
            if temp_shifts:
                text_report_lines.append("• Sıcaklık: " + ", ".join(temp_shifts))
            if precip_shifts:
                text_report_lines.append("• Yağış: " + ", ".join(precip_shifts))
        elif comparison_points:
            text_report_lines.append(
                "• Belirlenen eşikleri aşan sıcaklık veya yağış değişikliği yok."
            )
        else:
            text_report_lines.append(
                "• Ortak zaman dilimi bulunamadı; kıyaslama yapılamadı."
            )

    if synoptic:
        text_report_lines.append("\n🌀 2000 km Çaplı Bölgesel Basınç Durumu:")
        for syn_item in synoptic:
            text_report_lines.append(f"• {syn_item}")

    text_report_lines.append(f"\n🎙 Seslendirme Metni:\n\"{speech_text}\"")
    full_text_report = "\n".join(text_report_lines)

    print("[STEP 2 BAŞARILI] Rapor hazırlandı.")
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
    candidates = await asyncio.to_thread(fetch_model_update_metadata)
    if not candidates:
        message = "GFS in-progress/latest metadata alınamadı."
        print(f"[SKIP] {message}")
        if strict:
            raise RuntimeError(message)
        return

    previous_runs = get_previous_runs()
    processed_run_ids = {row[0] for row in previous_runs}
    pending_runs = [
        item for item in candidates
        if item["run_id"] not in processed_run_ids
    ]

    if not pending_runs:
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

    # Do not hold a GitHub Actions runner while the source is distributing a run.
    # In-progress metadata may be updated repeatedly; the scheduled 10-minute
    # checks will retry the exact Single Runs endpoint without blocking a job.
    available_at = metadata.get("last_modified_time")
    if available_at and metadata.get("completed", False):
        try:
            available_dt = _parse_utc_datetime(available_at)
            remaining = available_dt.timestamp() + 600 - datetime.now(timezone.utc).timestamp()
            if remaining > 0:
                print(
                    f"[PENDING] Tamamlanmış GFS koşusu için dağıtık sunucu tutarlılığı "
                    f"bekleniyor; yaklaşık {int(remaining)} saniye sonra zamanlanmış "
                    "kontrolde tekrar denenecek."
                )
                return
        except (TypeError, ValueError):
            print("[METADATA UYARI] last_modified_time çözümlenemedi; devam ediliyor.")
    elif not metadata.get("completed", False):
        print(
            f"[INFO] {run_id} hâlâ işleniyor (+{available_hours} saat mevcut). "
            "Tekil koşu arşivi henüz hazır olmayabilir; API kontrolü yapılacak."
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
        if os.getenv("GFS_WATCH_ONCE", "").strip().lower() in {"1", "true", "yes"}:
            asyncio.run(run_once())
        else:
            asyncio.run(main())
    except KeyboardInterrupt:
        print("[STOP] GFS Watch kontrollü şekilde durduruldu.")
