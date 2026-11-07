"""Regression tests for the split Cloudflare-stations / GitHub-GFS architecture."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    workflows = ROOT / ".github" / "workflows"
    publisher = (workflows / "publish-live-site.yml").read_text(encoding="utf-8")
    gfs_workflow_path = workflows / "istanbul-gfs-10min.yml"
    gfs_workflow = gfs_workflow_path.read_text(encoding="utf-8")

    # Pages remains a single publisher and consumes the isolated GFS data branch.
    assert "group: live-pages-publisher" in publisher
    assert "cancel-in-progress: false" in publisher
    assert "actions/deploy-pages@v4" in publisher
    assert "istanbul-gfs-data" in publisher
    assert "koy-gfs-data" in publisher
    assert "koy-mgm-data" in publisher

    # Istanbul GFS is a dedicated ten-minute state machine: F72 cache first,
    # F180 report second, with Pages and Telegram in independent jobs.
    assert 'cron: "*/10 * * * *"' in gfs_workflow
    assert "branches: [main]" in gfs_workflow
    assert "${GITHUB_WORKSPACE}/gfs/" in gfs_workflow
    assert "\\${GITHUB_WORKSPACE}" not in gfs_workflow
    assert "scripts/poll_istanbul_gfs_10min.py" in gfs_workflow
    assert "steps.poll.outputs.f180_ready == 'true'" in gfs_workflow
    assert "F72" in gfs_workflow and "F180" in gfs_workflow
    assert "Persist F72 cache and any F180 canonical run" in gfs_workflow
    assert "Build the report from the newly archived F180 run" in gfs_workflow
    assert "publish-live-site.yml" in gfs_workflow
    assert "uses: ./.github/workflows/publish-live-site.yml" in gfs_workflow
    assert "telegram:" in gfs_workflow
    assert "scripts/send_pending_istanbul_gfs_telegram.py" in gfs_workflow
    assert "TELEGRAM_TOKEN" in gfs_workflow and "CHAT_ID" in gfs_workflow
    assert "cancel-in-progress: false" in gfs_workflow

    collector = (ROOT / "scripts" / "poll_istanbul_gfs_10min.py").read_text(encoding="utf-8")
    builder = (ROOT / "scripts" / "build_istanbul_gfs_publication.py").read_text(encoding="utf-8")
    sender = (ROOT / "scripts" / "send_pending_istanbul_gfs_telegram.py").read_text(encoding="utf-8")
    assert "fetch_cycle" in collector and "normalize" in collector
    assert "f72_path" in collector and "run_path" in collector
    assert "not f180_ready" in collector
    assert "has_publication" in collector
    assert "F180 ready for report retry" in collector
    assert "GFS_TARGET_RUN_ID" in builder
    assert "Older delayed cycle" in builder
    assert "existing_run > utc_dt(current_run)" in builder
    assert "create_valid_time_comparison_assets" in builder
    assert "save_public_notification_svg_image" in builder
    assert "telegram_image_path" in builder
    assert "telegram-sent" in sender
    assert "text_message_id" in sender and "photo_message_id" in sender
    assert "send_photo" in sender
    assert "for item in items" in sender

    # Cloudflare is limited to station collection and the optional push API.
    station_deploy = (workflows / "deploy-stations-worker.yml").read_text(encoding="utf-8")
    assert "station-worker/**" in station_deploy
    push_config = json.loads((ROOT / "push-worker" / "wrangler.jsonc").read_text(encoding="utf-8"))
    assert push_config.get("triggers", {}).get("crons") == []
    assert not (workflows / "deploy-istanbul-gfs-cloudflare.yml").exists()
    assert not (ROOT / "workers" / "istanbul-gfs").exists()

    # The frontend now reads GFS JSON and notifications from static Pages files.
    api_config = (ROOT / "site" / "gfs-api-config.js").read_text(encoding="utf-8")
    index = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    table = (ROOT / "site" / "meteopt-gfs-table.js").read_text(encoding="utf-8")
    assert 'ISTANBUL_GFS_API_BASE = "";' in api_config
    assert 'const DATA_URL="./data/istanbul-gfs-latest.json";' in index
    assert 'const DATA_URL = "./data/istanbul-gfs-latest.json";' in table

    print(
        "[GFS/STATION ARCHITECTURE SMOKE] "
        "Cloudflare owns stations; GitHub Actions owns a 10-minute F72-cache/F180-publication GFS state machine, with independent Telegram delivery and Pages deployment."
    )


if __name__ == "__main__":
    main()
