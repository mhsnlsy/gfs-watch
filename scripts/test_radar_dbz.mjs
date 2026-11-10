import assert from "node:assert/strict";
import { classifyDbz, estimateDbz, formatIntensityLine } from "../radar-worker/src/index.js";

function label(dbz) {
  return classifyDbz(dbz).label;
}

assert.equal(label(0.9), "");
assert.equal(label(1), "Çok hafif yağmur");
assert.equal(label(4.9), "Çok hafif yağmur");
assert.equal(label(5), "Hafif");
assert.equal(label(9.9), "Hafif");
assert.equal(label(10), "Orta");
assert.equal(label(19.9), "Orta");
assert.equal(label(20), "Güçlü");
assert.equal(label(30), "Çok güçlü");
assert.equal(label(39.9), "Çok güçlü");
assert.equal(label(40), "Çok çok güçlü");
assert.equal(label(49.9), "Çok çok güçlü");
assert.equal(label(50), "Dolu ihtimali");
assert.equal(label(62), "Dolu ihtimali");

assert.equal(formatIntensityLine(18), "Yağış şiddeti: Orta (≈18 dBZ)");
assert.equal(formatIntensityLine(4), "Yağış şiddeti: Çok hafif yağmur (≈4 dBZ)");
assert.equal(formatIntensityLine(50), "Yağış şiddeti: Dolu ihtimali (≈50 dBZ)");

// Universal Blue rain colors below 10 dBZ (alpha 78–140, above the alpha > 40 gate).
assert.equal(estimateDbz(133, 125, 106), 1);
assert.equal(estimateDbz(146, 136, 113), 5);
assert.equal(estimateDbz(194, 180, 130), 9);
assert.equal(estimateDbz(0, 163, 224), 20);
assert.equal(estimateDbz(193, 0, 0), 50);

console.log(JSON.stringify({ ok: true, below_10_dbz: estimateDbz(194, 180, 130) }));
