# -*- coding: utf-8 -*-
"""从 PDF 文字层直接读速度标记 + 小节号 → 精确的「第几小节 / BPM」映射。

这是比 OCR 更可靠的主路径：MuseScore 等制谱软件导出的 PDF 把速度记号写成普通文字
（`=` 和 `138` 是相邻的两个 word，前面还有一个四分音符符头的字形）。
有了文字层，速度和位置都是精确值，不需要猜像素。

文字层拿不到时（扫描件/图片型 PDF）才回退到 tools/ocr_tempo.py 的几何 OCR。

用法：
    py -3 tools/pdf_tempo_marks.py <pdf>
输出：JSON [{page, bar, bpm, x, y, raw}]，bar 是谱面印刷的小节号（拿不到则为 null）。
"""
import json
import re
import sys
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover
    pymupdf = None

NUMBER_RE = re.compile(r"^\s*(\d{2,3})\s*$")
BAR_RE = re.compile(r"^\s*(\d{1,3})\s*$")


def extract(pdf_path):
    """返回 [{page, bpm, x, y, bar, raw}]。"""
    if pymupdf is None:
        raise RuntimeError("需要 PyMuPDF：pip install pymupdf")
    document = pymupdf.open(pdf_path)
    marks = []
    for index in range(document.page_count):
        page = document[index]
        words = page.get_text("words")  # [(x0,y0,x1,y1,word,block,line,word_no)]
        # 1) 速度标记：「=」word 紧跟着一个 2–3 位数字 word（同一行、水平相邻）
        for position, word in enumerate(words):
            if word[4].strip() != "=":
                continue
            following = words[position + 1] if position + 1 < len(words) else None
            if not following:
                continue
            matched = NUMBER_RE.match(following[4].strip())
            if not matched:
                continue
            value = int(matched.group(1))
            if not (20 <= value <= 320):
                continue
            # 必须在同一行（y 差 < 5）且水平相邻（x 差 < 40）
            if abs(word[1] - following[1]) > 6 or abs(following[0] - word[2]) > 40:
                continue
            marks.append({
                "page": index + 1,
                "bpm": value,
                "x": round(word[0], 1),
                "y": round(word[1], 1),
                "bar": None,
                "raw": f"= {value}",
            })
        # 2) 小节号：孤立的窄数字（页面左缘，字宽 < 30px）
        numbers = []
        for word in words:
            text = word[4].strip()
            if not BAR_RE.match(text):
                continue
            value = int(text)
            if not (1 <= value <= 400):
                continue
            if (word[2] - word[0]) > 22:
                continue
            numbers.append({"bar": value, "x": round(word[0], 1), "y": round(word[1], 1)})
        # 3) 关联：速度标记 → 它**上方最近的、印在谱表左缘**的小节号。
        #    谱面小节号印在最左缘（x 通常 < 80），速度记号在谱表中间（x ≥ 100），
        #    所以只认 x < 90 的候选；y 必须在速度标记上方 80px 内（同一系统）。
        for mark in marks:
            if mark["page"] != index + 1:
                continue
            candidates = [item for item in numbers
                          if item["x"] < 90 and item["y"] <= mark["y"] + 30
                          and mark["y"] - item["y"] < 80]
            if candidates:
                nearest = max(candidates, key=lambda item: item["y"])
                mark["bar"] = nearest["bar"]
    return marks


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    marks = extract(Path(sys.argv[1]))
    for mark in marks:
        bar = mark["bar"] if mark["bar"] is not None else "?"
        print(f"第 {mark['page']} 页  第 {bar} 小节  ♩={mark['bpm']}  "
              f"(x={mark['x']}, y={mark['y']})")
    print("共", len(marks), "处")
    print(json.dumps(marks, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
