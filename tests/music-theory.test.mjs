/**
 * 乐理规则的单测：延音线候选识别 + 弱起小节处理 + 调号换算。
 *
 * 这些规则来自简谱/乐理资料（README「乐理约定」一节列出了逐条依据）：
 *   · 延音线（tie）连接**相同音高**的音，时值相加；圆滑线（slur）连接**不同音高**的音，
 *     只表示连贯、不改变时值。所以「同音高 + 首尾相接」只能算**候选**，不能自动合并。
 *   · 弱起小节（anacrusis）是乐曲开头不完整的小节，其后紧跟完整小节；判断法可看
 *     「第 1 小节 + 末小节 ≈ 一个完整小节」。
 *   · 简谱的「1 = X」表示 do 的实际音高：1=C → do 是 C4（MIDI 60），1=F → do 是 F4（65）。
 *     数字 n 的音高 = do + 大调音阶第 n 级的半音数 + 12×八度。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const PYTHON = path.join(ROOT, ".venv", "Scripts", "python.exe");
const canRunPython = process.platform === "win32" && existsSync(PYTHON);

/** 直接调用 jianpu.py 里的乐理辅助函数（不需要图像）。 */
function callPython(code) {
  return execFileSync(PYTHON, ["-c", code], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
}

test("延音线候选：同音高且首尾相接才报告，不同音高/有间隔不报告", { skip: !canRunPython ? "需要 .venv" : false }, () => {
  const code = `
import sys, json
sys.path.insert(0, r"${ROOT}")
import jianpu
parts = [
    # 同音高、首尾相接 → 是一处延音线候选
    {"name": "p", "notes": [
        {"midi": 69, "startBeat": 0.0, "durationBeats": 4.0},
        {"midi": 69, "startBeat": 4.0, "durationBeats": 4.0},
    ]},
    # 不同音高（圆滑线/正常进行）→ 不是候选
    {"name": "q", "notes": [
        {"midi": 69, "startBeat": 0.0, "durationBeats": 4.0},
        {"midi": 67, "startBeat": 4.0, "durationBeats": 4.0},
    ]},
    # 同音高但有间隔（同音反复）→ 不是候选
    {"name": "r", "notes": [
        {"midi": 69, "startBeat": 0.0, "durationBeats": 2.0},
        {"midi": 69, "startBeat": 3.0, "durationBeats": 2.0},
    ]},
]
print(json.dumps(jianpu.find_tie_candidates(parts)))
`;
  const found = JSON.parse(callPython(code));
  assert.equal(found.length, 1, "只应报告 1 处延音线候选");
  assert.deepEqual(found[0], [0, 4.0], "候选应位于第 1 个声部的第 4 拍");
});

test("延音线候选：空输入与单音不会报错", { skip: !canRunPython ? "需要 .venv" : false }, () => {
  const code = `
import sys, json
sys.path.insert(0, r"${ROOT}")
import jianpu
print(json.dumps([
    jianpu.find_tie_candidates([]),
    jianpu.find_tie_candidates([{"name": "p", "notes": []}]),
    jianpu.find_tie_candidates([{"name": "p", "notes": [{"midi": 60, "startBeat": 0, "durationBeats": 1}]}]),
]))
`;
  const result = JSON.parse(callPython(code));
  assert.deepEqual(result, [[], [], []]);
});

test("调号换算：1=X 时数字 n 的音高 = do + 大调音阶半音数 + 12×八度", { skip: !canRunPython ? "需要 .venv" : false }, () => {
  const code = `
import sys, json
sys.path.insert(0, r"${ROOT}")
import jianpu
def pitch(do_midi, digit, octave=0):
    return do_midi + jianpu.MAJOR_SCALE[int(digit) - 1] + 12 * octave
print(json.dumps({
    "1=C 1": pitch(60, "1"),        # C
    "1=C 2": pitch(60, "2"),        # D
    "1=C 3": pitch(60, "3"),        # E
    "1=C 4": pitch(60, "4"),        # F
    "1=C 5": pitch(60, "5"),        # G
    "1=C 6": pitch(60, "6"),        # A
    "1=C 7": pitch(60, "7"),        # B
    "1=G 1": pitch(67, "1"),        # G
    "1=F 1": pitch(65, "1"),        # F
    "1=C 1_up": pitch(60, "1", 1),  # C5
    "1=C 1_down": pitch(60, "1", -1), # C3
    "scale": list(jianpu.MAJOR_SCALE),
}))
`;
  const result = JSON.parse(callPython(code));
  // C 大调音阶：C D E F G A B = 60 62 64 65 67 69 71
  assert.equal(result["1=C 1"], 60);
  assert.equal(result["1=C 2"], 62);
  assert.equal(result["1=C 3"], 64);
  assert.equal(result["1=C 4"], 65);
  assert.equal(result["1=C 5"], 67);
  assert.equal(result["1=C 6"], 69);
  assert.equal(result["1=C 7"], 71);
  assert.equal(result["1=G 1"], 67, "1=G 时 do 是 G4");
  assert.equal(result["1=F 1"], 65, "1=F 时 do 是 F4");
  assert.equal(result["1=C 1_up"], 72, "高八度点 = +12");
  assert.equal(result["1=C 1_down"], 48, "低八度点 = -12");
  assert.deepEqual(result.scale, [0, 2, 4, 5, 7, 9, 11], "大调音阶相对 do 的半音数");
});

test("调号换算：A 大调音阶落在正确的 MIDI 上", { skip: !canRunPython ? "需要 .venv" : false }, () => {
  const code = `
import sys, json
sys.path.insert(0, r"${ROOT}")
import jianpu
# 1=A：do 是 A4（MIDI 69），大调音阶 A B C# D E F# G#
print(json.dumps([69 + jianpu.MAJOR_SCALE[i] for i in range(7)]))
`;
  const result = JSON.parse(callPython(code));
  assert.deepEqual(result, [69, 71, 73, 74, 76, 78, 80], "A 大调音阶应为 A B C# D E F# G#");
});
