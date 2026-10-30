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
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    try:
        response = requests.get(METEOPT_URL, headers=headers, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        
        temp_elem = soup.select_one(".temp-val") or soup.find(id="temp")
        press_elem = soup.select_one(".press-val") or soup.find(id="pressure")
        precip_elem = soup.select_one(".precip-val") or soup.find(id="precip")

        if not temp_elem or not press_elem or not precip_elem:
            print(f"[{datetime.now()}] Meteopt sayfa yapısı okunamadı.")
            return None

        temp = float(temp_elem.text.replace("°C", "").strip())
        pressure = float(press_elem.text.replace("hPa", "").strip())
        precip = float(precip_elem.text.replace("mm", "").strip())
        run_hour = datetime.now().strftime("%Y-%m-%d %H:%M")

        return {"run_hour": run_hour, "temp": temp, "pressure": pressure, "precip": precip}
    except Exception as e:
        print(f"[{datetime.now()}] Veri çekme hatası: {e}")
        return None

async def send_telegram_alert(bot, text, audio_path=None):
    if not bot or not CHAT_ID:
        print("Telegram bot veya CHAT_ID eksik!")
        return
    try:
        await bot.send_message(chat_id=CHAT_ID, text=text, parse_mode="Markdown")
        if audio_path and os.path.exists(audio_path):
            with open(audio_path, "rb") as voice:
                await bot.send_voice(chat_id=CHAT_ID, voice=voice)
            os.remove(audio_path)
        print("Telegram bildirimi başarıyla gönderildi.")
    except Exception as e:
        print(f"Telegram mesaj gönderme hatası: {e}")

async def generate_speech(text, output_file="summary.mp3"):
    try:
        communicate = edge_tts.Communicate(text, "tr-TR-AhmetNeural")
        await communicate.save(output_file)
        return output_file
    except Exception as e:
        print(f"Ses oluşturma hatası: {e}")
        return None

def is_window_closing_exact():
    now = datetime.now().time()
    closing_times = [dtime(8, 16), dtime(14, 16), dtime(2, 16)]
    return any(now.hour == t.hour and abs(now.minute - t.minute) <= 5 for t in closing_times)

async def run_once():
    init_db()
    print("GFS Tek Seferlik Tarama Başlatıldı...")

    if not TELEGRAM_TOKEN:
        print("HATA: TELEGRAM_TOKEN bulunamadı!")
        return

    bot = Bot(token=TELEGRAM_TOKEN)
    data = fetch_meteopt_data()

    if data:
        last_data = get_last_record()
        
        if last_data:
            old_temp, old_press, old_precip = last_data
            press_diff = old_press - data["pressure"]
            precip_diff = data["precip"] - old_precip

            if press_diff >= PRESSURE_DROP_THRESHOLD or precip_diff >= PRECIP_SPIKE_THRESHOLD:
                alert_msg = (
                    f"🚨 *ANİ METEOROLOJİK DEĞİŞİM UYARISI*\n\n"
                    f"📉 **Basınç Düşüşü:** {press_diff:.1f} hPa\n"
                    f"🌧 **Yağış Artışı:** {precip_diff:.1f} mm\n"
                    f"🌡 **Anlık Sıcaklık:** {data['temp']}°C"
                )
                await send_telegram_alert(bot, alert_msg)

        save_record(data["run_hour"], data["temp"], data["pressure"], data["precip"])

        # Pencere kapanış zamanına denk geliniyorsa sesli ana bildirim atar
        if is_window_closing_exact():
            summary_text = (
                f"GFS Model Güncellemesi Tamamlandı. "
                f"Sıcaklık {data['temp']} derece, "
                f"Basınç {data['pressure']} hectopascal, "
                f"Hesaplanan Yağış {data['precip']} milimetre."
            )
            audio_file = await generate_speech(summary_text)
            formatted_msg = (
                f"📋 *GFS MODEL ANA GÜNCELLEME ÖZETİ*\n\n"
                f"• **Sıcaklık:** {data['temp']} °C\n"
                f"• **Basınç:** {data['pressure']} hPa\n"
                f"• **Yağış:** {data['precip']} mm"
            )
            await send_telegram_alert(bot, formatted_msg, audio_path=audio_file)
    else:
        print("Meteopt sitesinden veri alınamadı.")

if __name__ == "__main__":
    asyncio.run(run_once())
