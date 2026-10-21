# -*- coding: utf-8 -*-
"""生成 82 项采样音色质量审查报告。

数据来源：
  .cache/audio-analysis/soundfont-analysis.csv       （Librosa 解码 + 客观指标）
  .cache/audio-analysis/soundfont-map-coverage.csv   （映射覆盖）
  .assets/soundfonts/manifest.json                   （来源、层数、样本路径）
  app.js BANK_LEVEL                                  （当前响度系数）

输出：docs/采样音色质量审查.md

重要：本报告严格区分三类结论
  1) 测得正常 —— 客观指标（解码、静音、削波、音高偏差）
  2) 来源像该乐器 —— 样本来自哪个库、是否近似替代
  3) 听感悦耳 —— **未做主观试听，一律标"未试听"**，不拿指标冒充听感
"""
import csv
import json
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANALYSIS = ROOT / ".cache" / "audio-analysis" / "soundfont-analysis.csv"
COVERAGE = ROOT / ".cache" / "audio-analysis" / "soundfont-map-coverage.csv"
MANIFEST = ROOT / ".assets" / "soundfonts" / "manifest.json"
APP = ROOT / "app.js"
OUT = ROOT / "docs" / "采样音色质量审查.md"

# 已知的近似替代关系（不冒充原乐器）
APPROXIMATIONS = {
    "zhongruan_real": "Meta Open 尼龙弦吉他（近似，非真实中阮录音）",
    "liuqin_real": "Meta Open 钢弦吉他（近似，非真实柳琴录音）",
}

# 来源说明
SOURCE_NOTES = {
    "meta": "Meta Open Sound（CC0）",
    "fluidr3": "FluidR3 GM 音源库",
    "salamander": "Salamander Grand Piano",
}


def read_csv(path):
    if not path.exists():
        return []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def read_bank_levels():
    text = APP.read_text(encoding="utf-8")
    match = re.search(r"const BANK_LEVEL = \{([\s\S]*?)\n\};", text)
    if not match:
        return {}
    return {name: float(value) for name, value in re.findall(r"(\w+):\s*([\d.]+)", match.group(1))}


def number(value, fallback=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def classify(analysis, coverage):
    """返回 (问题列表, 结论标签)。只根据客观指标判断。"""
    problems = []
    clip = number(analysis.get("max_clip_fraction"), 0) or 0
    if clip > 0.001:
        problems.append(f"削波比例 {clip:.3f}")
    pitch_error = abs(number(analysis.get("median_pitch_error_cents"), 0) or 0)
    if pitch_error > 25:
        problems.append(f"音高偏差 {pitch_error:.0f} 音分")
    pitch_spread = abs(number(analysis.get("median_pitch_spread_cents"), 0) or 0)
    if pitch_spread > 40:
        problems.append(f"音高离散 {pitch_spread:.0f} 音分")
    flatness = number(analysis.get("median_flatness"), 0) or 0
    if flatness > 0.2:
        problems.append(f"频谱过平（噪声感）{flatness:.2f}")
    crest = number(analysis.get("median_crest_db"), 0) or 0
    if crest > 32:
        problems.append(f"波峰因数 {crest:.0f} dB（瞬态过强）")
    analyzed = number(analysis.get("analyzed_files"), 0) or 0
    if analyzed == 0:
        problems.append("没有可分析样本")
    silent = number(coverage.get("silent_refs"), 0) or 0
    audible = number(coverage.get("audible_refs"), 0) or 0
    if audible == 0:
        problems.append("映射后无可发声样本")
    elif silent > audible:
        problems.append(f"静音样本多于可发声（{silent} vs {audible}）")
    return problems


def main():
    analysis_rows = read_csv(ANALYSIS)
    coverage_rows = {row["bank"]: row for row in read_csv(COVERAGE)}
    levels = read_bank_levels()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {"banks": {}}

    lines = []
    lines.append("# 采样音色质量审查（82 项）")
    lines.append("")
    lines.append(f"生成日期：{date.today().isoformat()}")
    lines.append("")
    lines.append("## 这份报告怎么读")
    lines.append("")
    lines.append("每项分三层结论，**不要混着看**：")
    lines.append("")
    lines.append("| 层 | 含义 | 依据 |")
    lines.append("| --- | --- | --- |")
    lines.append("| **测得正常** | 解码、静音、削波、音高这些客观指标是否合格 | Librosa 实测 |")
    lines.append("| **来源像该乐器** | 样本来自哪个库；是不是「近似替代」 | manifest / 安装脚本 |")
    lines.append("| **听感悦耳** | 好不好听 | **本轮未做主观试听，全部标「未试听」** |")
    lines.append("")
    lines.append("> 说明：客观指标能查出「样本是空的、爆音的、音高错的」，")
    lines.append("> 但**不能**判断「好不好听」。所以任何一项的「听感」栏都不会因为指标好看就写「悦耳」。")
    lines.append("")

    total = len(analysis_rows)
    clean = []
    with_problems = []
    for row in analysis_rows:
        name = row["bank"]
        problems = classify(row, coverage_rows.get(name, {}))
        if problems:
            with_problems.append((name, problems))
        else:
            clean.append(name)

    lines.append("## 总览")
    lines.append("")
    lines.append(f"- 音色总数：**{total}**")
    lines.append(f"- 客观指标全部合格：**{len(clean)}**")
    lines.append(f"- 存在技术问题：**{len(with_problems)}**")
    lines.append(f"- 响度系数已标定：**{len(levels)}**")
    lines.append("")

    if with_problems:
        lines.append("### 需要处理的音色")
        lines.append("")
        lines.append("| 音色 | 问题 |")
        lines.append("| --- | --- |")
        for name, problems in with_problems:
            lines.append(f"| `{name}` | {'；'.join(problems)} |")
        lines.append("")

    lines.append("## 逐项明细")
    lines.append("")
    lines.append("| 音色 | 中文名 | 来源 | 层数 | 映射音域 | 样本数 | RMS | 音高偏差 | 削波 | 客观结论 | 真实性 | 听感 | 响度系数 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for row in sorted(analysis_rows, key=lambda item: item["bank"]):
        name = row["bank"]
        coverage = coverage_rows.get(name, {})
        spec = (manifest.get("banks") or {}).get(name, {})
        problems = classify(row, coverage)
        low = coverage.get("audible_note_min") or "—"
        high = coverage.get("audible_note_max") or "—"
        pitch_error = number(row.get("median_pitch_error_cents"))
        clip = number(row.get("max_clip_fraction"))
        rms = number(row.get("median_rms"))
        truth = APPROXIMATIONS.get(name) or ("真实乐器录音" if "real" in name else "合成音色")
        verdict = "合格" if not problems else "；".join(problems)
        lines.append(
            f"| `{name}` | {row.get('label', '')} | {row.get('sources', '') or '—'} | "
            f"{row.get('layers', '') or '—'} | {low}–{high} | {row.get('unique_files', '') or '—'} | "
            f"{f'{rms:.4f}' if rms is not None else '—'} | "
            f"{f'{pitch_error:.0f}' if pitch_error is not None else '—'} | "
            f"{f'{clip:.4f}' if clip is not None else '—'} | "
            f"{verdict} | {truth} | 未试听 | {levels.get(name, '—')} |")
    lines.append("")

    lines.append("## 近似替代音色（不冒充原乐器）")
    lines.append("")
    lines.append("| 音色 | 实际用的样本 | 说明 |")
    lines.append("| --- | --- | --- |")
    for name, note in APPROXIMATIONS.items():
        lines.append(f"| `{name}` | {note.split('（')[0]} | {note} |")
    lines.append("")
    lines.append("这两项在界面和文档里都必须标「近似」，不能写成真实中阮/柳琴录音。")
    lines.append("")

    lines.append("## 响度统一")
    lines.append("")
    lines.append("本轮做了两件事：")
    lines.append("")
    lines.append("1. **修掉「防削波砍增益」的旧逻辑**：旧代码用 `Math.min(增益, 0.85/样本峰值)` 限制单音增益，")
    lines.append("   导致录音电平低的样本（Meta Nylon 只有钢琴的 1/3.6）永远提不起来——")
    lines.append("   实测系数从 1.158 调到 3.089，输出 RMS 几乎不变。")
    lines.append("   现在改为给足增益，由 masterChain 的 tanh 软限幅兜底。")
    lines.append("2. **按浏览器实测 RMS 重新标定 BANK_LEVEL**（不是按文件字节或样本 RMS 估算）。")
    lines.append("")
    lines.append("实测结果（同一条件：C4、中强力度、0.3–1.0 秒窗口）：")
    lines.append("")
    lines.append("| 音色 | RMS | 峰值 | 响度系数 |")
    lines.append("| --- | --- | --- | --- |")
    for name, rms, peak in [
        ("piano_real", 0.10352, 0.4104),
        ("nylon_guitar_real", 0.10468, 0.2275),
        ("steel_guitar_real", 0.11117, 0.2136),
        ("zhongruan_real", 0.10578, 0.2175),
        ("liuqin_real", 0.09465, 0.179),
    ]:
        lines.append(f"| `{name}` | {rms:.4f} | {peak:.3f} | {levels.get(name, '—')} |")
    lines.append("")
    lines.append("**响度差 1.17 倍**（测试阈值 < 1.7），峰值均低于 0.42，没有削波。")
    lines.append("")

    lines.append("## 仍未完成的（如实说明）")
    lines.append("")
    lines.append("1. **主观试听**：本轮没有逐个人工试听 82 种音色。")
    lines.append("   表格里「听感」一栏全部是「未试听」，没有用指标冒充结论。")
    lines.append("2. **弱音色替换**：只处理了中阮/柳琴的近似映射与响度，")
    lines.append("   没有把其它乐器换成更好的采样源。哪些该换，需要先有人试听后判断。")
    lines.append("3. **长音尾音**：响度测量用的是 1.5 秒窗口，")
    lines.append("   更长尾音（如锣 27 秒）的衰减曲线只做了「不截断」验证，没有逐段核对响度。")
    lines.append("")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"已写出 {OUT}（{len(lines)} 行，{total} 项音色）")


if __name__ == "__main__":
    main()
