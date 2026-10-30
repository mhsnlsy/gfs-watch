# v9.2.0 - 1.2x Speech Speed & +180h Fast-Fetch Engine
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

LAT = 41.014
LON = 28.950
LOCATION_NAME = "İstanbul"

# 2000 km Çapındaki Sinoptik Kontrol Noktaları
SYNOPTIC_POINTS = {
    "Balkanlar": (45.0, 18.0),
    "Karadeniz / Kırım çevresi": (46.0, 35.0),
    "Orta Akdeniz": (38.0, 15.0),
    "Doğu Akdeniz": (34.0, 30.0)
}

# --- VERİTABANI TAKİBİ ---
def init_db():
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS gfs_runs_v3 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            run_name TEXT,
            forecast_json TEXT
        )
    """)
    conn.commit()
    conn.close()

def get_previous_runs():
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        SELECT run_name, forecast_json 
        FROM gfs_runs_v3 ORDER BY id DESC LIMIT 2
    """)
    rows = cursor.fetchall()
    conn.close()
    return rows

def save_run(run_name, forecast_dict):
    conn = sqlite3.connect("gfs_watch.db")
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO gfs_runs_v3 (run_name, forecast_json)
        VALUES (?, ?)
    """, (run_name, json.dumps(forecast_dict)))
    conn.commit()
    conn.close()

# --- ERKEN YAKALAMA (+180 SAAT / 8 GÜN SINIRLI) VERİ ÇEKME ---
def fetch_full_weather_data():
    print("[STEP 1] Erken paket (+180 saat sınırlı) çekiliyor...")
    local_url = "https://api.open-meteo.com/v1/forecast"
    
    local_params = {
        "latitude": LAT,
        "longitude": LON,
        "current": "temperature_2m,precipitation,rain,snowfall,wind_speed_10m,surface_pressure",
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max",
        "hourly": "temperature_2m,precipitation,snowfall,surface_pressure,wind_speed_10m",
        "forecast_days": 8,
        "models": "gfs_seamless",
        "timezone": "Europe/Istanbul"
    }

    try:
        res = requests.get(local_url, params=local_params, timeout=12)
        res.raise_for_status()
        data = res.json()

        current = data.get("current", {})
        daily = data.get("daily", {})
        hourly = data.get("hourly", {})

        times = hourly.get("time", [])
        temps = hourly.get("temperature_2m", [])
        precips = hourly.get("precipitation", [])

        # Sadece 0'dan +180. saate kadar 6 saatlik adımları kaydet
        forecast_timeline = {}
        for i in range(0, min(181, len(times)), 6):
            t_str = times[i]
            forecast_timeline[t_str] = {
                "step_hour": i,
                "temp": round(temps[i], 1) if i < len(temps) else 0.0,
                "precip": round(precips[i], 2) if i < len(precips) else 0.0
            }

        # 2000 km Çaplı Basınç Taraması (Eşikler: <=1015 hPa & >=1023 hPa)
        synoptic_alerts = []
        for region, (r_lat, r_lon) in SYNOPTIC_POINTS.items():
            r_params = {
                "latitude": r_lat,
                "longitude": r_lon,
                "current": "pressure_msl",
                "models": "gfs_seamless"
            }
            try:
                r_res = requests.get(local_url, params=r_params, timeout=6).json()
                r_press = round(r_res.get("current", {}).get("pressure_msl", 1013.0), 1)
                
                if r_press <= 1015.0:
                    synoptic_alerts.append(f"{region} üzerinde alçak basınç ({r_press} hPa)")
                elif r_press >= 1023.0:
                    synoptic_alerts.append(f"{region} üzerinde yüksek basınç ({r_press} hPa)")
            except Exception:
                continue

        payload = {
            "current": {
                "temp": round(current.get("temperature_2m", 0.0), 1),
                "precip": round(current.get("precipitation", 0.0), 2),
                "wind": round(current.get("wind_speed_10m", 0.0), 1),
                "pressure": round(current.get("surface_pressure", 1013.0), 1)
            },
            "daily": {
                "time": daily.get("time", []),
                "temp_max": daily.get("temperature_2m_max", []),
                "temp_min": daily.get("temperature_2m_min", []),
                "precip_sum": daily.get("precipitation_sum", []),
                "wind_max": daily.get("wind_speed_10m_max", [])
            },
            "timeline_180h": forecast_timeline,
            "synoptic_alerts": synoptic_alerts
        }

        run_name = f"Güncelleme ({datetime.now().strftime('%H:%M')})"
        print("[STEP 1 BAŞARILI] +180h Erken paket ve sinoptik veriler alındı.")
        return run_name, payload
    except Exception as e:
        print(f"[STEP 1 ERROR] Veri Alma Hatası: {e}")
        return None, None

# --- METİN VE SES İÇERİĞİ OLUŞTURUCU ---
def analyze_and_build_output(current_run_name, payload, previous_runs):
    print("[STEP 2] Raporlar ve ses metni üretiliyor...")
    curr = payload["current"]
