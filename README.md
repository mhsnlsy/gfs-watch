# GFS Watch

An Istanbul-focused NOAA GFS watcher. GitHub Actions checks Open-Meteo's GFS publication metadata every 10 minutes and sends one Telegram text and voice notification per model run, after that exact run reaches at least +180 forecast hours.

Telegram text is sent immediately without waiting for speech synthesis. Google Cloud Text-to-Speech runs concurrently; the voice message is sent as soon as it is ready.

## GitHub Actions deployment

The repository runs GFS Watch through GitHub Actions. No separate server, local installation, or terminal commands are needed.

1. Open **Settings → Secrets and variables → Actions** in this repository.
2. Add these repository secrets:
   - `TELEGRAM_TOKEN` — Telegram bot token (required).
   - `CHAT_ID` — Telegram chat ID (required).
   - `GCP_SA_KEY` — Google Cloud service-account JSON in one line (optional; without it, text notifications still work).
3. Open the **Actions** tab and select **GFS Watch**. Use **Run workflow** to test it.
4. The scheduled workflow checks for GFS publication progress every 10 minutes. GitHub may delay a scheduled start during periods of high load.

## Run tracking and +180-hour threshold

- The workflow checks both Open-Meteo's `in-progress.json` and `latest.json` for the `ncep_gfs013` model.
- Progress is measured from each run's own UTC `reference_time` to its latest published `valid_times`; it is not measured from the current clock.
- A run is not notified or marked as processed until at least +180 forecast hours have been published.
- Once eligible, the workflow retrieves that exact run through Open-Meteo's Single Runs API using its `run=` initialisation time and requests the full 181 hourly points from +0 to +180.
- If the Single Runs API has not yet made the run available, the workflow leaves it unprocessed and retries on a later check.
- When multiple unprocessed runs are eligible, the oldest eligible run is handled first to preserve chronological comparisons.

## Run history and comparisons

- The SQLite database is stored in the `gfs-watch-state` branch and restored before each check.
- The latest 10 days of run history are retained.
- Each eligible run is compared with the immediately preceding stored run. Temperature changes of at least 2 °C and precipitation changes of at least 1 mm are included in the report.
- Do not delete or manually edit the `gfs_watch.db` file in the state branch; the workflow maintains it.

## Notification behaviour

- One text notification is sent per eligible GFS run; there are no separate notifications for forecast changes.
- Telegram text delivery does not wait for TTS. Audio generation starts concurrently in a background thread.
- TTS generation and Telegram voice delivery each retry up to three times after failures. If audio cannot be produced or sent, the text report remains delivered.
- GitHub Actions prevents concurrent GFS Watch jobs from running at the same time.
