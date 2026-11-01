# -*- coding: utf-8 -*-
"""从 PDF 文字层读出「谱面排版信息」：声部标签、印刷小节号、拍号字形。

为什么需要：Audiveris 把整页当成一个长条来认，一页里的多个系统会被当成「同一拨声部的连续小节」，
声部对不上、小节错位（用户反馈的「莫名其妙的空拍 / 声部不准」）。逐系统识别之后，
还需要知道「每个系统从第几小节开始」「每行有哪些声部」「哪里转拍号」——这些信息
在 MuseScore/Sibelius 导出的 PDF 里都是**文字层**，可以直接精确读出，比 OCR/看图猜可靠：

- 声部标签：印在谱表左缘（Soprano / S. / 陶笛 / Pno.），音乐符号字体之外的小字；
- 印刷小节号：每行开头的小号数字（6、11、15…），用来核对/纠正小节数；
- 拍号字形：Sibelius 把 4/4 印成 OpusStd 字体的 "44" 两个数字字形，6/4 就是 "64"。
  它们出现在「哪一小节」直接决定变拍子处的小节长度。

用法：
    py -3 tools/pdf_score_layout.py <pdf>   # 打印 JSON
输出 JSON：{pages: [{page, width, height, labels, bars, timeGlyphs}]}
"""
import json
import re
import sys
from pathlib import Path

try:
    import pymupdf
except ImportError:  # pragma: no cover
    pymupdf = None

# 制谱软件里排版音乐符号用的字体：这些字体里的 "44"/"64" 是拍号图形，不是普通数字。
MUSIC_FONT_MARKERS = ("opus", "maestro", "bravura", "sonata", "mscore", "leland", "emmentaler", "petrucci")
BAR_RE = re.compile(r"^\d{1,3}$")
TIME_GLYPH_RE = re.compile(r"^\d{2,3}$")
LABEL_CHAR_RE = re.compile(r"[A-Za-z\u4e00-\u9fff]")


def is_music_font(font_name):
    lowered = str(font_name or "").lower()
    return any(marker in lowered for marker in MUSIC_FONT_MARKERS)


def glyph_text_to_meter(text):
    """Sibelius 拍号字形 → "拍数/音符时值"：44→4/4、64→6/4、68→6/8、128→12/8。"""
    if not TIME_GLYPH_RE.match(text):
        return ""
    if len(text) == 2:
        return f"{text[0]}/{text[1]}"
    return f"{text[:2]}/{text[2]}"


def extract_layout(pdf_path):
    """返回 {pages: [{page, width, height, labels, bars, timeGlyphs}]}。"""
    if pymupdf is None:
        raise RuntimeError("需要 PyMuPDF：pip install pymupdf")
    document = pymupdf.open(pdf_path)
    pages = []
    for index in range(document.page_count):
        page = document[index]
        rect = page.rect
        labels, bars, time_glyphs = [], [], []
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    text = span["text"].strip()
                    if not text:
                        continue
                    x0, y0, x1, y1 = span["bbox"]
                    width = round(x1 - x0, 1)
                    height = round(y1 - y0, 1)
                    font = span["font"]
                    size = round(span["size"], 1)
                    music = is_music_font(font)
                    # 1) 拍号字形：音乐字体里的 2–3 位数字，位于谱号右侧。
                    if music and TIME_GLYPH_RE.match(text) and 90 <= x0 <= 420:
                        meter = glyph_text_to_meter(text)
                        if meter:
                            time_glyphs.append({
                                "text": text, "meter": meter,
                                "x": round(x0, 1), "y": round(y0, 1),
                                "width": width, "height": height,
                            })
                        continue
                    if music:
                        continue
                    # 2) 印刷小节号：页面左缘、字号 6–10、纯数字（页脚页码 x 居中，会被排除）
                    if BAR_RE.match(text) and x0 < 110 and size <= 10.5 and width <= 26:
                        value = int(text)
                        if 1 <= value <= 400:
                            bars.append({
                                "bar": value, "x": round(x0, 1), "y": round(y0, 1),
                                "height": height,
                            })
                        continue
                    # 3) 声部标签：谱表左缘（x < 90）的短文字，如 Soprano / S. / 陶笛 / Pno.
                    if x0 < 90 and len(text) <= 24 and LABEL_CHAR_RE.search(text) and not BAR_RE.match(text):
                        labels.append({
                            "text": text, "x": round(x0, 1), "y": round(y0, 1),
                            "width": width, "height": height,
                        })
        # 同一行标签去重（有些 PDF 会把同一个标签拆成多个 span）
        merged_labels = []
        for label in sorted(labels, key=lambda item: (item["y"], item["x"])):
            joined = False
            for existing in merged_labels:
                if abs(existing["y"] - label["y"]) < 2 and abs(existing["x"] - label["x"]) < 40:
                    joined = True
                    break
            if not joined:
                merged_labels.append(label)
        pages.append({
            "page": index + 1,
            "width": round(rect.width, 2),
            "height": round(rect.height, 2),
            "labels": merged_labels,
            "bars": sorted(bars, key=lambda item: (item["y"], item["x"])),
            "timeGlyphs": sorted(time_glyphs, key=lambda item: (item["y"], item["x"])),
        })
    return {"pages": pages}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    layout = extract_layout(Path(sys.argv[1]))
    for page in layout["pages"]:
        print(f"第 {page['page']} 页 {page['width']}×{page['height']}："
              f"标签 {[item['text'] for item in page['labels']]} "
              f"小节号 {[item['bar'] for item in page['bars']]} "
              f"拍号字形 {[(item['meter'], item['x']) for item in page['timeGlyphs']]}")
    print(json.dumps(layout, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
