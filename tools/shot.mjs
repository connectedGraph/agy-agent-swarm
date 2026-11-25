// 截图工具：node tools/shot.mjs <url> <out.png> [width] [height] [waitMs]
import { chromium } from "playwright-core";

const [url, out, w = "1440", h = "900", wait = "1200"] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
await browser.close();
console.log("saved", out);
