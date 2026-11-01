import { chromium, request } from "playwright";

const target = "https://wstatmap.com/tr/stations/eyupsultan-18101";
const apiBase = "https://api.wstatmap.com";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "tr-TR",
  timezoneId: "Europe/Istanbul",
  viewport: { width: 1440, height: 1000 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
});
try {
  const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(8000);
  console.log("[PAGE STATUS]", response?.status(), "[TITLE]", await page.title());
  console.log("[BODY TEXT]\n" + (await page.locator("body").innerText()).slice(0, 10000));

  const ctx = await request.newContext({
    extraHTTPHeaders: {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Accept": "application/json, text/plain, */*",
      "Origin": "https://wstatmap.com",
      "Referer": target
    }
  });
  for (const [label, url] of [
    ["POINT", apiBase + "/v1/forecast/point/?lat=41.1028&lon=28.9242&past_hours=12&station_id=1963"],
    ["HISTORY", apiBase + "/v1/historical/station/data?station_id=1963&hours=24"]
  ]) {
    try {
      const res = await ctx.get(url, { timeout: 30000 });
      const body = await res.text();
      console.log("[DIRECT API]", label, res.status(), res.headers()["content-type"], body.slice(0, 12000));
    } catch (error) {
      console.log("[DIRECT API ERROR]", label, error?.message || error);
    }
  }
  await ctx.dispose();
} catch (error) {
  console.error("[INSPECTION ERROR]", error?.stack || error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
