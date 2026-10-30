import os
import re
import sqlite3
import requests
import asyncio
from bs4 import BeautifulSoup
from datetime import datetime
import edge_tts
from telegram import Bot

TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")
METEOPT_URL = "https://www.meteopt.com/modelos/gfs"

PRESSURE_DROP_THRESHOLD = 2.0
PRECIP_SPIKE_THRESHOLD = 5.0

def init_db():
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS forecasts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            run_hour TEXT,
            temp REAL,
            pressure REAL,
            precip REAL
        )
    """)
    conn.commit()
    conn.close()

def get_last_record():
    try:
        conn = sqlite3.connect("gfs_watch.db")
        cursor = conn.cursor()
        cursor.execute("SELECT temp, pressure, precip FROM forecasts ORDER BY id DESC LIMIT 1")
        row = cursor.fetchone()
        conn.close()
        return row
    except Exception as e:
        print(f"Veritabanı okuma hatası: {e}")
        return None

def save_record(run_hour, temp, pressure, precip):
    try:
        conn = sqlite3.connect("gfs_watch.db")
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO forecasts (run_hour, temp, pressure, precip)
            VALUES (?, ?, ?, ?)
        """, (run_hour, temp, pressure, precip))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"Veritabanı yazma hatası: {e}")

def fetch_meteopt_data():
    """Meteopt sayfasını regex ve BeautifulSoup ile güvenli şekilde tarar."""
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        response = requests.get(METEOPT_URL, headers=headers, timeout=15)
        response.raise_for_status()
        html = response.text

        temp = None
        pressure = None
        precip = None

        # Sayfadaki °C, hPa ve mm değerlerini regex ile bulma
        temp_match = re.search(r'(-?\d+(?:\.\d+)?)\s*°C', html)
        if temp_match:
            temp = float(temp_match.group(1))

        press_match = re.search(r'(\d{3,4}(?:\.\d+)?)\s*hPa', html)
        if press_match:
            pressure = float(press_match.group(1))

        precip_match = re.search(r'(\d+(?:\.\d+)?)\s*mm', html)
        if precip_match:
            precip = float(precip_match.group(1))

        # Bulunamayan değerler için varsayılanlar
        temp = temp if temp is not None else 15.0
        pressure = pressure if pressure is not None else 1013.2
        precip = precip if precip is not None else 0.0

        run_hour = datetime.now().strftime("%Y-%m-%d %H:%M")

        return {
            "run_info": "GFS Güncellemesi",
            "run_hour": run_hour,
            "temp": temp,
            "pressure": pressure,
            "precip": precip
        }
    except Exception as e:
        print(f"[{datetime.now()}] Meteopt veri çekme hatası: {e}")
        return {
            "run_info": "GFS Güncellemesi (Bağlantı Hatası)",
            "run_hour": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "temp": 0.0,
            "pressure": 1013.0,
            "precip": 0.0,
            "error": str(e)
        }

async def generate_speech(text, output_file="summary.mp3"):
    """Edge-TTS ile Türkçe ses dosyası oluşturur."""
    try:
        communicate = edge_tts.Communicate(text, "tr-TR-AhmetNeural")
        await communicate.save(output_file)
        return output_file
    except Exception as e:
        print(f"Ses oluşturma hatası: {e}")
        return None

async def send_telegram_alert(bot, text, audio_path=None):
    if not bot or not CHAT_ID:
        print("HATA: Telegram Token veya CHAT_ID eksik!")
        return
    try:
        await bot.send_message(chat_id=CHAT_ID, text=text, parse_mode="Markdown")
        if audio_path and os.path.exists(audio_path):
            with open(audio_path, "rb") as voice:
                await bot.send_voice(chat_id=CHAT_ID, voice=voice)
            os.remove(audio_path)
        print("Telegram bildirimi başarıyla gönderildi.")
    except Exception as e:
        print(f"Telegram gönderme hatası: {e}")

async def run_once():
    init_db()
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("HATA: TELEGRAM_TOKEN veya CHAT_ID tanımlı değil!")
        return

    bot = Bot(token=TELEGRAM_TOKEN)
    data = fetch_meteopt_data()

    if data:
        last_data = get_last_record()
        
        # Ani Değişim Kontrolü
        if last_data and "error" not in data:
            old_temp, old_press, old_precip = last_data
            press_diff = old_press - data["pressure"]
            precip_diff = data["precip"] - old_precip

            if press_diff >= PRESSURE_DROP_THRESHOLD or precip_diff >= PRECIP_SPIKE_THRESHOLD:
                alert_msg = (
                    f"🚨 *ANİ GFS MODEL DEĞİŞİMİ DETEKTÖRÜ*\n\n"
                    f"📉 **Basınç Düşüşü:** `{press_diff:.1f} hPa`\n"
                    f"🌧 **Yağış Artışı:** `{precip_diff:.1f} mm`\n"
                    f"🌡 **Anlık Sıcaklık:** `{data['temp']} °C`\n"
                    f"⏱ **Run Zamanı:** `{data['run_hour']}`"
                )
                await send_telegram_alert(bot, alert_msg)

        save_record(data["run_hour"], data["temp"], data["pressure"], data["precip"])

        # Raporlama ve Sesli Mesaj
        summary_text = (
            f"GFS Modeli Son Güncelleme Raporu. "
            f"Sıcaklık {data['temp']} derece, "
            f"Basınç {data['pressure']} hektopaskal, "
            f"Yağış {data['precip']} milimetre."
        )
        audio_file = await generate_speech(summary_text)

        report_msg = (
            f"📊 *GFS MODEL GÜNCELLEME RAPORU*\n\n"
            f"• **Durum:** `{data['run_info']}`\n"
            f"• **Sıcaklık:** `{data['temp']} °C`\n"
            f"• **Basınç:** `{data['pressure']} hPa`\n"
            f"• **Yağış:** `{data['precip']} mm`\n"
            f"• **Tarih:** `{data['run_hour']}`"
        )
        await send_telegram_alert(bot, report_msg, audio_path=audio_file)

if __name__ == "__main__":
    asyncio.run(run_once())
