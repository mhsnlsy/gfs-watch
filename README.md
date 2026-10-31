# GFS Watch

An Istanbul-focused GFS forecast watcher. It polls Open-Meteo model metadata every 10 minutes and sends one Telegram notification for every new GFS run. Forecast differences are included in the report for context but do not create separate notifications.

Telegram text is sent immediately without waiting for speech synthesis. Google Cloud Text-to-Speech runs concurrently; the voice message is sent as soon as it is ready.

## Fly.io deployment

1. Create a persistent volume in the app's primary region (`ams`):

   ```bash
   fly volumes create gfs_data --region ams --size 1
   ```

   If the volume already exists, do not create another one; check it with `fly volumes list`.

2. Set secrets:

   ```bash
   fly secrets set TELEGRAM_TOKEN="..." CHAT_ID="..." GCP_SA_KEY='...'
   ```

   `GCP_SA_KEY` is the service-account JSON as a single-line JSON string. If it is absent or TTS fails, the text notification is still delivered.

3. Deploy and ensure exactly one worker:

   ```bash
   fly deploy
   fly scale count 1 --process-group worker
   fly logs
   ```

4. Optional configuration:
   - `POLL_INTERVAL_SECONDS`: defaults to `600` (10 minutes).
   - `DB_PATH`: defaults to `/data/gfs_watch.db` on Fly and `./gfs_watch.db` locally.

## Run history and notification behaviour

- The run ID comes from Open-Meteo's `last_run_initialisation_time`, not the local clock.
- Every new GFS run produces one text notification. There are no separate notifications for significant forecast changes.
- Records older than 10 days are deleted at startup and on every polling cycle. The persistent volume preserves the remaining history across restarts.
- If metadata, forecast retrieval, or Telegram text delivery fails, the run is not marked processed and is retried on the next polling cycle.
- Telegram text delivery does not wait for TTS. Audio generation starts concurrently in a background thread.
- TTS generation and Telegram voice delivery each retry up to three times after failures. If audio still cannot be produced or sent, the text report remains delivered.
- Keep exactly one worker instance to avoid concurrent polling and duplicate notifications.
