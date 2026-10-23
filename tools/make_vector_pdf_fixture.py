# -*- coding: utf-8 -*-
"""造一份「矢量文字层 + 图片谱面」的 PDF 夹具，用来验证速度 OCR 的 PDF 文字层路径。

背景：整本识别有两条速度来源——① PDF 文字层（矢量 PDF，最准）② 谱面图片 OCR（扫描件）。
tools/make_import_fixture.py 造的 150 DPI 图片型 PDF 没有文字层，只能验 ②；
这里用 PyMuPDF 在每页嵌谱面图 + 第 1 页加一行「= 66」文字，让 tools/pdf_tempo_marks.py
能读出 ♩=66，从而对比「改动前/改动后」两条路径的速度结果是否一致。

输出：.cache/perf/import-8p-vector.pdf
"""
from pathlib import Path

import fitz  # PyMuPDF

WORK = Path(__file__).resolve().parent.parent
PAGES_PDF = WORK / ".cache" / "perf" / "import-8p-lowres.pdf"
OUT_PDF = WORK / ".cache" / "perf" / "import-8p-vector.pdf"

PAGE_W, PAGE_H = 595.0, 842.0  # A4 pt


def main():
    import pymupdf

    source = pymupdf.open(PAGES_PDF)
    output = pymupdf.open()
    for index in range(min(8, source.page_count)):
        source_page = source[index]
        # 取页面上的图片（Pillow 存出来的 PDF 每页一张图）
        images = source_page.get_images(full=True)
        page = output.new_page(width=PAGE_W, height=PAGE_H)
        if images:
            image = source.extract_image(images[0][0])
            rect = fitz.Rect(40, 60, PAGE_W - 40, PAGE_H - 60)
            page.insert_image(rect, stream=image["image"])
        # 第 1 页左上角印速度标记「♩ = 66」：符头用文字 ♩，再写「= 66」。
        # pdf_tempo_marks.py 只认「=」后跟 2–3 位数字，不关心前面的 ♩ 是什么字形。
        if index == 0:
            # 印在谱表左缘的小节号「1」+ 偏右的速度标记「♩ = 66」：
            # pdf_tempo_marks.py 会把 x<90 的窄数字当小节号、把「= 66」当速度，
            # 两者 y 相差 80 以内就关联起来 → 得到 (bar=1, bpm=66)，和真实制谱软件导出一致。
            page.insert_text((30, 110), "1", fontsize=9)
            page.insert_text((150, 120), "\u2669 = 66", fontsize=14)
        # 页脚页码（各页不同）
        page.insert_text((PAGE_W / 2 - 10, PAGE_H - 20), str(index + 1), fontsize=9)
    output.save(OUT_PDF)
    output.close()
    source.close()
    print("saved", OUT_PDF, OUT_PDF.stat().st_size, "bytes")

    # 自检：用项目自己的文字层解析器读一遍
    import sys
    sys.path.insert(0, str(WORK / "tools"))
    import pdf_tempo_marks

    marks = pdf_tempo_marks.extract(OUT_PDF)
    print("pdf_tempo_marks.extract =>", marks)


if __name__ == "__main__":
    main()
