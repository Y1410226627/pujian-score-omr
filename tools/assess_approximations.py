# -*- coding: utf-8 -*-
"""生成「近似音色差距评估」，为后续替换排优先级。

判断依据（可核查，不靠主观臆测）：
  1. 发声原理是否相近 —— 拨弦/拉弦/吹管/打击，原理不同则音色差异大
  2. 音域是否匹配 —— 借用乐器音域与目标乐器差距
  3. 演奏法差异 —— 是否有揉弦/滑音/泛音等目标乐器特征技法
  4. 是否有专门录音 —— 目前全部为借用，标注「需替换」

输出追加到 docs/采样音色质量审查.md
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / ".assets" / "soundfonts" / "manifest.json"
REPORT = ROOT / "docs" / "采样音色质量审查.md"

# 每个近似音色的评估：目标乐器 / 借用样本 / 发声原理是否相近 / 差距等级 / 理由
# 差距等级：高（原理不同，听感差异明显）/ 中（原理接近但音色有差）/ 低（原理与音域都接近）
ASSESSMENTS = {
    "guzheng_real": ("古筝", "竖琴", True, "低",
                     "同为拨弦、音域接近、都有泛音；差别在筝的按音滑音与钢丝弦亮度"),
    "pipa_real": ("琵琶", "班卓", True, "中",
                  "同为拨弦，但班卓是鼓面共鸣、音色更脆更短，缺琵琶的轮指与推拉音"),
    "zhonghu_real": ("中胡", "中提琴", True, "低",
                     "同为弓弦、音域接近；差别在胡琴的琴筒共鸣与滑音"),
    "gaohu_real": ("高胡", "小提琴", True, "中",
                   "同为弓弦但共鸣方式不同：高胡用蛇皮琴筒，音色更亮更集中"),
    "zhongruan_real": ("中阮", "尼龙弦吉他", True, "中",
                       "同为拨弦、音域接近；阮用拨片、音色更圆润，吉他偏亮"),
    "daruan_real": ("大阮", "原声贝斯", True, "中",
                    "同属低音拨弦，但贝斯是低音提琴族、阮是弹拨乐，起音差别明显"),
    "liuqin_real": ("柳琴", "钢弦吉他", True, "中",
                    "同为钢弦拨弦、音域偏高；柳琴用拨片、音色更尖亮"),
    "guanzi_real": ("管子", "唢呐", True, "低",
                    "同为双簧管类、音色高亢；差别在管子的筒音与音域"),
    "xun_real": ("埙", "陶笛", True, "低",
                 "同为陶土闭管吹奏、音色古朴；埙的指孔与俯吹更特殊"),
    "qudi_real": ("曲笛", "长笛", True, "中",
                  "同为横吹但笛膜是关键：曲笛有膜振动、音色更亮有「嗡嗡」感，长笛没有"),
    "dizi_real": ("笛子", "长笛", True, "中",
                  "同上：笛膜带来的特殊音色是长笛无法替代的"),
    "xiao_real": ("箫", "尺八", True, "低",
                  "同为竖吹竹管、音色接近；箫更柔、尺八更有气声"),
    "sheng_real": ("笙", "口琴", False, "高",
                   "原理不同：笙是自由簧加竹管共鸣、可吹可吸还能和声，口琴是纯自由簧"),
    "suona_real": ("唢呐", "唢呐音色 shanai", True, "低",
                   "GM 的 shanai 本来就是按唢呐做的音色，属同类"),
    "yangqin_real": ("扬琴", "洋琴", True, "低",
                     "同为击弦、音域接近；扬琴用竹签、音色更亮"),
    "yunluo_real": ("云锣", "管钟", True, "中",
                    "同为金属敲击，但云锣是小锣组、音高明确，管钟是长鸣钟声"),
    "pengling_real": ("碰铃", "指钹（VCSL）", True, "低",
                      "同为小金属对击、音色清脆"),
    "muyu_real": ("木鱼", "木块（VCSL）", True, "中",
                  "同为木质敲击，但木鱼有腔体共鸣、音高更明确"),
    "xiaoluo_real": ("小锣", "VCSL Gong 1", True, "中",
                     "同为锣类，但小锣音高更高、有「咣」的上滑音"),
    "daluo_real": ("大锣", "VCSL Gong 1", True, "低",
                   "同为大锣类，VCSL Gong 1 是交响锣，音色接近"),
    "bo_real": ("钹", "交响钹（VCSL）", True, "低",
                "同为对击金属片、音色接近"),
    "paigu_real": ("排鼓", "通鼓（VCSL）", True, "中",
                   "同为皮膜鼓，但排鼓可调音高、音色更集中"),
}

LEVEL_ORDER = {"高": 0, "中": 1, "低": 2}


def main():
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    banks = manifest.get("banks", {})

    rows = []
    for name, (target, borrowed, same_principle, level, reason) in ASSESSMENTS.items():
        spec = banks.get(name, {})
        label = spec.get("label", "")
        if "近似" not in label:
            continue
        rows.append({
            "name": name, "target": target, "borrowed": borrowed,
            "same": same_principle, "level": level, "reason": reason,
        })
    rows.sort(key=lambda item: (LEVEL_ORDER[item["level"]], item["name"]))

    lines = []
    lines.append("")
    lines.append("## 近似音色差距评估与替换优先级")
    lines.append("")
    lines.append(f"共 **{len(rows)} 个**民族乐器用的是西方乐器采样（见 manifest 的 label 字段）。")
    lines.append("下表按「差距大小」排序，**差距大的优先换**。")
    lines.append("")
    lines.append("判断依据是**发声原理与音域是否接近**，不是主观听感：")
    lines.append("")
    lines.append("- **高**：发声原理不同，听感差异明显，应优先替换")
    lines.append("- **中**：原理接近，但目标乐器的关键特征（笛膜、蛇皮、腔体）缺失")
    lines.append("- **低**：原理与音域都接近，可接受作为临时替代")
    lines.append("")
    lines.append("| 优先级 | 目标乐器 | 当前借用 | 原理相近 | 差距 | 理由 |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for index, row in enumerate(rows, 1):
        lines.append(
            f"| {index} | {row['target']} | {row['borrowed']} | "
            f"{'是' if row['same'] else '**否**'} | **{row['level']}** | {row['reason']} |")
    lines.append("")

    high = [row for row in rows if row["level"] == "高"]
    medium = [row for row in rows if row["level"] == "中"]
    low = [row for row in rows if row["level"] == "低"]
    lines.append("### 统计")
    lines.append("")
    lines.append(f"- 差距**高**（优先换）：**{len(high)}** 个 —— "
                 + ("、".join(row["target"] for row in high) if high else "无"))
    lines.append(f"- 差距**中**（有条件就换）：**{len(medium)}** 个 —— "
                 + "、".join(row["target"] for row in medium))
    lines.append(f"- 差距**低**（可暂用）：**{len(low)}** 个 —— "
                 + "、".join(row["target"] for row in low))
    lines.append("")
    lines.append("### 为什么这轮没有直接替换")
    lines.append("")
    lines.append("1. **没有找到可用的真实中国乐器单音采样库**（CC0/CC-BY 且能单音映射的）。")
    lines.append("   VCSL 里中国乐器覆盖有限，且多为演奏片段而非逐音采样。")
    lines.append("2. 交接文档提到的 Berkley BISA 二胡资源以**短语素材**为主，")
    lines.append("   不适合直接做单音采样映射（授权也需单独核对）。")
    lines.append("3. 替换音色必须**实际试听确认**，而本轮没有做主观试听（见上文说明）。")
    lines.append("   在没听过的情况下换掉，可能换得更差。")
    lines.append("")
    lines.append("**下一步建议**：按上表优先级，先找差距「高」的那几个（笙等）的真实采样；")
    lines.append("找到后按 `tools/install_soundfonts.py` 的方式接入，并在报告里更新来源与授权。")

    text = REPORT.read_text(encoding="utf-8")
    if "## 近似音色差距评估与替换优先级" in text:
        print("报告已有该小节，跳过")
        return
    REPORT.write_text(text.rstrip() + "\n" + "\n".join(lines) + "\n", encoding="utf-8")
    print(f"已追加近似音色评估（{len(rows)} 项，高 {len(high)} / 中 {len(medium)} / 低 {len(low)}）")


if __name__ == "__main__":
    main()
