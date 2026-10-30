# v5.0.0 - GFS +180h 6-Hour Interval Shift Engine & GCP TTS Integration
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

# --- OPEN-METEO GFS 180 SAATLİK (6 SAAT DİLİMLİ) VERİ ÇEKME ---
def fetch_gfs_180h_data():
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": LAT,
        "longitude": LON,
        "hourly": "temperature_2m,precipitation,snowfall,surface_pressure,wind_speed_10m",
        "forecast_hours": 180,
        "models": "gfs_seamless",
        "timezone": "Europe/Istanbul"
    }

    try:
        res = requests.get(url, params=params, timeout=20)
        res.raise_for_status()
        hourly = res.json().get("hourly", {})

        times = hourly.get("time", [])
        temps = hourly.get("temperature_2m", [])
        precips = hourly.get("precipitation", [])
        snows = hourly.get("snowfall", [])
        pressures = hourly.get("surface_pressure", [])
        winds = hourly.get("wind_speed_10m", [])

        forecast_timeline = {}

        # 0'dan 180'e kadar 6 saatlik adımlarla tara
        for i in range(0, min(181, len(times)), 6):
            t_str = times[i]
            forecast_timeline[t_str] = {
                "step_hour": i,
                "temp": round(temps[i], 1) if i < len(temps) else 0.0,
                "precip": round(precips[i], 1) if i < len(precips) else 0.0,
                "snow": round(snows[i], 1) if i < len(snows) else 0.0,
                "press": round(pressures[i], 1) if i < len(pressures) else 0.0,
                "wind": round(winds[i], 1) if i < len(winds) else 0.0
            }

        run_name = f"GFS ({datetime.now().strftime('%H:%M')})"
        return run_name, forecast_timeline
    except Exception as e:
        print(f"[HATA] Open-Meteo verisi çekilemedi: {e}")
        return None, None

# --- N-1 VE N-2 İLE 6 SAATLİK DİLİMLERDE KIYASLAMA VE SES METNİ ÜRETME ---
def analyze_and_build_script(current_run_name, current_forecast, previous_runs):
    script_parts = [f"GFS modelinin {current_run_name} güncellemesi alındı."]
    significant_changes = []
    is_important = False

    if previous_runs and len(previous_runs) > 0:
        prev_run_name, prev_json_str = previous_runs[0]
        prev_forecast = json.loads(prev_json_str)

        temp_shifts = []
        precip_shifts = []

        # Ortak zaman noktalarını kıyasla (+180 saate kadar)
        for time_key, curr_data in current_forecast.items():
            if time_key in prev_forecast:
                p_data = prev_forecast[time_key]
                step = curr_data["step_hour"]

                # 1. Sıcaklık Kıyaslaması (3 derece ve üzeri değişim)
                t_diff = round(curr_data["temp"] - p_data["temp"], 1)
                if abs(t_diff) >= 3.0:
                    direction = "artış" if t_diff > 0 else "düşüş"
                    temp_shifts.append(f"+{step}. saatte {abs(t_diff)} derece {direction}")

                # 2. Yağış Kıyaslaması (6 saatlik dilimde 7.0 mm ve üzeri değişim)
                p_diff = round(curr_data["precip"] - p_data["precip"], 1)
                if abs(p_diff) >= 7.0:
                    p_dir = "artış" if p_diff > 0 else "azalma"
                    precip_shifts.append(f"+{step}. saatte {abs(p_diff)} milimetre {p_dir}")

        if temp_shifts or precip_shifts:
            is_important = True
            script_parts.append(f"Önceki {prev_run_name} çıktısına göre 180 saatlik projeksiyonda önemli değişiklikler tespit edildi.")

            if temp_shifts:
                # İlk 3 belirgin değişimi seslendirmeye dahil et
                t_msg = "Sıcaklıkta: " + ", ".join(temp_shifts[:3]) + "."
                script_parts.append(t_msg)
                significant_changes.extend(temp_shifts)

            if precip_shifts:
                p_msg = "Yağışta: " + ", ".join(precip_shifts[:3]) + "."
                script_parts.append(p_msg)
                significant_changes.extend(precip_shifts)
        else:
            script_parts.append("Önceki çıktıya kıyasla 180 saatlik periyotta sıcaklıkta 3 derece veya yağışta 7 milimetre üzeri belirgin bir değişim saptanmadı.")
    else:
        script_parts.append("Veritabanında kıyaslanacak önceki koşu kaydı bulunmadığı için ilk referans veri kaydedildi.")
        is_important = True

    # Anlık İstanbul Durumu Bilgisi
    first_step = current_forecast.get(list(current_forecast.keys())[0], {})
    curr_t = first_step.get("temp", 0.0)
    curr_p = first_step.get("precip", 0.0)
    
    script_parts.append(f"İstanbul için anlık sıcaklık {curr_t} derece, yağış miktarı {curr_p} milimetre. Güvenli sürüşler.")

    speech_text = " ".join(script_parts)
    return speech_text, is_important, significant_changes

# --- GOOGLE CLOUD TTS MOTORU ---
async def generate_speech_gcp(text, output_file="summary.mp3"):
    try:
        if not GCP_SA_KEY:
            print("[HATA] GCP_SA_KEY secret tanımlı değil!")
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
        return output_file
    except Exception as e:
        print(f"[HATA] GCP TTS Hatası: {e}")
        return None

# --- TELEGRAM GÖNDERİCİ ---
async def send_telegram_alert(text, audio_path=None):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("[HATA] Telegram parametreleri eksik!")
        return
    try:
        async with Bot(token=TELEGRAM_TOKEN) as bot:
            await bot.send_message(chat_id=CHAT_ID, text=text)
            if audio_path and os.path.exists(audio_path):
                with open(audio_path, "rb") as voice:
                    await bot.send_voice(chat_id=CHAT_ID, voice=voice)
                os.remove(audio_path)
    except Exception as e:
        print(f"[HATA] Telegram Gönderim Hatası: {e}")

# --- ANA ÇALIŞTIRICI ---
async def main():
    init_db()
    print("[LOG] GFS 180 Saatlik Kıyaslama Otomasyonu Çalıştırılıyor...")

    run_name, current_forecast = fetch_gfs_180h_data()
    if not current_forecast:
        return

    previous_runs = get_previous_runs()
    speech_text, is_important, changes = analyze_and_build_script(run_name, current_forecast, previous_runs)

    # Veritabanına kaydet
    save_run(run_name, current_forecast)

    # Değişim varsa veya ilk çalıştırmaysa Telegram bildirimi at
    if is_important or len(previous_runs) == 0:
        changes_summary = ", ".join(changes) if changes else "İlk Referans Çalıştırması"
        report_msg = (
            f"🌐 GFS 180 SAATLİK KIYASLAMA RAPORU\n"
            f"📍 Konum: {LOCATION_NAME} | 🏷 Çıktı: {run_name}\n"
            f"⚡ Değişim Tespiti: {changes_summary}\n\n"
            f"🎙 Seslendirme Metni:\n\"{speech_text}\""
        )
        audio_file = await generate_speech_gcp(speech_text)
        await send_telegram_alert(report_msg, audio_path=audio_file)
    else:
        print("[LOG] +180 saatlik periyotta 3°C sıcaklık veya 7mm yağış üzerinde belirgin değişim saptanmadı. Bildirim gönderilmedi.")

if __name__ == "__main__":
    asyncio.run(main())
