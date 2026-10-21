// 创作室的「PDF 导入」：在浏览器里把 PDF 逐页渲染成图片，交给已有识别接口，拿回 MusicXML。
//
// 为什么在浏览器里渲染：项目已经有 pdf.js（vendor/pdfjs），工作台就是这么做的；
// 复用同一条路，不用在服务端再加一套渲染逻辑，也不会破坏现有识别通道。
//
// 纯逻辑（页数、DPI、分批）可单测：tests/composer-pdf-import.test.mjs

/** 识别用的渲染倍率：300 DPI ≈ scale 4.17（pdf.js 默认 72 DPI）。 */
export const RECOGNIZE_SCALE = 300 / 72;

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

/**
 * 完整流程：PDF 文件 → 每页 MusicXML。
 *
 * @param {object} options
 * @param {File|Blob} options.file PDF
 * @param {Function} options.onProgress ({phase, done, total, label}) => void
 * @returns {Promise<{pageCount:number, pages: Array<{page:number, musicxml:string|null}>}>}
 */
export async function recognizePdfToMusicXml({ file, onProgress }) {
  const pdfjs = await import("./vendor/pdfjs/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjs.getDocument({ data }).promise;
  const plan = planPdfRender(document.numPages);
  if (plan.truncated) {
    onProgress?.({ phase: "warn", done: 0, total: plan.pages.length,
      label: `这份 PDF 有 ${document.numPages} 页，先识别前 ${plan.pages.length} 页` });
  }

  // 1) 逐页渲染
  const blobs = [];
  for (const [index, pageNumber] of plan.pages.entries()) {
    onProgress?.({ phase: "render", done: index, total: plan.pages.length,
      label: `正在渲染第 ${pageNumber} 页…` });
    const page = await document.getPage(pageNumber);
    const canvas = await renderPageToCanvas(page, plan.scale);
    blobs.push(await canvasToPngBlob(canvas));
    page.cleanup();
  }

  // 2) 分批送识别
  const pages = [];
  const chunks = chunkPages(plan.pages);
  for (const [chunkIndex, chunk] of chunks.entries()) {
    onProgress?.({ phase: "recognize", done: chunkIndex, total: chunks.length,
      label: `正在识别第 ${chunk[0]}–${chunk[chunk.length - 1]} 页…` });
    const offset = plan.pages.indexOf(chunk[0]);
    const images = [];
    for (const [itemIndex] of chunk.entries()) {
      images.push(await blobToBase64(blobs[offset + itemIndex]));
    }
    const response = await fetch("/api/omr/recognize-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images }),
    });
    if (!response.ok) throw new Error(`识别服务返回 ${response.status}`);
    const payload = await response.json();
    const returned = Array.isArray(payload.pages) ? payload.pages : [];
    chunk.forEach((pageNumber, itemIndex) => {
      const item = returned[itemIndex];
      pages.push({ page: pageNumber, musicxml: item && item.musicxml ? item.musicxml : null });
    });
  }
  onProgress?.({ phase: "done", done: pages.length, total: pages.length, label: "识别完成" });
  return { pageCount: document.numPages, pages };
}
