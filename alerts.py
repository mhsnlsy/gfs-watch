"""Extreme weather alert thresholds for GFS Watch."""

from typing import Dict, List, Any

# Thresholds (tunable)
HEAVY_RAIN_MM_3H = 20.0
HEAVY_RAIN_DAILY_MM = 40.0
STRONG_WIND_KMH = 40.0
HEAT_C = 35.0
COLD_C = 0.0

def check_alerts(forecast_points: List[Dict[str, Any]]) -> List[str]:
    """Return list of alert messages for the forecast."""
    alerts = []
    max_temp = max((p.get("temperature_2m_c", -999) for p in forecast_points), default=-999)
    min_temp = min((p.get("temperature_2m_c", 999) for p in forecast_points), default=999)
    max_wind = max((p.get("wind_speed_10m_kmh", 0) for p in forecast_points), default=0)
    max_precip_3h = max((p.get("precipitation_mm", 0) for p in forecast_points), default=0)

    if max_temp >= HEAT_C:
        alerts.append(f"🌡️ Aşırı sıcak: {max_temp:.1f}°C")
    if min_temp <= COLD_C:
        alerts.append(f"❄️ Aşırı soğuk: {min_temp:.1f}°C")
    if max_wind >= STRONG_WIND_KMH:
        alerts.append(f"🌬️ Kuvvetli rüzgâr: {max_wind:.0f} km/sa")
    if max_precip_3h >= HEAVY_RAIN_MM_3H:
        alerts.append(f"🌧️ Kuvvetli yağış: {max_precip_3h:.1f} mm")

    return alerts

def format_alerts(alerts: List[str]) -> str:
    if not alerts:
        return ""
    return "\n\n⚠️ UYARILAR:\n" + "\n".join(f"- {a}" for a in alerts)
