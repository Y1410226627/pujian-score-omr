import { parseMusicXmlText, readMusicXmlFile } from "./musicxml.js";

const byId = (id) => document.getElementById(id);
const els = {
  fileInput: byId("fileInput"), dropzone: byId("dropzone"), currentFile: byId("currentFile"),
  fileName: byId("fileName"), fileInfo: byId("fileInfo"), removeFile: byId("removeFile"),
  recognizeButton: byId("recognizeButton"), recognizeLabel: byId("recognizeLabel"), clefSelect: byId("clefSelect"),
  engineHint: byId("engineHint"),
  staffSelectField: byId("staffSelectField"), staffSelect: byId("staffSelect"),
  emptyState: byId("emptyState"), canvasWrap: byId("canvasWrap"), scoreCanvas: byId("scoreCanvas"),
  overlayCanvas: byId("overlayCanvas"), pageControls: byId("pageControls"), pageLabel: byId("pageLabel"),
  prevPage: byId("prevPage"), nextPage: byId("nextPage"), processingOverlay: byId("processingOverlay"),
  scoreHint: byId("scoreHint"), scoreInfo: byId("scoreInfo"), scoreTitle: byId("scoreTitle"),
  scoreDetails: byId("scoreDetails"), scoreWarnings: byId("scoreWarnings"), noteCount: byId("noteCount"), noteList: byId("noteList"),
  voiceFilterField: byId("voiceFilterField"), voiceFilter: byId("voiceFilter"),
  notesEmpty: byId("notesEmpty"), addNoteButton: byId("addNoteButton"), midiButton: byId("midiButton"), playButton: byId("playButton"),
  playIcon: byId("playIcon"), playLabel: byId("playLabel"), stopButton: byId("stopButton"),
  tempoInput: byId("tempoInput"), toast: byId("toast"), chooseFileButton: byId("chooseFileButton"),
  recognitionBanner: byId("recognitionBanner"), recognitionSource: byId("recognitionSource"), recognitionDetail: byId("recognitionDetail"),
  lowConfidenceButton: byId("lowConfidenceButton"),
  selectionBar: byId("selectionBar"), selectionLabel: byId("selectionLabel"),
  loopToggle: byId("loopToggle"), clearSelection: byId("clearSelection"), scoreLegend: byId("scoreLegend"),
};
const state = {
  file: null, objectUrl: null, pdf: null, pageNumber: 1, pageCount: 1, notes: [], scoreInfo: null,
  recognized: false, isPlaying: false, audio: null, sources: new Set(), timers: [], toastTimer: null,
  // 令牌机制：文件加载 / 识别 / PDF 渲染各自带序号，只有最后一次发起的操作才允许改界面，
  // 避免"识别中切换文件""连点翻页"这类竞态把旧结果写回界面。
  loadToken: 0, recognizeToken: 0, renderToken: 0, isRecognizing: false,
  // 识别来源：engine=本机专业引擎 / estimate=浏览器粗略估算 / musicxml=直接导入的结构化乐谱
  recognitionSource: null,
  selection: null, loop: false, onlyLowConfidence: false,
};
// 粗略估算得到的符头置信分低于此值即标为"待校对"
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const durations = [
  ["breve", "倍全音符", 8], ["dottedWhole", "附点全音符", 6], ["whole", "全音符", 4],
  ["doubleDottedHalf", "双附点二分音符", 3.5], ["dottedHalf", "附点二分音符", 3], ["half", "二分音符", 2],
  ["doubleDottedQuarter", "双附点四分音符", 1.75], ["dottedQuarter", "附点四分音符", 1.5], ["quarter", "四分音符", 1],
  ["quarterTriplet", "四分三连音", 2 / 3], ["dottedEighth", "附点八分音符", 0.75], ["eighth", "八分音符", 0.5],
  ["eighthTriplet", "八分三连音", 1 / 3], ["dottedSixteenth", "附点十六分音符", 0.375], ["sixteenth", "十六分音符", 0.25],
  ["sixteenthTriplet", "十六分三连音", 1 / 6], ["thirtySecond", "三十二分音符", 0.125],
  ["sixtyFourth", "六十四分音符", 0.0625], ["oneTwentyEighth", "一百二十八分音符", 0.03125],
];
const durationBeats = Object.fromEntries(durations.map((entry) => [entry[0], entry[2]]));
const durationFromBeats = (beats) => durations.find((entry) => Math.abs(entry[2] - beats) < 0.00001)?.[0] || "custom";
const beatsForNote = (note) => Number.isFinite(note.durationBeats) ? note.durationBeats : (durationBeats[note.duration] || 1);
const voiceIdentity = (note) => JSON.stringify([note.partId || note.partName || "旋律", note.staff || "1", note.voice || "1"]);

function makeId() {
  return window.crypto && typeof window.crypto.randomUUID === "function"
    ? window.crypto.randomUUID()
    : "note-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}
function formatSize(bytes) {
  return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB" : (bytes / 1048576).toFixed(1) + " MB";
}
// 本机是否装有专业识别引擎。null 表示尚未探测成功（例如直接用 file:// 打开页面）。
let homrAvailable = null;
function idleRecognizeLabel() {
  if (homrAvailable === false) return "估算识别";
  if (state.recognized) return "重新识别";
  return "识别乐谱";
}
function updateEngineHint() {
  if (!els.engineHint) return;
  if (homrAvailable === true) {
    els.engineHint.textContent = "已检测到本机专业识别引擎；识别结果仍建议逐音校对后再使用。";
  } else if (homrAvailable === false) {
    els.engineHint.textContent = "未检测到本机专业识别引擎：图片只会做粗略估算，结果可能明显不准，请务必逐音校对。";
  }
}
async function refreshEngineStatus() {
  try {
    const response = await fetch("/api/omr/status");
    const payload = await response.json();
    homrAvailable = Boolean(payload.homrAvailable);
  } catch {
    homrAvailable = null;
  }
  updateEngineHint();
  if (state.file && !state.isRecognizing && !/\.(musicxml|xml|mxl)$/i.test(state.file.name)) {
    els.recognizeLabel.textContent = idleRecognizeLabel();
  }
}
function clearOverlay() {
  els.overlayCanvas.getContext("2d").clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
}
function clearScore() {
  state.notes = [];
  state.recognized = false;
  state.scoreInfo = null;
  state.recognitionSource = null;
  state.selection = null;
  state.onlyLowConfidence = false;
  els.scoreInfo.hidden = true;
  updateVoiceOptions(true);
  els.staffSelect.replaceChildren();
  els.staffSelectField.hidden = true;
  renderNotes();
  clearOverlay();
  updateRecognitionBanner();
  els.scoreHint.textContent = "导入文件后开始";
}
async function destroyPdf() {
  const previous = state.pdf;
  state.pdf = null;
  if (!previous) return;
  try {
    await previous.destroy();
  } catch (error) {
    console.info("PDF 文档释放时出错（通常可忽略）。", error);
  }
}
// 只有"粗略估算"出来的音符才带置信分；专业引擎与 MusicXML 导入没有逐音置信度。
const isLowConfidence = (note) => Number.isFinite(note.confidence) && note.confidence < LOW_CONFIDENCE_THRESHOLD;
const hasLowConfidenceNotes = () => state.notes.some(isLowConfidence);
function updateRecognitionBanner() {
  const banner = els.recognitionBanner;
  if (!banner) return;
  if (!state.recognitionSource || !state.notes.length) {
    banner.hidden = true;
    return;
  }
  const lowCount = state.notes.filter(isLowConfidence).length;
  if (state.recognitionSource === "engine") {
    banner.className = "recognition-banner is-engine";
    els.recognitionSource.textContent = "本机专业识别引擎";
    els.recognitionDetail.textContent = `${state.notes.length} 个音符，已生成节奏与声部 · 结果仍需逐音校对`;
  } else if (state.recognitionSource === "musicxml") {
    banner.className = "recognition-banner is-file";
    els.recognitionSource.textContent = "来自文件的结构化乐谱";
    els.recognitionDetail.textContent = `${state.notes.length} 个音符 · 音高与时值直接读取自 MusicXML，未经过图像识别`;
  } else {
    banner.className = "recognition-banner is-estimate";
    els.recognitionSource.textContent = "粗略估算 · 未经专业识别";
    els.recognitionDetail.textContent = lowCount
      ? `${state.notes.length} 个音符，其中 ${lowCount} 个置信度偏低 · 请逐音校对后再使用`
      : `${state.notes.length} 个音符 · 估算结果仅供参考，请逐音校对后再使用`;
  }
  banner.hidden = false;
}
function setCanvasSize(width, height) {
  els.scoreCanvas.width = width;
  els.scoreCanvas.height = height;
  els.overlayCanvas.width = width;
  els.overlayCanvas.height = height;
  els.emptyState.hidden = true;
  els.canvasWrap.hidden = false;
  clearOverlay();
}
async function loadFile(file) {
  if (!file) return;
  const lowerName = file.name.toLowerCase();
  const isPdf = file.type === "application/pdf" || lowerName.endsWith(".pdf");
  const isMusicXml = /\.(musicxml|xml|mxl)$/i.test(lowerName);
  const isImage = Boolean(file.type?.startsWith("image/")) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name);
  if (!isPdf && !isImage && !isMusicXml) return showToast("请选择 PDF、图片或 MusicXML 乐谱文件。");
  stopPlayback();
  await destroyPdf();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  const token = ++state.loadToken;
  state.file = file;
  // PDF 交给 pdf.js 直接读 ArrayBuffer，MusicXML 在浏览器内解析，两者都不需要 blob URL。
  state.objectUrl = (isPdf || isMusicXml) ? null : URL.createObjectURL(file);
  state.pageNumber = 1;
  state.pageCount = 1;
  clearScore();
  els.clefSelect.disabled = isMusicXml;
  els.fileName.textContent = file.name;
  els.fileInfo.textContent = (isMusicXml ? "MusicXML 乐谱" : isPdf ? "PDF 文档" : "图片文件") + " · " + formatSize(file.size);
  els.currentFile.hidden = false;
  els.recognizeButton.disabled = true;
  els.recognizeLabel.textContent = "正在载入…";
  els.pageControls.hidden = true;
  els.scoreHint.textContent = "正在载入谱面";
  try {
    if (isMusicXml) {
      const scoreInfo = await readMusicXmlFile(file);
      if (token !== state.loadToken) return;
      for (const note of scoreInfo.notes) note.duration = durationFromBeats(note.durationBeats);
      state.scoreInfo = scoreInfo;
      state.notes = scoreInfo.notes;
      state.recognitionSource = scoreInfo.notes.length ? "musicxml" : null;
      updateVoiceOptions(true);
      state.recognized = false;
      state.pageCount = 1;
      els.canvasWrap.hidden = true;
      els.emptyState.hidden = true;
      els.scoreInfo.hidden = false;
      els.staffSelectField.hidden = true;
      els.scoreTitle.textContent = scoreInfo.title;
      els.scoreDetails.textContent = `${scoreInfo.notes.length} 个音符 · ${scoreInfo.partNames.length} 个声部 · ${scoreInfo.measureCount} 小节 · ${scoreInfo.timeSummary} · ${scoreInfo.keySummary}`;
      els.scoreWarnings.textContent = scoreInfo.warnings.join(" ");
      els.scoreWarnings.hidden = scoreInfo.warnings.length === 0;
      els.tempoInput.value = Math.min(320, Math.max(20, Math.round(scoreInfo.tempo)));
      renderNotes();
      updateRecognitionBanner();
      els.recognizeButton.disabled = true;
      els.recognizeLabel.textContent = "已载入符号乐谱";
      els.pageControls.hidden = true;
      els.scoreHint.textContent = scoreInfo.notes.length
        ? "已从 MusicXML 读取音高、声部、休止与节奏位置"
        : "这份乐谱没有可演奏的带音高音符";
      showToast(scoreInfo.notes.length
        ? `已读取 ${scoreInfo.notes.length} 个音符，请校对后试听。`
        : "已读取乐谱，但没有找到可演奏的带音高音符。");
      return;
    }
    if (isPdf) await loadPdf(file, token);
    else await loadImage(file, token);
    if (token !== state.loadToken) return;
    els.recognizeButton.disabled = false;
    els.recognizeLabel.textContent = idleRecognizeLabel();
    els.scoreHint.textContent = "可以开始识别";
  } catch (error) {
    // 文件已被更新的选择取代时，静默退出，不要把旧错误打到新界面上。
    if (token !== state.loadToken) return;
    console.error(error);
    els.recognizeButton.disabled = true;
    els.recognizeLabel.textContent = "识别乐谱";
    els.scoreInfo.hidden = true;
    els.canvasWrap.hidden = true;
    els.emptyState.hidden = false;
    els.scoreHint.textContent = "载入失败";
    showToast(error.message || "文件无法打开，请尝试其他文件。");
  }
}
async function loadImage(file, token) {
  const image = new Image();
  image.src = state.objectUrl;
  await image.decode();
  if (token !== state.loadToken) return;
  const scale = Math.min(1, 2600 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  setCanvasSize(width, height);
  const ctx = els.scoreCanvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  els.fileInfo.textContent = "图片文件 · " + formatSize(file.size) + " · " + image.naturalWidth + " × " + image.naturalHeight;
}
async function loadPdf(file, token) {
  let pdfjs;
  try {
    pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.mjs");
  } catch {
    throw new Error("PDF 阅读组件载入失败。请连接网络后刷新页面，或将 PDF 页面另存为图片。");
  }
  if (token !== state.loadToken) return;
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.mjs";
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  if (token !== state.loadToken) {
    try { await document.destroy(); } catch { /* 已被取代，尽力释放即可 */ }
    return;
  }
  state.pdf = document;
  state.pageCount = document.numPages;
  els.pageControls.hidden = state.pageCount <= 1;
  await renderPdfPage(1, token);
}
async function renderPdfPage(number, token = state.loadToken) {
  if (!state.pdf) return;
  const targetPage = Math.max(1, Math.min(number, state.pageCount));
  state.pageNumber = targetPage;
  const renderToken = ++state.renderToken;
  const page = await state.pdf.getPage(targetPage);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2.2, 2200 / Math.max(base.width, base.height)) });
  if (renderToken !== state.renderToken || token !== state.loadToken) return;
  const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
  // 先渲染到离屏画布，再把最终结果贴到可见画布：这样连点翻页时不会对同一画布并发调用 render()。
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const offscreenContext = offscreen.getContext("2d", { willReadFrequently: true });
  offscreenContext.fillStyle = "#fff";
  offscreenContext.fillRect(0, 0, width, height);
  await page.render({ canvasContext: offscreenContext, viewport }).promise;
  if (renderToken !== state.renderToken || token !== state.loadToken) return;
  setCanvasSize(width, height);
  const ctx = els.scoreCanvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(offscreen, 0, 0);
  els.pageLabel.textContent = targetPage + " / " + state.pageCount;
  els.prevPage.disabled = targetPage <= 1;
  els.nextPage.disabled = targetPage >= state.pageCount;
}
function removeCurrentFile() {
  stopPlayback();
  state.loadToken++;
  destroyPdf();
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.file = null;
  state.objectUrl = null;
  els.fileInput.value = "";
  els.currentFile.hidden = true;
  els.recognizeButton.disabled = true;
  els.recognizeLabel.textContent = "识别乐谱";
  els.clefSelect.disabled = false;
  els.canvasWrap.hidden = true;
  els.emptyState.hidden = false;
  els.pageControls.hidden = true;
  clearScore();
}

function otsuThreshold(gray) {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) histogram[gray[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * histogram[t];
  let sumBackground = 0, weightBackground = 0, best = -1, threshold = 170;
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t];
    if (!weightBackground) continue;
    const weightForeground = gray.length - weightBackground;
    if (!weightForeground) break;
    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > best) { best = variance; threshold = t; }
  }
  return Math.max(90, Math.min(220, threshold));
}
function detectStaff(binary, width, height) {
  const rowCounts = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0, offset = y * width;
    for (let x = 0; x < width; x++) count += binary[offset + x];
    rowCounts[y] = count;
  }
  const coverage = Math.max(12, width * 0.32), centers = [];
  let start = -1, last = -1;
  for (let y = 0; y <= height; y++) {
    if (y < height && rowCounts[y] >= coverage) {
      if (start < 0) start = y;
      last = y;
    } else if (start >= 0 && (y - last > 2 || y === height)) {
      let weighted = 0, strength = 0;
      for (let row = start; row <= last; row++) {
        weighted += row * rowCounts[row];
        strength += rowCounts[row];
      }
      centers.push({ y: weighted / Math.max(1, strength), strength: strength / Math.max(1, last - start + 1) });
      start = -1;
    }
  }
  const candidates = [];
  for (let i = 0; i + 4 < centers.length; i++) {
    const lines = centers.slice(i, i + 5);
    const gaps = lines.slice(1).map((line, j) => line.y - lines[j].y);
    const spacing = gaps.reduce((a, b) => a + b, 0) / 4;
    if (spacing < 4 || spacing > Math.min(55, height / 12)) continue;
    if (Math.max(...gaps) - Math.min(...gaps) > Math.max(2.4, spacing * 0.29)) continue;
    candidates.push({ lines, spacing, strength: lines.reduce((sum, line) => sum + line.strength, 0) / 5 });
  }
  candidates.sort((a, b) => b.strength - a.strength);
  const unique = [];
  for (const item of candidates) {
    const overlap = unique.some((other) => item.lines.filter((line) =>
      other.lines.some((candidate) => Math.abs(line.y - candidate.y) < item.spacing * 0.45)).length >= 3);
    if (!overlap) unique.push(item);
  }
  unique.sort((a, b) => a.lines[0].y - b.lines[0].y);
  return unique;
}
function naturalMidi(letter, octave) {
  const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return (octave + 1) * 12 + semitones[letter];
}
function pitchForStaffStep(step, clef) {
  const bottomNotes = {
    treble: { letter: "E", octave: 4 },
    bass: { letter: "G", octave: 2 },
    alto: { letter: "F", octave: 3 },
    tenor: { letter: "D", octave: 3 },
  };
  const bottom = bottomNotes[clef] || bottomNotes.treble;
  const letters = ["C", "D", "E", "F", "G", "A", "B"];
  let index = letters.indexOf(bottom.letter) + step;
  const octave = bottom.octave + Math.floor(index / 7);
  index = ((index % 7) + 7) % 7;
  const letter = letters[index];
  return { name: letter + octave, midi: naturalMidi(letter, octave) };
}
function headScore(binary, width, height, cx, cy, spacing, staffRows) {
  const rx = Math.max(3, spacing * 0.42), ry = Math.max(2, spacing * 0.29);
  let ink = 0, samples = 0;
  for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
    const y = Math.round(cy + dy);
    if (y < 0 || y >= height || staffRows.has(y)) continue;
    for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
      if (dx * dx / (rx * rx) + dy * dy / (ry * ry) > 1) continue;
      const x = Math.round(cx + dx);
      if (x < 0 || x >= width) continue;
      samples++;
      ink += binary[y * width + x];
    }
  }
  return samples ? ink / samples : 0;
}
function hasStem(binary, width, height, x, y, spacing) {
  for (const side of [-1, 1]) {
    const sx = Math.round(x + side * spacing * 0.34);
    let ink = 0, samples = 0;
    for (let dy = -Math.round(spacing * 2.7); dy <= Math.round(spacing * 2.7); dy++) {
      if (Math.abs(dy) < spacing * 0.48) continue;
      const sy = Math.round(y + dy);
      if (sy < 0 || sy >= height || sx < 0 || sx >= width) continue;
      samples++;
      ink += binary[sy * width + sx];
    }
    if (samples > 3 && ink / samples > 0.62) return true;
  }
  return false;
}
function analyzeCanvas() {
  const canvas = els.scoreCanvas, width = canvas.width, height = canvas.height;
  const pixels = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height).data;
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = Math.round(pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114);
  const threshold = otsuThreshold(gray), binary = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) binary[i] = gray[i] < threshold ? 1 : 0;
  const staves = detectStaff(binary, width, height);
  if (!staves.length) return { notes: [], staffFound: false };
  const selectedStaff = Math.min(Number(els.staffSelect.value) || 0, staves.length - 1);
  const staff = staves[selectedStaff], spacing = staff.spacing;
  const staffRows = new Set();
  for (const line of staff.lines) for (let dy = -1; dy <= 1; dy++) staffRows.add(Math.round(line.y + dy));
  const raw = [], bottomY = staff.lines[4].y, scanStep = Math.max(1, Math.round(spacing / 8));
  for (let step = -8; step <= 19; step++) {
    const targetY = bottomY - step * spacing / 2;
    if (targetY < 0 || targetY >= height) continue;
    const hits = [];
    for (let x = Math.round(width * 0.025); x < width * 0.975; x += scanStep) {
      let best = 0, bestY = targetY;
      for (let offset = -2; offset <= 2; offset++) {
        const candidateY = targetY + offset;
        const score = headScore(binary, width, height, x, candidateY, spacing, staffRows);
        if (score > best) { best = score; bestY = candidateY; }
      }
      if (best >= 0.34) hits.push({ x, y: bestY, score: best });
    }
    const groups = [];
    for (const hit of hits) {
      const last = groups[groups.length - 1];
      if (last && hit.x - last[last.length - 1].x <= spacing * 0.68) last.push(hit);
      else groups.push([hit]);
    }
    for (const group of groups) {
      const best = group.reduce((a, b) => a.score >= b.score ? a : b);
      const pitch = pitchForStaffStep(step, els.clefSelect.value);
      const stem = hasStem(binary, width, height, best.x, best.y, spacing);
      const duration = !stem && best.score < 0.49 ? "whole" : (!stem && best.score < 0.55 ? "half" : "quarter");
      raw.push({ name: pitch.name, midi: pitch.midi, x: group.reduce((sum, h) => sum + h.x, 0) / group.length, y: best.y, duration, score: best.score });
    }
  }
  raw.sort((a, b) => a.x - b.x || b.y - a.y);
  const events = [];
  for (const note of raw) {
    const last = events[events.length - 1];
    if (last && note.x - last.x <= spacing * 0.72) {
      if (!last.notes.some((item) => item.midi === note.midi)) last.notes.push(note);
      last.x = last.notes.reduce((sum, item) => sum + item.x, 0) / last.notes.length;
    } else events.push({ x: note.x, notes: [note] });
  }
  const notes = [];
  let startBeat = 0;
  events.forEach((event, eventId) => {
    const eventLength = Math.max(...event.notes.map((note) => durationBeats[note.duration] || 1));
    event.notes.forEach((note) => notes.push({
      id: makeId(), eventId, pitch: note.name, midi: note.midi, duration: note.duration,
      durationBeats: durationBeats[note.duration] || 1, startBeat, partName: "识别旋律", x: note.x, y: note.y,
      // 符头打分直接带出来当作置信度，让用户能看出哪些音是"猜"的。
      confidence: Number.isFinite(note.score) ? note.score : Number.NaN,
    }));
    startBeat += eventLength;
  });
  return { notes, staffFound: true, staffCount: staves.length };
}
function drawNoteOverlay(notes, focusedNoteId = null) {
  clearOverlay();
  const ctx = els.overlayCanvas.getContext("2d");
  for (const note of notes) {
    if (!Number.isFinite(note.x) || !Number.isFinite(note.y)) continue;
    const focused = note.id === focusedNoteId;
    ctx.beginPath();
    ctx.arc(note.x, note.y, focused ? 8 : 5, 0, Math.PI * 2);
    ctx.fillStyle = focused ? "rgba(220, 145, 103, .35)" : "rgba(120, 167, 132, .19)";
    ctx.fill();
    ctx.lineWidth = focused ? 2.5 : 1.7;
    ctx.strokeStyle = focused ? "rgba(180, 92, 55, .95)" : "rgba(67, 117, 79, .82)";
    ctx.stroke();
  }
}
function focusNearestScoreNote(event) {
  const bounds = els.overlayCanvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const x = (event.clientX - bounds.left) * els.overlayCanvas.width / bounds.width;
  const y = (event.clientY - bounds.top) * els.overlayCanvas.height / bounds.height;
  let nearest = null, nearestDistance = Infinity;
  for (const note of state.notes) {
    if (!Number.isFinite(note.x) || !Number.isFinite(note.y)) continue;
    const distance = Math.hypot(note.x - x, note.y - y);
    if (distance < nearestDistance) { nearest = note; nearestDistance = distance; }
  }
  if (!nearest || nearestDistance > 42) return;
  const row = Array.from(els.noteList.querySelectorAll(".note-row")).find((item) => item.dataset.noteId === nearest.id);
  if (!row) return;
  row.scrollIntoView({ block: "nearest" });
  row.querySelector(".note-pitch")?.focus();
  drawNoteOverlay(state.notes, nearest.id);
}
function parsePitch(value) {
  const match = /^([A-Ga-g])(?:\(([-+]?\d+(?:\.\d+)?)\)|(##|bb|#|b))?(-?\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const letter = match[1].toUpperCase(), accidental = match[3] || "", octave = Number(match[4]);
  const alteration = match[2] !== undefined ? Number(match[2]) : ({ "##": 2, "#": 1, b: -1, bb: -2, "": 0 })[accidental];
  const midi = naturalMidi(letter, octave) + alteration;
  if (midi < 0 || midi > 127) return null;
  return { label: letter + (match[2] !== undefined ? `(${match[2]})` : accidental) + octave, midi };
}
function formatBeatCount(beats) {
  return Number.isInteger(beats) ? String(beats) : String(Number(beats.toFixed(3)));
}
function renderNotes() {
  els.noteList.replaceChildren();
  if (!state.notes.length) {
    els.notesEmpty.hidden = false;
    els.noteList.append(els.notesEmpty);
  } else {
    els.notesEmpty.hidden = true;
    state.notes.forEach((note, index) => {
      const row = document.createElement("div");
      row.className = "note-row";
      if (isLowConfidence(note)) row.classList.add("is-low-confidence");
      row.hidden = state.onlyLowConfidence && !isLowConfidence(note);
      row.dataset.noteId = note.id;
      row.dataset.eventId = String(note.eventId);
      const rowParts = [note.partName, note.voice ? `声部 ${note.voice}` : ""].filter(Boolean).join(" · ");
      const confidenceText = isLowConfidence(note) ? ` · 置信度偏低（${note.confidence.toFixed(2)}），建议校对` : "";
      row.title = rowParts + confidenceText;
      const indexLabel = document.createElement("span");
      indexLabel.className = "note-index";
      indexLabel.textContent = String(index + 1).padStart(2, "0");
      indexLabel.tabIndex = 0;
      indexLabel.setAttribute("role", "button");
      indexLabel.title = "点击设为选区起点，Shift+点击设为终点";
      const applySelection = (extend) => {
        state.selection = extend && state.selection
          ? { anchorId: state.selection.anchorId, focusId: note.id }
          : { anchorId: note.id, focusId: note.id };
        markSelectedRows();
        updateSelectionUi();
      };
      indexLabel.addEventListener("click", (event) => {
        event.preventDefault();
        applySelection(event.shiftKey);
      });
      indexLabel.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        applySelection(event.shiftKey);
      });
      const input = document.createElement("input");
      input.className = "note-pitch";
      input.type = "text";
      input.value = note.pitch;
      input.setAttribute("aria-label", "音符音高");
      input.autocomplete = "off";
      input.spellcheck = false;
      const startInput = document.createElement("input");
      startInput.className = "note-onset";
      startInput.type = "number";
      startInput.min = "0";
      startInput.step = "any";
      startInput.value = formatBeatCount(Number(note.startBeat) || 0);
      startInput.setAttribute("aria-label", "音符起拍（以四分音符为一拍）");
      startInput.title = "从乐曲开始计算的拍数，以四分音符为一拍";
      const durationSelect = document.createElement("select");
      durationSelect.className = "note-duration";
      durationSelect.setAttribute("aria-label", "音符时值");
      if (note.duration === "custom") {
        const customOption = document.createElement("option");
        customOption.value = "custom";
        customOption.textContent = `原时值 · ${formatBeatCount(beatsForNote(note))} 拍`;
        durationSelect.append(customOption);
      }
      for (const [value, label] of durations) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        durationSelect.append(option);
      }
      durationSelect.value = note.duration;
      const deleteButton = document.createElement("button");
      deleteButton.className = "delete-note";
      deleteButton.type = "button";
      deleteButton.title = "删除音符";
      deleteButton.setAttribute("aria-label", "删除音符");
      deleteButton.textContent = "×";
      row.append(indexLabel, input, startInput, durationSelect, deleteButton);
      const focusScoreNote = () => drawNoteOverlay(state.notes, note.id);
      const clearFocusedScoreNote = () => drawNoteOverlay(state.notes);
      input.addEventListener("focus", focusScoreNote);
      startInput.addEventListener("focus", focusScoreNote);
      durationSelect.addEventListener("focus", focusScoreNote);
      row.addEventListener("mouseenter", focusScoreNote);
      row.addEventListener("mouseleave", clearFocusedScoreNote);
      input.addEventListener("change", () => {
        const parsed = parsePitch(input.value);
        if (!parsed) {
          input.setCustomValidity("请输入音名，如 C4、F#4、Bb3 或 C(+0.5)4");
          input.reportValidity();
          input.value = note.pitch;
          input.setCustomValidity("");
          return;
        }
        note.pitch = parsed.label;
        note.midi = parsed.midi;
        updatePlaybackReady();
      });
      startInput.addEventListener("change", () => {
        const rawStartBeat = startInput.value.trim();
        const startBeat = Number(rawStartBeat);
        if (!rawStartBeat || !Number.isFinite(startBeat) || startBeat < 0) {
          startInput.setCustomValidity("起拍需要是大于或等于 0 的数字。");
          startInput.reportValidity();
          startInput.value = formatBeatCount(Number(note.startBeat) || 0);
          startInput.setCustomValidity("");
          return;
        }
        note.startBeat = startBeat;
        updatePlaybackReady();
      });
      durationSelect.addEventListener("change", (event) => {
        note.duration = event.target.value;
        if (durationBeats[note.duration]) note.durationBeats = durationBeats[note.duration];
      });
      deleteButton.addEventListener("click", () => {
        state.notes = state.notes.filter((item) => item.id !== note.id);
        updateVoiceOptions();
        renderNotes();
        drawNoteOverlay(state.notes);
      });
      els.noteList.append(row);
    });
  }
  els.lowConfidenceButton.hidden = !hasLowConfidenceNotes();
  // 只有带谱面坐标的结果（图片路径）才有 overlay 圆点；MusicXML 导入没有坐标，别显示误导性的图例。
  els.scoreLegend.hidden = !state.notes.some((note) => Number.isFinite(note.x) && Number.isFinite(note.y));
  markSelectedRows();
  updateSelectionUi();
}
function updateVoiceOptions(reset = false) {
  const previous = reset ? "all" : (els.voiceFilter.value || "all");
  const groups = new Map();
  for (const note of state.notes) {
    const key = voiceIdentity(note);
    if (!groups.has(key)) {
      const staffText = note.staff ? ` · 谱表 ${note.staff}` : "";
      const voiceText = note.voice ? ` · 声部 ${note.voice}` : "";
      groups.set(key, `${note.partName || "乐谱"}${staffText}${voiceText}`);
    }
  }
  els.voiceFilter.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "全部声部";
  els.voiceFilter.append(allOption);
  for (const [key, label] of groups) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    els.voiceFilter.append(option);
  }
  els.voiceFilter.value = groups.has(previous) ? previous : "all";
  els.voiceFilterField.hidden = groups.size < 2;
}
// 选区：以音符在列表中的顺序区间表示（锚点 + 焦点）
function selectionRange() {
  if (!state.selection) return null;
  const ids = state.notes.map((note) => note.id);
  const anchorIndex = ids.indexOf(state.selection.anchorId);
  const focusIndex = ids.indexOf(state.selection.focusId ?? state.selection.anchorId);
  if (anchorIndex < 0 || focusIndex < 0) return null;
  const start = Math.min(anchorIndex, focusIndex), end = Math.max(anchorIndex, focusIndex);
  return { start, end, ids: ids.slice(start, end + 1) };
}
function markSelectedRows() {
  const range = selectionRange();
  const selectedIds = range ? new Set(range.ids) : null;
  for (const row of els.noteList.querySelectorAll(".note-row")) {
    row.classList.toggle("is-selected", Boolean(selectedIds && selectedIds.has(row.dataset.noteId)));
  }
}
function updateSelectionUi() {
  const range = selectionRange();
  if (range) {
    els.selectionBar.classList.add("is-active");
    els.selectionLabel.textContent = `已选第 ${range.start + 1}–${range.end + 1} 个音符，共 ${range.ids.length} 个`;
    els.clearSelection.hidden = false;
  } else {
    els.selectionBar.classList.remove("is-active");
    els.selectionLabel.textContent = "未选择片段：点音符序号设起点，Shift+点设终点";
    els.clearSelection.hidden = true;
  }
  els.loopToggle.checked = state.loop;
  updatePlaybackReady();
}
function getPlaybackNotes() {
  const selected = els.voiceFilter.value;
  const voiceNotes = (!selected || selected === "all") ? state.notes : state.notes.filter((note) => voiceIdentity(note) === selected);
  const range = selectionRange();
  if (!range) return voiceNotes;
  const selectedIds = new Set(range.ids);
  return voiceNotes.filter((note) => selectedIds.has(note.id));
}
// 试听/导出的时间轴：把选区（或整曲）整体平移到从第 0 拍开始，
// 这样选中片段不会因为前面的空白而延迟很久才响。
function playbackTimeline() {
  const notes = getPlaybackNotes();
  if (!notes.length) return { notes: [], offset: 0, finishBeat: 0 };
  const rawOffset = notes.reduce((min, note) => Math.min(min, Number(note.startBeat) || 0), Infinity);
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
  const finishBeat = notes.reduce((end, note) => Math.max(end, (Number(note.startBeat) || 0) - offset + beatsForNote(note)), 0);
  return { notes, offset, finishBeat };
}
function updatePlaybackReady() {
  const activeNotes = getPlaybackNotes();
  els.noteCount.innerHTML = activeNotes.length + " <small>个</small>";
  els.playButton.disabled = activeNotes.length === 0 || activeNotes.some((note) => !Number.isFinite(note.midi)) || state.isPlaying;
  els.midiButton.disabled = activeNotes.length === 0;
  els.midiButton.title = selectionRange() ? "下载所选片段的 MIDI 文件" : "下载 MIDI 文件";
  // 播放控件文案与选区状态保持一致（否则选完片段按钮仍写着"试听旋律"）。
  els.playIcon.textContent = state.isPlaying ? "Ⅱ" : "▶";
  els.playLabel.textContent = state.isPlaying ? "正在播放" : (selectionRange() ? "试听选区" : "试听旋律");
  els.stopButton.disabled = !state.isPlaying;
}
function addNote() {
  if (els.voiceFilter.value !== "all") els.voiceFilter.value = "all";
  const eventId = state.notes.length ? Math.max(...state.notes.map((note) => note.eventId)) + 1 : 0;
  const startBeat = state.notes.reduce((end, note) => Math.max(end, note.startBeat + beatsForNote(note)), 0);
  state.notes.push({ id: makeId(), eventId, pitch: "C4", midi: 60, duration: "quarter", durationBeats: 1, startBeat, x: NaN, y: NaN });
  renderNotes();
  els.noteList.scrollTop = els.noteList.scrollHeight;
}
async function recognizeWithLocalHomr() {
  if (typeof els.scoreCanvas.toBlob !== "function") return { unavailable: true };
  const imageBlob = await new Promise((resolve) => els.scoreCanvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!imageBlob) return { unavailable: true };
  try {
    const response = await fetch("/api/omr/recognize", {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: imageBlob,
    });
    const payload = await response.json();
    if (response.status === 503) return { unavailable: true };
    if (!response.ok) return { error: payload.error || "本机 OMR 引擎没有完成识谱。" };
    return { scoreInfo: parseMusicXmlText(payload.musicxml) };
  } catch (error) {
    console.info("本机 OMR 未响应，改用浏览器基础检测。", error);
    return { unavailable: true };
  }
}
async function recognizeScore() {
  if (!state.file || !els.scoreCanvas.width) return;
  // 重入保护：识别期间再点（或改动谱号/谱表触发的自动重识别）直接忽略，
  // 否则两次识别会互相覆盖 state.notes / 按钮状态，并让本机引擎被并发调用。
  if (state.isRecognizing) return;
  state.isRecognizing = true;
  const token = ++state.recognizeToken;
  const fileToken = state.loadToken;
  const superseded = () => token !== state.recognizeToken || fileToken !== state.loadToken;
  stopPlayback();
  state.selection = null;
  els.processingOverlay.hidden = false;
  els.recognizeButton.disabled = true;
  els.recognizeLabel.textContent = "正在识别…";
  els.clefSelect.disabled = true;
  els.staffSelect.disabled = true;
  els.scoreHint.textContent = homrAvailable === false
    ? "未检测到专业引擎，正在做粗略估算"
    : "正在尝试本机专业识别；若未安装则改用粗略估算";
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 30)));
  try {
    const homrResult = await recognizeWithLocalHomr();
    if (superseded()) return;
    // 引擎返回了结果但一个带音高音符都没有时，视为失败，继续走估算兜底。
    const engineScore = homrResult.scoreInfo && homrResult.scoreInfo.notes.length ? homrResult.scoreInfo : null;
    if (engineScore) {
      for (const note of engineScore.notes) note.duration = durationFromBeats(note.durationBeats);
      state.scoreInfo = engineScore;
      state.notes = engineScore.notes;
      state.recognitionSource = "engine";
      updateVoiceOptions(true);
      state.recognized = true;
      els.clefSelect.disabled = true;
      updateStaffOptions(0);
      renderNotes();
      drawNoteOverlay(engineScore.notes);
      updateRecognitionBanner();
      els.scoreHint.textContent = `本机专业引擎完成识别：${engineScore.notes.length} 个音符，已生成节奏与声部。`;
      const warning = engineScore.warnings[0] ? ` ${engineScore.warnings[0]}` : "";
      showToast(`识别到 ${engineScore.notes.length} 个音符，请逐音校对。${warning}`);
      return;
    }

    state.scoreInfo = null;
    els.clefSelect.disabled = false;
    const result = analyzeCanvas();
    if (superseded()) return;
    state.notes = result.notes;
    state.recognitionSource = result.notes.length ? "estimate" : null;
    updateVoiceOptions(true);
    state.recognized = result.staffFound;
    updateStaffOptions(result.staffFound ? result.staffCount : 0);
    renderNotes();
    drawNoteOverlay(result.notes);
    updateRecognitionBanner();
    if (!result.staffFound) {
      els.scoreHint.textContent = "未找到清晰的五线谱";
      showToast("没能找到五线谱。请试试更清晰、对比度更高的谱面图片。");
    } else if (!result.notes.length) {
      els.scoreHint.textContent = "已找到谱表，暂未识别到音符";
      showToast("找到谱表但没有提取到音符，可以点击“添加”手动录入旋律。");
    } else {
      els.scoreHint.textContent = "检测到 " + result.staffCount + " 行谱表，音符位置以圆点标记";
      const fallbackReason = homrResult.error
        ? "本机专业引擎未能完成，"
        : homrResult.unavailable ? "未找到本机专业引擎，" : "";
      showToast(fallbackReason + "粗略估算出 " + result.notes.length + " 个音符，请逐音校对音高与时值。");
    }
  } catch (error) {
    if (superseded()) return;
    console.error(error);
    // 识别失败时清掉上一次的结果，避免旧音符继续被当作"本次识别结果"试听和导出。
    state.notes = [];
    state.scoreInfo = null;
    state.recognitionSource = null;
    state.recognized = false;
    renderNotes();
    clearOverlay();
    updateRecognitionBanner();
    showToast("识别时遇到问题，请换一张更清晰的图片再试。");
    els.scoreHint.textContent = "识别失败，已清空上一次的结果";
  } finally {
    if (!superseded()) {
      state.isRecognizing = false;
      els.processingOverlay.hidden = true;
      els.recognizeButton.disabled = !state.file;
      els.recognizeLabel.textContent = idleRecognizeLabel();
      els.clefSelect.disabled = false;
      els.staffSelect.disabled = false;
    }
  }
}
function updateStaffOptions(count) {
  const selected = Math.min(Number(els.staffSelect.value) || 0, Math.max(0, count - 1));
  els.staffSelect.replaceChildren();
  for (let index = 0; index < count; index++) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = "第 " + (index + 1) + " 行谱表（从上往下）";
    els.staffSelect.append(option);
  }
  els.staffSelect.value = String(selected);
  els.staffSelectField.hidden = count < 2;
}
function variableLength(value) {
  let remaining = Math.max(0, Math.floor(value));
  const bytes = [remaining & 0x7f];
  remaining = Math.floor(remaining / 128);
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 128);
  }
  return bytes;
}
function buildMidiFile(notes = getPlaybackNotes(), offset = 0) {
  const ticksPerBeat = 480;
  const tempo = Math.min(320, Math.max(20, Number(els.tempoInput.value) || 84));
  const microsPerBeat = Math.round(60000000 / tempo);
  const events = [{
    tick: 0, priority: 0,
    bytes: [0xff, 0x51, 0x03, (microsPerBeat >> 16) & 0xff, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff],
  }];
  for (const note of notes) {
    if (!Number.isFinite(note.midi)) continue;
    const startTick = Math.max(0, Math.round(((note.startBeat || 0) - offset) * ticksPerBeat));
    const endTick = startTick + Math.max(1, Math.round(beatsForNote(note) * ticksPerBeat));
    const midi = Math.min(127, Math.max(0, Math.round(note.midi)));
    events.push({ tick: startTick, priority: 2, bytes: [0x90, midi, 88] });
    events.push({ tick: endTick, priority: 1, bytes: [0x80, midi, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.priority - b.priority);
  const track = [];
  let previousTick = 0;
  for (const event of events) {
    track.push(...variableLength(event.tick - previousTick), ...event.bytes);
    previousTick = event.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);
  const header = [0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x01, 0xe0];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, (track.length >>> 24) & 0xff, (track.length >>> 16) & 0xff, (track.length >>> 8) & 0xff, track.length & 0xff];
  return new Blob([new Uint8Array([...header, ...trackHeader, ...track])], { type: "audio/midi" });
}
function downloadMidi() {
  const { notes, offset } = playbackTimeline();
  if (!notes.length) return;
  const url = URL.createObjectURL(buildMidiFile(notes, offset));
  const anchor = document.createElement("a");
  const baseName = state.file ? state.file.name.replace(/\.[^.]+$/, "") : "谱见旋律";
  anchor.href = url;
  anchor.download = baseName.replace(/[\\/:*?"<>|]/g, "_") + ".mid";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(selectionRange() ? "所选片段的 MIDI 已下载。" : "MIDI 文件已下载。");
}
function midiFrequency(midi) { return 440 * (2 ** ((midi - 69) / 12)); }
function playTone(midi, startAt, duration) {
  const audio = state.audio, gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.055, startAt + Math.min(0.18, duration * 0.42));
  gain.gain.setValueAtTime(0.05, Math.max(startAt + 0.03, startAt + duration - 0.045));
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
  gain.connect(audio.destination);
  const oscillator = audio.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(midiFrequency(midi), startAt);
  oscillator.connect(gain);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.015);
  state.sources.add(oscillator);
  oscillator.onended = () => {
    // 连接到 destination 的节点不会被垃圾回收，必须显式断开，
    // 否则每次试听都会永久留下一批 gain + oscillator，反复试听后音频图会持续膨胀。
    try {
      gain.disconnect();
      oscillator.disconnect();
    } catch (error) {
      console.info("音频节点释放时出错（通常可忽略）。", error);
    }
    state.sources.delete(oscillator);
  };
}
async function playMelody() {
  const { notes: playbackNotes, offset, finishBeat } = playbackTimeline();
  if (!playbackNotes.length || state.isPlaying) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return showToast("当前浏览器不支持音频播放，请使用较新的浏览器。");
  if (!state.audio) state.audio = new AudioContextClass();
  await state.audio.resume();
  // 清掉上一轮遗留的定时器（包括循环定时器），避免反复试听让定时器数组无界增长。
  for (const timer of state.timers) clearTimeout(timer);
  state.timers = [];
  const tempo = Math.min(320, Math.max(20, Number(els.tempoInput.value) || 84));
  els.tempoInput.value = tempo;
  const eventMap = new Map();
  for (const note of playbackNotes) {
    const onset = Math.max(0, (Number(note.startBeat) || 0) - offset);
    const onsetKey = onset.toFixed(6);
    if (!eventMap.has(onsetKey)) eventMap.set(onsetKey, { id: onsetKey, notes: [], startBeat: onset });
    const event = eventMap.get(onsetKey);
    event.notes.push(note);
    event.startBeat = Math.min(event.startBeat, onset);
  }
  const events = [...eventMap.values()].sort((a, b) => a.startBeat - b.startBeat);
  const beatSeconds = 60 / tempo, start = state.audio.currentTime + 0.06;
  state.isPlaying = true;
  updatePlaybackControls();
  for (const event of events) {
    for (const note of event.notes) {
      const seconds = beatsForNote(note) * beatSeconds;
      const at = start + Math.max(0, (Number(note.startBeat) || 0) - offset) * beatSeconds;
      playTone(note.midi, at, seconds * 0.92);
    }
    state.timers.push(setTimeout(() => highlightEvent(event.notes.map((note) => note.id)), event.startBeat * beatSeconds * 1000));
  }
  state.timers.push(setTimeout(() => {
    state.isPlaying = false;
    highlightEvent(null);
    updatePlaybackControls();
    if (state.loop && getPlaybackNotes().length) playMelody().catch((error) => console.error(error));
  }, finishBeat * beatSeconds * 1000 + 120));
}
function highlightEvent(noteIds) {
  const activeIds = noteIds === null ? null : new Set(noteIds);
  for (const row of els.noteList.querySelectorAll(".note-row")) {
    row.classList.toggle("is-playing", activeIds !== null && activeIds.has(row.dataset.noteId));
  }
}
function stopPlayback() {
  for (const timer of state.timers) clearTimeout(timer);
  state.timers = [];
  for (const source of state.sources) {
    try { source.stop(); } catch { /* The note may have just ended. */ }
  }
  state.sources.clear();
  state.isPlaying = false;
  highlightEvent(null);
  updatePlaybackControls();
}
function updatePlaybackControls() {
  updatePlaybackReady();
}
function handleDrop(event) {
  event.preventDefault();
  els.dropzone.classList.remove("is-dragging");
  const file = event.dataTransfer && event.dataTransfer.files[0];
  if (file) loadFile(file);
}
async function goToPdfPage(number) {
  if (!state.pdf) return;
  clearScore();
  const token = state.loadToken;
  await renderPdfPage(number, token);
  if (token !== state.loadToken) return;
  els.scoreHint.textContent = "可以开始识别此页";
}
els.fileInput.addEventListener("change", (event) => loadFile(event.target.files[0]));
els.chooseFileButton.addEventListener("click", () => els.fileInput.click());
els.removeFile.addEventListener("click", removeCurrentFile);
els.recognizeButton.addEventListener("click", recognizeScore);
els.addNoteButton.addEventListener("click", addNote);
els.midiButton.addEventListener("click", downloadMidi);
els.playButton.addEventListener("click", playMelody);
els.stopButton.addEventListener("click", stopPlayback);
els.canvasWrap.addEventListener("click", focusNearestScoreNote);
els.voiceFilter.addEventListener("change", () => {
  stopPlayback();
  updateSelectionUi();
});
els.lowConfidenceButton.addEventListener("click", () => {
  state.onlyLowConfidence = !state.onlyLowConfidence;
  els.lowConfidenceButton.classList.toggle("is-active", state.onlyLowConfidence);
  els.lowConfidenceButton.textContent = state.onlyLowConfidence ? "显示全部" : "只看待校对";
  renderNotes();
});
els.loopToggle.addEventListener("change", () => {
  state.loop = els.loopToggle.checked;
  updateSelectionUi();
});
els.clearSelection.addEventListener("click", () => {
  state.selection = null;
  markSelectedRows();
  updateSelectionUi();
});
els.prevPage.addEventListener("click", () => goToPdfPage(state.pageNumber - 1));
els.nextPage.addEventListener("click", () => goToPdfPage(state.pageNumber + 1));
els.clefSelect.addEventListener("change", () => { if (state.file && state.recognized) recognizeScore(); });
els.staffSelect.addEventListener("change", () => { if (state.file && state.recognized) recognizeScore(); });
els.dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); els.fileInput.click(); }
});
for (const name of ["dragenter", "dragover"]) els.dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  els.dropzone.classList.add("is-dragging");
});
for (const name of ["dragleave", "drop"]) els.dropzone.addEventListener(name, (event) => {
  event.preventDefault();
  els.dropzone.classList.remove("is-dragging");
});
els.dropzone.addEventListener("drop", handleDrop);
els.tempoInput.addEventListener("change", () => {
  els.tempoInput.value = Math.min(320, Math.max(20, Number(els.tempoInput.value) || 84));
});
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.target.matches("input, select, textarea, button")) return;
  event.preventDefault();
  if (state.isPlaying) stopPlayback();
  else if (!els.playButton.disabled) playMelody();
});
renderNotes();
refreshEngineStatus();
