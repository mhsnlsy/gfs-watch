import os
import time
import asyncio
import sqlite3
import requests
from bs4 import BeautifulSoup
from datetime import datetime, time as dtime
import edge_tts
from telegram import Bot

# Bilgiler bulut sunucusundan (Render) çekilecek
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")
METEOPT_URL = "https://www.meteopt.com/modelos/gfs"

PRESSURE_DROP_THRESHOLD = 2.0
PRECIP_SPIKE_THRESHOLD = 5.0

bot = Bot(token=TELEGRAM_TOKEN)

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
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("SELECT temp, pressure, precip FROM forecasts ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    return row

def save_record(run_hour, temp, pressure, precip):
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO forecasts (run_hour, temp, pressure, precip)
        VALUES (?, ?, ?, ?)
    """, (run_hour, temp, pressure, precip))
    conn.commit()
    conn.close()

def fetch_meteopt_data():
    headers = {"User-Agent": "Mozilla/5.0"}
    try:
        response = requests.get(METEOPT_URL, headers=headers, timeout=10)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        
        # Meteopt varsayılan veri çekme yapısı
        temp = float(soup.select_one(".temp-val").text.replace("°C", "").strip())
        pressure = float(soup.select_one(".press-val").text.replace("hPa", "").strip())
        precip = float(soup.select_one(".precip-val").text.replace("mm", "").strip())
        run_hour = datetime.now().strftime("%Y-%m-%d %H:%M")

        return {"run_hour": run_hour, "temp": temp, "pressure": pressure, "precip": precip}
    except Exception as e:
        print(f"[{datetime.now()}] Veri çekme hatası: {e}")
        return None

async def send_telegram_alert(text, audio_path=None):
    await bot.send_message(chat_id=CHAT_ID, text=text, parse_mode="Markdown")
    if audio_path and os.path.exists(audio_path):
        with open(audio_path, "rb") as voice:
            await bot.send_voice(chat_id=CHAT_ID, voice=voice)
        os.remove(audio_path)

async def generate_speech(text, output_file="summary.mp3"):
    communicate = edge_tts.Communicate(text, "tr-TR-AhmetNeural")
    await communicate.save(output_file)
    return output_file

def is_in_target_window():
    now = datetime.now().time()
    w1_start, w1_end = dtime(6, 30), dtime(8, 16)
    w2_start, w2_end = dtime(12, 30), dtime(14, 16)
    w3_start, w3_end = dtime(0, 30), dtime(2, 16)
    return (w1_start <= now <= w1_end) or (w2_start <= now <= w2_end) or (w3_start <= now <= w3_end)

def is_window_closing_exact():
    now = datetime.now().time()
    closing_times = [dtime(8, 16), dtime(14, 16), dtime(2, 16)]
    return any(now.hour == t.hour and now.minute == t.minute for t in closing_times)

async def main_loop():
    init_db()
    print("GFS-Watch Takip Motoru Başlatıldı...")

    while True:
        if is_in_target_window():
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
                        await send_telegram_alert(alert_msg)

                save_record(data["run_hour"], data["temp"], data["pressure"], data["precip"])

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
                    await send_telegram_alert(formatted_msg, audio_path=audio_file)

            await asyncio.sleep(600)
        else:
            await asyncio.sleep(60)

if __name__ == "__main__":
    asyncio.run(main_loop())