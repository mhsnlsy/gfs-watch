"""Regression tests for the single-publisher live data architecture."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    workflows = ROOT / ".github/workflows"
    publisher = (workflows / "publish-live-site.yml").read_text(encoding="utf-8")

    assert 'cron: "*/5 * * * *"' in publisher
    assert "group: live-pages-publisher" in publisher
    assert "cancel-in-progress: false" in publisher
    assert "actions/deploy-pages@v4" in publisher
    assert "gfs-watch-state" in publisher
    assert "koy-gfs-data" in publisher
    assert "koy-mgm-data" in publisher

    collector_workflows = (
        "meteopt-gfs-live.yml",
        "main-station-refresh.yml",
        "eyupsultan-mgm-refresh.yml",
        "sisli-mgm-refresh.yml",
    )
    for name in collector_workflows:
        source = (workflows / name).read_text(encoding="utf-8")
        assert "pages-live.yml" not in source, f"{name} still deploys Pages directly."
        assert "deploy-pages:" not in source, f"{name} still has a direct Pages deploy job."
        assert "deploy-live-site:" not in source, f"{name} still has a direct Pages deploy job."

    source = (workflows / "ecmwf-eps.yml").read_text(encoding="utf-8")
    assert "gh workflow run pages.yml" not in source, "ecmwf-eps.yml still dispatches Pages directly."
    assert not (workflows / "render-pages-charts-from-saved-data.yml").exists()

    assert not (workflows / "pages-live.yml").exists()

    print(
        "[LIVE PUBLISH ARCHITECTURE SMOKE] "
        "Collectors are decoupled from Pages and one central five-minute publisher owns deployment."
    )


if __name__ == "__main__":
    main()
