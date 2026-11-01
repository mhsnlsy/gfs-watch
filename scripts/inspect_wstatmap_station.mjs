import { chromium } from "playwright";

const target = "https://wstatmap.com/tr/stations/eyupsultan-18101";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  locale: "tr-TR",
  timezoneId: "Europe/Istanbul",
  viewport: { width: 1440, height: 1000 },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
});
const requests = new Set();
page.on("request", request => {
  const url = request.url();
  if (/wstatmap\.com/i.test(url) && /api|station|observ|weather|data|json|graphql/i.test(url)) requests.add(url);
});
page.on("response", async response => {
  const url = response.url();
  if (/wstatmap\.com/i.test(url) && /api|station|observ|weather|data|json|graphql/i.test(url)) {
    console.log("[WSTAT RESPONSE]", response.status(), response.request().method(), url);
    const type = response.headers()["content-type"] || "";
    if (/json|text/i.test(type)) {
      try {
        const body = await response.text();
        console.log("[WSTAT BODY]", body.slice(0, 5000));
      } catch {}
    }
  }
});
try {
  const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 60000 });
  console.log("[PAGE STATUS]", response?.status(), "[FINAL URL]", page.url());
  await page.waitForTimeout(12000);
  console.log("[PAGE TITLE]", await page.title());
  console.log("[BODY TEXT]\n" + (await page.locator("body").innerText()).slice(0, 16000));
  console.log("[RELEVANT HTML]");
  const html = await page.locator("body").innerHTML();
  for (const term of ["°C", "°", "Nem", "Basınç", "Rüzgar", "Yağış", "Güncelleme", "Gözlem"]) {
    const at = html.toLocaleLowerCase("tr").indexOf(term.toLocaleLowerCase("tr"));
    if (at >= 0) console.log("TERM", term, html.slice(Math.max(0, at - 700), Math.min(html.length, at + 1500)));
  }
  console.log("[MATCHING REQUEST URLS]\n" + [...requests].join("\n"));
} catch (error) {
  console.error("[INSPECTION ERROR]", error?.stack || error);
  console.log("[PAGE URL]", page.url());
  try { console.log("[BODY TEXT]\n" + (await page.locator("body").innerText()).slice(0, 5000)); } catch {}
  process.exitCode = 1;
} finally {
  await browser.close();
}
