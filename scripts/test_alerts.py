"""Tests for extreme weather alerts."""
from alerts import check_alerts, HEAT_C, STRONG_WIND_KMH, HEAVY_RAIN_MM_3H

def test_heat_alert():
    points = [{"temperature_2m_c": HEAT_C + 1}]
    alerts = check_alerts(points)
    assert any("sıcak" in a.lower() for a in alerts)

def test_no_alerts():
    points = [{"temperature_2m_c": 20, "wind_speed_10m_kmh": 10, "precipitation_mm": 1}]
    alerts = check_alerts(points)
    assert alerts == []

def test_wind_and_rain():
    points = [
        {"wind_speed_10m_kmh": STRONG_WIND_KMH + 5, "precipitation_mm": HEAVY_RAIN_MM_3H + 1}
    ]
    alerts = check_alerts(points)
    assert len(alerts) >= 2

if __name__ == "__main__":
    test_heat_alert()
    test_no_alerts()
    test_wind_and_rain()
    print("All alert tests passed.")
