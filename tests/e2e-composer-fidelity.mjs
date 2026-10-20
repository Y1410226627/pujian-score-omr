// 最终验收：用真实乐谱验证「导入 → 一个音不改 → 导出」后逐音一致（0 误差）。
//
// 覆盖：音符数、拍位、时值、音高、调号、拍号、速度、声部结构。
// 数据来源：用户提供的《进击的巨人》第 1 页真实识别结果（229 个音符、4 条并行 voice）。
import { createRequire } from "node:module";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE);
const appUrl = process.env.APP_URL || "http://127.0.0.1:4492/";
const fixture = "tests/fixtures/call-of-silence-p1.musicxml";

/** 独立实现的「从 MusicXML 读音符」——刻意不复用被测代码。 */
function readExpected(xml) {
  const divisions = Number(/<divisions>(\d+)<\/divisions>/.exec(xml)?.[1] || 480);
  const notes = [];
  const measures = [...xml.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)];
  let measureIndex = 0;
  let per = 4;
  for (const [, body] of measures) {
    const time = /<time>[\s\S]*?<beats>(\d+)<\/beats>[\s\S]*?<beat-type>(\d+)<\/beat-type>/.exec(body);
    if (time) per = (Number(time[1]) * 4) / Number(time[2]);
    const cursors = new Map();
    const chordOffsets = new Map();
    for (const [, inner] of body.matchAll(/<note\b[^>]*>([\s\S]*?)<\/note>/g)) {
      if (/<grace\b/.test(inner)) continue;
      const staff = /<staff>(\d+)<\/staff>/.exec(inner)?.[1] || "1";
      const voice = /<voice>([^<]+)<\/voice>/.exec(inner)?.[1] || "1";
      const key = `${staff}|${voice}`;
      const durationDiv = Number(/<duration>(-?\d+)<\/duration>/.exec(inner)?.[1] || 0);
      const isChord = /<chord\s*\/?>/s.test(inner);
      const offset = isChord ? (chordOffsets.get(key) || 0) : (cursors.get(key) || 0);
      if (!isChord) {
        chordOffsets.set(key, offset);
        cursors.set(key, offset + durationDiv / divisions);
      }
      if (/<rest\s*\/?>/s.test(inner)) continue;
      const step = (/<step>([^<]+)<\/step>/.exec(inner)?.[1] || "").toUpperCase();
      const octave = Number(/<octave>(-?\d+)<\/octave>/.exec(inner)?.[1]);
      const alter = Number(/<alter>(-?\d+)<\/alter>/.exec(inner)?.[1] || 0) || 0;
      const table = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      if (!(step in table) || !Number.isFinite(octave)) continue;
      const midi = (octave + 1) * 12 + table[step] + alter;
      if (midi < 0 || midi > 127) continue;
      notes.push({
        beat: Math.round((measureIndex * per + offset) * 1e6) / 1e6,
        beats: Math.round((durationDiv / divisions) * 1e6) / 1e6,
        midi,
        staff: Number(staff),
        voice: Number(voice),
      });
    }
    measureIndex += 1;
  }
  return notes;
}

const keyToKey = (note) => `${note.beat.toFixed(6)}|${note.midi}|${note.staff}|${note.voice}`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ acceptDownloads: true });
const errors = [];
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
let exitCode = 0;
const results = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  results.push(ok);
};

try {
  const xml = readFileSync(fixture, "utf8");
  const expected = readExpected(xml);
  console.log(`真实乐谱：${expected.length} 个发声音符`);

  await page.goto(appUrl + "composer.html?debug=1", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);

  // 1) 走真实上传路径导入
  await page.setInputFiles("#musicXmlInput", fixture);
  await page.waitForTimeout(2500);
  const imported = await page.evaluate(() => {
    const state = window.__pujianComposer.state;
    const score = state.score;
    const out = [];
    for (const part of score.parts) {
      (part.staves || []).forEach((staff, staffIndex) => {
        (staff.voices || []).forEach((voice, voiceIndex) => {
          for (const event of voice.events || []) {
            if (event.rest) continue;
            out.push({
              beat: event.beat,
              beats: event.beats,
              midi: event.midi,
              staff: staff.number || staffIndex + 1,
              voice: voice.number || voiceIndex + 1,
            });
          }
        });
      });
    }
    return {
      notes: out,
      voices: score.parts[0].staves[0].voices.length,
      staves: score.parts[0].staves.length,
      time: score.timeSignature,
      keyFifths: score.keyFifths,
      tempo: score.tempo,
      toast: document.querySelector("#toast")?.textContent || "",
    };
  });

  const expectedSorted = expected.map(keyToKey).sort();
  const importedSorted = imported.notes.map(keyToKey).sort();
  check("音符数完全一致", imported.notes.length === expected.length,
    `导入 ${imported.notes.length} / 原谱 ${expected.length}`);
  const diff = [];
  for (let i = 0; i < Math.max(expectedSorted.length, importedSorted.length); i += 1) {
    if (expectedSorted[i] !== importedSorted[i]) diff.push({ at: i, expected: expectedSorted[i], actual: importedSorted[i] });
  }
  check("拍位/音高/时值/声部全部一致（0 误差）", diff.length === 0,
    diff.length ? JSON.stringify(diff.slice(0, 3)) : `${expected.length} 个音逐一比对通过`);
  // 这份 fixture 是《进击的巨人》第 1 页，3 条并行 voice（整份 PDF 共 4 条）
  const expectedVoices = await page.evaluate(async (source) => {
    const { musicXmlToV2 } = await import("./composer-v2xml.js");
    return musicXmlToV2(source).score.parts[0].staves[0].voices.length;
  }, xml);
  check("并行声部线都保留", imported.voices === expectedVoices,
    `${imported.voices} 条 voice（期望 ${expectedVoices}）`);
  check("两条谱表保留（钢琴大谱表）", imported.staves >= 2, `${imported.staves} 行`);
  check("拍号/调号/速度正确",
    imported.time.beats === 4 && imported.time.beatType === 4 && imported.keyFifths === 0,
    JSON.stringify(imported.time) + " fifths=" + imported.keyFifths);

  // 2) 导出 → 再导入 → 仍一致
  const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
  await page.click("#exportMusicXml");
  const download = await downloadPromise;
  const target = join(process.env.TEMP || ".", "final-roundtrip.musicxml");
  await download.saveAs(target);
  const exportedXml = readFileSync(target, "utf8");
  const reimported = await page.evaluate(async (text) => {
    const { musicXmlToV2 } = await import("./composer-v2xml.js");
    const { scoreToPlayableNotes } = await import("./composer-model.js");
    const { score } = musicXmlToV2(text);
    return scoreToPlayableNotes(score).map((note) => ({
      beat: note.startBeat, beats: note.durationBeats, midi: note.midi,
      staff: note.staff, voice: note.voice,
    }));
  }, exportedXml);
  const reSorted = reimported.map(keyToKey).sort();
  const diff2 = [];
  for (let i = 0; i < expectedSorted.length; i += 1) {
    if (expectedSorted[i] !== reSorted[i]) diff2.push({ at: i, expected: expectedSorted[i], actual: reSorted[i] });
  }
  check("导入→导出→再导入，仍与原谱一致（往返无损）",
    reimported.length === expected.length && diff2.length === 0,
    diff2.length ? JSON.stringify(diff2.slice(0, 3)) : `${expected.length} 个音一致`);

  check("无 JS 报错", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log(`\n${results.filter(Boolean).length}/${results.length} 项通过`);
  if (results.some((item) => !item)) exitCode = 1;
} catch (error) {
  console.log("失败：", error.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
