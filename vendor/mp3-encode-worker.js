// MP3 编码 Worker：用 WebAssembly 版 LAME 编码，比纯 JS 的 lamejs 快约 3–5 倍，
// 而且整个编码过程不占用主线程——导出时浏览器不会卡住。
//
// 主线程协议（postMessage）：
//   发来 { type: "encode", left: Float32Array, right: Float32Array, sampleRate, kbps }
//     （left/right 用 transferable 传进来，不复制、不额外占内存）
//   回   { type: "progress", done: 0..1 }
//   回   { type: "done", mp3: ArrayBuffer, elapsedMs }（transferable）
//   回   { type: "error", message }
//
// 说明：这里用 createEncoder + 显式 wasm URL，而不是 createMp3Encoder()——
// 后者会把 wasm 内联成 data: URL 再 fetch，在 CSP 下需要额外放开 connect-src data:；
// 显式 URL 走同源静态文件，更干净。

let modulePromise = null;

function loadModule() {
  if (!modulePromise) modulePromise = import("./wasm-mp3/wasm-media-encoders.mjs");
  return modulePromise;
}

async function handleEncode(message) {
  const module = await loadModule();
  const wasmUrl = new URL("./wasm-mp3/mp3.wasm", self.location.href).href;
  const encoder = await module.createEncoder("audio/mpeg", wasmUrl);
  const sampleRate = message.sampleRate || 44100;
  const kbps = message.kbps || 128;
  encoder.configure({ sampleRate, channels: 2, bitrate: kbps });
  const left = message.left;
  const right = message.right;
  const total = left.length;
  // 每次喂 0.5 秒：太碎会增加 wasm 调用开销，太大又收不到进度
  const blockSize = Math.max(4096, Math.floor(sampleRate / 2));
  const chunks = [];
  let totalBytes = 0;
  let lastReportAt = 0;
  const startedAt = Date.now();
  for (let offset = 0; offset < total; offset += blockSize) {
    const end = Math.min(total, offset + blockSize);
    const encoded = encoder.encode([left.subarray(offset, end), right.subarray(offset, end)]);
    if (encoded.length) {
      const copy = new Uint8Array(encoded.length);
      copy.set(encoded);           // encoder 返回的 buffer 会被下一次调用复用，必须复制
      chunks.push(copy);
      totalBytes += copy.length;
    }
    const now = Date.now();
    if (now - lastReportAt > 120) {
      lastReportAt = now;
      self.postMessage({ type: "progress", done: end / total });
    }
  }
  const tail = encoder.finalize();
  if (tail.length) {
    const copy = new Uint8Array(tail.length);
    copy.set(tail);
    chunks.push(copy);
    totalBytes += copy.length;
  }
  const merged = new Uint8Array(totalBytes);
  let writeAt = 0;
  for (const chunk of chunks) {
    merged.set(chunk, writeAt);
    writeAt += chunk.length;
  }
  self.postMessage({ type: "done", mp3: merged.buffer, elapsedMs: Date.now() - startedAt }, [merged.buffer]);
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type !== "encode") return;
  handleEncode(message).catch((error) => {
    self.postMessage({ type: "error", message: String((error && error.message) || error) });
  });
};
