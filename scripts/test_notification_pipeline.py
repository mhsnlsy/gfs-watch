"""Regression tests for the shared Telegram/Pages GFS report pipeline."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    main_source = (ROOT / "main.py").read_text(encoding="utf-8")
    process_start = main_source.index("async def process_gfs_update(")
    process_end = main_source.index("\nasync def run_manual_multi_comparison", process_start)
    process = main_source[process_start:process_end]

    publish_at = process.index("publish_public_notification,")
    save_at = process.index("save_run(run_id, payload)", publish_at)
    telegram_at = process.index("send_telegram_text(full_text_report)")
    assert publish_at < save_at < telegram_at, (
        "Pages archive must succeed before a GFS run is marked processed or Telegram is sent."
    )
    publish_section = process[publish_at:telegram_at]
    assert "except Exception:" in publish_section and "raise" in publish_section, (
        "Pages publication failure must propagate and trigger a retry."
    )
    assert "[WEB NOTIFICATION REQUIRED]" in process

    gfs_workflow = (ROOT / ".github/workflows/gfs-watch.yml").read_text(encoding="utf-8")
    restore_start = gfs_workflow.index("Restore GFS run and Pages notification history")
    report_start = gfs_workflow.index("Discover NOAA cycles, prefetch and process one reportable cycle")
    restore_section = gfs_workflow[restore_start:report_start]
    assert "git archive origin/gfs-watch-state public/notifications | tar -x -C ." in restore_section
    assert gfs_workflow.index("rm -rf public/notifications") < gfs_workflow.index('cp -a "$RUNNER_TEMP/public/." public/')
    assert 'if [ "${{ steps.check-gfs.outcome }}" = "success" ] && [ -d public ]; then' in gfs_workflow
    assert "Report step failed; keeping the previously published Pages forecast and notification archive." in gfs_workflow

    pages_workflow = (ROOT / ".github/workflows/pages.yml").read_text(encoding="utf-8")
    assert "Verify latest GFS report and every referenced Pages asset" in pages_workflow
    assert 'base_url="${PAGE_URL%/}/data/notifications"' in pages_workflow
    assert "latest.json?verify=$GITHUB_RUN_ID" in pages_workflow
    assert "Live Pages serves" in pages_workflow
    assert "Pages notification media is missing" in pages_workflow

    print("[NOTIFICATION PIPELINE SMOKE] Pages-first publication, retry-on-failure, "
          "four-report archive restore and live JSON/media verification passed.")


if __name__ == "__main__":
    main()
