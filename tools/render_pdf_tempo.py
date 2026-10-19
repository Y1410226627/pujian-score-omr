# -*- coding: utf-8 -*-
"""用 PyMuPDF 渲染 Hall PDF 并跑速度 OCR（不依赖浏览器/playwright）。

这解决了「Node 里没有 document」的问题，也让速度 OCR 的验证可以完全离线跑。
"""
import json
import subprocess
import sys
from pathlib import Path

PROJECT = Path(r"E:\识谱弹琴")


def render(pdf_path, pages, scale=3, out_dir=None):
    import pymupdf
    out_dir = out_dir or Path.cwd()
    paths = []
    document = pymupdf.open(pdf_path)
    for index in range(min(pages, document.page_count)):
        page = document[index]
        matrix = pymupdf.Matrix(scale, scale)
        pixmap = page.get_pixmap(matrix=matrix, alpha=False)
        target = out_dir / f"page{index + 1:02d}.png"
        pixmap.save(target)
        paths.append(target)
    return paths


def main():
    pdf = sys.argv[1]
    pages = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    out_dir = Path(sys.argv[3]) if len(sys.argv) > 3 else Path.cwd()
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = render(pdf, pages, 3, out_dir)
    print(f"渲染 {len(paths)} 页")
    result = subprocess.run(
        [sys.executable, str(PROJECT / "tools" / "ocr_tempo.py"), str(out_dir), "--debug"],
        capture_output=True, text=True, encoding="utf-8",
    )
    print(result.stdout)
    if result.stderr.strip():
        print("stderr:", result.stderr[:300])


if __name__ == "__main__":
    main()
