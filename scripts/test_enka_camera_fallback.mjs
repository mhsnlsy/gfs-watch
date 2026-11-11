import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  knotsToKmh,
  observationFromCameraReading,
  parseCameraOverlayText,
  recognizeCameraOverlay,
  shouldUseCameraFallback
} from "../station-worker/src/enka-camera.js";

assert.equal(knotsToKmh(1.7), 3.1);
assert.equal(knotsToKmh(0), 0);
assert.equal(knotsToKmh(10), 18.5);

assert.equal(shouldUseCameraFallback(null), true);
assert.equal(shouldUseCameraFallback({
  is_stale: true,
  status: "stale",
  temperature_2m_c: 11.2,
  observed_at_utc: "2026-11-10T22:55:00.000Z",
  age_minutes: 343
}), true);
assert.equal(shouldUseCameraFallback({
  is_stale: false,
  status: "live",
  temperature_2m_c: 12,
  observed_at_utc: "2026-11-11T04:30:00.000Z",
  age_minutes: 4
}), false);
assert.equal(shouldUseCameraFallback({
  is_stale: false,
  status: "live",
  temperature_2m_c: null,
  observed_at_utc: "2026-11-11T04:30:00.000Z",
  age_minutes: 2
}), true);

const parsed = parseCameraOverlayText(
  ["11.22S", "86?", "1019.3?9?", "1.7?SSW", "0.0 mm"],
  "11-11-202607:36:20"
);
assert.equal(parsed.temperature_c, 11.2);
assert.equal(parsed.humidity_percent, 86);
assert.equal(parsed.pressure_hpa, 1019.3);
assert.equal(parsed.wind_knots, 1.7);
assert.equal(parsed.wind_direction_cardinal, "SSW");
assert.equal(parsed.observed_at_utc, "2026-11-11T04:36:20.000Z");
assert.equal("precipitation_daily_mm" in parsed, false);

const observation = observationFromCameraReading(parsed, 20, Date.parse("2026-11-11T04:38:00.000Z"));
assert.equal(observation.observation_method, "enka-camera-overlay");
assert.equal(observation.source, "ENKA · OCR");
assert.equal(observation.is_stale, false);
assert.equal(observation.status, "live");
assert.equal(observation.wind_speed_10m_kmh, 3.1);
assert.equal(observation.temperature_2m_c, 11.2);
assert.equal(observation.precipitation_1h_mm, null);
assert.equal(observation.precipitation_daily_mm, null);
assert.equal(observation.precipitation_source, null);
assert.ok(observation.dew_point_c != null);
assert.ok(observation.feels_like_c != null);

const staleCamera = observationFromCameraReading(parsed, 20, Date.parse("2026-11-11T06:00:00.000Z"));
assert.equal(staleCamera.is_stale, true);

const jpeg = readFileSync(new URL("./fixtures/enka-camera-overlay.jpg", import.meta.url));
const recognized = recognizeCameraOverlay(jpeg);
assert.equal(recognized.temperature_c, 11.2);
assert.equal(recognized.humidity_percent, 86);
assert.equal(recognized.pressure_hpa, 1019.3);
assert.equal(recognized.wind_knots, 1.7);
assert.equal(recognized.wind_direction_cardinal, "SSW");
assert.equal(recognized.observed_at_utc, "2026-11-11T04:36:20.000Z");
assert.equal(recognized.precipitation_daily_mm, undefined);

console.log(JSON.stringify({
  ok: true,
  temperature_c: recognized.temperature_c,
  wind_kmh: knotsToKmh(recognized.wind_knots),
  observed_at_utc: recognized.observed_at_utc
}));
