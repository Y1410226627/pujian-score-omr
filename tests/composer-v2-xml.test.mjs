import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";

import { musicXmlToV2, v2ToMusicXml } from "../composer-v2xml.js";
import { scoreToPlayableNotes, beatsPerMeasure } from "../composer-model.js";

// 真实乐谱：用户提供的《进击的巨人 Call of Silence》第 1 页，由项目自己的识别引擎产出
const REAL_XML = readFileSync(new URL("./fixtures/call-of-silence-p1.musicxml", import.meta.url), "utf8");

test("真实乐谱：每个音符的拍位/时值/音高都与原谱一致（0 误差）", () => {
  const { score } = musicXmlToV2(REAL_XML, { DOMParser });
  const imported = scoreToPlayableNotes(score);

  // 从原始 MusicXML 独立算一遍「应该有哪些音」
  const expected = readExpectedNotes(REAL_XML);

  assert.ok(expected.length > 100, `样本应有足够多的音，实际 ${expected.length}`);
  assert.equal(imported.length, expected.length,
    `音符数必须完全一致：导入 ${imported.length}，原谱 ${expected.length}`);

  // 逐音对账（按 拍位 + 音高 配对，两边都排序）
  // 同一拍同一音高可能同时出现在上下两行谱表（左手伴奏 + 右手旋律），
  // 所以对账要把「谱表 + voice」也带上，否则会把两个不同声部的音当成一个。
  const sortKey = (note) => `${note.startBeat.toFixed(6)}|${note.midi}|${note.staff || ""}|${note.voice || ""}`;
  const importedKeys = imported.map(sortKey).sort();
  const expectedKeys = expected.map(sortKey).sort();
  const mismatched = [];
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (expectedKeys[index] !== importedKeys[index]) {
      mismatched.push({ expected: expectedKeys[index], actual: importedKeys[index] });
    }
  }
  assert.deepEqual(mismatched.slice(0, 5), [], `拍位/音高不符：${JSON.stringify(mismatched.slice(0, 5))}`);

  // 时值也要逐一对上
  const durationOf = new Map();
  for (const note of imported) durationOf.set(sortKey(note), note.durationBeats);
  const durationMismatch = [];
  for (const note of expected) {
    const key = sortKey(note);
    const actual = durationOf.get(key);
    if (actual === undefined || Math.abs(actual - note.durationBeats) > 1e-6) {
      durationMismatch.push({ key, expected: note.durationBeats, actual });
    }
  }
  assert.deepEqual(durationMismatch.slice(0, 5), [], `时值不符：${JSON.stringify(durationMismatch.slice(0, 5))}`);
});

test("真实乐谱：并行声部与谱表都被保留（不再被压扁）", () => {
  const { score, stats } = musicXmlToV2(REAL_XML, { DOMParser });
  const voiceCount = score.parts.reduce((sum, part) => sum
    + part.staves.reduce((inner, staff) => inner + staff.voices.length, 0), 0);
  const staffCount = score.parts.reduce((sum, part) => sum + part.staves.length, 0);
  console.log("   声部统计：", JSON.stringify({
    parts: score.parts.length, staves: staffCount, voices: voiceCount,
    notes: stats.notes, chords: stats.chords, ties: stats.ties, slurs: stats.slurs,
    rests: stats.rests, measures: stats.measures,
  }));
  assert.ok(voiceCount >= 4, `应保留至少 4 条并行 voice，实际 ${voiceCount}`);
  assert.ok(staffCount >= 2, `钢琴谱应有上下两条谱表，实际 ${staffCount}`);
  assert.ok(stats.chords > 50, `和弦应被保留，实际 ${stats.chords}`);
  assert.ok(stats.ties > 20, `连音线应被保留，实际 ${stats.ties}`);
  assert.ok(stats.slurs > 0, `圆滑线应被保留，实际 ${stats.slurs}`);
});

test("真实乐谱：导入 → 导出 MusicXML → 再导入，音符完全不变（往返无损）", () => {
  const first = musicXmlToV2(REAL_XML, { DOMParser });
  const xml = v2ToMusicXml(first.score);
  const second = musicXmlToV2(xml, { DOMParser });
  const a = scoreToPlayableNotes(first.score).map((note) => `${note.startBeat}|${note.midi}|${note.durationBeats}`).sort();
  const b = scoreToPlayableNotes(second.score).map((note) => `${note.startBeat}|${note.midi}|${note.durationBeats}`).sort();
  assert.deepEqual(b, a, "往返后音符、拍位、时值必须完全相同");
});

test("真实乐谱：拍号/调号/速度/小节数都对", () => {
  const { score } = musicXmlToV2(REAL_XML, { DOMParser });
  assert.deepEqual(score.timeSignature, { beats: 4, beatType: 4 });
  assert.equal(beatsPerMeasure(score), 4);
  assert.ok(score.tempo > 0, "应读到速度");
  const totalBeats = Math.max(...scoreToPlayableNotes(score).map((note) => note.startBeat + note.durationBeats));
  assert.ok(totalBeats > 100, `总长度应覆盖整页，实际 ${totalBeats} 拍`);
});

/**
 * 独立实现一遍「从 MusicXML 读期望的音符列表」，用于对账。
 * 刻意不复用被测代码，避免「自己验证自己」。
 */
function readExpectedNotes(xml) {
  const divMatch = /<divisions>(\d+)<\/divisions>/.exec(xml);
  const divisions = divMatch ? Number(divMatch[1]) : 480;
  const notes = [];
  const measureRegex = /<measure\b[^>]*>([\s\S]*?)<\/measure>/g;
  let measureIndex = 0;
  let per = 4;
  let measureMatch;
  while ((measureMatch = measureRegex.exec(xml)) !== null) {
    const body = measureMatch[1];
    const timeMatch = /<time>[\s\S]*?<beats>(\d+)<\/beats>[\s\S]*?<beat-type>(\d+)<\/beat-type>/.exec(body);
    if (timeMatch) {
      per = (Number(timeMatch[1]) * 4) / Number(timeMatch[2]);
    }
    const cursors = new Map();
    const chordOffsets = new Map();
    const noteRegex = /<note\b[^>]*>([\s\S]*?)<\/note>/g;
    let noteMatch;
    while ((noteMatch = noteRegex.exec(body)) !== null) {
      const inner = noteMatch[1];
      const staff = (/<staff>(\d+)<\/staff>/.exec(inner) || [, "1"])[1];
      const voice = (/<voice>([^<]+)<\/voice>/.exec(inner) || [, "1"])[1];
      const key = `${staff}|${voice}`;
      const durationDiv = Number((/<duration>(-?\d+)<\/duration>/.exec(inner) || [, 0])[1]);
      const isChord = /<chord\s*\/>/.test(inner);
      const isGrace = /<grace\b/.test(inner);
      if (isGrace) continue;
      const offset = isChord ? (chordOffsets.get(key) || 0) : (cursors.get(key) || 0);
      if (!isChord) {
        chordOffsets.set(key, offset);
        cursors.set(key, offset + durationDiv / divisions);
      }
      if (/<rest\s*\/>/.test(inner)) continue;
      const step = (/<step>([^<]+)<\/step>/.exec(inner) || [, ""])[1].trim().toUpperCase();
      const octave = Number((/<octave>(-?\d+)<\/octave>/.exec(inner) || [, NaN])[1]);
      const alter = Number((/<alter>(-?\d+)<\/alter>/.exec(inner) || [, 0])[1]) || 0;
      const semitones = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
      if (!(step in semitones) || !Number.isFinite(octave)) continue;
      const midi = (octave + 1) * 12 + semitones[step] + alter;
      if (midi < 0 || midi > 127) continue;
      notes.push({
        startBeat: Math.round((measureIndex * per + offset) * 1e6) / 1e6,
        durationBeats: Math.round((durationDiv / divisions) * 1e6) / 1e6,
        midi,
        staff: Number(staff) || 1,
        voice: Number(voice) || 1,
      });
    }
    measureIndex += 1;
  }
  return notes;
}
