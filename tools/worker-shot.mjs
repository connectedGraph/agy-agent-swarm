// 子代理专用截图工具。由编排器通过 SWARM_SHOT_JS 注入路径。
// 用法: node "$SWARM_SHOT_JS" <url> <out.png> [width] [height]
const url = process.argv[2];
const out = process.argv[3];
const width = Number(process.argv[4] || 1440);
const height = Number(process.argv[5] || 900);
if (!url || !out) {
  console.error("usage: node worker-shot.mjs <url> <out.png> [width] [height]");
  process.exit(2);
}

const core = process.env.SWARM_PLAYWRIGHT_CORE;
if (!core) {
  console.error("SWARM_PLAYWRIGHT_CORE 未设置");
  process.exit(3);
}
const mod = await import(core);
const chromium = mod.chromium || mod.default?.chromium;
if (!chromium) {
  console.error("playwright-core 加载失败");
  process.exit(3);
}

const exe =
  process.env.SWARM_CHROME_PATH ||
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

const browser = await chromium.launch({
  executablePath: exe,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});
try {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: out });
  console.log(`screenshot saved: ${out}`);
} finally {
  await browser.close();
}
