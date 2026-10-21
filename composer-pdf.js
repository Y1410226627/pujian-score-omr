// 创作室的「PDF 导入」：在浏览器里把 PDF 逐页渲染成图片，交给已有识别接口。
//
// 支持两类谱子：
//   · 五线谱 → Audiveris（/api/omr/recognize-batch），拿回 MusicXML；
//   · 简谱   → jianpu.py（/api/jianpu/recognize-batch），拿回音符模型后直接建成创作室乐谱。
// 「自动」模式先试五线谱；没有 Audiveris 或一页 MusicXML 都没读出来时，自动改走简谱。
// 用户材料以简谱为主，这条回退路径是「PDF 能导入编辑」的关键。
//
// 纯逻辑（页数、DPI、分批、简谱转谱）可单测：tests/composer-pdf-import.test.mjs

import {
  createScore, createPart, createStaff, createVoice, createEvent,
} from "./composer-model.js";

/** 识别用的渲染倍率：300 DPI ≈ scale 4.17（pdf.js 默认 72 DPI）。 */
export const RECOGNIZE_SCALE = 300 / 72;

/**
 * 简谱识别用的渲染倍率：约 150 DPI。
 *
 * 为什么不能用五线谱的 300 DPI：jianpu.py 的数字模板和行距判定是在
 * 约 1300–1900px 长边的页面上调出来的（实测《从前慢》第 1 页：
 * 120 DPI 读到 0 个音、150 DPI 读到 108 个音、175 DPI 会误拆成 6 个声部、
 * 300 DPI 只读到 2 个音）。所以简谱必须单独用低一档的分辨率渲染。
 */
export const JIANPU_RECOGNIZE_SCALE = 150 / 72;

/** 简谱页面长边的目标像素数：A4 约 150 DPI；其它开本按同一长边归一。 */
export const JIANPU_TARGET_LONG_EDGE = 1750;

/** 一次最多送多少页给识别接口（太多会超时/占内存）。 */
export const MAX_PAGES_PER_REQUEST = 16;

/** PDF 拒绝的页数上限（再多的谱子建议先拆分）。 */
export const MAX_PAGES = 64;

/**
 * 计算要渲染哪些页、渲染倍率。
 * @param {number} pageCount PDF 总页数
 * @param {{scale?: number, maxPages?: number}} options
 * @returns {{pages: number[], scale: number, truncated: boolean}}
 */
export function planPdfRender(pageCount, options = {}) {
  const total = Math.max(0, Math.floor(Number(pageCount) || 0));
  const maxPages = Math.max(1, Number(options.maxPages) || MAX_PAGES);
  const scale = Number(options.scale) || RECOGNIZE_SCALE;
  const pages = [];
  for (let index = 1; index <= Math.min(total, maxPages); index += 1) pages.push(index);
  return { pages, scale, truncated: total > maxPages };
}

/** 把页列表按每批上限切开，避免一次请求太大。 */
export function chunkPages(pages, size = MAX_PAGES_PER_REQUEST) {
  const list = Array.isArray(pages) ? pages : [];
  const step = Math.max(1, Number(size) || MAX_PAGES_PER_REQUEST);
  const chunks = [];
  for (let index = 0; index < list.length; index += step) {
    chunks.push(list.slice(index, index + step));
  }
  return chunks;
}

/** 渲染一页到 canvas（供调用方 toBlob）。 */
export async function renderPageToCanvas(page, scale) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

/** canvas → PNG Blob。 */
export function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片生成失败"))), "image/png");
  });
}

/** Blob → base64（去掉 data: 前缀）。 */
export async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** 打开 PDF 并算出要识别的页。 */
async function openPdf(file) {
  const pdfjs = await import("./vendor/pdfjs/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data }).promise;
  const plan = planPdfRender(document.numPages);
  if (plan.truncated) {
    plan.truncatedNotice = `这份 PDF 有 ${document.numPages} 页，先识别前 ${plan.pages.length} 页`;
  }
  return { pageCount: document.numPages, plan, document };
}

/** 逐页渲染成 PNG Blob；targetLongEdge 用于把不同开本的页面归一到相近像素。 */
async function renderPages(document, plan, scale, onProgress, targetLongEdge = 0) {
  if (plan.truncatedNotice) {
    onProgress?.({ phase: "warn", done: 0, total: plan.pages.length, label: plan.truncatedNotice });
  }
  const blobs = [];
  for (const [index, pageNumber] of plan.pages.entries()) {
    onProgress?.({ phase: "render", done: index, total: plan.pages.length,
      label: `正在渲染第 ${pageNumber} 页…` });
    const page = await document.getPage(pageNumber);
    let pageScale = scale;
    if (targetLongEdge) {
      const base = page.getViewport({ scale: 1 });
      pageScale = Math.min(scale, targetLongEdge / Math.max(base.width, base.height));
    }
    const canvas = await renderPageToCanvas(page, pageScale);
    blobs.push(await canvasToPngBlob(canvas));
    page.cleanup();
  }
  return blobs;
}

/** 把每一批图片 POST 到某个识别接口，按页返回结果。 */
async function requestRecognition(url, blobs, plan, extra = {}, onProgress, phaseLabel = "正在识别") {
  const pages = [];
  const chunks = chunkPages(plan.pages);
  for (const [chunkIndex, chunk] of chunks.entries()) {
    onProgress?.({ phase: "recognize", done: chunkIndex, total: chunks.length,
      label: `${phaseLabel}第 ${chunk[0]}–${chunk[chunk.length - 1]} 页…` });
    const offset = plan.pages.indexOf(chunk[0]);
    const images = [];
    for (let itemIndex = 0; itemIndex < chunk.length; itemIndex += 1) {
      images.push(await blobToBase64(blobs[offset + itemIndex]));
    }
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...extra, images }),
    });
    if (!response.ok) {
      let detail = `识别服务返回 ${response.status}`;
      try {
        const payload = await response.json();
        if (payload && payload.error) detail = payload.error;
      } catch { /* 响应不是 JSON 就用状态码 */ }
      const error = new Error(detail);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    const returned = Array.isArray(payload.pages) ? payload.pages : [];
    chunk.forEach((pageNumber, itemIndex) => {
      pages.push({ page: pageNumber, item: returned[itemIndex] || null });
    });
  }
  return pages;
}

/**
 * 完整流程：PDF → 每页识别结果。
 *
 * @param {object} options
 * @param {File|Blob} options.file PDF
 * @param {"auto"|"staff"|"jianpu"} [options.engine] 自动 / 五线谱 / 简谱
 * @param {number} [options.jianpuDo] 简谱的 1 = ?（MIDI，默认 F=65）
 * @param {number} [options.jianpuBeats] 简谱每小节拍数（默认 4）
 * @param {Function} [options.onProgress] ({phase, done, total, label}) => void
 * @returns {Promise<{pageCount:number, engine:"staff"|"jianpu",
 *   pages: Array<{page:number, musicxml?:string|null, payload?:object}>}>}
 */
export async function recognizePdf({
  file, engine = "auto", jianpuDo = 65, jianpuBeats = 4, onProgress,
}) {
  const { pageCount, plan, document } = await openPdf(file);

  // 1) 五线谱：300 DPI 渲染，自动模式下失败不报错，静默改走简谱
  if (engine !== "jianpu") {
    const staffBlobs = await renderPages(document, plan, RECOGNIZE_SCALE, onProgress);
    let staffPages = null;
    let staffError = null;
    try {
      const raw = await requestRecognition("/api/omr/recognize-batch", staffBlobs, plan, {}, onProgress);
      staffPages = raw.map(({ page, item }) => ({
        page, musicxml: item && item.musicxml ? item.musicxml : null,
      }));
    } catch (error) {
      staffError = error;
    }
    if (staffPages && countMusicXmlPitches(staffPages) >= 4) {
      onProgress?.({ phase: "done", done: staffPages.length, total: staffPages.length, label: "识别完成" });
      return { pageCount, engine: "staff", pages: staffPages };
    }
    if (engine === "staff") {
      throw staffError || new Error("这份 PDF 没有识别出五线谱音符。如果它是简谱，请在导入处选「简谱」或「自动」。");
    }
  }

  // 2) 简谱：换成简谱专用的分辨率重新渲染（300 DPI 会让 jianpu.py 几乎读不到音）
  onProgress?.({ phase: "recognize", done: 0, total: 1, label: "五线谱没读到音符，改用简谱识别…" });
  const jianpuBlobs = await renderPages(
    document, plan, JIANPU_RECOGNIZE_SCALE, onProgress, JIANPU_TARGET_LONG_EDGE,
  );
  const pages = await requestRecognition("/api/jianpu/recognize-batch", jianpuBlobs, plan,
    { do: jianpuDo, beats: jianpuBeats }, onProgress, "正在识别简谱");
  onProgress?.({ phase: "done", done: pages.length, total: pages.length, label: "识别完成" });
  return {
    pageCount,
    engine: "jianpu",
    pages: pages.map(({ page, item }) => ({ page, payload: item })),
  };
}

/** 统计识别出的 MusicXML 里有多少个带音高的音符（少于几个就当没识别出来）。 */
function countMusicXmlPitches(pages) {
  let count = 0;
  for (const item of pages) {
    if (!item.musicxml) continue;
    const matched = item.musicxml.match(/<pitch>/g);
    count += matched ? matched.length : 0;
  }
  return count;
}

/** 简谱的「每小节几拍（四分音符为单位）」→ 合法的拍号（避免写出 4.5/4 这种不存在的拍号）。 */
export function jianpuTimeSignature(beats) {
  const value = Number(beats) || 4;
  if (Math.abs(value - 1.5) < 1e-6) return { beats: 3, beatType: 8 };
  if (Math.abs(value - 4.5) < 1e-6) return { beats: 9, beatType: 8 };
  if (Math.abs(value - 6) < 1e-6) return { beats: 12, beatType: 8 };
  if (Math.abs(value - 3) < 1e-6) return { beats: 3, beatType: 4 };
  if (Math.abs(value - 2) < 1e-6) return { beats: 2, beatType: 4 };
  return { beats: Math.max(1, Math.round(value)), beatType: 4 };
}

/**
 * 简谱识别结果（多页）→ 创作室 v2 乐谱。
 *
 * 每页的 startBeat 都从 0 开始，所以后续页要整体平移到上一页结束后的小节线上。
 * 同一拍位上的多个音合成和弦（否则界面会当成两个先后音，拍位全错）。
 *
 * @param {Array<{page:number, payload:object}>} items
 * @param {{beats?:number, title?:string, tempo?:number}} [options]
 * @returns {{score:object, noteCount:number, pageCount:number, partCount:number, warnings:string[]}}
 */
export function jianpuPagesToScore(items = [], options = {}) {
  const beatsPerBar = Math.max(0.5, Number(options.beats) || 4);
  const score = createScore({
    title: options.title || "简谱识别结果",
    tempo: Number(options.tempo) || 84,
    timeSignature: jianpuTimeSignature(beatsPerBar),
  });
  score.parts = [];

  const warnings = [];
  let offset = 0;
  let noteCount = 0;
  let pageCount = 0;

  for (const item of items) {
    const payload = item && (item.payload || item.jianpu);
    if (!payload || !Array.isArray(payload.parts) || !payload.parts.length) continue;
    pageCount += 1;
    const pageEnd = aggregateJianpuPart(score, payload, { offset });
    noteCount += pageEnd.noteCount;
    if (Array.isArray(payload.warnings)) warnings.push(...payload.warnings);
    // 下一页从上一页结束处之后对齐到小节线开始
    offset += Math.ceil((pageEnd.endBeat - 1e-6) / beatsPerBar) * beatsPerBar;
  }

  return { score, noteCount, pageCount, partCount: score.parts.length, warnings };
}

/** 把一页简谱音符并进 v2 乐谱；返回这一页的音符数与结束拍位。 */
function aggregateJianpuPart(score, payload, { offset }) {
  let noteCount = 0;
  let endBeat = 0;
  payload.parts.forEach((sourcePart, partIndex) => {
    while (score.parts.length <= partIndex) {
      score.parts.push(createPart({
        name: sourcePart.name || `声部${score.parts.length + 1}`,
        // 前四个声部按人声处理（合唱谱常见），多出来的一般是钢琴伴奏
        timbre: score.parts.length < 4 ? "choir" : "piano",
      }));
    }
    const part = score.parts[partIndex];
    const voice = part.staves[0].voices[0];
    // 同一拍位上的多个音 = 和弦，必须挂在同一个锚音上
    const byBeat = new Map();
    for (const note of sourcePart.notes || []) {
      const localBeat = Math.max(0, Number(note.startBeat) || 0);
      const duration = Math.max(0.0625, Number(note.durationBeats) || 1);
      const key = localBeat.toFixed(6);
      const entry = byBeat.get(key) || { beat: offset + localBeat, beats: duration, midis: [] };
      entry.beats = Math.max(entry.beats, duration);
      const midi = Math.round(Number(note.midi));
      if (Number.isFinite(midi) && !entry.midis.includes(midi)) entry.midis.push(midi);
      byBeat.set(key, entry);
      endBeat = Math.max(endBeat, localBeat + duration);
      noteCount += 1;
    }
    for (const entry of byBeat.values()) {
      if (!entry.midis.length) continue;
      const anchor = createEvent({ beat: entry.beat, beats: entry.beats, midi: entry.midis[0] });
      voice.events.push(anchor);
      for (const midi of entry.midis.slice(1)) {
        voice.events.push(createEvent({
          beat: entry.beat, beats: entry.beats, midi, chordWith: anchor.id,
        }));
      }
    }
    voice.events.sort((left, right) => left.beat - right.beat || left.midi - right.midi);
  });
  return { noteCount, endBeat };
}
