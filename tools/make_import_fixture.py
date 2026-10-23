# -*- coding: utf-8 -*-
"""生成 OMR 导入性能测试夹具：图片型低清（150 DPI）多页 PDF + 单页 PNG。

输入是 tools/make_import_fixture.mjs 用创作室（VexFlow）渲染出来的整幅谱面 PNG。
输出：
  .cache/perf/import-8p-lowres.pdf  —— 8 页 A4 图片型 PDF（每页只含一张位图）
  .cache/perf/import-1p.png         —— 单页 PNG（走「识别这一页」的图片路径）

为什么做成 150 DPI 图片型 PDF：这正是用户抱怨慢的那条「低清图片型 PDF」路径
（app.js 会 4.99× 放大到 2970×4200 再锐化 + PNG，客户端 prep 最重）。
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WORK = Path(__file__).resolve().parent.parent
SRC = WORK / ".cache" / "perf" / "score-render.png"
OUT_PDF = WORK / ".cache" / "perf" / "import-8p-lowres.pdf"
OUT_PNG = WORK / ".cache" / "perf" / "import-1p.png"

PAGE_W, PAGE_H = 1240, 1754      # A4 @ 150 DPI
MARGIN_X, MARGIN_Y = 50, 40
PAGE_COUNT = 8


def find_font():
    for path in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\arial.ttf"):
        if Path(path).is_file():
            return ImageFont.truetype(path, 26)
    return ImageFont.load_default()


def main():
    if not SRC.is_file():
        raise SystemExit("找不到 %s，先跑 tools/make_import_fixture.mjs" % SRC)
    score = Image.open(SRC).convert("L")
    w, h = score.size
    # 把整幅谱面切成上下两半（每半约 5-6 个系统），作为「一页谱」的内容
    slices = [score.crop((0, 0, w, h // 2)), score.crop((0, h // 2, w, h))]
    font = find_font()
    print("source score:", score.size, "-> slices", [s.size for s in slices])

    pages = []
    for index in range(PAGE_COUNT):
        piece = slices[index % len(slices)].copy()
        # 缩放到页面可用宽度
        avail_w = PAGE_W - 2 * MARGIN_X
        avail_h = PAGE_H - 2 * MARGIN_Y
        scale = min(avail_w / piece.width, avail_h / piece.height)
        target = (max(1, round(piece.width * scale)), max(1, round(piece.height * scale)))
        piece = piece.resize(target, Image.LANCZOS)
        page = Image.new("L", (PAGE_W, PAGE_H), 255)
        page.paste(piece, ((PAGE_W - target[0]) // 2, MARGIN_Y))
        draw = ImageDraw.Draw(page)
        # 页脚页码（同时让各页像素不同，避免任何按图像哈希的缓存干扰测量）
        draw.text((MARGIN_X, PAGE_H - 34), "fixture page %d / %d" % (index + 1, PAGE_COUNT), fill=90, font=font)
        pages.append(page)

    pages[0].save(OUT_PNG)
    print("saved", OUT_PNG, OUT_PNG.stat().st_size, "bytes")
    pages[0].save(OUT_PDF, "PDF", resolution=150.0, save_all=True, append_images=pages[1:])
    print("saved", OUT_PDF, OUT_PDF.stat().st_size, "bytes", "pages", len(pages))


if __name__ == "__main__":
    sys.exit(main())
