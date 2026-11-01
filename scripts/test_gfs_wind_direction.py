"""Fast unit tests for GFS wind-direction math and JSON backfill."""
from __future__ import annotations

from backfill_gfs_wind_direction import (
    apply_direction_values,
    wind_direction_from_uv,
)


def main() -> None:
    # Meteorological "from" direction, clockwise from north.
    assert wind_direction_from_uv(0.0, -1.0) == 0.0
    assert wind_direction_from_uv(-1.0, 0.0) == 90.0
    assert wind_direction_from_uv(0.0, 1.0) == 180.0
    assert wind_direction_from_uv(1.0, 0.0) == 270.0
    assert wind_direction_from_uv(0.0, 0.0) is None

    forecast = [
        {"forecast_hour": 0, "wind_direction_10m_deg": None},
        {"forecast_hour": 3, "wind_direction_10m_deg": None},
        {"forecast_hour": 72, "wind_direction_10m_deg": None},
        {"forecast_hour": 75, "wind_direction_10m_deg": None},
    ]
    changed = apply_direction_values(
        {"forecast_6_hourly": forecast},
        {0: 0.0, 3: 90.0, 72: 180.0},
    )
    assert changed == 3
    assert [point["wind_direction_10m_deg"] for point in forecast] == [
        0.0, 90.0, 180.0, None
    ]

    print("[GFS WIND DIRECTION] U/V bearing, calm-wind handling and 72h JSON patch passed.")


if __name__ == "__main__":
    main()
