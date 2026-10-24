// 音源加载提速验证：
//   1) 整库加载（没有乐谱信息）vs 按需加载（有当前乐谱音高）——同一个 bank 的耗时/样本数/内存；
//   2) 缓存命中（已加载过的 bank 再取一次）；
//   3) 加载多个 bank 后回头再用第一个（验证不会被淘汰重载）。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const APP = process.env.APP_URL || "http://127.0.0.1:4492/";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));
await page.goto(APP + "?debug=1", { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__pujian && window.__pujian.state.sampleManifest, null, { timeout: 60000 });
await page.waitForTimeout(400);

const result = await page.evaluate(async () => {
  const debug = window.__pujian;
  const state = debug.state;
  const out = {};

  const measure = async (name, options = {}) => {
    const t0 = performance.now();
    const bank = await debug.ensureSampleBank(name, options);
    const ms = Math.round(performance.now() - t0);
    let samples = 0;
    let mb = 0;
    if (bank) {
      for (const layer of bank.layers) {
        for (const sample of layer.samples) {
          samples += 1;
          if (sample.buffer) mb += sample.buffer.length * 4;
        }
      }
    }
    return { name, ms, samples, mb: Math.round(mb / 1048576), partial: bank ? Boolean(bank.partial) : null, loaded: Boolean(bank) };
  };
  const reset = () => {
    state.sampleBanks.clear();
    state.sampleOrder = [];
  };

  // 场景 A：没有乐谱信息 → 整库加载
  reset();
  out.fullPiano = await measure("piano_real");

  // 场景 B：有乐谱（音高 55–79，25 个音）→ 按需加载
  reset();
  state.partTimbres.set("P1", "piano_real");
  state.notes = [];
  for (let midi = 55; midi <= 79; midi += 1) {
    state.notes.push({ id: "t" + midi, eventId: midi, partId: "P1", partName: "P1", midi, pitch: "C4", duration: "quarter", durationBeats: 1, startBeat: midi });
  }
  const needed = debug.midisForTimbre("piano_real");
  out.neededMidis = needed.size;
  out.ondemandPiano = await measure("piano_real", { midis: needed });

  // 场景 C：缓存命中（再取一次）
  const t0 = performance.now();
  await debug.ensureSampleBank("piano_real", { midis: needed });
  out.cachedHitMs = Math.round(performance.now() - t0);

  // 场景 D：再加载 5 个别的音源，然后回头用 piano_real（当前乐谱在用它，不应被淘汰）
  const others = ["strings_real", "choir_real", "erhu_real", "guzheng_real", "timpani_real"];
  out.others = [];
  for (const name of others) out.others.push(await measure(name));
  out.backToPiano = await measure("piano_real", { midis: needed });
  out.cachedBanks = state.sampleBanks.size;
  out.cachedNames = [...state.sampleBanks.keys()];

  // 场景 E：换一个「当前乐谱没用」的音源进来，看是否会挤掉最久没用的
  out.extra = await measure("violin_real");
  out.cachedBanksAfter = state.sampleBanks.size;
  return out;
});

console.log(JSON.stringify(result, null, 1));
await browser.close();
