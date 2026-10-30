import os
import sqlite3
import requests
import asyncio
from bs4 import BeautifulSoup
from datetime import datetime, time as dtime
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

async def send_telegram_alert(bot, text, audio_path=None):
    if not bot or not CHAT_ID:
        print("HATA: Telegram Token veya CHAT_ID bulunamadı!")
        return
    try:
        await bot.send_message(chat_id=CHAT_ID, text=text, parse_mode="Markdown")
        if audio_path and os.path.exists(audio_path):
            with open(audio_path, "rb") as voice:
                await bot.send_voice(chat_id=CHAT_ID, voice=voice)
            os.remove(audio_path)
        print("Telegram bildirimi başarıyla gönderildi!")
    except Exception as e:
        print(f"Telegram gönderme hatası: {e}")

async def run_once():
    init_db()
    print("GFS Takip Çalıştırılıyor...")

    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("HATA: TELEGRAM_TOKEN veya CHAT_ID Secrets bölümünde tanımlı değil!")
        return

    bot = Bot(token=TELEGRAM_TOKEN)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")

    # TEST VE DOĞRULAMA BİLDİRİMİ
    test_message = f"✅ *GFS Watcher Bağlantı Testi Başarılı*\n\n⏱ **Çalışma Zamanı:** `{now_str}`\nSistem GitHub Actions üzerinde aktif olarak çalışıyor."
    await send_telegram_alert(bot, test_message)

if __name__ == "__main__":
    asyncio.run(run_once())
