import os
import re
import sqlite3
import asyncio
from datetime import datetime
import cloudscraper
from bs4 import BeautifulSoup
import edge_tts
from telegram import Bot

# --- KONFİGÜRASYON ---
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
CHAT_ID = os.getenv("CHAT_ID")
METEOPT_URL = "https://www.meteopt.com/modelos/gfs"

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

# --- CLOUDSCRAPER ILE VERİ KAZIMA ENGINE ---
def fetch_meteopt_data():
    try:
        print("[LOG] Cloudscraper oluşturuluyor...")
        # Gerçek Chrome tarayıcı parmak izi taklidi yapar
        scraper = cloudscraper.create_scraper(
            browser={
                'browser': 'chrome',
                'platform': 'windows',
                'desktop': True
            }
        )
        
        print("[LOG] Meteopt sitesine bağlanılıyor...")
        response = scraper.get(METEOPT_URL, timeout=20)
        print(f"[LOG] HTTP Yanıt Kodu: {response.status_code}")
        response.raise_for_status()
        html = response.text

        # 1. Güncel Run Bilgisini Yakala (00Z, 06Z, 12Z, 18Z)
        run_match = re.search(r'GFS\s+(\d{2}Z)', html, re.IGNORECASE)
        run_name = f"GFS {run_match.group(1)}" if run_match else f"GFS Run ({datetime.now().strftime('%H:%M')})"

        # 2. Sıcaklık (°C)
        temp_matches = re.findall(r'(-?\d+(?:\.\d+)?)\s*°C', html)
        temp = float(temp_matches[0]) if temp_matches else 15.0

        # 3. Basınç (hPa)
        press_matches = re.findall(r'(\d{3,4}(?:\.\d+)?)\s*hPa', html)
        pressure = float(press_matches[0]) if press_matches else 1013.0

        # 4. Yağış (mm)
        precip_matches = re.findall(
