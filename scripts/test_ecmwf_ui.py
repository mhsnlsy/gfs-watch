"""Static smoke tests for exact GFS/ECMWF forecast layout parity."""
from __future__ import annotations

import re
import math
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "site" / "index.html"
MAIN = ROOT / "main.py"


def main() -> None:
    html = HTML.read_text(encoding="utf-8")
    main = MAIN.read_text(encoding="utf-8")
    required = (
        'id="model-gfs-button"',
        'id="model-ecmwf-button"',
        'id="gfs-model-view"',
        'id="ecmwf-model-view"',
        'id="ecmwf-daily-grid"',
        'id="next-72h-panel"',
        'class="station-history-inline"',
        'id="station-history-panel"',
        'id="station-temperature-trend"',
        'id="station-rain-trend"',

        'id="next72-temperature"',
        'id="next72-precipitation"',
        'id="next72-wind-speed"',
        'id="next72-wind-direction"',
        'function renderNext72Hours()',
        'wind_direction_10m_deg',
        'id="ecmwf-comparison-temperature-chart"',
        'id="ecmwf-comparison-precipitation-chart"',
        'id="ecmwf-comparison-wind10-chart"',
        'id="ecmwf-comparison-wind850-chart"',
        'function renderEcmwfComparisonChart(metric,targetId,history)',
        'document.comparison_runs',
        'id="ecmwf-pressure-findings"',
        'id="ecmwf-valid-until"',
        'const ECMWF_DATA_URL="./data/ecmwf/latest.json";',
        'localStorage.setItem("istanbul-hava-model-view",activeModel)',
        'localStorage.getItem("istanbul-hava-model-view")',
        'document.forecasts.length!==55',
        '2 m sıcaklık, 10 m rüzgâr ve yağış IFS HRES; 850 hPa ve basınç alanları IFS ensemble verisidir.',
        'IFS HRES oper/fc + IFS ENS em/es',
        'Yüzey alanları için ENS standart sapması Open Data ürününde bulunmadığından gösterilmez.',
        'function renderDaily(items,targetId="daily-grid")',
        'function renderChart(metric,targetId,sourceData=forecastData)',
        'renderDaily(viewData.daily_summary,"ecmwf-daily-grid")',
        'renderEcmwfComparisonChart("precipitation","ecmwf-comparison-precipitation-chart",comparisonRuns)',
        'renderFindings(viewData.regional_pressure_analysis&&viewData.regional_pressure_analysis.findings,first.mslp&&first.mslp.mean_hpa,"ecmwf-pressure-findings")',
        'http-equiv="refresh" content="300"',
    )
    missing = [item for item in required if item not in html]
    if missing:
        raise AssertionError("Missing ECMWF website contract: " + ", ".join(missing))

    station_card_start = html.index('<article class="weather-card station-card"')
    history_start = html.index('<section class="history-panel station-history-inline"')
    history_end = html.index('</section>', history_start)
    station_card_end = html.index('</article>', history_end)
    if not (station_card_start < history_start < history_end < station_card_end):
        raise AssertionError("The 24-hour station trends must be embedded inside the live observation card.")
    if '.station-history-inline .history-charts{grid-template-columns:repeat(2,minmax(0,1fr))' not in html:
        raise AssertionError("The embedded station history must use a compact two-chart layout.")
    if '.daily-grid .day{padding:10px 4px 9px' not in html:
        raise AssertionError("The eight-day forecast cards are missing their compact visual treatment.")

    ids = re.findall('id="([^"]+)"', html)
    duplicates = sorted(name for name, count in Counter(ids).items() if count > 1)
    if duplicates:
        raise AssertionError("Duplicate HTML IDs: " + ", ".join(duplicates))

    gfs = html[html.index('<div id="gfs-model-view">'):html.index('<div id="ecmwf-model-view"')]
    ecmwf = html[html.index('<div id="ecmwf-model-view"'):html.index("</main>")]
    for shared_class in ('class="section"', 'class="section-head"', 'class="chart-stack"',
                         'class="chart-card"', 'class="lower-grid"', 'class="pressure-card"',
                         'class="info-card"', 'class="daily-grid"'):
        if shared_class not in gfs or shared_class not in ecmwf:
            raise AssertionError(f"GFS/ECMWF layout mismatch: {shared_class}")

    for section_id in ("ecmwf-tahmin", "ecmwf-seyir", "ecmwf-basinc"):
        if f'id="{section_id}"' not in ecmwf:
            raise AssertionError(f"Missing ECMWF section: {section_id}")

    if "ecmwf-comparison-wind10-chart" not in ecmwf or "ecmwf-comparison-wind850-chart" not in ecmwf:
        raise AssertionError("Missing separate 10m/850hPa ECMWF comparison cards.")

    if "ecmwf-comparison-wind10-chart" not in ecmwf or "ecmwf-comparison-wind850-chart" not in ecmwf:
        raise AssertionError("Missing separate 10m/850hPa ECMWF comparison cards.")

    if "ecmwf-wind-chart" in html or "ecmwf-forecast-table" in html:
        raise AssertionError("Legacy ECMWF-only layout remains in the website.")

    if 'id="ecmwf-daily-cycle-chip"' not in html or 'id="ecmwf-daily-updated-chip"' not in html:
        raise AssertionError("ECMWF daily metadata targets are missing.")

    if '"wind_direction_10m_deg": values.get("wind_direction_deg")' not in main:
        raise AssertionError("GFS 10 m wind direction is not exported to the forecast timeline.")
    if 'math.atan2(-float(u_value), -float(v_value))' not in main:
        raise AssertionError("Meteorological wind-from direction is not calculated from GFS U/V fields.")
    direction_from_uv = lambda u, v: (math.degrees(math.atan2(-u, -v)) + 360.0) % 360.0
    assert abs(direction_from_uv(0.0, -1.0) - 0.0) < 1e-9
    assert abs(direction_from_uv(-1.0, 0.0) - 90.0) < 1e-9
    assert abs(direction_from_uv(0.0, 1.0) - 180.0) < 1e-9
    assert abs(direction_from_uv(1.0, 0.0) - 270.0) < 1e-9

    print("[ECMWF UI SMOKE] GFS/ECMWF shared card and section layout, model selector, "
          "persistent choice, 5-minute refresh, 55-step contract and unique IDs passed.")


if __name__ == "__main__":
    main()
