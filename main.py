# v3.1.0 - NOAA + GCP TTS + Async Telegram Session Fix
import os
import json
import sqlite3
import asyncio
from datetime import datetime, timedelta
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

# --- DOĞRUDAN NOAA GFS SERVİSİNDEN VERİ ÇEKME ---
def fetch_noaa_data():
    now = datetime.utcnow()
    current_hour = now.hour
    if current_hour >= 18:
        run_hour_str = "18"
    elif current_hour >= 12:
        run_hour_str = "12"
    elif current_hour >= 6:
        run_hour_str = "06"
    else:
        run_hour_str = "00"
        
    date_str = now.strftime("%Y%m%d")
    run_name = f"GFS {date_str} {run_hour_str}Z"

    url = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
    params = {
        "file": f"gfs.t{run_hour_str}z.pgrb2.0p25.f000",
        "lev_2_m_above_ground": "on",
        "lev_surface": "on",
        "var_TMP": "on",
        "var_PRES": "on",
        "var_PRATE": "on",
        "subregion": "on",
        "toplat": str(LAT + 0.25),
        "bottomlat": str(LAT - 0.25),
        "leftlon": str(LON - 0.25),
        "rightlon": str(LON + 0.25),
        "dir": f"/gfs.{date_str}/{run_hour_str}/atmos"
    }

    try:
        print(f"[LOG] NOAA NOMADS verisi çekiliyor ({run_name})...")
        res = requests.get(url, params=params, timeout=20)
        
        if res.status_code != 200:
            print("[LOG] Son koşu henüz yazılıyor, bir önceki GFS koşusuna bakılıyor...")
            prev_time = now - timedelta(hours=6)
            date_str = prev_time.strftime("%Y%m%d")
            run_hour_int = (prev_time.hour // 6) * 6
            run_hour_str = f"{run_hour_int:02d}"
            run_name = f"GFS {date_str} {run_hour_str}Z"
            
            params["file"] = f"gfs.t{run_hour_str}z.pgrb2.0p25.f000"
            params["dir"] = f"/gfs.{date_str}/{run_hour_str}/atmos"
            res = requests.get(url, params=params, timeout=20)

        if res.status_code == 200 and len(res.content) > 0:
            with open("temp_gfs.grib2", "wb") as f:
                f.write(res.content)
            
            import xarray as xr
            ds = xr.open_dataset("temp_gfs.grib2", engine="cfgrib")
            
            temp_k = float(ds['t2m'].values.mean()) if 't2m' in ds else 288.15
            temp_c = round(temp_k - 273.15, 1)

            press_pa = float(ds['sp'].values.mean()) if 'sp' in ds else 101325.0
            press_hpa = round(press_pa / 100.0, 1)

            prate = float(ds['prate'].values.mean()) if 'prate' in ds else 0.0
            precip_mm = round(prate * 3600.0, 1)

            ds.close()
            if os.path.exists("temp_gfs.grib2"):
                os.remove("temp_gfs.grib2")

            weather_desc = "Açık / Bulutsuz"
            if precip_mm > 2.0:
                weather_desc = "Kuvvetli Yağışlı"
            elif precip_mm > 0.0:
                weather_desc = "Hafif Yağmurlu"

            print(f"[LOG] NOAA Verisi Alındı: {run_name} | {temp_c}°C | {press_hpa}hPa")
            return {
                "run_name": run_name,
                "temp": temp_c,
                "pressure": press_hpa,
                "precip": precip_mm,
                "wind_speed": 15.0,
                "weather_desc": weather_desc,
                "time_str": datetime.now().strftime("%Y-%m-%d %H:%M")
            }
        else:
            print(f"[HATA] NOAA HTTP Yanıt Kodu: {res.status_code}")
            return None

    except Exception as e:
        print(f"[HATA] NOAA Veri İşleme Hatası: {e}")
        if os.path.exists("temp_gfs.grib2"):
            os.remove("temp_gfs.grib2")
        return None

# --- METEOROLOG KONUŞMA METNİ ÜRETİCİSİ ---
def build_meteorologist_script(data, runs):
    run_name = data['run_name']
    temp = data['temp']
    precip = data['precip']
    press = data['pressure']
    
    script = f"Amerikan Meteoroloji Servisi GFS modelinin {run_name} çıktısı alındı. "
    
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
        script += "Belirgin bir yağış riski görünmüyor, hava açık. "
        
    script += f"İstanbul için anlık sıcaklık {temp} derece civarında. Güvenli sürüşler ve iyi günler."
    return script

# --- GOOGLE CLOUD TTS MOTORU ---
async def generate_speech_gcp(text, output_file="summary.mp3"):
    try:
        print("[LOG] Google Cloud TTS ile ses dosyası üretiliyor...")
        if not GCP_SA_KEY:
            print("[HATA] GCP_SA_KEY GitHub Secret bulunamadı veya boş!")
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

        print("[LOG] Ses dosyası başarıyla üretildi.")
        return output_file
    except Exception as e:
        print(f"[HATA] GCP TTS Üretim Hatası: {e}")
        return None

# --- TELEGRAM GÖNDERİCİ (ASYNC CONTEXT FIXED) ---
async def send_telegram_alert(text, audio_path=None):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print(f"[HATA] TELEGRAM_TOKEN ({bool(TELEGRAM_TOKEN)}) veya CHAT_ID ({bool(CHAT_ID)}) GitHub Secrets'ta EKSİK!")
        return
    try:
        print("[LOG] Telegram sunucularına bağlanılıyor...")
        async with Bot(token=TELEGRAM_TOKEN) as bot:
            print("[LOG] Metin mesajı gönderiliyor...")
            await bot.send_message(chat_id=CHAT_ID, text=text)
            print("[LOG] Metin mesajı iletildi.")
            
            if audio_path and os.path.exists(audio_path):
                print("[LOG] Ses dosyası gönderiliyor...")
                with open(audio_path, "rb") as voice:
                    await bot.send_voice(chat_id=CHAT_ID, voice=voice)
                print("[LOG] Ses dosyası iletildi.")
                os.remove(audio_path)
    except Exception as e:
        print(f"[HATA] Telegram İletim Hatası: {e}")

# --- ANA ÇALIŞTIRICI ---
async def main():
    init_db()
    print("[LOG] GFS Otomasyonu Başlatıldı.")

    data = fetch_noaa_data()

    if not data:
        print("[UYARI] NOAA verisi alınamadı, yedek bildirim gönderiliyor.")
        err_msg = (
            f"⚠️ NOAA GFS BAĞLANTI UYARISI\n"
            f"⏱ Tarih: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
            f"NOAA sunucularından ham GFS GRIB2 verisi çekilemedi."
        )
        await send_telegram_alert(err_msg)
        return

    runs = get_previous_runs()
    speech_text = build_meteorologist_script(data, runs)
    
    save_run(data["run_name"], data["temp"], data["pressure"], data["precip"], data["wind_speed"], data["weather_desc"])

    report_msg = (
        f"🌐 DOĞRUDAN NOAA GFS GÜNCELLEME RAPORU\n"
        f"📍 Konum: {LOCATION_NAME} | 🏷 Çıktı: {data['run_name']}\n"
        f"⏱ Güncelleme Zamanı: {data['time_str']}\n\n"
        f"🌡 Sıcaklık: {data['temp']} °C\n"
        f"🌧 Yağış Miktarı: {data['precip']} mm/saat ({data['weather_desc']})\n"
        f"📉 Yüzey Basıncı: {data['pressure']} hPa\n\n"
        f"🎙 Seslendirme Metni:\n\"{speech_text}\""
    )

    audio_file = await generate_speech_gcp(speech_text)
    await send_telegram_alert(report_msg, audio_path=audio_file)

if __name__ == "__main__":
    asyncio.run(main())
