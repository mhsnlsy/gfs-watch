# GFS Watch

An Istanbul-focused GFS forecast watcher. It polls Open-Meteo model metadata every 10 minutes and sends a Telegram text report as soon as a new GFS run is detected. Google Cloud Text-to-Speech runs concurrently; the voice message is sent when audio generation finishes.

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

   `GCP_SA_KEY` is the service-account JSON as a single-line JSON string. If it is absent, text alerts still work and voice generation is skipped.

3. Deploy and ensure exactly one worker:

   ```bash
   fly deploy
   fly scale count 1 --process-group worker
   fly logs
   ```

4. Optional configuration:
   - `POLL_INTERVAL_SECONDS`: defaults to `600` (10 minutes).
   - `DB_PATH`: defaults to `/data/gfs_watch.db` on Fly and `./gfs_watch.db` locally.

SQLite state is stored on the mounted volume so processed model run IDs survive restarts. Keep one worker instance to avoid duplicate polling and notifications.

## Notification behaviour

- The run ID comes from Open-Meteo's `last_run_initialisation_time`, not the local clock.
- If metadata, forecast retrieval, or Telegram text delivery fails, the run is not marked processed and is retried on the next polling cycle.
- Telegram text is sent without waiting for TTS. TTS starts in a background thread and the voice message follows when ready.
- If TTS or voice delivery fails, the text report remains delivered; audio is not automatically retried.
