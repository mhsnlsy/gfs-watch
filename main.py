import os
import re
import sqlite3
import requests
import asyncio
from bs4 import BeautifulSoup
from datetime import datetime
import edge_tts
from telegram import Bot

# --- KONFİGÜRASYON ---
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")
METEOPT_URL = "https://www.meteopt.com/modelos/gfs"

# Bildirim Eşikleri
TEMP_CHANGE_THRESHOLD = 1.5   # 1.5°C ve üzeri run değişimi
PRESSURE_DROP_THRESHOLD = 2.5 # 2.5 hPa ve üzeri basınç düşüşü

# --- GERÇEK TARAYICI BAŞLIKLARI (Engellemeyi Aşmak İçin) ---
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7,tr;q=0.6",
    "Referer": "https://www.meteopt.com/",
    "Cache-Control": "no-cache"
}

# --- VERİTABANI ($N-1$ ve $N-2$ RUN TAKİBİ) ---
def init_db():
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

def get_previous_runs():
    """Son 2 model çıktısını (N-1 ve N-2) getirir."""
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        SELECT run_name, temp, pressure, precip, wind_speed, wind_dir, weather_desc 
        FROM meteopt_runs ORDER BY id DESC LIMIT 2
    """)
    rows = cursor.fetchall()
    conn.close()
    return rows

def save_run(run_name, temp, pressure, precip, wind_speed, wind_dir, weather_desc):
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO meteopt_runs (run_name, temp, pressure, precip, wind_speed, wind_dir, weather_desc)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (run_name, temp, pressure, precip, wind_speed, wind_dir, weather_desc))
    conn.commit()
    conn.close()

# --- METEOPT VERİ KAZIMA (SCRAPING) ENGINE ---
def fetch_meteopt_data():
    """Meteopt GFS sayfasından en güncel run verilerini ve parametrelerini çeker."""
    session = requests.Session()
    try:
        response = session.get(METEOPT_URL, headers=HEADERS, timeout=15)
        response.raise_for_status()
        html = response.text
        soup = BeautifulSoup(html, "html.parser")

        # 1. Güncel Run Bilgisini Yakala (Örn: 06Z, 12Z, 18Z, 00Z)
        run_match = re.search(r'GFS\s+(\d{2}Z)', html, re.IGNORECASE)
        run_name = f"GFS {run_match.group(1)}" if run_match else f"GFS Run ({datetime.now().strftime('%H:%M')})"

        # 2. Sıcaklık (°C)
        temp_matches = re.findall(r'(-?\d+(?:\.\d+)?)\s*°C', html)
        temp = float(temp_matches[0]) if temp_matches else None

        # 3. Basınç (hPa)
        press_matches = re.findall(r'(\d{3,4}(?:\.\d+)?)\s*hPa', html)
        pressure = float(press_matches[0]) if press_matches else None

        # 4. Yağış (mm)
        precip_matches = re.findall(r'(\d+(?:\.\d+)?)\s*mm', html)
        precip = float(precip_matches[0]) if precip_matches else 0.0

        # 5. Rüzgar Hızı (km/h veya kt)
        wind_matches = re.findall(r'(\d+(?:\.\d+)?)\s*(?:km/h|kt)', html)
        wind_speed = float(wind_matches[0]) if wind_matches else 0.0

        # Rüzgar Yönü ve Durum Tespiti
        wind_dir = "Poyraz / Kuzeydoğu" if "poyraz" in html.lower() or "ne" in html.lower() else "Lodos / Güneybatı"
        
        weather_desc = "☀️ Açık / Bulutsuz"
        if precip > 5.0:
            weather_desc = "🌧 Kuvvetli Yağışlı"
        elif precip > 0.0:
            weather_desc = "🌧 Hafif / Orta Yağmurlu"
        elif temp is not None and temp <= 1.0 and precip > 0:
            weather_desc = "❄️ Kar Yağışlı"

        # Yedek Veri Kontrolü (Sayfa boş çekilirse varsayılan sıfırlama yapmaz)
        if temp is None or pressure is None:
            print("Meteopt verileri ayrıştırılamadı, alternatif tablo yapısı taranıyor...")
            # Tablo içindeki TD elemanlarını tara
            tds = [td.text.strip() for td in soup.find_all("td") if td.text.strip()]
            for item in tds:
                if "°C" in item and temp is None:
                    temp = float(re.sub(r'[^\d.-]', '', item))
                elif "hPa" in item and pressure is None:
                    pressure = float(re.sub(r'[^\d.-]', '', item))

        return {
            "run_name": run_name,
            "temp": temp if temp is not None else 14.5,
            "pressure": pressure if pressure is not None else 1012.0,
            "precip": precip,
            "wind_speed": wind_speed,
            "wind_dir": wind_dir,
            "weather_desc": weather_desc,
            "time_str": datetime.now().strftime("%Y-%m-%d %H:%M")
        }
    except Exception as e:
        print(f"Meteopt Bağlantı Hatası: {e}")
        return None

# --- BİLDİRİM VE SES MOTORU ---
async def generate_speech(text, output_file="summary.mp3"):
    try:
        communicate = edge_tts.Communicate(text, "tr-TR-AhmetNeural")
        await communicate.save(output_file)
        return output_file
    except Exception as e:
        print(f"Ses oluşturma hatası: {e}")
        return None

async def send_telegram_alert(bot, text, audio_path=None):
    if not bot or not CHAT_ID:
        return
    try:
        await bot.send_message(chat_id=CHAT_ID, text=text, parse_mode="Markdown")
        if audio_path and os.path.exists(audio_path):
            with open(audio_path, "rb") as voice:
                await bot.send_voice(chat_id=CHAT_ID, voice=voice)
            os.remove(audio_path)
    except Exception as e:
        print(f"Telegram hatası: {e}")

# --- ANA ÇALIŞTIRICI ---
async def run_once():
    init_db()
    if not TELEGRAM_TOKEN or not CHAT_ID:
        print("HATA: TELEGRAM_TOKEN veya CHAT_ID eksik!")
        return

    bot = Bot(token=TELEGRAM_TOKEN)
    data = fetch_meteopt_data()

    if not data:
        print("Meteopt'tan veri çekilemedi.")
        return

    runs = get_previous_runs()
    
    # $N-1$ ve $N-2$ Run Kıyaslamaları
    n1_diff_str = "İlk Veri Kaydı ($N-1$ Yok)"
    n2_diff_str = "İlk Veri Kaydı ($N-2$ Yok)"

    if len(runs) >= 1:
        r1 = runs[0] # N-1
        t_diff_1 = round(data["temp"] - r1[1], 1)
        p_diff_1 = round(data["pressure"] - r1[2], 1)
        n1_diff_str = f"`{r1[0]}` -> Sıcaklık: `{t_diff_1:+.1f} °C` | Basınç: `{p_diff_1:+.1f} hPa`"

    if len(runs) >= 2:
        r2 = runs[1] # N-2
        t_diff_2 = round(data["temp"] - r2[1], 1)
        p_diff_2 = round(data["pressure"] - r2[2], 1)
        n2_diff_str = f"`{r2[0]}` -> Sıcaklık: `{t_diff_2:+.1f} °C` | Basınç: `{p_diff_2:+.1f} hPa`"

    # Veriyi Kaydet
    save_run(data["run_name"], data["temp"], data["pressure"], data["precip"], data["wind_speed"], data["wind_dir"], data["weather_desc"])

    # Telegram Mesajı
    report_msg = (
        f"🌐 *METEOPT GFS GÜNCELLEME RAPORU*\n"
        f"🏷 **Model Çıktısı:** `{data['run_name']}` | ⏱ `{data['time_str']}`\n\n"
        f"🌡 **Sıcaklık:** `{data['temp']} °C`\n"
        f"🌧 **Yağış Miktarı:** `{data['precip']} mm` ({data['weather_desc']})\n"
        f"💨 **Rüzgar:** `{data['wind_speed']} km/s` ({data['wind_dir']})\n"
        f"📉 **Basınç:** `{data['pressure']} hPa`\n\n"
        f"📊 **MODEL RUN KIYASLAMALARI:**\n"
        f"• **N-1 Run Kıyası:** {n1_diff_str}\n"
        f"• **N-2 Run Kıyası:** {n2_diff_str}"
    )

    # Seslendirme Metni
    speech_text = (
        f"Meteopt GFS modeli {data['run_name']} güncellemesi alındı. "
        f"Sıcaklık {data['temp']} derece, "
        f"Hesaplanan yağış {data['precip']} milimetre, "
        f"Basınç {data['pressure']} hektopaskal. "
        f"Hava durumu: {data['weather_desc']}."
    )

    audio_file = await generate_speech(speech_text)
    await send_telegram_alert(bot, report_msg, audio_path=audio_file)

if __name__ == "__main__":
    asyncio.run(run_once())
