# GFS Watch Improvements (v3)

## 1. Website Data Loading Fixes
- Added robust loading states, error messages, and retry logic for JSON data sources (latest.json, station observations, ECMWF, notifications).
- Fallbacks for missing data so the page remains usable.
- Improved caching and network-first strategy in service worker for /data/ paths.

## 2. GFS + ECMWF Comparison
- Side-by-side and difference charts for temperature and precipitation.
- Confidence/spread indicators from ensemble where available.
- Clear model run timestamps and validity periods.

## 3. UI/UX Improvements
- Cleaner, more modern dark theme consistent with existing design.
- Better responsive grids and chart scaling for mobile and desktop.
- Improved readability of forecasts, station data, and archived reports.

## 4. main.py Modularization
- Extracted alert logic into `alerts.py`.
- Prepared structure for further splitting of GRIB processing, reporting, and plotting.
- Original main.py remains functional; modular pieces can be adopted incrementally.

## 5. Additional Stations / Locations
- Extended station observation support beyond ENKA Balmumcu and Eyüpsultan.
- Configurable station list and history endpoints.
- Documentation for adding new MGM or other observation sources.

## 6. Extreme Weather Alerts
- Threshold-based alerts for:
  - Heavy precipitation (>20 mm / 3h or daily)
  - Strong winds (>40 km/h)
  - Extreme temperatures (heat >35°C, cold <0°C)
- Alerts integrated into Telegram reports and optional push notifications.

## 7. Expanded Tests
- New unit tests for alert thresholds.
- Continued smoke tests for chart themes and data structures.
- Validation of JSON schemas for public data.

All changes are backward compatible. Deploy via the existing GitHub Pages workflow after merge to main.
