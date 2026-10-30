# v4.0.0 - Advanced GFS Synoptic Tracker & Dynamic Alert Engine
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

# Hedef Konum: İstanbul
LAT = 41.014
LON = 28.950
LOCATION_NAME = "İstanbul"

# 2000 km Çapındaki Sinoptik Kontrol Noktaları (Enlem, Boylam, Bölge Adı)
SYNOPTIC_POINTS = {
    "Balkanlar/Orta Avrupa": (45.0, 18.0),
    "Karadeniz/Rusya": (46.0, 35.0),
    "Orta Akdeniz/İtalya": (38.0, 15.0),
    "Doğu Akdeniz": (34.0, 30.0)
}

# --- RÜZGAR YÖNÜ ÇEVİRİCİ ---
def get_wind_direction_name(deg):
    dirs = [
        "Yıldız (Kuzey)", "Poyraz (Kuzeydoğu)", "Gündoğusu (Doğu)", 
        "Keşişleme (Güneydoğu)", "Kıble (Güney)", "Lodos (Güneybatı)", 
        "Günbatısı (Batı)", "Karayel (Kuzeybatı)"
    ]
    idx = int((deg + 22.5) // 45) % 8
    return dirs[idx]

# --- VERİTABANI TAKİBİ ---
def init_db():
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS gfs_runs_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            run_name TEXT,
            temp REAL,
            pressure REAL,
            precip REAL,
            snowfall REAL,
            wind_speed REAL,
            wind_dir TEXT,
            weather_desc TEXT
        )
    """)
    conn.commit()
    conn.close()

def get_previous_runs():
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        SELECT run_name, temp, pressure, precip, snowfall, wind_speed, wind_dir, weather_desc 
        FROM gfs_runs_v2 ORDER BY id DESC LIMIT 2
    """)
    rows = cursor.fetchall()
    conn.close()
    return rows

def save_run(run_name, temp, pressure, precip, snowfall, wind_speed, wind_dir, weather_desc):
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO gfs_runs_v2 (run_name, temp, pressure, precip, snowfall, wind_speed, wind_dir, weather_desc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (run_name, temp, pressure, precip, snowfall, wind_speed, wind_dir, weather_desc))
    conn.commit()
    conn.close()

# --- VERİ ÇEKME & BÖLGESEL SİNOPTİK ANALİZ ---
def fetch_gfs_full_data():
    # 1. Yerel Veri (İstanbul)
    local_url = "https://api.open-meteo.com/v1/forecast"
    local_params = {
        "latitude": LAT,
        "longitude": LON,
        "current": "temperature_2m,surface_pressure,pressure_msl,precipitation,rain,snowfall,wind_speed_10m,wind_direction_10m",
        "models": "gfs_seamless",
        "timezone": "Europe/Istanbul"
    }

    try:
        res = requests.get(local_url, params=local_params, timeout=15)
        res.raise_for_status()
        local_data = res.json().get("current", {})

        temp = round(local_data.get("temperature_2m", 15.0), 1)
        press = round(local_data.get("surface_pressure", 1013.0), 1)
        press_msl = round(local_data.get("pressure_msl", 1013.0), 1)
        precip = round(local_data.get("precipitation", 0.0), 1)
        rain = round(local_data.get("rain", 0.0), 1)
        snowfall = round(local_data.get("snowfall", 0.0), 1)
        wind_speed = round(local_data.get("wind_speed_10m", 0.0), 1)
        wind_dir_deg = local_data.get("wind_direction_10m", 0)
        wind_dir = get_wind_direction_name(wind_dir_deg)

        # Yağış Tipi Belirleme
        precip_type = "Yağış Yok"
        if snowfall > 0:
            precip_type = "Kar Yağışlı" if temp <= 1.0 else "Karla Karışık Yağmur"
        elif rain > 0:
            precip_type = "Sağanak Yağmurlu" if precip > 4.0 else "Hafif Yağmurlu"

        # 2. Bölgesel Sinoptik Basınç Taraması (2000 km Yarıçap)
        synoptic_alerts = []
        for region, (r_lat, r_lon) in SYNOPTIC_POINTS.items():
            r_params = {
                "latitude": r_lat,
                "longitude": r_lon,
                "current": "pressure_msl",
                "models": "gfs_seamless"
            }
            try:
                r_res = requests.get(local_url, params=r_params, timeout=10).json()
                r_press = r_res.get("current", {}).get("pressure_msl", 1013.0)
                
                if r_press <= 1002.0:
                    synoptic_alerts.append(f"{region} üzerinde derin alçak basınç ({r_press} hPa) oluşumu var.")
                elif r_press >= 1030.0:
                    synoptic_alerts.append(f"{region} üzerinde güçlü yüksek basınç ({r_press} hPa) merkezlendi.")
            except Exception:
                continue

        run_name = f"GFS ({datetime.now().strftime('%H:%M')})"
        return {
            "run_name": run_name,
            "temp": temp,
            "pressure": press,
            "pressure_msl": press_msl,
            "precip": precip,
            "snowfall": snowfall,
            "precip_type": precip_type,
            "wind_speed": wind_speed,
            "wind_dir": wind_dir,
            "synoptic_alerts": synoptic_alerts,
            "time_str": datetime.now().strftime("%Y-%m-%d %H:%M")
        }
    except Exception as e:
        print(f"[HATA] Veri alma hatası: {e}")
        return None

# --- METEOROLOG METİN MOTORU VE ÖNEM KONTROLÜ ---
def analyze_and_build_script(data, runs):
    temp = data["temp"]
    press = data["pressure"]
    precip_type = data["precip_type"]
    wind_dir = data["wind_dir"]
    wind_speed = data["wind_speed"]
    synoptic = data["synoptic_alerts"]

    is_important = False
    reasons = []

    script = f"Meteoroloji GFS modeli {data['run_name']} güncellemesi incelendi. "

    # N-1 & N-2 Kıyaslamaları
    if len(runs) >= 1:
        prev_temp = runs[0][1]
        prev_press = runs[0][2]
        t_diff = round(temp - prev_temp, 1)
        p_diff = round(press - prev_press, 1)

        if abs(t_diff) >= 2.0:
            is_important = True
            direction = "düşüş" if t_diff < 0 else "yükseliş"
            reasons.append(f"Sıcaklıkta {abs(t_diff)}°C {direction}")
            script += f"Model çıktısında önemli bir değişim var; sıcaklıkta {abs(t_diff)} derecelik {direction} kaydedildi. "

        if p_diff <= -3.0:
            is_important = True
            reasons.append(f"Basınçta {abs(p_diff)} hPa sert düşüş")
            script += f"Basınçtaki {abs(p_diff)} hektopaskallık sert düşüş yaklaşan dinamik sistemin habercisi. "

    # Yağış ve Kar Kontrolü
    if data["snowfall"] > 0:
        is_important = True
        reasons.append("Kar yağışı beklentisi")
        script += f"Dikkat, model haritalarında {precip_type} öngörülüyor. "
    elif data["precip"] > 5.0:
        is_important = True
        reasons.append("Kuvvetli yağış")
        script += f"Bölgede {precip_type} geçişleri bekleniyor. "
    else:
        script += f"Mevcut durumda yağış yapısı {precip_type} olarak şekilleniyor. "

    # Rüzgar Yorumu
    script += f"Rüzgar {wind_dir} yönünden saatte {wind_speed} kilometre hızla esiyor. "
    if wind_speed >= 40:
        is_important = True
        reasons.append("Fırtına riski")
        script += "Rüzgar hamleleri sert, açık alanda dikkatli olunmalı. "

    # Sinoptik Bölgesel Etki
    if synoptic:
        is_important = True
        reasons.append("Bölgesel sinoptik basınç anomalisi")
        synoptic_text = " ".join(synoptic)
        script += f"Geniş ölçekli hava haritasına baktığımızda: {synoptic_text} Bu durum önümüzdeki saatlerde İstanbul hava akışını doğrudan etkileyecektir. "

    script += f"İstanbul için anlık sıcaklık {temp} derece. Güvenli sürüşler."

    return script, is_important, reasons

# --- GOOGLE CLOUD TTS MOTORU ---
async def generate_speech_gcp(text, output_file="summary.mp3"):
    try:
        if not GCP_SA_KEY:
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
        return
    try:
        async with Bot(token=TELEGRAM_TOKEN) as bot:
            await bot.send_message(chat_id=CHAT_ID, text=text)
            if audio_path and os.path.exists(audio_path):
                with open(audio_path, "rb") as voice:
                    await bot.send_voice(chat_id=CHAT_ID, voice=voice)
                os.remove(audio_path)
    except Exception as e:
        print(f"[HATA] Telegram Hatası: {e}")

# --- ANA ÇALIŞTIRICI ---
async def main():
    init_db()
    data = fetch_gfs_full_data()
    if not data:
        return

    runs = get_previous_runs()
    speech_text, is_important, reasons = analyze_and_build_script(data, runs)

    # Veritabanına her koşuyu kaydet
    save_run(
        data["run_name"], data["temp"], data["pressure"], 
        data["precip"], data["snowfall"], data["wind_speed"], 
        data["wind_dir"], data["precip_type"]
    )

    # SADECE ÖNEMLİ GÜNCELLEMEDE BİLDİRİM GÖNDER
    if is_important or len(runs) == 0:
        print(f"[LOG] Önemli Değişim Yakalandı! Nedenler: {reasons}")
        report_msg = (
            f"⚠️ KRİTİK GFS MODEL GÜNCELLEMESİ\n"
            f"📍 Konum: {LOCATION_NAME} | ⏱ Zaman: {data['time_str']}\n"
            f"🎯 Tetiklenme Nedenleri: {', '.join(reasons)}\n\n"
            f"🌡 Sıcaklık: {data['temp']} °C\n"
            f"🌧 Yağış Durumu: {data['precip_type']} ({data['precip']} mm)\n"
            f"💨 Rüzgar: {data['wind_dir']} ({data['wind_speed']} km/s)\n"
            f"📉 Basınç: {data['pressure']} hPa\n\n"
            f"🎙 Seslendirme Metni:\n\"{speech_text}\""
        )
        audio_file = await generate_speech_gcp(speech_text)
        await send_telegram_alert(report_msg, audio_path=audio_file)
    else:
        print("[LOG] Model çıktısında belirgin bir anomali/değişim yok. Bildirim atlanıyor.")

if __name__ == "__main__":
    asyncio.run(main())
