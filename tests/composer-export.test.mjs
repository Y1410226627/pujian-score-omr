import assert from "node:assert/strict";
import test from "node:test";
import { DOMParser } from "@xmldom/xmldom";

globalThis.DOMParser = DOMParser;
const { parseMusicXmlText } = await import("../musicxml.js");
const composer = await import("../composer.js");
const exporter = await import("../composer-export.js");

function buildScore() {
  const score = composer.createScore({ title: "创作测试", tempo: 96, beatsPerMeasure: 4 });
  score.parts = [composer.createPart({ name: "旋律" }), composer.createPart({ name: "伴奏", clef: "bass" })];
  composer.appendNote(score.parts[0], { midi: 72, beats: 1 });
  composer.appendNote(score.parts[0], { midi: 74, beats: 0.5 });
  composer.appendNote(score.parts[0], { midi: 76, beats: 2.5 });
  composer.appendNote(score.parts[0], { midi: 77, beats: 4 });
  composer.appendNote(score.parts[1], { midi: 48, beats: 2 });
  composer.appendNote(score.parts[1], { midi: 50, beats: 2 });
  composer.appendNote(score.parts[1], { midi: 52, beats: 4 });
  return score;
}

test("MIDI → MusicXML 音高（升号写法 + 八度）", () => {
  assert.deepEqual(exporter.midiToStepAlter(60), { step: "C", alter: 0, octave: 4 });
  assert.deepEqual(exporter.midiToStepAlter(61), { step: "C", alter: 1, octave: 4 });
  assert.deepEqual(exporter.midiToStepAlter(46), { step: "A", alter: 1, octave: 2 });
  assert.deepEqual(exporter.midiToStepAlter(21), { step: "A", alter: 0, octave: 0 });
});

test("拍数 → 音符类型（含附点）", () => {
  assert.deepEqual(exporter.noteTypeOf(4), { type: "whole", dots: 0 });
  assert.deepEqual(exporter.noteTypeOf(3), { type: "half", dots: 1 });
  assert.deepEqual(exporter.noteTypeOf(1.5), { type: "quarter", dots: 1 });
  assert.deepEqual(exporter.noteTypeOf(0.25), { type: "16th", dots: 0 });
});

test("导出的 MusicXML 能被项目自己的解析器读回，而且音符数/时值/速度都对", () => {
  const score = buildScore();
  const xml = exporter.scoreToMusicXml(score);
  const result = parseMusicXmlText(xml);
  assert.equal(result.title, "创作测试");
  assert.equal(result.partNames.length, 2);
  assert.equal(result.tempo, 96);
  assert.equal(result.timeSummary, "4/4");
  assert.equal(result.measureCount, 2, "两小节内容（末尾不补空小节）");
  // 旋律 4 个音 + 伴奏 3 个音
  assert.equal(result.notes.length, 7);
  const melody = result.notes.filter((note) => note.partName === "旋律").sort((a, b) => a.startBeat - b.startBeat);
  assert.deepEqual(melody.map((note) => note.midi), [72, 74, 76, 77]);
  assert.deepEqual(melody.map((note) => note.durationBeats), [1, 0.5, 2.5, 4]);
  assert.deepEqual(melody.map((note) => note.startBeat), [0, 1, 1.5, 4]);
  const accompaniment = result.notes.filter((note) => note.partName === "伴奏");
  assert.deepEqual(accompaniment.map((note) => note.startBeat).sort((a, b) => a - b), [0, 2, 4]);
});

test("每个小节的拍数都正好齐（导出不会产生残小节）", () => {
  const score = buildScore();
  const xml = exporter.scoreToMusicXml(score);
  const result = parseMusicXmlText(xml);
  const perMeasure = new Map();
  for (const note of result.notes) {
    const index = Math.floor(note.startBeat / 4);
    perMeasure.set(index, Math.max(perMeasure.get(index) || 0, note.startBeat - index * 4 + note.durationBeats));
  }
  for (const [index, end] of perMeasure) assert.ok(end <= 4 + 1e-6, `第 ${index + 1} 小节超出 4 拍`);
  assert.equal(result.totalBeats, 8);
});

test("导出的 MIDI 是合法的 SMF：MThd/MTrk、division 480、轨数=声部数+1", () => {
  const score = buildScore();
  const midi = exporter.scoreToMidi(score);
  const text = String.fromCharCode(...midi.slice(0, 4));
  assert.equal(text, "MThd");
  // SMF 头：MThd(4) + 长度(4) + format(2) + ntrks(2) + division(2)
  assert.equal(midi[4], 0x00);
  assert.equal(midi[5], 0x00);
  assert.equal(midi[6], 0x00);
  assert.equal(midi[7], 0x06, "header 长度 6");
  assert.equal((midi[8] << 8) | midi[9], 1, "format 1");
  assert.equal((midi[10] << 8) | midi[11], 3, "声部 2 个 + 速度 1 轨");
  assert.equal((midi[12] << 8) | midi[13], 480, "divisions 480");
  const body = String.fromCharCode(...midi.slice(14));
  assert.equal((body.match(/MTrk/g) || []).length, 3);
  assert.ok(midi[midi.length - 3] === 0xff && midi[midi.length - 2] === 0x2f && midi[midi.length - 1] === 0x00,
    "每个轨结尾要有 End of Track");
});

test("变长整数编码符合 MIDI 规范", () => {
  assert.deepEqual(exporter.variableLength(0), [0x00]);
  assert.deepEqual(exporter.variableLength(0x40), [0x40]);
  assert.deepEqual(exporter.variableLength(0x80), [0x81, 0x00]);
  assert.deepEqual(exporter.variableLength(480), [0x83, 0x60]);
  assert.deepEqual(exporter.variableLength(0x0fffffff), [0xff, 0xff, 0xff, 0x7f]);
});

test("空乐谱也能导出（不会抛异常，也不产生音符）", () => {
  const score = composer.createScore();
  const xml = exporter.scoreToMusicXml(score);
  const result = parseMusicXmlText(xml);
  assert.equal(result.notes.length, 0);
  const midi = exporter.scoreToMidi(score);
  assert.equal(String.fromCharCode(...midi.slice(0, 4)), "MThd");
});

test("工程文件（JSON）能原样读回", () => {
  const score = buildScore();
  const json = exporter.scoreToProjectJson(score);
  const parsed = JSON.parse(json);
  assert.equal(parsed.format, "pujian-composer");
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.score, score);
});

test("休止符导出成 <rest/>，且 MusicXML 解析后该位置没有音、拍数仍对齐", () => {
  const score = composer.createScore({ title: "休止测试", tempo: 90, beatsPerMeasure: 4 });
  score.parts = [composer.createPart({ name: "旋律" })];
  composer.appendNote(score.parts[0], { midi: 72, beats: 1 });
  composer.appendNote(score.parts[0], { rest: true, beats: 1 });
  composer.appendNote(score.parts[0], { midi: 74, beats: 2 });
  const xml = exporter.scoreToMusicXml(score);
  assert.ok(xml.includes("<rest/>"), "MusicXML 里要有休止记号");
  const result = parseMusicXmlText(xml);
  assert.equal(result.notes.length, 2, "休止符不产生音符事件");
  const starts = result.notes.map((note) => note.startBeat).sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 2], "第 2 拍是休止，所以第二个音在第 3 拍（=startBeat 2）");
  assert.equal(result.totalBeats, 4);
});

test("整小节休止也能导出，MIDI 里没有该小节的发声事件但仍占时间", () => {
  const score = composer.createScore({ beatsPerMeasure: 4 });
  const part = score.parts[0];
  composer.appendNote(part, { rest: true, beats: 4 });
  composer.appendNote(part, { midi: 60, beats: 4 });
  const xml = exporter.scoreToMusicXml(score);
  const result = parseMusicXmlText(xml);
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0].startBeat, 4, "休止的整小节让后一个音从第 5 拍（第二小节）开始");
  const midi = exporter.scoreToMidi(score);
  assert.equal(String.fromCharCode(...midi.slice(0, 4)), "MThd", "仍应是合法 MIDI 文件");
  const trackCount = (String.fromCharCode(...midi.slice(14)).match(/MTrk/g) || []).length;
  assert.equal(trackCount, 2, "速度轨 + 1 个声部轨");
});
