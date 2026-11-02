"""Static smoke tests for exact GFS/ECMWF forecast layout parity."""
from __future__ import annotations

import re
import math
import json
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
        'station-history-inline',
        'id="station-history-panel"',
        'id="station-temperature-trend"',
        'id="station-rain-trend"',

        'id="next72-temperature"',
        'id="next72-precipitation"',
        'function renderNext72Hours()',
        'async function refreshStationObservations()',
        'window.setInterval(refreshStationObservations,60000)',
        'id="ecmwf-comparison-wind10-chart"',
        'id="ecmwf-comparison-wind850-chart"',
        'function renderEcmwfComparisonChart(metric,targetId,history)',
        'document.comparison_runs',
        'id="ecmwf-cycle-temperature-chart"',
        'id="ecmwf-cycle-t850-chart"',
        'id="ecmwf-cycle-rain-chart"',
        'renderEcmwfComparisonChart("temperature","ecmwf-cycle-temperature-chart",comparisonRuns)',
        'renderEcmwfComparisonChart("t850","ecmwf-cycle-t850-chart",comparisonRuns)',
        'renderEcmwfComparisonChart("precipitation","ecmwf-cycle-rain-chart",comparisonRuns)',
        'renderEcmwfComparisonChart("wind10","ecmwf-comparison-wind10-chart",comparisonRuns)',
        'renderEcmwfComparisonChart("wind850","ecmwf-comparison-wind850-chart",comparisonRuns)',
        'function scheduleTouchChartTooltipDismiss(hideFn)',
        'window.setTimeout(dismissActiveTouchChartTooltip,2800)',
        'station-chart-hit-area',
        'id="tahmin"',
        'id="basinc"',
        'id="ecmwf-tahmin"',
        'id="ecmwf-basinc"',
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
        'renderFindings(viewData.regional_pressure_analysis&&viewData.regional_pressure_analysis.findings,first.mslp&&first.mslp.mean_hpa,"ecmwf-pressure-findings")',
        'http-equiv="refresh" content="300"',
    )
    missing = [item for item in required if item not in html]
    if missing:
        raise AssertionError("Missing ECMWF website contract: " + ", ".join(missing))

    station_card_start = html.index('<article class="weather-card station-card"')
    history_start = html.index('<section class="station-history-inline history-panel"')
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
    for shared_class in ('class="section"', 'class="section-head"', 'class="lower-grid"',
                         'class="pressure-card"', 'class="info-card"', 'class="daily-grid"'):
        if shared_class not in gfs or shared_class not in ecmwf:
            raise AssertionError(f"GFS/ECMWF layout mismatch: {shared_class}")

    # The old 180-hour surface temperature/precipitation charts were intentionally removed.
    removed_charts = (
        'id="seyir"',
        'id="temperature-chart"',
        'id="precipitation-chart"',
        'id="ecmwf-comparison-temperature-chart"',
        'id="ecmwf-comparison-precipitation-chart"',
    )
    remaining = [item for item in removed_charts if item in html]
    if remaining:
        raise AssertionError("Removed 180-hour charts still present: " + ", ".join(remaining))

    if 'id="tahmin"' not in gfs or gfs.index('id="tahmin"') < gfs.index('id="basinc"'):
        raise AssertionError("GFS eight-day forecast must be the final model section.")
    if 'id="ecmwf-tahmin"' not in ecmwf or ecmwf.index('id="ecmwf-tahmin"') < ecmwf.index('id="ecmwf-basinc"'):
        raise AssertionError("ECMWF eight-day forecast must be the final model section.")
    if 'class="chart-stack"' in gfs:
        raise AssertionError("GFS legacy 180-hour graph card container remains.")
    if gfs.count('class="chart-card"') != 1 or 'id="gfs-850-card"' not in gfs:
        raise AssertionError("GFS should keep only the 850 hPa comparison card.")
    if 'class="chart-stack"' not in ecmwf or 'class="chart-card"' not in ecmwf:
        raise AssertionError("The remaining ECMWF wind comparison charts are missing.")
    if '.next-72h-card{\n      border:0!important' not in html or '.chart-stack>.chart-card{\n      border:0!important' not in html:
        raise AssertionError("Mobile chart cards must be frameless.")
    if html.count('document.addEventListener("pointerdown"') != 1 or html.count('window.addEventListener("scroll"') != 1:
        raise AssertionError("Touch tooltip dismissal must use singleton global listeners.")

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

    version = json.loads((ROOT / "site" / "version.json").read_text(encoding="utf-8"))
    if version.get("name") != "İstanbul'un Havası" or version.get("version") != "3.0":
        raise AssertionError("Shared app identity must stay İstanbul'un Havası 3.0 until the version file changes.")
    if 'data-app-name' not in html or 'data-app-version' not in html or "./version.json" not in html:
        raise AssertionError("The website must render its name and version from site/version.json.")
    if "GFS Watch · v3.0.0" in html or "GFS Watch v3.0.0" in html:
        raise AssertionError("The old GFS Watch version label is still visible.")
    if '"version.json"' not in main or "APP_LABEL" not in main or 'f"🌦 {APP_LABEL}"' not in main:
        raise AssertionError("Telegram reports must take their version from the same site/version.json.")

    if 'id="next72-wind-speed"' in html or 'id="next72-wind-direction"' in html:
        raise AssertionError("The 72-hour panel must show only temperature and precipitation.")
    if "viewport-fit=cover" not in html or "env(safe-area-inset-top)" not in html:
        raise AssertionError("Modern iPhone safe-area viewport support is missing.")
    if "orientation:landscape" not in html or "max-height:600px" not in html:
        raise AssertionError("Compact landscape phone layout is missing.")
    print("[ECMWF UI SMOKE] model selector, daily forecast ordering, temperature/rain-only "
          "72-hour panel, responsive safe areas, touch tooltip dismissal, ECMWF wind comparison, "
          "55-step contract and unique IDs passed.")


if __name__ == "__main__":
    main()
