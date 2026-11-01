import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = (process.env.PAGES_URL || "https://mhsnlsy.github.io/gfs-watch/").replace(/\/?$/, "/");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    locale: "tr-TR",
    timezoneId: "Europe/Istanbul",
    viewport: { width: 1440, height: 1000 }
  });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  const response = await page.goto(baseUrl + "?station-history-smoke-test=" + Date.now(), {
    waitUntil: "domcontentloaded",
    timeout: 60000
  });
  assert.ok(response && response.status() === 200, "GitHub Pages dashboard must load successfully.");
  await page.waitForSelector("#station-eyupsultan-button", { timeout: 30000 });
  await page.waitForFunction(() => {
    const temperatureMeta = document.querySelector("#station-trend-meta")?.textContent || "";
    const rainMeta = document.querySelector("#station-rain-meta")?.textContent || "";
    return temperatureMeta.includes("ENKA Balmumcu") && rainMeta.includes("ENKA Balmumcu");
  }, { timeout: 30000 });

  const panel = page.locator("#station-history-panel");
  await page.locator("#station-eyupsultan-button").click();
  await page.waitForFunction(() => {
    const source = document.querySelector("#history-station-source")?.textContent || "";
    const temperatureMeta = document.querySelector("#station-trend-meta")?.textContent || "";
    const rainMeta = document.querySelector("#station-rain-meta")?.textContent || "";
    return source.includes("EYÜPSULTAN")
      && temperatureMeta.includes("Eyüpsultan")
      && rainMeta.includes("Eyüpsultan");
  }, { timeout: 10000 });

  assert.equal(await page.locator("#station-card-title").textContent(), "Eyüpsultan · İstanbul");
  assert.equal(await panel.getAttribute("aria-label"), "Eyüpsultan son 24 saat geçmişi");
  const eyupsultanPanelText = await panel.innerText();
  assert.ok(eyupsultanPanelText.includes("Eyüpsultan"), "Eyüpsultan source must be visible in the history panel.");
  assert.ok(!eyupsultanPanelText.includes("ENKA"), "ENKA history labels must not leak into Eyüpsultan mode.");
  const eyupsultanTemp = await page.locator("#station-temperature-trend").innerHTML();
  const eyupsultanRain = await page.locator("#station-rain-trend").innerHTML();
  assert.ok(/Eyüpsultan/.test(eyupsultanTemp), "Temperature graph or its empty state must identify Eyüpsultan.");
  assert.ok(/Eyüpsultan/.test(eyupsultanRain), "Rain graph or its empty state must identify Eyüpsultan.");

  await page.locator("#station-enka-button").click();
  await page.waitForFunction(() => {
    const source = document.querySelector("#history-station-source")?.textContent || "";
    const temperatureMeta = document.querySelector("#station-trend-meta")?.textContent || "";
    const rainMeta = document.querySelector("#station-rain-meta")?.textContent || "";
    return source.includes("ENKA BALMUMCU")
      && temperatureMeta.includes("ENKA Balmumcu")
      && rainMeta.includes("ENKA Balmumcu");
  }, { timeout: 10000 });

  assert.equal(await page.locator("#station-card-title").textContent(), "ENKA Balmumcu · İstanbul");
  assert.equal(await panel.getAttribute("aria-label"), "ENKA Balmumcu son 24 saat geçmişi");
  const enkaPanelText = await panel.innerText();
  assert.ok(enkaPanelText.includes("ENKA Balmumcu"), "ENKA source must be visible when selected.");
  assert.ok(!enkaPanelText.includes("Eyüpsultan"), "Eyüpsultan history labels must not leak into ENKA mode.");

  assert.deepEqual(errors, [], "Dashboard should not raise browser JavaScript errors while switching stations.");
  console.log("Live Pages station history e2e passed: ENKA → Eyüpsultan → ENKA; both history graphs switch sources.");
} finally {
  await browser.close();
}
