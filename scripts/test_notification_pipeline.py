"""Regression tests for the split Cloudflare-stations / GitHub-GFS architecture."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    workflows = ROOT / ".github" / "workflows"
    publisher = (workflows / "publish-live-site.yml").read_text(encoding="utf-8")
    gfs_workflow_path = workflows / "istanbul-gfs-github.yml"
    gfs_workflow = gfs_workflow_path.read_text(encoding="utf-8")

    # Pages remains a single publisher and consumes the isolated GFS data branch.
    assert "group: live-pages-publisher" in publisher
    assert "cancel-in-progress: false" in publisher
    assert "actions/deploy-pages@v4" in publisher
    assert "istanbul-gfs-data" in publisher
    assert "koy-gfs-data" in publisher
    assert "koy-mgm-data" in publisher

    # Istanbul GFS polls every 5 minutes so publication is driven by F180
    # availability rather than a fixed four-times-daily publication window.
    assert 'cron: "*/5 * * * *"' in gfs_workflow
    assert "steps.fetch.outputs.publish == 'true'" in gfs_workflow
    assert "steps.fetch.outputs.f72_publish == 'true'" in gfs_workflow
    assert "F72" in gfs_workflow and "F180" in gfs_workflow
    assert "scripts/fetch_istanbul_gfs_meteopt.py" in gfs_workflow
    assert "scripts/build_istanbul_gfs_publication.py" in gfs_workflow
    assert "scripts/send_canonical_istanbul_gfs_telegram.py" in gfs_workflow
    assert "gh workflow run publish-live-site.yml" in gfs_workflow
    assert "TELEGRAM_TOKEN" in gfs_workflow and "CHAT_ID" in gfs_workflow

    collector = (ROOT / "scripts" / "fetch_istanbul_gfs_meteopt.py").read_text(encoding="utf-8")
    builder = (ROOT / "scripts" / "build_istanbul_gfs_publication.py").read_text(encoding="utf-8")
    sender = (ROOT / "scripts" / "send_canonical_istanbul_gfs_telegram.py").read_text(encoding="utf-8")
    assert "180 not in steps" in collector or "require_f180" in collector
    assert "f72_marker" in collector
    assert "f72_publish" in collector
    assert 'series["wind10mdir"]' in collector or 'values_for(document, key)' in collector
    assert "latest = dict(current_doc)" in builder
    assert 'latest["comparison_runs"] = list(reversed(docs))' in builder
    assert "telegram-sent" in sender
    assert "send_media_group" in sender

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
        "Cloudflare owns stations; GitHub Actions owns 5-minute F180-driven GFS publication, PNGs, Telegram and Pages."
    )


if __name__ == "__main__":
    main()
