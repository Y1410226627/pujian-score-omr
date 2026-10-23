// 导入（OMR 上传识别）端到端分阶段测速。
//
// 测量对象：工作台 index.html 的两条导入路径
//   · 整本识别「识别全部 N 页」 → app.js recognizeAllPages（一次性整页上传）
//   · 单页识别「识别乐谱」     → app.js recognizeScore（单页 Audiveris）
//
// 做法：在页面里 patch 掉所有能观测的耗时点（canvas.toBlob / getImageData /
// 带 filter 的 drawImage / FileReader / fetch / Response.json / JSON.stringify），
// 并用 MutationObserver 记录进度条文案时间线；再用 CDP Profiler 抓 CPU 采样，
// 用来把「渲染 / 锐化 / 建音符模型 / renderNotes」等纯 CPU 段归类。
//
// 用法：
//   $env:PLAYWRIGHT_CORE='E:\识谱弹琴\.cache\e2e\node_modules\playwright-core';
//   $env:APP_URL='http://127.0.0.1:4492/';
//   node tools/profile_import_speed.mjs --mode=all --fixture=.cache/perf/import-8p-lowres.pdf
//        [--out=.cache/perf/baseline.json] [--timeout=300000]
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);

function arg(name, fallback) {
  const eqPrefix = "--" + name + "=";
  const eqArg = process.argv.find((value) => value.startsWith(eqPrefix));
  if (eqArg) return eqArg.slice(eqPrefix.length);
  const index = process.argv.indexOf("--" + name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const APP = process.env.APP_URL || "http://127.0.0.1:4492/";
const MODE = arg("mode", "all");           // all | batch | single
const PAGE_PATH = arg("page", "");         // 例如 index-baseline.html（测冻结的旧版本）
const FIXTURE = resolve(arg("fixture", ".cache/perf/import-8p-lowres.pdf"));
const OUT = resolve(arg("out", ".cache/perf/profile.json"));
const TIMEOUT = Number(arg("timeout", "420000"));
const PAGE_URL = APP + PAGE_PATH + (PAGE_PATH.includes("?") ? "&" : "?") + "debug=1";
console.log("页面:", PAGE_URL, " 夹具:", FIXTURE);

const appHash = createHash("md5").update(readFileSync("app.js")).digest("hex").slice(0, 12);
const serveHash = createHash("md5").update(readFileSync("serve.py")).digest("hex").slice(0, 12);

// —— 页面内探针（在页面任何脚本之前注入）——
function installProbes() {
  const perf = { events: [], timeline: [], counts: {} };
  window.__perf = perf;
  window.__perfRecord = (kind, ms, extra) => {
    perf.events.push(Object.assign({ kind, ms: Math.round(ms * 10) / 10, t: Math.round(performance.now()) }, extra || {}));
  };
  window.__perfMark = (name) => {
    perf.timeline.push({ t: Math.round(performance.now()), label: "[mark] " + name });
    perf.events.push({ kind: "mark", name, t: Math.round(performance.now()) });
  };

  const record = (kind, start, extra) => {
    try { window.__perfRecord(kind, performance.now() - start, extra); } catch { /* ignore */ }
  };

  // canvas.toBlob：PNG/JPEG 编码耗时 + 产出体积
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
    const start = performance.now();
    const width = this.width, height = this.height;
    return origToBlob.call(this, (blob) => {
      record("canvasToBlob", start, { type: type || "", width, height, bytes: blob ? blob.size : 0 });
      callback(blob);
    }, type, quality);
  };

  // toDataURL
  const origToDataUrl = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    const start = performance.now();
    const result = origToDataUrl.apply(this, args);
    record("canvasToDataURL", start, { type: args[0] || "", bytes: result.length });
    return result;
  };

  // getImageData / putImageData：锐化里两次整页像素读写
  const origGet = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function (...args) {
    const start = performance.now();
    const result = origGet.apply(this, args);
    record("getImageData", start, { pixels: result.width * result.height });
    return result;
  };
  const origPut = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function (...args) {
    const start = performance.now();
    const result = origPut.apply(this, args);
    record("putImageData", start, { pixels: args[0] ? args[0].width * args[0].height : 0 });
    return result;
  };
  // 带 filter 的 drawImage（sharpenCanvas 里的 blur 通道）
  const origDrawImage = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    const filtered = this.filter && this.filter !== "none";
    if (!filtered) return origDrawImage.apply(this, args);
    const start = performance.now();
    const result = origDrawImage.apply(this, args);
    record("blurDrawImage", start, { filter: this.filter, width: this.canvas.width, height: this.canvas.height });
    return result;
  };

  // FileReader.readAsDataURL：blob → base64
  const origRead = FileReader.prototype.readAsDataURL;
  FileReader.prototype.readAsDataURL = function (blob) {
    const start = performance.now();
    const bytes = blob && blob.size;
    this.addEventListener("load", () => record("fileReaderBase64", start, { bytes, outBytes: String(this.result || "").length }));
    return origRead.call(this, blob);
  };

  // JSON.stringify（>100KB 才算，避免把歌词之类的小对象也记录）
  const origStringify = JSON.stringify;
  JSON.stringify = function (...args) {
    const start = performance.now();
    const result = origStringify.apply(this, args);
    const length = typeof result === "string" ? result.length : 0;
    if (length > 100000) record("jsonStringify", start, { chars: length });
    return result;
  };

  // fetch：记录到响应头的时间，并包一层 body 读取计时
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const shortUrl = url.split("?")[0];
    const start = performance.now();
    const promise = origFetch.apply(this, arguments);
    if (!/\/api\//.test(shortUrl)) return promise;
    return promise.then((response) => {
      record("fetchHeaders", start, { url: shortUrl, status: response.status });
      for (const method of ["json", "text", "arrayBuffer"]) {
        const original = response[method];
        if (typeof original !== "function") continue;
        try {
          response[method] = function (...bodyArgs) {
            const bodyStart = performance.now();
            const bodyPromise = original.apply(this, bodyArgs);
            if (bodyPromise && typeof bodyPromise.then === "function") {
              bodyPromise.then((value) => {
                record("responseBody", bodyStart, { url: shortUrl, method });
                if (/recognize-batch/.test(shortUrl) && value && Array.isArray(value.pages)) {
                  record("batchMeta", 0, {
                    workers: value.workers,
                    elapsedMs: value.elapsedMs,
                    pages: value.pages.length,
                    okPages: value.pages.filter((item) => item && item.musicxml).length,
                  });
                }
              },
                () => record("responseBodyError", bodyStart, { url: shortUrl, method }));
            }
            return bodyPromise;
          };
        } catch { /* Response 实例可能不允许挂属性，忽略 */ }
      }
      return response;
    }, (error) => {
      record("fetchError", start, { url: shortUrl });
      throw error;
    });
  };

  // 等页面 DOM 就绪后监听进度文案（进度文案就是阶段切分的好标记）
  document.addEventListener("DOMContentLoaded", () => {
    const watch = (id) => {
      const node = document.getElementById(id);
      if (!node) return;
      const observer = new MutationObserver(() => {
        perf.timeline.push({ t: Math.round(performance.now()), label: node.textContent.trim().slice(0, 120), id });
      });
      observer.observe(node, { childList: true, characterData: true, subtree: true });
      perf.timeline.push({ t: Math.round(performance.now()), label: "[init] " + node.textContent.trim().slice(0, 80), id });
    };
    ["recognizeProgressLabel", "scoreHint", "recognizeAllLabel", "recognizeLabel"].forEach(watch);
  });
}

// —— PDF 页渲染计时：patch pdf.js 的 page.render（PDFPageProxy 没从 pdf.mjs 导出，
//    只能先拿一个页实例，再沿着原型链找到 render 所在的原型）——
async function patchPdfRender(page) {
  return page.evaluate(async () => {
    try {
      const state = window.__pujian && window.__pujian.state;
      if (!state || !state.pdf) return "no pdf yet";
      const firstPage = await state.pdf.getPage(1);
      let proto = Object.getPrototypeOf(firstPage);
      while (proto && !Object.prototype.hasOwnProperty.call(proto, "render")) {
        proto = Object.getPrototypeOf(proto);
      }
      if (!proto) return "render not found on prototype chain";
      const original = proto.render;
      proto.render = function (...args) {
        const start = performance.now();
        const pageNumber = this.pageNumber;
        const result = original.apply(this, args);
        if (result && result.promise) {
          result.promise.then(() => {
            window.__perfRecord("pdfRender", performance.now() - start, { page: pageNumber });
          }, () => {
            window.__perfRecord("pdfRenderError", performance.now() - start, { page: pageNumber });
          });
        }
        return result;
      };
      return "patched";
    } catch (error) {
      return "failed: " + error.message;
    }
  });
}

function summarize(perf, timeline, extra) {
  const byKind = {};
  for (const event of perf.events) {
    if (event.kind === "mark") continue;
    const key = event.kind;
    byKind[key] = byKind[key] || { count: 0, sum: 0, max: 0, items: [] };
    const bucket = byKind[key];
    bucket.count += 1;
    bucket.sum += event.ms || 0;
    bucket.max = Math.max(bucket.max, event.ms || 0);
    if (bucket.items.length < 60) bucket.items.push(event);
  }
  for (const bucket of Object.values(byKind)) bucket.sum = Math.round(bucket.sum * 10) / 10;
  const marks = timeline.filter((item) => item.label.startsWith("[mark]")).map((item) => ({
    t: item.t, name: item.label.replace("[mark] ", ""),
  }));
  const click = marks.find((item) => item.name === "click")?.t
    || timeline[0]?.t || 0;
  const done = marks.find((item) => item.name === "done")?.t;
  return {
    appHash: extra.appHash,
    serveHash: extra.serveHash,
    mode: extra.mode,
    fixture: extra.fixture,
    totalMs: done ? done - click : null,
    eventsByKind: byKind,
    marks,
    timeline: timeline.slice(0, 200),
    score: extra.score,
  };
}

// —— 运行一次「整本识别」 ——
async function runBatch(browser, fixture) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const appScripts = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/app[^/]*\.js(\?|$)/.test(url)) appScripts.push(url);
  });
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("[console error]", message.text().slice(0, 240));
  });
  await page.addInitScript(installProbes);
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__pujian), null, { timeout: 30000 });
  await page.setInputFiles("#fileInput", fixture);
  await page.waitForFunction(() => window.__pujian.state.pageCount > 1, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  console.log("pdf render patch:", await patchPdfRender(page));
  const pageCount = await page.evaluate(() => window.__pujian.state.pageCount);
  console.log("fixture loaded, pages =", pageCount);

  // 清空已有事件，标记 click
  await page.evaluate(() => {
    window.__perf.events.length = 0;
    window.__perf.timeline.length = 0;
    window.__perfMark("click");
  });
  const clickAt = Date.now();
  await page.click("#recognizeAllButton");

  // 等识别结束：isRecognizing 从 true 回到 false，且 notes 有内容或提示失败
  await page.waitForFunction(() => {
    const state = window.__pujian.state;
    return state.isRecognizing === false && (state.notes.length > 0
      || /失败|没有识别/.test((document.getElementById("scoreHint") || {}).textContent || ""));
  }, null, { timeout: TIMEOUT }).catch(async (error) => {
    console.log("等待识别结束超时：", error.message);
  });
  await page.waitForTimeout(1200);
  const wallMs = Date.now() - clickAt;
  await page.evaluate(() => { window.__perfMark("done"); });

  const collected = await page.evaluate(() => {
    const state = window.__pujian.state;
    const scoreInfo = state.scoreInfo || {};
    return {
      perf: window.__perf,
      score: {
        notes: state.notes.length,
        partNames: scoreInfo.partNames || [],
        measureCount: scoreInfo.measureCount || 0,
        timeSummary: scoreInfo.timeSummary || "",
        keySummary: scoreInfo.keySummary || "",
        tempo: scoreInfo.tempo || 0,
        source: state.recognitionSource || "",
        details: (document.getElementById("scoreDetails") || {}).textContent || "",
        hint: (document.getElementById("scoreHint") || {}).textContent || "",
      },
    };
  });
  await page.close();
  const report = summarize(collected.perf, collected.perf.timeline, {
    appHash, serveHash, mode: "batch", fixture,
    score: collected.score,
  });
  report.wallMs = wallMs;
  report.pageUrl = PAGE_URL;
  report.appScripts = appScripts;
  return report;
}

// —— 运行一次「单页识别」 ——
async function runSingle(browser, fixture) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const appScripts = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/app[^/]*\.js(\?|$)/.test(url)) appScripts.push(url);
  });
  page.on("pageerror", (error) => console.log("[pageerror]", error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.log("[console error]", message.text().slice(0, 240));
  });
  await page.addInitScript(installProbes);
  await page.goto(PAGE_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__pujian), null, { timeout: 30000 });
  await page.setInputFiles("#fileInput", fixture);
  await page.waitForFunction(() => window.__pujian.state.pageCount >= 1
    && window.__pujian.state.pdf, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  console.log("pdf render patch:", await patchPdfRender(page));

  await page.evaluate(() => {
    window.__perf.events.length = 0;
    window.__perf.timeline.length = 0;
    window.__perfMark("click");
  });
  const clickAt = Date.now();
  await page.click("#recognizeButton");
  await page.waitForFunction(() => {
    const state = window.__pujian.state;
    return state.isRecognizing === false && (state.notes.length > 0
      || /失败|没有识别/.test((document.getElementById("scoreHint") || {}).textContent || ""));
  }, null, { timeout: TIMEOUT }).catch((error) => console.log("等待识别结束超时：", error.message));
  await page.waitForTimeout(1000);
  const wallMs = Date.now() - clickAt;
  await page.evaluate(() => { window.__perfMark("done"); });

  const collected = await page.evaluate(() => {
    const state = window.__pujian.state;
    const scoreInfo = state.scoreInfo || {};
    return {
      perf: window.__perf,
      score: {
        notes: state.notes.length,
        partNames: scoreInfo.partNames || [],
        measureCount: scoreInfo.measureCount || 0,
        timeSummary: scoreInfo.timeSummary || "",
        keySummary: scoreInfo.keySummary || "",
        tempo: scoreInfo.tempo || 0,
        source: state.recognitionSource || "",
        details: (document.getElementById("scoreDetails") || {}).textContent || "",
        hint: (document.getElementById("scoreHint") || {}).textContent || "",
      },
    };
  });
  await page.close();
  const report = summarize(collected.perf, collected.perf.timeline, {
    appHash, serveHash, mode: "single", fixture,
    score: collected.score,
  });
  report.wallMs = wallMs;
  report.pageUrl = PAGE_URL;
  report.appScripts = appScripts;
  return report;
}

function printReport(report) {
  console.log("\n================ 测量结果 ================");
  console.log("模式:", report.mode, " 夹具:", report.fixture);
  console.log("app.js md5:", report.appHash, " serve.py md5:", report.serveHash);
  console.log("端到端（click → 结果落地）:", report.totalMs, "ms  (wall", report.wallMs, "ms)");
  console.log("识别结果: " + JSON.stringify(report.score));
  console.log("\n各阶段累计（同一类事件的 sum）:");
  const order = ["pdfRender", "getImageData", "putImageData", "blurDrawImage", "canvasToBlob",
    "fileReaderBase64", "jsonStringify", "fetchHeaders", "responseBody", "canvasToDataURL"];
  const kinds = Object.keys(report.eventsByKind).sort((a, b) => report.eventsByKind[b].sum - report.eventsByKind[a].sum);
  for (const kind of kinds) {
    const bucket = report.eventsByKind[kind];
    const extra = order.includes(kind) ? "" : "  (其它)";
    console.log(`  ${kind.padEnd(18)} count=${String(bucket.count).padStart(3)}  sum=${String(bucket.sum).padStart(8)} ms  max=${bucket.max} ms${extra}`);
  }
  console.log("\n关键事件明细:");
  for (const kind of ["pdfRender", "canvasToBlob", "fetchHeaders", "responseBody", "fileReaderBase64", "jsonStringify"]) {
    const bucket = report.eventsByKind[kind];
    if (!bucket) continue;
    for (const item of bucket.items.slice(0, 40)) console.log(`  ${kind}: ${JSON.stringify(item)}`);
  }
  console.log("\n进度时间线:");
  for (const item of report.timeline.filter((row) => !row.label.startsWith("[init]")).slice(0, 120)) {
    console.log(`  t=${String(item.t).padStart(7)}  ${item.label}`);
  }
}

// —— main ——
const browser = await chromium.launch({ channel: "msedge", headless: true });
const reports = {};
try {
  if (MODE === "all" || MODE === "single") {
    console.log("\n### 单页识别 ###");
    reports.single = await runSingle(browser, FIXTURE);
    printReport(reports.single);
  }
  if (MODE === "all" || MODE === "batch") {
    console.log("\n### 整本识别 ###");
    reports.batch = await runBatch(browser, FIXTURE);
    printReport(reports.batch);
  }
} finally {
  await browser.close();
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(reports, null, 1));
console.log("\nreport saved:", OUT, "appHash", appHash, "serveHash", serveHash);
