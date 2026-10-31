# v9.5.0 - Istanbul Timezone Fix (UTC+3), 180h Forecast & 1.2x Speech
import os
import json
import sqlite3
import asyncio
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo  # Türkiye saati için yerleşik kütüphane
import requests
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
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO gfs_runs_v3 (run_name, forecast_json)
        VALUES (?, ?)
    """, (run_name, json.dumps(forecast_dict)))
    conn.commit()
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

            return {
                "model": MODEL_NAME,
                "metadata_source": metadata_url,
                "run_id": run_id,
                "last_run_initialisation_time": run_id,
                "last_run_availability_time": _normalise_model_timestamp(modified_at),
                "last_modified_time": _normalise_model_timestamp(modified_at),
                "last_valid_time": last_valid_dt.isoformat(timespec="minutes"),
                "forecast_horizon_hours": available_hours,
                "completed": bool(record.get("completed", False)),
            }
        except Exception as e:
            errors.append(f"{metadata_url}: {type(e).__name__}: {e}")

    print("[METADATA HATA] GFS ilerleme bilgisi alınamadı. " + " | ".join(errors))
    return None


# --- VERİ ÇEKME (+180 SAAT / FAST-FETCH) ---
def fetch_full_weather_data(run_id):
    print(f"[STEP 1] Open-Meteo Single Runs API verisi çekiliyor: {run_id}")
    try:
        run_dt = _parse_utc_datetime(run_id)
        run_param = run_dt.strftime("%Y-%m-%dT%H:%M")
        local_params = {
            "latitude": LAT,
            "longitude": LON,
            "run": run_param,
            "models": MODEL_NAME,
            "current": "temperature_2m,precipitation,rain,snowfall,wind_speed_10m,surface_pressure",
            "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
            "hourly": "temperature_2m,precipitation,snowfall,surface_pressure,wind_speed_10m",
            "forecast_hours": MIN_FORECAST_HOURS + 1,
            "timezone": "Europe/Istanbul",
        }

        res = requests.get(SINGLE_RUNS_URL, params=local_params, timeout=30)
        if res.status_code in (404, 425, 503):
            print(
                f"[PENDING] Single Runs API henüz {run_param} çalışmasını sunmuyor "
                f"(HTTP {res.status_code}); sonraki kontrolde tekrar denenecek."
            )
            return {
                "_pending_single_run": True,
                "_run_id": run_id,
                "_http_status": res.status_code,
            }
        res.raise_for_status()
        data = res.json()

        current = data.get("current", {})
        daily = data.get("daily", {})
        hourly = data.get("hourly", {})
        times = hourly.get("time", [])
        temps = hourly.get("temperature_2m", [])
        precips = hourly.get("precipitation", [])

        if not times:
            raise ValueError("Single Runs API hourly time dizisi boş döndü.")

        first_dt = _parse_utc_datetime(times[0])
        last_dt = _parse_utc_datetime(times[-1])
        if abs((first_dt - run_dt).total_seconds()) > 3600:
            raise ValueError(
                f"Single Runs API yanlış başlangıç saati döndürdü: {times[0]} "
                f"(beklenen {run_param})."
            )

        available_hours = max(
            0, int((last_dt - run_dt).total_seconds() // 3600)
        )
        if available_hours < MIN_FORECAST_HOURS or len(times) < MIN_FORECAST_HOURS + 1:
            print(
                f"[PENDING] Tekil GFS çalışması yalnızca +{available_hours} saate kadar "
                f"erişilebilir; +{MIN_FORECAST_HOURS} saat bekleniyor."
            )
            return {
                "_pending_single_run": True,
                "_run_id": run_id,
                "_available_hours": available_hours,
            }

        forecast_timeline = {}
        for i in range(0, min(MIN_FORECAST_HOURS + 1, len(times)), 6):
            t_str = times[i]
            forecast_timeline[t_str] = {
                "step_hour": int(
                    (_parse_utc_datetime(t_str) - run_dt).total_seconds() // 3600
                ),
                "temp": round(temps[i], 1) if i < len(temps) else 0.0,
                "precip": round(precips[i], 2) if i < len(precips) else 0.0,
            }

        synoptic_alerts = []
        live_url = "https://api.open-meteo.com/v1/forecast"
        for region, (r_lat, r_lon) in SYNOPTIC_POINTS.items():
            r_params = {
                "latitude": r_lat,
                "longitude": r_lon,
                "current": "pressure_msl",
                "models": MODEL_NAME,
            }
            try:
                r_res = requests.get(live_url, params=r_params, timeout=6)
                r_res.raise_for_status()
                r_press = round(
                    r_res.json().get("current", {}).get("pressure_msl", 1013.0), 1
                )
                if r_press <= 1015.0:
                    synoptic_alerts.append(
                        f"{region} üzerinde alçak basınç ({r_press} hPa)"
                    )
                elif r_press >= 1023.0:
                    synoptic_alerts.append(
                        f"{region} üzerinde yüksek basınç ({r_press} hPa)"
                    )
            except Exception:
                continue

        payload = {
            "current": {
                "temp": round(current.get("temperature_2m", 0.0), 1),
                "precip": round(current.get("precipitation", 0.0), 2),
                "wind": round(current.get("wind_speed_10m", 0.0), 1),
                "pressure": round(current.get("surface_pressure", 1013.0), 1),
            },
            "daily": {
                "time": daily.get("time", []),
                "temp_max": daily.get("temperature_2m_max", []),
                "temp_min": daily.get("temperature_2m_min", []),
                "precip_sum": daily.get("precipitation_sum", []),
                "wind_max": daily.get("wind_speed_10m_max", []),
            },
            "timeline_180h": forecast_timeline,
            "forecast_horizon_hours": available_hours,
            "synoptic_alerts": synoptic_alerts,
        }

        print(
            f"[STEP 1 BAŞARILI] Tam {run_param} GFS çalışması alındı; "
            f"+{available_hours} saat."
        )
        return payload
    except Exception as e:
        print(f"[STEP 1 HATA] Open-Meteo Single Runs API erişim hatası: {e}")
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

    if previous_runs and len(previous_runs) > 0:
        try:
            prev_json = json.loads(previous_runs[0][1])
            prev_timeline = prev_json.get("timeline_180h", {})

            for time_key, curr_data in timeline.items():
                if time_key in prev_timeline:
                    p_data = prev_timeline[time_key]
                    step = curr_data["step_hour"]

                    t_diff = round(curr_data["temp"] - p_data["temp"], 1)
                    if abs(t_diff) >= 2.0:
                        direction = "artış" if t_diff > 0 else "düşüş"
                        temp_shifts.append(f"+{step}. saatte {abs(t_diff)} derece {direction}")

                    p_diff = round(curr_data["precip"] - p_data["precip"], 2)
                    if abs(p_diff) >= 1.00:
                        p_dir = "artış" if p_diff > 0 else "azalma"
                        precip_shifts.append(f"+{step}. saatte {abs(p_diff)} milimetre {p_dir}")
        except Exception as e:
            print(f"[UYARI] Kıyaslama yapılırken hata oluştu: {e}")

    if temp_shifts or precip_shifts:
        speech_parts.append("Önceki çıktıya kıyasla ilerleyen saatlerde değişimler var.")
        if temp_shifts:
            speech_parts.append("Sıcaklıkta: " + ", ".join(temp_shifts[:2]) + ".")
        if precip_shifts:
            speech_parts.append("Yağışta: " + ", ".join(precip_shifts[:2]) + ".")

    if synoptic:
        speech_parts.append("Bölgesel basınç haritasında: " + ", ".join(synoptic) + " tespit edildi.")

    speech_text = " ".join(speech_parts)

    now_tr_str = datetime.now(TR_TZ).strftime('%Y-%m-%d %H:%M')

    text_report_lines = [
        f"🌐 MODEL GÜNCELLEME RAPORU",
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

    if temp_shifts or precip_shifts:
        text_report_lines.append("\n⚡ +180 Saate Kadar 6 Saatlik Dilim Değişiklikleri:")
        if temp_shifts:
            text_report_lines.append("• Sıcaklık: " + ", ".join(temp_shifts))
        if precip_shifts:
            text_report_lines.append("• Yağış: " + ", ".join(precip_shifts))

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
    metadata = await asyncio.to_thread(fetch_model_update_metadata)
    if not metadata:
        message = "GFS in-progress/latest metadata alınamadı."
        print(f"[SKIP] {message}")
        if strict:
            raise RuntimeError(message)
        return

    run_id = metadata["run_id"]
    available_hours = int(metadata.get("forecast_horizon_hours", 0))
    print(
        f"[MODEL] GFS run {run_id}; yayınlanan tahmin: +{available_hours} saat; "
        f"hedef: +{MIN_FORECAST_HOURS} saat."
    )

    # Do not use the current time as the reference. The threshold is measured
    # from this exact GFS run's UTC initialisation time.
    if available_hours < MIN_FORECAST_HOURS:
        print(
            f"[PENDING] {run_id} henüz +{MIN_FORECAST_HOURS} saate ulaşmadı "
            f"(şu an +{available_hours}). Sonraki kontrolde yeniden bakılacak."
        )
        return

    previous_runs = get_previous_runs()
    if previous_runs and previous_runs[0][0] == run_id:
        print(f"[UNCHANGED] GFS run zaten işlendi: {run_id}")
        return

    # Open-Meteo recommends waiting 10 minutes after a model update to allow
    # geographically distributed API servers to become consistent.
    available_at = metadata.get("last_modified_time")
    if available_at:
        try:
            available_dt = _parse_utc_datetime(available_at)
            remaining = available_dt.timestamp() + 600 - datetime.now(timezone.utc).timestamp()
            if remaining > 0:
                print(
                    f"[WAIT] GFS verisinin sunucular arasında tutarlı hale gelmesi için "
                    f"{int(remaining)} saniye bekleniyor."
                )
                await asyncio.sleep(remaining)
        except (TypeError, ValueError):
            print("[METADATA UYARI] last_modified_time çözümlenemedi; devam ediliyor.")

    print(f"[UPDATE] +180 saat eşiğine ulaşan GFS run alınıyor: {run_id}")
    payload = await asyncio.to_thread(fetch_full_weather_data, run_id)
    if payload and "_pending_single_run" in payload:
        print(
            f"[PENDING] {run_id} Single Runs API üzerinde henüz hazır değil; "
            "sonraki kontrolde tekrar denenecek."
        )
        return
    if not payload:
        message = f"{run_id} için Single Runs API tahmini alınamadı."
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
    init_db()
    print(
        f"[START] GFS Watch çalışıyor. Kontrol aralığı: "
        f"{POLL_INTERVAL_SECONDS // 60} dakika; model: {MODEL_NAME}."
    )
    while True:
        try:
            await process_gfs_update()
        except Exception as e:
            print(f"[LOOP HATA] {type(e).__name__}: {e}")
        print(f"[WAIT] {POLL_INTERVAL_SECONDS} saniye sonra tekrar kontrol.")
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


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
