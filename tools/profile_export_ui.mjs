// 大谱导出端到端：等下载完成并读 state.lastExportStats + 控制台。
// 用法：$env:PLAYWRIGHT_CORE='...'; node tools/profile_export_ui.mjs
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const XML = process.env.XML || "E:/识谱弹琴/.cache/perf/big-4v-160m.musicxml";
if (!existsSync(XML)) throw new Error("缺夹具 " + XML);

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const logs = [];
page.on("console", (message) => logs.push(message.type() + ": " + message.text()));
page.on("pageerror", (error) => logs.push("pageerror: " + error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.setInputFiles("#fileInput", XML);
await page.waitForFunction(() => window.__pujian && window.__pujian.state.notes.length > 0, null, { timeout: 300000 });
await page.waitForTimeout(5000);

const started = Date.now();
const downloadPromise = page.waitForEvent("download", { timeout: 1200000 });
await page.click("#audioButton");
const download = await downloadPromise;
const wallMs = Date.now() - started;
const target = process.env.TEMP ? `${process.env.TEMP}\\profile-export-ui.mp3` : "profile-export-ui.mp3";
await download.saveAs(target);
const stats = await page.evaluate(() => window.__pujian.state.lastExportStats || null);
console.log(JSON.stringify({
  wallMs,
  fileKB: Math.round(readFileSync(target).length / 1024),
  stats,
  exportLogs: logs.filter((line) => line.includes("导出计时") || line.includes("编码") || line.includes("wasm")),
}, null, 1));
await browser.close();
