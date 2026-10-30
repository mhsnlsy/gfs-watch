# v2.0.0 - Direct NOAA AWS/NOMADS Engine
import os
import sqlite3
import asyncio
from datetime import datetime, timedelta
import requests
import edge_tts
from telegram import Bot

# --- KONFİGÜRASYON ---
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")

# İstanbul Koordinatları
LAT = 41.014
LON = 28.950
LOCATION_NAME = "İstanbul"

# --- VERİTABANI TAKİBİ ---
def init_db():
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS noaa_gfs_runs (
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
        FROM noaa_gfs_runs ORDER BY id DESC LIMIT 2
    """)
    rows = cursor.fetchall()
    conn.close()
    return rows

def save_run(run_name, temp, pressure, precip, wind_speed, weather_desc):
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO noaa_gfs_runs (run_name, temp, pressure, precip, wind_speed, weather_desc)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (run_name, temp, pressure, precip, wind_speed, weather_desc))
    conn.commit()
    conn.close()

# --- DOĞRUDAN NOAA GFS SERVİSİNDEN VERİ ÇEKME ---
def fetch_noaa_direct_data():
    """
    NOAA NOMADS GRIB Filter servisini kullanarak HTML'e gerek duymadan
    doğrudan ham GFS verisini çeker.
    """
    now = datetime.utcnow()
    
    # En güncel GFS koşu saatini belirleme (00, 06, 12, 18 UTC)
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

    # NOAA NOMADS Filtre End-Point
    # Doğrudan İstanbul koordinat kutusu (subregion) için ham veri
    url = f"https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
    params = {
        "file": f"gfs.t{run_hour_str}z.pgrb2.0p25.f000",
        "lev_2_m_above_ground": "on",
        "lev_surface": "on",
        "lev_10_m_above_ground": "on",
        "var_TMP": "on",
        "var_PRES": "on",
        "var_PRATE": "on",
        "var_UGRD": "on",
        "var_VGRD": "on",
        "subregion": "on",
        "toplat": str(LAT + 0.25),
        "bottomlat": str(LAT - 0.25),
        "leftlon": str(LON - 0.25),
        "rightlon": str(LON + 0.25),
        "dir": f"/gfs.{date_str}/{run_hour_str}/atmos"
    }

    try:
        print(f"[LOG] NOAA NOMADS doğrudan ham GFS verisi isteniyor: {run_name}...")
        res = requests.get(url, params=params, timeout=20)
        
        # NOAA henüz bu saatin dosyasını tam yazmadıysa bir önceki saat koşusuna bak
        if res.status_code != 200:
            print("[LOG] Son koşu henüz yazılıyor, bir önceki GFS koşusu taranıyor...")
            prev_time = now - timedelta(hours=6)
            date_str = prev_time.strftime("%Y%m%d")
            run_hour_int = (prev_time.hour // 6) * 6
            run_hour_str = f"{run_hour_int:02d}"
            run_name = f"GFS {date_str} {run_hour_str}Z"
            
            params["file"] = f"gfs.t{run_hour_str}z.pgrb2.0p25.f000"
            params["dir"] = f"/gfs.{date_str}/{run_hour_str}/atmos"
            res = requests.get(url, params=params, timeout=20)

        if res.status_code == 200 and len(res.content) > 0:
            # Geçici GRIB2 dosyasını kaydet ve içeriğini oku
            with open("temp_gfs.grib2", "wb") as f:
                f.write(res.content)
            
            # GRIB2 dosyasından doğrudan değerleri ayrıştır
            import xarray as xr
            ds = xr.open_dataset("temp_gfs.grib2", engine="cfgrib")
            
            # Sıcaklık Kelvin -> Celsius
            temp_k = float(ds['t2m'].values.mean()) if 't2m' in ds else 288.15
            temp_c = round(temp_k - 273.15, 1)

            # Yüzey Basıncı Pa -> hPa
            press_pa = float(ds['sp'].values.mean()) if 'sp' in ds else 101325.0
            press_hpa = round(press_pa / 100.0, 1)

            # Yağış Oranı
            prate = float(ds['prate'].values.mean()) if 'prate' in ds else 0.0
            precip_mm = round(prate * 3600.0, 1) # kg/m2/s -> mm/h

            # Rüzgar Hızı
            u10 = float(ds['u10'].values.mean()) if 'u10' in ds else 0.0
            v10 = float(ds['v10'].values.mean()) if 'v10' in ds else 0.0
            wind_speed = round((u10**2 + v10**2)**0.5 * 3.6, 1) # m/s -> km/h

            ds.close()
            if os.path.exists("temp_gfs.grib2"):
                os.remove("temp_gfs.grib2")

            weather_desc = "Açık / Parçalı Bulutlu"
            if precip_mm > 2.0:
                weather_desc = "Kuvvetli Yağışlı"
            elif precip_mm > 0.0:
                weather_desc = "Hafif Yağmurlu"

            print(f"[LOG] NOAA Verisi Başarıyla Çekildi: {run_name} | {temp_c}°C | {press_hpa}hPa")
            return {
                "run_name": run_name,
                "temp": temp_c,
                "pressure": press_hpa,
                "precip": precip_mm,
                "wind_speed": wind_speed,
                "weather_desc": weather_desc,
                "time_str": datetime.now().strftime("%Y-%m-%d %H:%M")
            }
        else:
            print(f"[HATA] NOAA NOMADS HTTP Yanıtı: {res.status_code}")
            return None

    except Exception as e:
        print(f"[HATA] NOAA Doğrudan Veri İşleme Hatası: {e}")
        if os.path.exists("temp_gfs.grib2"):
            os.remove("temp_gfs.grib2")
        return None

# --- BİLDİRİM VE SES MOTORU ---
async def generate_speech(text, output_file="summary.mp3"):
    try:
        communicate = edge_tts.Communicate(text, "tr-TR-AhmetNeural")
        await communicate.save(output_file)
        return output_file
    except Exception as e:
        print(f"[HATA] Ses üretilemedi: {e}")
        return None

async def send_telegram_alert(text, audio_path=None):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("[HATA] TELEGRAM_TOKEN veya CHAT_ID eksik!")
        return
    try:
        bot = Bot(token=TELEGRAM_TOKEN)
        await bot.send_message(chat_id=CHAT_ID, text=text)
        if audio_path and os.path.exists(audio_path):
            with open(audio_path, "rb") as voice:
                await bot.send_voice(chat_id=CHAT_ID, voice=voice)
            os.remove(audio_path)
        print("[LOG] Telegram bildirimi başarıyla gönderildi.")
    except Exception as e:
        print(f"[HATA] Telegram gönderim hatası: {e}")

# --- ANA ÇALIŞTIRICI ---
async def main():
    init_db()
    print(f"[LOG] NOAA GFS Takipçisi Başlatıldı.")

    data = fetch_noaa_direct_data()

    if not data:
        err_msg = (
            f"⚠️ NOAA GFS BAĞLANTI UYARISI\n"
            f"⏱ Tarih: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
            f"NOAA sunucularından ham GFS GRIB2 verisi alınamadı."
        )
        await send_telegram_alert(err_msg)
        return

    runs = get_previous_runs()
    
    n1_diff_str = "İlk Veri Kaydı (N-1 Yok)"
    n2_diff_str = "İlk Veri Kaydı (N-2 Yok)"

    if len(runs) >= 1:
        r1 = runs[0]
        t_diff_1 = round(data["temp"] - r1[1], 1)
        p_diff_1 = round(data["pressure"] - r1[2], 1)
        n1_diff_str = f"{r1[0]} -> Sıcaklık: {t_diff_1:+.1f} °C | Basınç: {p_diff_1:+.1f} hPa"

    if len(runs) >= 2:
        r2 = runs[1]
        t_diff_2 = round(data["temp"] - r2[1], 1)
        p_diff_2 = round(data["pressure"] - r2[2], 1)
        n2_diff_str = f"{r2[0]} -> Sıcaklık: {t_diff_2:+.1f} °C | Basınç: {p_diff_2:+.1f} hPa"

    save_run(data["run_name"], data["temp"], data["pressure"], data["precip"], data["wind_speed"], data["weather_desc"])

    report_msg = (
        f"🌐 DOĞRUDAN NOAA GFS GÜNCELLEME RAPORU\n"
        f"📍 Konum: {LOCATION_NAME} | 🏷 Çıktı: {data['run_name']}\n"
        f"⏱ Güncelleme Zamanı: {data['time_str']}\n\n"
        f"🌡 Sıcaklık: {data['temp']} °C\n"
        f"🌧 Yağış Miktarı: {data['precip']} mm/saat ({data['weather_desc']})\n"
        f"💨 Rüzgar Hızı: {data['wind_speed']} km/s\n"
        f"📉 Yüzey Basıncı: {data['pressure']} hPa\n\n"
        f"📊 MODEL RUN KIYASLAMALARI:\n"
        f"• N-1 Run Kıyası: {n1_diff_str}\n"
        f"• N-2 Run Kıyası: {n2_diff_str}"
    )

    speech_text = (
        f"Amerikan meteoroloji servisi GFS modeli {data['run_name']} güncellemesi alındı. "
        f"İstanbul için sıcaklık {data['temp']} derece, "
        f"Basınç {data['pressure']} hektopaskal, "
        f"Yağış miktarı {data['precip']} milimetre. "
        f"Hava durumu: {data['weather_desc']}."
    )

    audio_file = await generate_speech(speech_text)
    await send_telegram_alert(report_msg, audio_path=audio_file)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"[KRİTİK HATA] {e}")
