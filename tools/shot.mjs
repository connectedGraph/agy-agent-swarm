// 控制台截图：node tools/shot.mjs <url> <out.png> [theme] [taskIndex] [width] [height] [waitMs]
// theme: light | dark
// 截图前把本机绝对路径替换成中性路径，避免把个人目录带进公开图片。
import { chromium } from "playwright-core";

const [url, out, theme = "light", taskIndex = "0", w = "1440", h = "900", wait = "1400", scroll = "0"] =
  process.argv.slice(2);

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
});

const ctx = await browser.newContext({
  viewport: { width: Number(w), height: Number(h) },
  deviceScaleFactor: 2,
});
await ctx.addInitScript((t) => {
  try {
    localStorage.setItem("swarm-theme", t);
  } catch {}
}, theme);

const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(Number(wait));

// 选中指定任务
const items = page.locator(".console-left button");
if ((await items.count()) > Number(taskIndex)) {
  await items.nth(Number(taskIndex)).click();
  await page.waitForTimeout(700);
}

// 向下滚动舞台，截取下半部分
if (Number(scroll) > 0) {
  await page.evaluate((y) => {
    const main = document.querySelector("main");
    if (main) main.scrollTop = y;
  }, Number(scroll));
  await page.waitForTimeout(500);
}

// 路径中性化
await page.evaluate(() => {
  const walk = (root) => {
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = it.nextNode())) {
      if (!n.nodeValue) continue;
      n.nodeValue = n.nodeValue
        .replace(/\/home\/rap\/0_workspace\/02_projects\/agent-swarm/g, "/srv/agent-swarm")
        .replace(/\/home\/rap\/scratch\/[^\s"']+/g, "/srv/demo")
        .replace(/\/home\/rap/g, "/home/user");
    }
  };
  walk(document.body);
  for (const el of document.querySelectorAll("[title]")) {
    el.title = el.title
      .replace(/\/home\/rap\/0_workspace\/02_projects\/agent-swarm/g, "/srv/agent-swarm")
      .replace(/\/home\/rap\/scratch\/[^\s"']+/g, "/srv/demo")
      .replace(/\/home\/rap/g, "/home/user");
  }
});

await page.screenshot({ path: out });
await browser.close();
console.log("saved", out, theme);
