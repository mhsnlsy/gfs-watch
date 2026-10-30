# v9.3.0 - Fast-Fetch (+180h), 1.2x Speech Speed & Strict Error-Raising Engine
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
    daily = payload["daily"]
    timeline = payload["timeline_180h"]
    synoptic = payload["synoptic_alerts"]

    curr_t = curr["temp"]
    curr_p = curr["precip"]
    curr_w = curr["wind"]

    # 1. ANLIK HAVA DURUMU SES METNİ
    speech_parts = [f"İstanbul'da anlık sıcaklık {curr_t} derece."]
    
    if curr_p > 0:
        speech_parts.append(f"Yağış {curr_p} milimetre.")
    else:
        speech_parts.append("Yağış beklenmiyor.")

    if curr_w > 20.0:
        speech_parts.append("Hava rüzgarlı.")

    # 2. ÖNÜMÜZDEKİ 3 GÜNLÜK ÖZET (Yarın, Sonraki gün, 3. gün)
    speech_parts.append("Önümüzdeki 3 günlük özete baktığımızda:")
    day_labels = ["Yarın", "Sonraki gün", "3. gün"]
    
    for idx, i in enumerate(range(1, min(4, len(daily.get("time", []))))):
        label = day_labels[idx] if idx < len(day_labels) else f"{idx+1}. gün"
        t_max = round(daily["temp_max"][i], 1) if i < len(daily["temp_max"]) else 0.0
        t_min = round(daily["temp_min"][i], 1) if i < len(daily["temp_min"]) else 0.0
        p_sum = round(daily["precip_sum"][i], 1) if i < len(daily["precip_sum"]) else 0.0
        w_max = round(daily["wind_max"][i], 1) if i < len(daily["wind_max"]) else 0.0

        day_text = f"{label}: En düşük {t_min}, en yüksek {t_max} derece."
        if p_sum > 0:
            day_text += f" Toplam yağış {p_sum} milimetre."
        else:
            day_text += " Yağışsız."

        if w_max > 20.0:
            day_text += " Hava rüzgarlı."

        speech_parts.append(day_text)

    # 3. +180 SAATLİK KIYASLAMA (2°C Sıcaklık / 1.00mm Yağış Eşiği)
    temp_shifts = []
    precip_shifts = []

    if previous_runs and len(previous_runs) > 0:
        try:
            prev_json = json.loads(previous_runs[0][1])
            prev_timeline = prev_json.get("timeline_180h", {})

            for time_key, curr_data in timeline.items():
                if time_key in prev_timeline:
                    p_data = prev_timeline[time_key]
                    step = curr_data["step_hour"]

                    # Sıcaklık Değişimi (>= 2.0°C)
                    t_diff = round(curr_data["temp"] - p_data["temp"], 1)
                    if abs(t_diff) >= 2.0:
                        direction = "artış" if t_diff > 0 else "düşüş"
                        temp_shifts.append(f"+{step}. saatte {abs(t_diff)} derece {direction}")

                    # Yağış Değişimi (>= 1.00mm)
                    p_diff = round(curr_data["precip"] - p_data["precip"], 2)
                    if abs(p_diff) >= 1.00:
                        p_dir = "artış" if p_diff > 0 else "azalma"
                        precip_shifts.append(f"+{step}. saatte {abs(p_diff)} milimetre {p_dir}")
        except Exception as e:
            print(f"[UYARI] Kıyaslama hatası: {e}")

    if temp_shifts or precip_shifts:
        speech_parts.append("Önceki çıktıya kıyasla ilerleyen saatlerde değişimler var.")
        if temp_shifts:
            speech_parts.append("Sıcaklıkta: " + ", ".join(temp_shifts[:2]) + ".")
        if precip_shifts:
            speech_parts.append("Yağışta: " + ", ".join(precip_shifts[:2]) + ".")

    # 4. SİNOPTİK BASINÇ BİLDİRİMİ
    if synoptic:
        syn_text = "Bölgesel basınç haritasında: " + ", ".join(synoptic) + " tespit edildi."
        speech_parts.append(syn_text)

    speech_text = " ".join(speech_parts)

    # TELEGRAM METİN RAPORU
    text_report_lines = [
        f"🌐 MODEL GÜNCELLEME RAPORU",
        f"📍 Konum: {LOCATION_NAME} | ⏱ Zaman: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n",
        f"🌡 Anlık Sıcaklık: {curr_t} °C",
        f"🌧 Anlık Yağış: {curr_p} mm",
        f"💨 Anlık Rüzgar: {curr_w} km/s {'(Rüzgarlı 🌬️)' if curr_w > 20.0 else ''}\n",
        f"📅 ÖNÜMÜZDEKİ 3 GÜNLÜK ÖZET:"
    ]

    for idx, i in enumerate(range(1, min(4, len(daily.get("time", []))))):
        label = day_labels[idx] if idx < len(day_labels) else f"{idx+1}. gün"
        t_max = round(daily["temp_max"][i], 1) if i < len(daily["temp_max"]) else 0.0
        t_min = round(daily["temp_min"][i], 1) if i < len(daily["temp_min"]) else 0.0
        p_sum = round(daily["precip_sum"][i], 1) if i < len(daily["precip_sum"]) else 0.0
        w_max = round(daily["wind_max"][i], 1) if i < len(daily["wind_max"]) else 0.0

        wind_tag = " | 🌬️ Rüzgarlı" if w_max > 20.0 else ""
        text_report_lines.append(f"• {label}: {t_min}°C / {t_max}°C | Yağış: {p_sum} mm{wind_tag}")

    if temp_shifts or precip_shifts:
        text_report_lines.append("\n⚡ +180 Saate Kadar 6 Saatlik Dilim Değişiklikleri:")
        if temp_shifts:
            text_report_lines.append("• Sıcaklık: " + ", ".join(temp_shifts))
        if precip_shifts:
            text_report_lines.append("• Yağış: " + ", ".join(precip_shifts))

    if synoptic:
        text_report_lines.append("\n🌀 2000 km Çaplı Bölgesel Basınç Durumu:")
        for syn_item in synoptic:
            text_report_lines.append(f"• {syn_item}")

    text_report
