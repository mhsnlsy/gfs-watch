# v3.2.0 - Open-Meteo NOAA GFS + Google Cloud TTS + Telegram
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
        CREATE TABLE IF NOT EXISTS gfs_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            run_name TEXT,
            temp REAL,
            pressure REAL,
            precip REAL,
            wind_speed REAL,
            weather_desc TEXT
        )
    """)
    conn.commit()
    conn.close()

def get_previous_runs():
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        SELECT run_name, temp, pressure, precip, wind_speed, weather_desc 
        FROM gfs_runs ORDER BY id DESC LIMIT 2
    """)
    rows = cursor.fetchall()
    conn.close()
    return rows

def save_run(run_name, temp, pressure, precip, wind_speed, weather_desc):
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO gfs_runs (run_name, temp, pressure, precip, wind_speed, weather_desc)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (run_name, temp, pressure, precip, wind_speed, weather_desc))
    conn.commit()
    conn.close()

# --- OPEN-METEO NOKTASI ÜZERİNDEN NOAA GFS VERİ ÇEKME ---
def fetch_noaa_gfs_data():
    """
    Open-Meteo üzerindeki resmi NOAA GFS 0.25° model verilerini çeker.
    """
    url = "https://api.open-meteo.com/v1/forecast"
    params = {
        "latitude": LAT,
        "longitude": LON,
        "current": "temperature_2m,surface_pressure,precipitation,wind_speed_10m",
        "models": "gfs_seamless",
        "timezone": "Europe/Istanbul"
    }

    try:
        print("[LOG] NOAA GFS verileri çekiliyor...")
        res = requests.get(url, params=params, timeout=15)
        res.raise_for_status()
        data = res.json()

        current = data.get("current", {})
        temp_c = round(current.get("temperature_2m", 15.0), 1)
        press_hpa = round(current.get("surface_pressure", 1013.0), 1)
        precip_mm = round(current.get("precipitation", 0.0), 1)
        wind_speed = round(current.get("wind_speed_10m", 0.0), 1)

        run_name = f"GFS Model Run ({datetime.now().strftime('%H:%M')})"

        weather_desc = "Açık / Bulutsuz"
        if precip_mm > 2.0:
            weather_desc = "Kuvvetli Yağışlı"
        elif precip_mm > 0.0:
            weather_desc = "Hafif Yağmurlu"

        print(f"[LOG] NOAA GFS Verisi Alındı: {temp_c}°C | {press_hpa}hPa | Yağış: {precip_mm}mm")
        return {
            "run_name": run_name,
            "temp": temp_c,
            "pressure": press_hpa,
            "precip": precip_mm,
            "wind_speed": wind_speed,
            "weather_desc": weather_desc,
            "time_str": datetime.now().strftime("%Y-%m-%d %H:%M")
        }

    except Exception as e:
        print(f"[HATA] NOAA GFS Veri Çekme Hatası: {e}")
        return None

# --- METEOROLOG KONUŞMA METNİ ÜRETİCİSİ ---
def build_meteorologist_script(data, runs):
    temp = data['temp']
    precip = data['precip']
    press = data['pressure']
    
    script = f"Amerikan Meteoroloji Servisi GFS modelinin son çıktısı alındı. "
    
    if len(runs) >= 1:
        prev_temp = runs[0][1]
        prev_press = runs[0][2]
        t_diff = round(temp - prev_temp, 1)
        p_diff = round(press - prev_press, 1)
        
        if t_diff <= -2.0:
            script += f"Son güncellemede belirgin bir soğuma var, sıcaklık {abs(t_diff)} derece düştü. "
        elif t_diff >= 2.0:
            script += f"Modelde ısınma eğilimi öne çıkıyor, sıcaklık {t_diff} derece yükseldi. "
            
        if p_diff <= -3.0:
            script += f"Basınçtaki {abs(p_diff)} hektopaskallık düşüş yaklaşan alçak basınç sistemine işaret ediyor. "
    
    if precip > 5.0:
        script += "Dışarıda olacaksanız dikkatli olun, kuvvetli sağanak yağış bekleniyor. "
    elif precip > 0.0:
        script += "Aralıklı hafif yağmur geçişleri görülebilir. "
    else:
        script += "Önemli bir yağış riski görünmüyor, hava açık. "
        
    script += f"İstanbul için anlık sıcaklık {temp} derece civarında. Güvenli sürüşler ve iyi günler."
    return script

# --- GOOGLE CLOUD TTS MOTORU ---
async def generate_speech_gcp(text, output_file="summary.mp3"):
    try:
        print("[LOG] Google Cloud TTS ile ses üretiliyor...")
        if not GCP_SA_KEY:
            print("[HATA] GCP_SA_KEY secret bulunamadı!")
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
            speaking_rate=1.02
        )

        response = client.synthesize_speech(
            input=synthesis_input, voice=voice, audio_config=audio_config
        )

        with open(output_file, "wb") as out:
            out.write(response.audio_content)

        print("[LOG] Google Cloud TTS ses dosyası başarıyla üretildi.")
        return output_file
    except Exception as e:
        print(f"[HATA] GCP TTS Üretim Hatası: {e}")
        return None

# --- TELEGRAM GÖNDERİCİ ---
async def send_telegram_alert(text, audio_path=None):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("[HATA] Telegram secrets eksik!")
        return
    try:
        async with Bot(token=TELEGRAM_TOKEN) as bot:
            await bot.send_message(chat_id=CHAT_ID, text=text)
            if audio_path and os.path.exists(audio_path):
                with open(audio_path, "rb") as voice:
                    await bot.send_voice(chat_id=CHAT_ID, voice=voice)
                os.remove(audio_path)
        print("[LOG] Telegram bildirimi ve ses dosyası iletildi.")
    except Exception as e:
        print(f"[HATA] Telegram Gönderim Hatası: {e}")

# --- ANA ÇALIŞTIRICI ---
async def main():
    init_db()
    print("[LOG] GFS Otomasyonu Çalıştırılıyor...")

    data = fetch_noaa_gfs_data()

    if not data:
        err_msg = (
            f"⚠️ GFS BAĞLANTI UYARISI\n"
            f"⏱ Tarih: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
            f"NOAA GFS verisi alınamadı."
        )
        await send_telegram_alert(err_msg)
        return

    runs = get_previous_runs()
    speech_text = build_meteorologist_script(data, runs)
    
    save_run(data["run_name"], data["temp"], data["pressure"], data["precip"], data["wind_speed"], data["weather_desc"])

    report_msg = (
        f"🌐 DOĞRUDAN NOAA GFS GÜNCELLEME RAPORU\n"
        f"📍 Konum: {LOCATION_NAME} | ⏱ Güncelleme: {data['time_str']}\n\n"
        f"🌡 Sıcaklık: {data['temp']} °C\n"
        f"🌧 Yağış Miktarı: {data['precip']} mm/saat ({data['weather_desc']})\n"
        f"💨 Rüzgar Hızı: {data['wind_speed']} km/s\n"
        f"📉 Yüzey Basıncı: {data['pressure']} hPa\n\n"
        f"🎙 Seslendirme Metni:\n\"{speech_text}\""
    )

    audio_file = await generate_speech_gcp(speech_text)
    await send_telegram_alert(report_msg, audio_path=audio_file)

if __name__ == "__main__":
    asyncio.run(main())
