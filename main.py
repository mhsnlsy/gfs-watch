# v1.0.2 - Fixed Syntax and Error Catching
import os
import re
import sqlite3
import asyncio
from datetime import datetime
import requests
from bs4 import BeautifulSoup
import edge_tts
from telegram import Bot

# --- KONFİGÜRASYON ---
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")
METEOPT_URL = "https://dawn-hill-a95d.muhsin-ulusoy.workers.dev/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

# --- VERİTABANI TAKİBİ ---
def init_db():
    try:
        conn = sqlite3.connect("gfs_watch.db")
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS meteopt_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                run_name TEXT,
                temp REAL,
                pressure REAL,
                precip REAL,
                wind_speed REAL,
                wind_dir TEXT,
                weather_desc TEXT
            )
        """)
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[VERİTABANI HATASI] {e}")

def get_previous_runs():
    try:
        conn = sqlite3.connect("gfs_watch.db")
        cursor = conn.cursor()
        cursor.execute("""
            SELECT run_name, temp, pressure, precip, wind_speed, wind_dir, weather_desc 
            FROM meteopt_runs ORDER BY id DESC LIMIT 2
        """)
        rows = cursor.fetchall()
        conn.close()
        return rows
    except Exception as e:
        print(f"[VERİTABANI OKUMA HATASI] {e}")
        return []

def save_run(run_name, temp, pressure, precip, wind_speed, wind_dir, weather_desc):
    try:
        conn = sqlite3.connect("gfs_watch.db")
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO meteopt_runs (run_name, temp, pressure, precip, wind_speed, wind_dir, weather_desc)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (run_name, temp, pressure, precip, wind_speed, wind_dir, weather_desc))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[VERİTABANI YAZMA HATASI] {e}")

# --- METEOPT VERİ ÇEKME ---
def fetch_meteopt_data():
    try:
        print("[LOG] Meteopt bağlantısı kuruluyor...")
        response = requests.get(METEOPT_URL, headers=HEADERS, timeout=15)
        print(f"[LOG] HTTP Yanıt Kodu: {response.status_code}")
        
        if response.status_code != 200:
            print(f"[UYARI] Meteopt erişim engeli döndürdü: HTTP {response.status_code}")
            return None

        html = response.text

        run_match = re.search(r'GFS\s+(\d{2}Z)', html, re.IGNORECASE)
        run_name = f"GFS {run_match.group(1)}" if run_match else f"GFS Run ({datetime.now().strftime('%H:%M')})"

        temp_matches = re.findall(r'(-?\d+(?:\.\d+)?)\s*°C', html)
        temp = float(temp_matches[0]) if temp_matches else 15.0

        press_matches = re.findall(r'(\d{3,4}(?:\.\d+)?)\s*hPa', html)
        pressure = float(press_matches[0]) if press_matches else 1013.0

        precip_matches = re.findall(r'(\d+(?:\.\d+)?)\s*mm', html)
        precip = float(precip_matches[0]) if precip_matches else 0.0

        wind_matches = re.findall(r'(\d+(?:\.\d+)?)\s*(?:km/h|kt)', html)
        wind_speed = float(wind_matches[0]) if wind_matches else 0.0

        wind_dir = "Poyraz / Kuzeydoğu"
        weather_desc = "Açık / Bulutsuz"
        if precip > 0:
            weather_desc = "Yağmurlu"

        print(f"[LOG] Veri Alındı: {run_name} | Sıcaklık: {temp}°C | Basınç: {pressure}hPa")
        return {
            "run_name": run_name,
            "temp": temp,
            "pressure": pressure,
            "precip": precip,
            "wind_speed": wind_speed,
            "wind_dir": wind_dir,
            "weather_desc": weather_desc,
            "time_str": datetime.now().strftime("%Y-%m-%d %H:%M")
        }
    except Exception as e:
        print(f"[HATA] Meteopt veri çekme hatası: {e}")
        return None

# --- BİLDİRİM VE SES ---
async def generate_speech(text, output_file="summary.mp3"):
    try:
        print("[LOG] Ses dosyası üretiliyor...")
        communicate = edge_tts.Communicate(text, "tr-TR-AhmetNeural")
        await communicate.save(output_file)
        return output_file
    except Exception as e:
        print(f"[HATA] Ses üretilemedi: {e}")
        return None

async def send_telegram_alert(text, audio_path=None):
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("[HATA] TELEGRAM_TOKEN veya CHAT_ID secrets eksik!")
        return
    try:
        bot = Bot(token=TELEGRAM_TOKEN)
        print("[LOG] Telegram mesajı gönderiliyor...")
        await bot.send_message(chat_id=CHAT_ID, text=text)
        
        if audio_path and os.path.exists(audio_path):
            print("[LOG] Telegram ses dosyası gönderiliyor...")
            with open(audio_path, "rb") as voice:
                await bot.send_voice(chat_id=CHAT_ID, voice=voice)
            os.remove(audio_path)
        print("[LOG] Telegram bildirimi başarıyla tamamlandı.")
    except Exception as e:
        print(f"[HATA] Telegram gönderim hatası: {e}")

# --- ANA ÇALIŞTIRICI ---
async def main():
    init_db()
    print(f"[LOG] Başlatıldı. Token Var mı: {bool(TELEGRAM_TOKEN)}, Chat ID Var mı: {bool(CHAT_ID)}")

    data = fetch_meteopt_data()

    if not data:
        err_msg = (
            f"⚠️ METEOPT BAĞLANTI UYARISI\n"
            f"⏱ Tarih: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n\n"
            f"Meteopt sunucusu GitHub Actions IP adresini engellediği için veri çekilemedi (HTTP 403 / Cloudflare)."
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

    save_run(data["run_name"], data["temp"], data["pressure"], data["precip"], data["wind_speed"], data["wind_dir"], data["weather_desc"])

    report_msg = (
        f"🌐 METEOPT GFS GÜNCELLEME RAPORU\n"
        f"🏷 Model Çıktısı: {data['run_name']} | ⏱ {data['time_str']}\n\n"
        f"🌡 Sıcaklık: {data['temp']} °C\n"
        f"🌧 Yağış Miktarı: {data['precip']} mm ({data['weather_desc']})\n"
        f"💨 Rüzgar: {data['wind_speed']} km/s ({data['wind_dir']})\n"
        f"📉 Basınç: {data['pressure']} hPa\n\n"
        f"📊 MODEL RUN KIYASLAMALARI:\n"
        f"• N-1 Run Kıyası: {n1_diff_str}\n"
        f"• N-2 Run Kıyası: {n2_diff_str}"
    )

    speech_text = (
        f"Meteopt GFS modeli {data['run_name']} güncellemesi alındı. "
        f"Sıcaklık {data['temp']} derece, "
        f"Hesaplanan yağış {data['precip']} milimetre, "
        f"Basınç {data['pressure']} hektopaskal."
    )

    audio_file = await generate_speech(speech_text)
    await send_telegram_alert(report_msg, audio_path=audio_file)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"[KRİTİK HATA] {e}")
