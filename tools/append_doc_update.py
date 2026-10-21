# -*- coding: utf-8 -*-
"""给 音源接入方案.md 追加带日期的更新说明（不破坏历史内容）。"""
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "音源接入方案.md"

note = f"""

---

## 更新记录（{date.today().isoformat()}）

> 上面是历史方案记录，保留原样。以下是**当前实际状态**，以文件与 manifest 为准。

### 钢琴：已从 Salamander 换成 Meta Open（4 层）

| 项目 | 上面写的（历史） | 现在实际 |
| --- | --- | --- |
| 音源 | Salamander Grand Piano V3 | **Meta Open Sound（Meta Open Piano）** |
| 许可 | CC BY 3.0 | **CC0**（无需署名，但仍保留来源说明） |
| 力度层 | velocity4 + velocity12 两层 | **4 层 × 88 键 = 352 个 OGG** |
| 本地路径 | — | `.assets/soundfonts/meta-open/meta-piano/` |

### 吉他族与两件「近似」民族乐器

| 音色 | 实际样本 | 说明 |
| --- | --- | --- |
| `nylon_guitar_real` | Meta Open Nylon Guitar（3 层 × 88 键） | 真实尼龙弦吉他录音 |
| `steel_guitar_real` | Meta Open Steel Guitar（3 层 × 88 键） | 真实钢弦吉他录音 |
| `zhongruan_real` | 复用 Meta Nylon 样本 | **近似中阮，不是真实中阮录音** |
| `liuqin_real` | 复用 Meta Steel 样本 | **近似柳琴，不是真实柳琴录音** |

后两项在 `timbre.js`、manifest 和界面里都明确标了「近似」，不冒充原乐器。

### 响度标定方式变了

旧做法：给单音增益封顶（`Math.min(增益, 0.85/样本峰值)`）。
问题：录音电平低的样本永远提不起来（Meta Nylon 只有钢琴的 1/3.6），
系数怎么调输出都不变。

现做法：按浏览器实测 RMS 归一化给足增益，削波交给 `masterChain` 的 tanh 软限幅器。
实测 Meta 钢琴/吉他族响度差从 4.11 倍降到 **1.17 倍**，峰值均 < 0.42。
标定工具：`tools/measure_browser_levels.mjs`、`tools/calc_bank_levels.py`。

### 82 项逐项审查

见 `docs/采样音色质量审查.md`（由 `tools/build_quality_report.py` 生成）。
"""

if "## 更新记录（" in TARGET.read_text(encoding="utf-8"):
    print("已有更新记录，跳过")
else:
    with TARGET.open("a", encoding="utf-8") as handle:
        handle.write(note)
    print("已追加更新记录到 音源接入方案.md")
