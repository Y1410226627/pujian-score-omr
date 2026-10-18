#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成简谱识别的「回归语料」快照（tests/fixtures/jianpu_corpus.json）。

为什么需要：项目只有《敕勒歌》p11 这一页经过人工逐小节核对。换一份谱（不同字体、
英文声部标签、《从前慢》这种有引子括号与三连音记号的排版）时出现过系统性 ±0.5 拍偏差。
把另外几页的**当前识别结果**固化成快照，任何改动只要动了这些数字，测试立刻失败——
这样"修一个坏一个"能在提交前发现，而不是等到用户听出来。

注意：这里记录的是**当前管线的输出**，不是人工核对过的真值；`selfCheck` 里列出的
「待核对小节」正是已知需要人工看谱确认的位置（见 下一步优化方向.md）。

用法：
  # 1) 把 PDF 渲染成长边 2600px（与应用实际渲染一致）
  python tests/generate_jianpu_pages.py "D:/…/从前慢.pdf" <临时目录> 1
  …（对第 1–4 页各跑一次）
  # 2) 重新生成快照
  PUJIAN_CORPUS_DIR=<临时目录> python tests/snapshot_jianpu_corpus.py
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import jianpu  # noqa: E402

OUT = ROOT / "tests" / "fixtures" / "jianpu_corpus.json"
CORPUS_DIR = Path(os.environ.get("PUJIAN_CORPUS_DIR", ""))
FIXTURES = ROOT / "tests" / "fixtures" / "jianpu_pages"

# 语料清单：key = 快照里的名字，value = (说明, 图片路径候选列表)
CASES = {
    "chilele_p11_reference": (
        "《敕勒歌》第 11 页（简谱，已人工逐小节核对；3× 渲染）",
        [FIXTURES / "_source__p11_3x.png"],
    ),
    "chilele_p11_reference_2600": (
        "《敕勒歌》第 11 页（简谱，长边 2600px，与应用渲染一致）",
        [FIXTURES / "_source__p11_2600.png"],
    ),
    "congqianman_p01": ("《从前慢》第 1 页（长边 2600px）", [CORPUS_DIR / "从前慢_p01_2600.png"]),
    "congqianman_p02": ("《从前慢》第 2 页（长边 2600px）", [CORPUS_DIR / "从前慢_p02_2600.png"]),
    "congqianman_p03": ("《从前慢》第 3 页（长边 2600px）", [CORPUS_DIR / "从前慢_p03_2600.png"]),
    "congqianman_p04": ("《从前慢》第 4 页（长边 2600px）", [CORPUS_DIR / "从前慢_p04_2600.png"]),
}


def summarize(payload):
    """只保留「改了就该被测试抓住」的字段：音符数、声部、小节、自检结论。"""
    parts = payload.get("parts") or []
    return {
        "notes": sum(len(part.get("notes") or []) for part in parts),
        "partCounts": [len(part.get("notes") or []) for part in parts],
        "measureCount": payload.get("measureCount"),
        "beatsPerMeasure": payload.get("beatsPerMeasure"),
        "selfCheck": payload.get("selfCheck"),
    }


def main():
    pages = {}
    missing = []
    for key, (description, candidates) in CASES.items():
        path = next((item for item in candidates if item.is_file()), None)
        if path is None:
            missing.append(key)
            continue
        payload = jianpu.recognize(path, do_midi=65, beats_per_measure=4.0)
        if payload.get("error"):
            raise SystemExit("{} 识别失败：{}".format(key, payload["error"]))
        pages[key] = {"description": description, **summarize(payload)}
        print("%-28s 音符 %3d / 小节 %2d / 声部 %d" % (
            key, pages[key]["notes"], pages[key]["measureCount"], len(pages[key]["partCounts"])))
    if missing:
        print("\n跳过（找不到图片）：", "、".join(missing))
        print("提示：《从前慢》的页面需要用 tests/generate_jianpu_pages.py 先渲染，"
              "并用 PUJIAN_CORPUS_DIR 指向那个目录。")
    if not pages:
        raise SystemExit("没有可用的语料页，未写入快照。")
    payload = {
        "provenance": (
            "由 jianpu.py 识别得到；除 chilele_p11_reference* 是人工逐小节核对过的基准外，"
            "其余记录的是当前管线输出（回归护栏，不是真值）。selfCheck.issues 列出的是已知需要"
            "人工核对的「拍数与拍号对不上」的小节，详见 下一步优化方向.md。"
        ),
        "options": {"do": 65, "beats": 4},
        "pages": pages,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("\n写入", OUT)


if __name__ == "__main__":
    main()
