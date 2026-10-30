# v7.1.0 - Hyper-Verbose Diagnostic & Open-Meteo Parameter Fix
import os
import json
import sqlite3
import asyncio
from datetime import datetime
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

# --- VERİTABANI TAKİBİ ---
def init_db():
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS gfs_runs_v3 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            run_name TEXT,
            forecast_json TEXT
        )
    """)
    conn.commit()
    conn.close()

def get_previous_runs():
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        SELECT run_name, forecast_json 
        FROM gfs_runs_v3 ORDER BY id DESC LIMIT 2
    """)
    rows = cursor.fetchall()
    conn.close()
    return rows

def save_run(run_name, forecast_dict):
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO gfs_runs_v3 (run_name, forecast_json)
        VALUES (?, ?)
    """, (run_name, json.dumps(forecast_dict)))
    conn.commit()
    conn.close()

# --- ANLIK, 3 GÜNLÜK VE 180 SAATLİK VERİ ÇEKME ---
def fetch_full_weather_data():
    print("[STEP 1] Open-Meteo verileri çekiliyor...")
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": LAT,
        "longitude": LON,
        "current": "temperature_2m,precipitation,rain,snowfall,wind_speed_10m",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
        "hourly": "temperature_2m,precipitation,snowfall,surface_pressure,wind_speed_10m",
        "forecast_days": 8,
        "models": "gfs_seamless",
        "timezone": "Europe/Istanbul"
    }

    try:
        res = requests.get(url, params=params, timeout=20)
        res.raise_for_status()
        data = res.json()

        current = data.get("current", {})
        daily = data.get("daily", {})
        hourly = data.get("hourly", {})

        times = hourly.get("time", [])
        temps = hourly.get("temperature_2m", [])
        precips = hourly.get("precipitation", [])

        forecast_timeline = {}
        for i in range(0, min(181, len(times)), 6):
            t_str = times[i]
            forecast_timeline[t_str] = {
                "step_hour": i,
                "temp": round(temps[i], 1) if i < len(temps) else 0.0,
                "precip": round(precips[i], 2) if i < len(precips) else 0.0
            }

        payload = {
            "current": {
                "temp": round(current.get("temperature_2m", 0.0), 1),
                "precip": round(current.get("precipitation", 0.0), 2),
                "wind": round(current.get("wind_speed_10m", 0.0), 1)
            },
            "daily": {
                "time": daily.get("time", []),
                "temp_max": daily.get("temperature_2m_max", []),
                "temp_min": daily.get("temperature_2m_min", []),
                "precip_sum": daily.get("precipitation_sum", []),
                "wind_max": daily.get("wind_speed_10m_max", [])
            },
            "timeline_180h": forecast_timeline
        }

        run_name = f"Güncelleme ({datetime.now().strftime('%H:%M')})"
        print("[STEP 1 BAŞARILI] Hava durumu verileri tam olarak çekildi.")
        return run_name, payload
    except Exception as e:
        print(f"[STEP 1 CRITICAL ERROR] Open-Meteo Veri Alma Hatası: {e}")
        return None, None

# --- METİN VE SES İÇERİĞİ OLUŞTURUCU ---
def analyze_and_build_output(current_run_name, payload, previous_runs):
    print("[STEP 2] Metin ve analiz içeriği oluşturuluyor...")
    curr = payload["current"]
    daily = payload["daily"]
    timeline = payload["timeline_180h"]

    curr_t = curr["temp"]
    curr_p = curr["precip"]
    curr_w = curr["wind"]

    # 1. ANLIK HAVA DURUMU SES METNİ
    speech_parts = [f"İstanbul'da anlık sıcaklık {curr_t} derece."]
    
    if curr_p > 0:
        speech_parts.append(f"Yağış {curr_p} milimetre.")
    else:
        speech_parts.append("Yağış beklenmiyor.")

    if curr_w > 20.0:
        speech_parts.append("Hava rüzgarlı.")

    # 2. 3 GÜNLÜK ÖZET SES METNİ
    speech_parts.append("Önümüzdeki 3 günlük özete baktığımızda:")
    day_labels = ["Bugün", "Yarın", "Sonraki gün"]
    
    for i in range(min(3, len(daily.get("time", [])))):
        label = day_labels[i] if i < len(day_labels) else f"{i+1}. gün"
        t_max = round(daily["temp_max"][i], 1) if i < len(daily["temp_max"]) else 0.0
        t_min = round(daily["temp_min"][i], 1) if i < len(daily["temp_min"]) else 0.0
        p_sum = round(daily["precip_sum"][i], 1) if i < len(daily["precip_sum"]) else 0.0
        w_max = round(daily["wind_max"][i], 1) if i < len(daily["wind_max"]) else 0.0

        day_text = f"{label}: En düşük {t_min}, en yüksek {t_max} derece."
        if p_sum > 0:
            day_text += f" Toplam yağış {p_sum} milimetre."
        else:
            day_text += " Yağışsız."

        if w_max > 20.0:
            day_text += " Hava rüzgarlı."

        speech_parts.append(day_text)

    # 3. 180 SAATLİK 6 SAATLİK DİLİM DEĞİŞİKLİK KIYASLAMASI (N-1)
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
                        temp_shifts.append(f"+{step}. saatte {abs(t_diff)}°C {direction}")

                    p_diff = round(curr_data["precip"] - p_data["precip"], 2)
                    if abs(p_diff) >= 2.00:
                        p_dir = "artış" if p_diff > 0 else "azalma"
                        precip_shifts.append(f"+{step}. saatte {abs(p_diff)} mm {p_dir}")
        except Exception as e:
            print(f"[UYARI] Kıyaslama hatası: {e}")

    if temp_shifts or precip_shifts:
        speech_parts.append("Önceki çıktıya kıyasla ilerleyen saatlerde değişimler var.")
        if temp_shifts:
            speech_parts.append("Sıcaklıkta: " + ", ".join(temp_shifts[:2]) + ".")
        if precip_shifts:
            speech_parts.append("Yağışta: " + ", ".join(precip_shifts[:2]) + ".")

    speech_text = " ".join(speech_parts)

    # TELEGRAM METİN RAPORU
    text_report_lines = [
        f"🌐 MODEL GÜNCELLEME RAPORU",
        f"📍 Konum: {LOCATION_NAME} | ⏱ Zaman: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n",
        f"🌡 Anlık Sıcaklık: {curr_t} °C",
        f"🌧 Anlık Yağış: {curr_p} mm",
        f"💨 Anlık Rüzgar: {curr_w} km/s {'(Rüzgarlı 🌬️)' if curr_w > 20.0 else ''}\n",
        f"📅 ÖNÜMÜZDEKİ 3 GÜNLÜK ÖZET:"
    ]

    for i in range(min(3, len(daily.get("time", [])))):
        label = day_labels[i] if i < len(day_labels) else f"{i+1}. gün"
        t_max = round(daily["temp_max"][i], 1) if i < len(daily["temp_max"]) else 0.0
        t_min = round(daily["temp_min"][i], 1) if i < len(daily["temp_min"]) else 0.0
        p_sum = round(daily["precip_sum"][i], 1) if i < len(daily["precip_sum"]) else 0.0
        w_max = round(daily["wind_max"][i], 1) if i < len(daily["wind_max"]) else 0.0

        wind_tag = " | 🌬️ Rüzgarlı" if w_max > 20.0 else ""
        text_report_lines.append(f"• {label}: {t_min}°C / {t_max}°C | Yağış: {p_sum} mm{wind_tag}")

    if temp_shifts or precip_shifts:
        text_report_lines.append("\n⚡ 180 Saate Kadar 6 Saatlik Dilim Değişiklikleri:")
        if temp_shifts:
            text_report_lines.append("• Sıcaklık: " + ", ".join(temp_shifts))
        if precip_shifts:
            text_report_lines.append("• Yağış: " + ", ".join(precip_shifts))

    text_report_lines.append(f"\n🎙 Seslendirme Metni:\n\"{speech_text}\"")
    full_text_report = "\n".join(text_report_lines)

    print("[STEP 2 BAŞARILI] Rapor ve ses metni hazırlandı.")
    return full_text_report, speech_text

# --- GOOGLE CLOUD TTS MOTORU ---
async def generate_speech_gcp(text, output_file="summary.mp3"):
    print("[STEP 3] Google Cloud TTS ile ses dosyası üretiliyor...")
    try:
        if not GCP_SA_KEY:
            print("[STEP 3 ERROR] GCP_SA_KEY secret tanımlı değil veya boş!")
            return None

        key_dict = json.loads(GCP_SA_KEY)
        credentials = service_account.Credentials.from_service_account_info(key_dict)
        client = texttospeech.TextToSpeechClient(credentials=credentials)

        synthesis_input = texttospeech.SynthesisInput(text=text)
        voice = texttospeech.VoiceSelectionParams(
            language_code="tr-TR",
            name="tr-TR-Wavenet-C",
            ssml_gender=texttospeech.SsmlVoiceGender.MALE
        )
        audio_config = texttospeech.AudioConfig(
            audio_encoding=texttospeech.AudioEncoding.MP3,
            speaking_rate=1.03
        )
        response = client.synthesize_speech(input=synthesis_input, voice=voice, audio_config=audio_config)

        with open(output_file, "wb") as out:
            out.write(response.audio_content)
        print("[STEP 3 BAŞARILI] Ses dosyası üretildi.")
        return output_file
    except Exception as e:
        print(f"[STEP 3 ERROR] GCP TTS Hatası: {e}")
        return None

# --- TELEGRAM GÖNDERİCİ ---
async def send_telegram_alert(text, audio_path=None):
    print("[STEP 4] Telegram mesajı gönderiliyor...")
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print(f"[STEP 4 ERROR] TELEGRAM_TOKEN var mı: {bool(TELEGRAM_TOKEN)}, CHAT_ID var mı: {bool(CHAT_ID)}")
        return
    try:
        async with Bot(token=TELEGRAM_TOKEN) as bot:
            print(f"[STEP 4.1] Metin mesajı iletiliyor...")
            await bot.send_message(chat_id=CHAT_ID, text=text)
            print("[STEP 4.1 BAŞARILI] Metin mesajı iletildi.")
            
            if audio_path and os.path.exists(audio_path):
                print("[STEP 4.2] Ses dosyası iletiliyor...")
                with open(audio_path, "rb") as voice:
                    await bot.send_voice(chat_id=CHAT_ID, voice=voice)
                print("[STEP 4.2 BAŞARILI] Ses dosyası iletildi.")
                os.remove(audio_path)
            else:
                print("[STEP 4.2 SKIPPED] Ses dosyası bulunamadı.")
    except Exception as e:
        print(f"[STEP 4 CRITICAL ERROR] Telegram İletim Hatası: {e}")

# --- ANA ÇALIŞTIRICI ---
async def main():
    init_db()
    print("[LOG START] Hava Durumu Otomasyonu Başlatıldı.")

    run_name, payload = fetch_full_weather_data()
    if not payload:
        print("[LOG ABORT] Veri çekilemediği için süreç sonlandırıldı.")
        return

    previous_runs = get_previous_runs()
    full_text_report, speech_text = analyze_and_build_output(run_name, payload, previous_runs)

    save_run(run_name, payload)

    audio_file = await generate_speech_gcp(speech_text)
    await send_telegram_alert(full_text_report, audio_path=audio_file)
    print("[LOG COMPLETE] Süreç tamamlandı.")

if __name__ == "__main__":
    asyncio.run(main())
