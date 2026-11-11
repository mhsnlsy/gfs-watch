import assert from "node:assert/strict";
import {
  formatIstanbulClock,
  istanbulSky,
  moonPhase,
  sunriseOn,
  sunsetOn
} from "../site/istanbul-sky.js";

const rise = sunriseOn(2026, 11, 11);
const set = sunsetOn(2026, 11, 11);
assert.equal(formatIstanbulClock(rise), "07:46");
assert.equal(formatIstanbulClock(set), "17:49");
assert.ok(rise.getTime() < set.getTime());

const juneRise = sunriseOn(2026, 6, 21);
const juneSet = sunsetOn(2026, 6, 21);
const decemberRise = sunriseOn(2026, 12, 21);
const decemberSet = sunsetOn(2026, 12, 21);
assert.ok(juneSet - juneRise > decemberSet - decemberRise);

const morning = istanbulSky(new Date("2026-11-11T05:11:00.000Z"));
assert.equal(morning.night, false);
assert.equal(morning.text, "Gün doğumu 07:46 · Gün batımı 17:49");

const evening = istanbulSky(new Date("2026-11-11T18:00:00.000Z"));
assert.equal(evening.night, true);
assert.equal(evening.sunrise_label, "07:48");
assert.equal(evening.sunset_label, "17:49");

const afterMidnight = istanbulSky(new Date("2026-11-11T22:30:00.000Z"));
assert.equal(afterMidnight.night, true);
assert.equal(afterMidnight.sunrise_label, "07:48");
assert.equal(afterMidnight.sunset_label, "17:49");

assert.equal(moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14, 0))).name, "Yeni ay");
const synodic = 29.530588853;
const epoch = Date.UTC(2000, 0, 6, 18, 14, 0);
assert.equal(moonPhase(new Date(epoch + synodic / 8 * 86400000)).name, "Hilal");
assert.equal(moonPhase(new Date(epoch + synodic / 4 * 86400000)).name, "İlk dördün");
assert.equal(moonPhase(new Date(epoch + synodic / 2 * 86400000)).name, "Dolunay");
assert.equal(moonPhase(new Date(epoch + synodic * 5 / 8 * 86400000)).name, "Küçülen şişkin ay");
assert.equal(moonPhase(new Date(epoch + synodic * 3 / 4 * 86400000)).name, "Son dördün");
assert.equal(moonPhase(new Date(epoch + synodic * 7 / 8 * 86400000)).name, "Küçülen hilal");
assert.notEqual(moonPhase(new Date(epoch + synodic / 8 * 86400000)).name, moonPhase(new Date(epoch + synodic * 7 / 8 * 86400000)).name);

console.log(JSON.stringify({
  ok: true,
  sunrise: morning.sunrise_label,
  sunset: morning.sunset_label,
  moon: morning.moon.name,
  night: morning.night
}));
