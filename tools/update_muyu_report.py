# -*- coding: utf-8 -*-
"""更新报告：木鱼已换样本，从「未收敛」移出。"""
from pathlib import Path

path = Path(__file__).resolve().parent.parent / "docs" / "采样音色质量审查.md"
text = path.read_text(encoding="utf-8")

old_start = text.find("### 仍未收敛的（如实说明）")
if old_start < 0:
    print("没找到「仍未收敛」小节")
    raise SystemExit(1)

old_end = text.find("## 近似音色差距评估")
if old_end < 0:
    old_end = len(text)

new_section = """### 木鱼已换样本（本轮解决）

`muyu_real` 原来用 VCSL Woodblock，三层样本 RMS 只有
0.0017 / 0.0054 / 0.0163 —— 全系最响的 `wood_click_ff` 也不到 0.017。
播放时即使系数给到 oneShot 上限 4.5，输出 RMS 仍只有 0.036，
比其它打击乐（约 0.077）轻一半。

**为什么换**：实测 VCSL 里所有木类音色都轻——

| 音色 | 最高样本 RMS |
| --- | --- |
| Woodblock | 0.0164 |
| Claves | 0.0039 |
| Slapstick | 0.0183 |
| Slit Drum | 0.0140 |
| Cowbells | 0.0237 |
| **Cajon** | **0.0700** |

Cajon 是唯一达到可用电平的，且力度分层完整（pp / p / mp / f / fff）。
改用它的 `hit3` 系列做三层：

| 层 | 文件 | 原始 RMS |
| --- | --- | --- |
| 轻 | `Cajon_hit3_p_rr1.wav` | 0.0167 |
| 中 | `Cajon_hit3_mp_rr1.wav` | 0.0442 |
| 重 | `Cajon_hit3_f_rr1.wav` | 0.0634 |

**换后效果**（e2e 实测，主力度层）：木鱼 RMS **0.1248**，
其它 5 个打击乐 0.1247–0.1385，**整体极差 1.11 倍**，远低于 1.7 阈值。

**必须说明**：Cajon 是箱鼓（木制箱体 + 打击面），不是中国木鱼。
标签已改成「木鱼（采样·近似箱鼓 Cajon）」，不冒充真实木鱼录音。

### 顺带修掉一个测试不公平

打击乐测试原来用统一的轻力度（velocity 0.44）测所有音色。
但木鱼有 3 层、其它打击乐只有 1 层——轻力度下木鱼落到 soft 层，
而单层音色无论多轻都只能播放自己那一层，
等于拿「木鱼最轻的层」和「别人中等的层」比。
已改为取每个音色的**主力度层**（各层 velocity 的中位数），
也就是这个音色的「标准一击」，比较才公平。

"""

text = text[:old_start] + new_section + text[old_end:]
path.write_text(text, encoding="utf-8")
print("报告已更新：木鱼从未收敛移到已解决")
