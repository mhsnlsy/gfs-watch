# GFS Watch

An Istanbul-focused GFS forecast watcher. It checks Open-Meteo's GFS model metadata every 10 minutes and sends one Telegram notification for every new GFS run. Forecast differences are included in the report for context but do not create separate notifications.

Telegram text is sent immediately without waiting for speech synthesis. Google Cloud Text-to-Speech runs concurrently; the voice message is sent as soon as it is ready.

## GitHub Actions deployment

The repository runs GFS Watch through GitHub Actions. No separate server, local installation, or terminal commands are needed.

1. Open **Settings → Secrets and variables → Actions** in this repository.
2. Add these repository secrets:
   - `TELEGRAM_TOKEN` — Telegram bot token (required).
   - `CHAT_ID` — Telegram chat ID (required).
   - `GCP_SA_KEY` — Google Cloud service-account JSON in one line (optional; without it, text notifications still work).
3. After the workflow is merged into `main`, open the **Actions** tab and select **GFS Watch**. Use **Run workflow** once to test it.
4. The scheduled workflow then checks for a new GFS run every 10 minutes. Its start time may occasionally be delayed by GitHub Actions.

## Run history

- The SQLite database is stored in the `gfs-watch-state` branch and restored before each check.
- The workflow keeps the latest 10 days of run history. This history is used to compare forecasts across GFS runs.
- Do not delete or manually edit the `gfs_watch.db` file in the state branch; the workflow maintains it.
- The run ID comes from Open-Meteo's `last_run_initialisation_time`, not the local clock.

## Notification behaviour

- Every new GFS run produces one text notification. There are no separate notifications for significant forecast changes.
- If the GFS data has not finished propagating across Open-Meteo's servers, the task waits for the remainder of the 10-minute consistency window before fetching it.
- If metadata or forecast retrieval fails, the run is not marked processed and a later scheduled check retries it.
- Telegram text delivery does not wait for TTS. Audio generation starts concurrently in a background thread.
- TTS generation and Telegram voice delivery each retry up to three times after failures. If audio cannot be produced or sent, the text report remains delivered.
- GitHub Actions prevents concurrent GFS Watch jobs from running at the same time.
