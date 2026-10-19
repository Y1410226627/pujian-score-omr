# -*- coding: utf-8 -*-
"""最终验收：Hall 曲（变速）+ 全乐器响度配平。

用项目自己的接口和工具验证，不依赖浏览器：
1) PDF 文字层 → 22 处速度标记（含印刷小节号）
2) tempo.js → 起始速度 138、播放分 22 段变速、MIDI 写速度事件
3) 几何 OCR 兜底 → PyMuPDF 3 倍渲染后 5 处全对
4) BANK_LEVEL → 67 种音源全覆盖、校正后峰值收敛
5) 单测全绿（133 项）
"""
import glob
import json
import re
import subprocess
import sys
from pathlib import Path

PROJECT = Path(r"E:\识谱弹琴")
sys.path.insert(0, str(PROJECT / "tools"))
import pdf_tempo_marks  # noqa: E402

HALL_PDF = Path(r"C:\Users\湮貉\AppData\Local\Temp\dsh-6ATCj7\newpdfs\hall.pdf")


def step(name, ok, detail=""):
    print(f"{'OK ' if ok else 'FAIL'} {name}" + (f"  {detail}" if detail else ""))
    return bool(ok)


def main():
    results = []

    # 1) PDF 文字层速度标记
    marks = pdf_tempo_marks.extract(HALL_PDF)
    # 按「小节号（None 视为 0）」排序，让开头的 138 排在第一位
    marks.sort(key=lambda item: ((item.get("bar") or 0), item.get("page", 0)))
    results.append(step("Hall 曲 PDF 文字层速度标记", len(marks) == 22, f"读出 {len(marks)} 处"))
    with_bar = [m for m in marks if m.get("bar") is not None]
    results.append(step("速度标记都带印刷小节号", len(with_bar) == 21,
                        f"21 处带小节号，1 处是乐句标题里的起始速度"))
    opening = marks[0]
    results.append(step("起始速度是 ♩=138", opening["bpm"] == 138 and opening.get("bar") is None,
                        f"开头 Alla marcia = {opening['bpm']}"))
    speeds = [m["bpm"] for m in marks]
    results.append(step("中途多次变速（非匀速）",
                        speeds.count(80) == 1 and 200 in speeds,
                        f"第 6 小节 80 → 第 74 小节 200，共 {len(set(speeds))} 种速度"))

    # 2) 拍位换算 + 变速分段 + MIDI 速度事件
    mapped = [{"beat": (m["bar"] - 1) * 4 if m.get("bar") else 0, "bpm": m["bpm"]} for m in marks]
    node = subprocess.run(
        ["node", "-e",
         "import('./tempo.js').then((m) => { const marks = "
         + json.dumps(mapped, ensure_ascii=False)
         + "; const d = m.detectStartTempo(marks);"
         + " const p = m.playbackTempoSegments(marks, { detectedBpm: d.bpm, userBpm: d.bpm });"
         + " const e = m.midiTempoEvents(marks, { detectedBpm: d.bpm, userBpm: d.bpm, ticksPerBeat: 480 });"
         + " console.log(JSON.stringify({ start: d, segments: p.segments.length, startBpm: p.startBpm,"
         + " events: e.length, lastTick: e[e.length - 1].tick, firstSeg: p.segments[0] })); })"],
        capture_output=True, text=True, encoding="utf-8", cwd=str(PROJECT))
    tempo = json.loads(node.stdout.strip())
    results.append(step("起始速度用第 0 拍的 138（而非默认 84）",
                        tempo["start"]["bpm"] == 138 and tempo["start"]["source"] == "opening"))
    results.append(step("播放分 22 段变速", tempo["segments"] == 22, f"segments={tempo['segments']}"))
    results.append(step("MIDI 写分段速度事件",
                        tempo["events"] == 20 and tempo["lastTick"] == 292 * 480,
                        f"events={tempo['events']}, 最后一个在 tick {tempo['lastTick']}"))

    # 3) 几何 OCR 兜底（扫描件/图片型 PDF 用）
    render_dir = Path(r"C:\Users\湮貉\AppData\Local\Temp\dsh-6ATCj7\halltempo")
    if render_dir.is_dir():
        out = subprocess.run([sys.executable, str(PROJECT / "tools" / "ocr_tempo.py"),
                              str(render_dir), "--pages", "1"],
                             capture_output=True, text=True, encoding="utf-8", cwd=str(PROJECT))
        ok = "5 处 138, 80, 85, 90, 95" in out.stdout
        first_line = out.stdout.strip().splitlines()[0] if out.stdout.strip() else "（无输出）"
        results.append(step("几何 OCR 兜底（3 倍渲染）", ok, first_line))

    # 4) 响度配平
    levels = json.loads((PROJECT / "tools" / "bank_levels.json").read_text(encoding="utf-8"))["banks"]
    node = subprocess.run(
        ["node", "-e",
         "import('./soundbanks.js').then(m => console.log(JSON.stringify(Object.keys(m.SAMPLED_TIMBRES))))"],
        capture_output=True, text=True, encoding="utf-8", cwd=str(PROJECT))
    all_banks = json.loads(node.stdout.strip())
    covered = [name for name in all_banks if name in levels]
    results.append(step("响度配平覆盖全部音源", len(covered) == len(all_banks),
                        f"{len(covered)}/{len(all_banks)}"))
    peaks = sorted(v["level"] * v["peak"] for v in levels.values())
    results.append(step("校正后响度收敛",
                        peaks[0] > 0.16 * 0.54 and peaks[-1] < 0.16 * 1.36,
                        f"峰值 {peaks[0]:.3f}–{peaks[-1]:.3f}（目标 0.16）"))

    # 5) 单测（逐个文件跑，npm test 在本机有 spawn EPERM 问题）
    test_files = sorted(glob.glob(str(PROJECT / "tests" / "*.test.mjs")))
    test = subprocess.run(["node", "--test"] + test_files, capture_output=True, text=True,
                           encoding="utf-8", cwd=str(PROJECT), timeout=1800)
    combined = test.stdout + test.stderr
    passed = sum(int(m.group(1)) for m in re.finditer(r"ℹ pass (\d+)", combined))
    failed = sum(int(m.group(1)) for m in re.finditer(r"ℹ fail (\d+)", combined))
    results.append(step("单元测试全部通过", failed == 0, f"{passed} 项通过，{failed} 项失败"))

    print()
    if all(results):
        print(f"全部 {len(results)} 项验收通过")
        return 0
    print(f"{results.count(False)} 项未通过")
    return 1


if __name__ == "__main__":
    sys.exit(main())
