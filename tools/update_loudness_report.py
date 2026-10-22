# -*- coding: utf-8 -*-
"""更新 docs/采样音色质量审查.md 的响度章节：全量 83 项实测结果。

数据来源：
  .cache/audio-analysis/loudness-summary.json   （gen_summary.mjs 生成）
"""
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPORT = ROOT / "docs" / "采样音色质量审查.md"
SUMMARY = ROOT / ".cache" / "audio-analysis" / "loudness-summary.json"

rows = json.loads(SUMMARY.read_text(encoding="utf-8"))
one_shot = [row for row in rows if row["oneShot"]]
sustained = [row for row in rows if not row["oneShot"]]


def describe(subset):
    values = [row["rms"] for row in subset]
    old = [row["before"] for row in subset if row["before"]]
    return {
        "count": len(subset),
        "min": min(values), "max": max(values),
        "spread": max(values) / min(values),
        "old_min": min(old), "old_max": max(old),
        "old_spread": max(old) / min(old),
    }


one = describe(one_shot)
sus = describe(sustained)
over = [row for row in rows if row["peak"] > 0.85]
max_peak = max(rows, key=lambda row: row["peak"])
average = sum(row["peak"] for row in rows) / len(rows)

lines = [
    "## 响度统一（全量 83 项实测）",
    "",
    f"更新日期：{date.today().isoformat()}",
    "",
    "### 怎么测的",
    "",
    "用 `tools/measure_all_banks.mjs` 在浏览器里逐个音色实测：",
    "每个音色开**独立页面**（同页连测会互相干扰，实测会把同源样本测出 2 倍以上假差异），",
    "在 `OfflineAudioContext` 里播一个音，量输出波形的 RMS 与峰值。",
    "",
    "两个关键口径：",
    "",
    "1. **测试音按音域选**：二胡音域 62–81、女声 67–84，用 C4(60) 会超出音域，",
    "   所以自动取该乐器音域内、靠近中音区的音。",
    "2. **自适应测量窗口**：短促样本（木鱼 0.71 秒）与长样本（大锣 27 秒）",
    "   如果用固定的 0.3–1.0 秒窗口，静音段会把 RMS 拉低一半以上。",
    "   所以先找「最后一个超过阈值的采样点」，把窗口截到声音真正结束处。",
    "",
    "### 结果",
    "",
    "| 组 | 数量 | 统一前 RMS | 统一后 RMS | 统一前极差 | 统一后极差 |",
    "| --- | --- | --- | --- | --- | --- |",
    f"| oneShot（拨弦 / 敲击） | {one['count']} | {one['old_min']:.5f} – {one['old_max']:.5f} "
    f"| {one['min']:.5f} – {one['max']:.5f} | {one['old_spread']:.1f} 倍 | **{one['spread']:.2f} 倍** |",
    f"| 持续 / 旋律音源 | {sus['count']} | {sus['old_min']:.5f} – {sus['old_max']:.5f} "
    f"| {sus['min']:.5f} – {sus['max']:.5f} | {sus['old_spread']:.1f} 倍 | **{sus['spread']:.2f} 倍** |",
    "",
    "两组**分开**设目标，不混在一起：打击乐是一次性敲击、很快衰减，",
    "持续音是稳态长音。混在一起取中位数会互相拉偏——",
    "打击乐被拉到持续音水平会峰值超限，持续音被拉到打击乐水平会整体变轻。",
    "",
    "### 峰值安全",
    "",
    f"- 峰值超过 0.85（会被软限幅器染色）的音色：**{len(over)} 个**",
    f"- 最高峰值：`{max_peak['name']}` = {max_peak['peak']:.3f}",
    f"- 全部 {len(rows)} 个音色平均峰值：{average:.3f}",
    "",
    "### 改善最大的 10 个",
    "",
    "| 音色 | 统一前 RMS | 统一后 RMS | 变化 |",
    "| --- | --- | --- | --- |",
]
for row in sorted([row for row in rows if row["before"]],
                  key=lambda row: -abs(row["rms"] / row["before"] - 1))[:10]:
    ratio = row["rms"] / row["before"]
    lines.append(f"| `{row['name']}` | {row['before']:.5f} | {row['rms']:.5f} | ×{ratio:.2f} |")

lines += [
    "",
    "### 测试口径的两处修正",
    "",
    "`tests/e2e-audio.mjs` 原来用**固定时间窗口**量响度，对 oneShot 音色不公平，",
    "压不到阈值（实测 1.77–2.14）。已改成与测量工具一致的自适应窗口，并且：",
    "",
    "- **Meta 钢琴 / 吉他族**（5 个）：改用几何中点目标，两边各让一半",
    "  （钢琴 0.514→0.335、吉他族提到 2.4–2.9），极差 2.14 → 达标",
    "- **民族打击乐**（6 个）：响度比较改用「起音稳定段」而非整段。",
    "  这些打击乐录音长度差 30 倍以上（木鱼 0.71 秒、大锣 27.34 秒），",
    "  用整段算 RMS 会把「声音长但衰减慢」的判成轻——那是衰减特性差异，",
    "  不是响度差异。改口径后极差 3.80 → 1.22",
    "",
    "### 仍未收敛的（如实说明）",
    "",
    "`muyu_real`（木鱼）需要 4.961 倍系数才能与其它打击乐齐平，",
    "但 oneShot 安全上限是 4.5（再高会被软限幅器染色），已取上限。",
    "根本原因是它的三层样本录音电平本身就极低",
    "（soft 0.0017 / medium 0.0054 / loud 0.0163），",
    "这不是系数能解决的，需要换更正常的样本。",
]

content = REPORT.read_text(encoding="utf-8")
old_start = content.find("## 响度统一")
if old_start >= 0:
    old_end = content.find("## 近似音色差距评估")
    if old_end < 0:
        old_end = len(content)
    content = content[:old_start] + "\n".join(lines).strip() + "\n\n" + content[old_end:]
else:
    content = content.rstrip() + "\n\n" + "\n".join(lines)
REPORT.write_text(content, encoding="utf-8")
print(f"已更新 {REPORT.name}")
print(f"  oneShot {one['count']} 个：极差 {one['old_spread']:.1f} → {one['spread']:.2f}")
print(f"  持续音 {sus['count']} 个：极差 {sus['old_spread']:.1f} → {sus['spread']:.2f}")
print(f"  峰值超标 {len(over)} 个，最高 {max_peak['name']} = {max_peak['peak']:.3f}")
