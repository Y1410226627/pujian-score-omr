// 生成 OMR 性能测试用的「图片型低清 PDF」夹具：第 1 步，把真实 MusicXML
// 用创作室（composer.html，VexFlow）渲染成整幅谱面 PNG。
//
// 为什么不把 SVG 序列化后当图片画：VexFlow 的符头/谱号是 SVG 文本 + 音乐字体
// （Bravura），序列化成独立 SVG 图片后字体不可用，会变成空心方框。
// 改用 Playwright 把活页面里的 SVG 复制到一个不被滚动容器裁剪的全屏容器里，
// 再对该容器截图 —— 字体由页面 CSS 提供，渲染才正确。
//
// 用法：
//   $env:PLAYWRIGHT_CORE='E:\识谱弹琴\.cache\e2e\node_modules\playwright-core';
//   $env:APP_URL='http://127.0.0.1:4492/';
//   node tools/make_import_fixture.mjs [--xml tests/fixtures/call-of-silence-p1.musicxml]
//                                      [--out .cache/perf/score-render.png]
//                                      [--width 1400] [--scale 2]
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

function arg(name, fallback) {
  const index = process.argv.indexOf("--" + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = arg("xml", "tests/fixtures/call-of-silence-p1.musicxml");
const OUT = arg("out", ".cache/perf/score-render.png");
const WIDTH = Number(arg("width", "1400"));
const SCALE = Number(arg("scale", "2"));

const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH + 200, height: 1200 },
    deviceScaleFactor: SCALE,
  });
  page.on("pageerror", (error) => console.log("pageerror:", error.message));
  await page.goto(APP + "composer.html?debug=1", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  const xml = readFileSync(resolve(XML), "utf8");
  await page.setInputFiles("#musicXmlInput", {
    name: "fixture.musicxml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml, "utf8"),
  });
  await page.waitForSelector("#scoreEditor svg", { timeout: 60000 });
  await page.waitForTimeout(2500);

  const box = await page.evaluate(() => {
    const svg = document.querySelector("#scoreEditor svg");
    const rect = svg.getBoundingClientRect();
    const holder = document.createElement("div");
    holder.id = "perf-shot";
    holder.style.cssText =
      `position:absolute;left:0;top:0;z-index:2147483647;background:#fff;overflow:visible;` +
      `width:${Math.ceil(rect.width)}px;height:${Math.ceil(rect.height)}px;`;
    const clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    holder.appendChild(clone);
    document.body.appendChild(holder);
    // 把提示条之类遮挡物关掉
    document.querySelectorAll("#toast, .toast").forEach((node) => { node.style.display = "none"; });
    window.scrollTo(0, 0);
    return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  });
  console.log("svg size:", JSON.stringify(box));

  const holder = await page.$("#perf-shot");
  await holder.screenshot({ path: resolve(OUT) });
  const bytes = readFileSync(resolve(OUT));
  console.log("saved", resolve(OUT), "bytes", bytes.length);
} finally {
  await browser.close();
}
