import assert from "node:assert/strict";
import { tomorrowLocalWind, windSector } from "../shared/tomorrow-local-wind.js";

assert.equal(windSector(180), "lodos");
assert.equal(windSector(220), "lodos");
assert.equal(windSector(157.5), "lodos");
assert.equal(windSector(247.5), "other");
assert.equal(windSector(315), "karayel");
assert.equal(windSector(292.5), "karayel");
assert.equal(windSector(337.5), "other");
assert.equal(windSector(45), "poyraz");
assert.equal(windSector(22.5), "poyraz");
assert.equal(windSector(67.5), "other");
assert.equal(windSector(0), "other");
assert.equal(windSector(90), "other");
assert.equal(windSector(270), "other");
assert.equal(windSector(-90), "other");

assert.equal(tomorrowLocalWind([{ speed: 10, direction: 180 }]), null);
assert.equal(tomorrowLocalWind([{ speed: 10.1, direction: 180 }]).phrase, "lodos etkili");
assert.equal(tomorrowLocalWind([{ speed: 15, direction: 220 }]).phrase, "lodos etkili");
assert.equal(tomorrowLocalWind([{ speed: 15, direction: 310 }]).phrase, "karayel etkili");
assert.equal(tomorrowLocalWind([{ speed: 15, direction: 40 }]).phrase, "poyraz etkili");
assert.equal(tomorrowLocalWind([{ speed: 20, direction: 90 }]), null);
assert.equal(tomorrowLocalWind([{ speed: 20, direction: 0 }]), null);
assert.equal(tomorrowLocalWind([{ speed: 30, direction: null }]), null);

const westDominates = [
  ...Array.from({ length: 6 }, () => ({ speed: 15, direction: 270 })),
  ...Array.from({ length: 2 }, () => ({ speed: 12, direction: 220 }))
];
assert.equal(tomorrowLocalWind(westDominates), null);

const southAndSouthwest = [
  { speed: 12, direction: 190 },
  { speed: 14, direction: 200 },
  { speed: 16, direction: 230 },
  { speed: 11, direction: 210 },
  { speed: 18, direction: 80 }
];
const lodos = tomorrowLocalWind(southAndSouthwest);
assert.equal(lodos.phrase, "lodos etkili");
assert.equal(lodos.hours, 4);
assert.equal(lodos.direction_deg, 230);

const tied = [
  { speed: 12, direction: 180 },
  { speed: 18, direction: 200 },
  { speed: 12, direction: 270 },
  { speed: 18, direction: 280 }
];
assert.equal(tomorrowLocalWind(tied), null);

console.log(JSON.stringify({ ok: true }));
