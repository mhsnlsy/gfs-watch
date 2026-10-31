# GFS Watch

A point-specific GFS forecast watcher for 41.014°N, 28.950°E. GitHub Actions reads native NOAA GFS GRIB2 messages directly from the public S3 bucket, prefetches forecast fields before +180 is published, and sends one Telegram notification as soon as the f180 cycle is ready.

## Data sources and direct GRIB2 retrieval

- Run discovery is performed directly against NOAA's public `noaa-gfs-bdp-pds` S3 inventory. The watcher sends lightweight HTTP HEAD requests for each recent 00Z/06Z/12Z/18Z cycle's `f180` GRIB2 object. A successful response confirms that the exact +180-hour global model file has been published; it does not download the 500+ MB object.
- WXCharts identifies NOAA/NCEP as its GFS source. Instead of scraping third-party chart pages or waiting for a secondary archive API, this project reads the underlying operational NOAA/NCEP GFS 0.25° GRIB2 data directly.
- Forecast data is not requested from a weather API or the NOMADS filter service. For each native GFS GRIB2 object, the watcher reads its small adjacent `.idx` inventory, selects the required GRIB2 records, and downloads those exact byte ranges directly from NOAA S3. This avoids downloading the full roughly 500 MB global file while retaining the original GRIB2 messages.
- Requested coordinate: **41.014°N, 28.950°E**. The nearest native GFS 0.25° grid node is **41.000°N, 29.000°E**. Forecast values represent that model grid cell, not an interpolation over all of Istanbul.
- GRIB2 messages are decoded locally with ecCodes. The point forecast uses 2 m temperature, 10 m U/V wind components and surface precipitation. The current/model-start snapshot and regional mean-sea-level pressure analysis are also decoded from the same cycle's f000 GRIB2 fields; no Open-Meteo or other weather API is called.
- Values are converted to °C, km/h and mm. Precipitation uses the exact interval between consecutive native GFS output times (hourly through +120h, then three-hourly); cumulative run totals are not added repeatedly.
- The forecast timeline contains 141 native valid times from +0 to +180: hourly from f000 through f120, then f123, f126, ... f180. Daily minima/maxima, precipitation totals and wind maxima are aggregated from these native model samples.

## GitHub Actions deployment

The repository runs GFS Watch through GitHub Actions. No separate server or local installation is needed.

1. Open **Settings → Secrets and variables → Actions** in this repository.
2. Add these repository secrets:
   - `TELEGRAM_TOKEN` — Telegram bot token (required).
   - `CHAT_ID` — Telegram chat ID (required).
   - `GCP_SA_KEY` — Google Cloud service-account JSON in one line (optional; without it, text notifications still work).
3. Open the **Actions** tab and select **GFS Watch**. Use **Run workflow** to test it.
4. The scheduled workflow starts at 06:50, 12:50, 18:50 and 00:50 Istanbul time. Each scheduled job stays active for up to 90 minutes. It checks f180 every 15 seconds and scans for newly published input files every 5 minutes. GitHub may delay scheduled starts during periods of high load.

The workflow installs the ecCodes system library and Python package automatically on its GitHub-hosted runner.

## Run tracking and +180-hour threshold

- A single scheduled workflow begins 3 hours 50 minutes after each six-hour GFS cycle starts: 06:50 for 00Z, 12:50 for 06Z, 18:50 for 12Z and 00:50 for 18Z (Istanbul time).
- Each scheduled job remains active for up to 90 minutes. At startup it caches every currently available input lead through f177; it then scans for newly published leads every five minutes. The cache covers f000–f120 hourly and f123–f177 every three hours (140 input files in total), using direct NOAA S3 `.idx` byte ranges.
- NOAA's exact global `f180` GRIB2 object is checked directly on S3 every 15 seconds. When it appears, the watcher verifies that all f000–f177 inputs are cached, catches up any missing files, then downloads f180 and locally decodes the complete 141-point native forecast.
- The separate 15-second f180 check means the workflow does not have to wait for the next five-minute prefetch scan to notice the final file; actual GitHub job start times can still be delayed by GitHub Actions scheduling.
- The selected fields are 2 m temperature, 10 m U/V wind, surface precipitation, and f000 mean-sea-level pressure. The pressure analysis uses the native global PRMSL GRIB2 field and evaluates a 2,500 km diameter circle centred on 41.014°N, 28.950°E.
- The full +0 to +180 timeline uses all 141 native forecast steps and the nearest GFS grid cell for the configured point. Cache entries are removed after a run is processed; abandoned cycle caches are pruned after 48 hours.

## Public machine-readable JSON

After a GFS run has been successfully processed, the workflow publishes JSON files on the public `gfs-watch-state` branch:

- [Latest forecast JSON](https://raw.githubusercontent.com/mhsnlsy/gfs-watch/gfs-watch-state/public/latest.json) — always points to the latest processed run.
- Archived run JSON files use `public/runs/YYYYMMDDTHHZ.json`, for example `20261031T06Z.json`. The workflow retains the latest 10 days of run files.

The JSON includes the exact requested coordinate (41.014°N, 28.950°E), the nearest native GFS grid point (41.000°N, 29.000°E), the GFS run time, 141 native forecast points through +180 hours, daily summaries, units and source metadata. Forecast timestamps include both UTC and Europe/Istanbul time. The initial-condition snapshot comes from the run's f000 GRIB2 fields; it is a model initial state, not a live observation.

This is a downloadable public data file, not a live feed automatically consumed by WXCharts or Meteopt. Those platforms would need to support and be configured for a custom data source.

## Run history and comparisons

- The SQLite database is stored in the `gfs-watch-state` branch and restored before each check.
- The latest 10 days of run history are retained.
- Run-to-run temperature, six-hour precipitation and 10 m wind-speed changes are presented in the four-cycle comparison image, not repeated in the text report or voice script.
- The comparison image uses a shared set of overlapping Istanbul calendar dates across all four cycles. Every panel labels each date with its Turkish weekday. The first lead of a new cycle has no six-hour precipitation interval preceding its own initialisation, so that point is excluded from precipitation comparisons.
- At model initialisation, the native f000 NOAA/NCEP mean-sea-level pressure GRIB2 field is analysed inside a 2,500 km diameter circle centred on 41.014°N, 28.950°E. High/low pressure findings are written in the text report only and are not included in the voice script.
- Do not delete or manually edit the `gfs_watch.db` file in the state branch; the workflow maintains it.

## Report clarity

- The Telegram report identifies the output type, model-cycle time in TSİ and UTC, report creation time, and the full +180-hour validity interval in TSİ.
- Daily summaries use Turkish weekday names and calendar dates instead of relative labels such as "tomorrow" or "the following day".
- The voice script also uses weekday names for daily summaries. Regional pressure findings and all previous-run change/comparison narration are excluded from the voice script. Run-to-run changes appear only in the four-cycle comparison image.

## Notification behaviour

- One text notification is sent per eligible GFS run; there are no separate notifications for forecast changes.
- Every automatic GFS cycle notification (00Z, 06Z, 12Z and 18Z) also sends a four-cycle PNG comparison chart to Telegram: the current run plus the three immediately preceding six-hour cycles. For example, a 12Z notification compares 18Z (previous day), 00Z, 06Z and the new 12Z run.
- The chart contains grouped daily temperature candlesticks (first/last six-hour sample as open/close; daily low/high as wick), grouped daily precipitation totals and grouped daily maximum wind speed. All four runs use the same set of overlapping Istanbul calendar dates and consistent colours across panels.
- The three exact preceding runs are loaded from SQLite in read-only mode. If a run is missing from retained history, its NOAA/NCEP forecast is fetched read-only for chart generation; this fallback does not save a DB row, alter notification state or update public JSON. Manual report resends do not generate or send comparison images.
- Telegram text delivery does not wait for TTS. Audio generation starts concurrently in a background thread.
- TTS generation and Telegram voice delivery each retry up to three times after failures. If audio cannot be produced or sent, the text report remains delivered.
- GitHub Actions prevents overlapping GFS Watch jobs.
