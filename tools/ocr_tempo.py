#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从谱面图里读「速度标记」的数字（♩=138 这类）。

为什么不能只靠 Audiveris：它的 MusicXML 里速度记号来自符号识别 + OCR，
实测《在山魔王的宫殿》第 1 页有 5 处速度标记（138/80/85/90/95），
Audiveris 只输出 1 处、而且读成 66。速度数字是普通阿拉伯数字，
用「数字模板匹配」比让 OMR 引擎猜要可靠得多——本模块就做这一件事。

思路：
1) 速度标记一定紧跟在「=」后面，且左侧有一个小小的四分音符符头（♩）；
2) 先找「=」：两条平行短横线，宽 10–40px、高 2–8px、上下间距 6–20px；
3) 「=」右边 1–3 个数字：按连通块宽高比 > 0.35、高 15–60px 筛；
4) 数字用内置 7 段式轮廓特征做 0–9 分类（不依赖字体/模板文件）；
5) 输出 (页, x, y, bpm)，由上层和 MusicXML 的 tempoMarks 合并。

用法：
    py -3 tools/ocr_tempo.py <页面图片目录> [--pages 1-8] [--debug]

供 serve.py 的 /api/omr/tempo 接口调用，也用于离线核对。
"""
import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

PROJECT = Path(__file__).resolve().parent.parent
TEMPO_MIN, TEMPO_MAX = 20, 320


# ---------------------------------------------------------------- 图像基础
def load_gray(path):
    from PIL import Image
    return np.asarray(Image.open(path).convert("L"), dtype=np.uint8)


def binarize(gray, threshold=128):
    """返回 True=墨迹 的布尔矩阵。"""
    return gray < threshold


def connected_components(mask):
    """4 邻域连通域：返回 [(x0, y0, x1, y1, area)]（含端点）。"""
    height, width = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    boxes = []
    for y in range(height):
        row = mask[y]
        if not row.any():
            continue
        for x in np.nonzero(row & ~seen[y])[0]:
            if seen[y, x]:
                continue
            stack = [(x, y)]
            seen[y, x] = True
            x0 = x1 = x
            y0 = y1 = y
            area = 0
            while stack:
                cx, cy = stack.pop()
                area += 1
                x0 = min(x0, cx); x1 = max(x1, cx)
                y0 = min(y0, cy); y1 = max(y1, cy)
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < width and 0 <= ny < height and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((nx, ny))
            if area >= 12:
                boxes.append((x0, y0, x1, y1, area))
    return boxes


# ---------------------------------------------------------------- 数字识别
def digit_features(mask, box):
    """把一个数字块归一化成 7×5 网格的墨迹比例，作为"形状指纹"。"""
    x0, y0, x1, y1, _ = box
    patch = mask[y0:y1 + 1, x0:x1 + 1]
    rows, cols = patch.shape
    grid_rows, grid_cols = 7, 5
    features = np.zeros((grid_rows, grid_cols), dtype=np.float32)
    for gy in range(grid_rows):
        ya = int(gy * rows / grid_rows)
        yb = max(ya + 1, int((gy + 1) * rows / grid_rows))
        for gx in range(grid_cols):
            xa = int(gx * cols / grid_cols)
            xb = max(xa + 1, int((gx + 1) * cols / grid_cols))
            cell = patch[ya:yb, xa:xb]
            features[gy, gx] = float(cell.mean()) if cell.size else 0.0
    return features


def _normalize_patch(mask, box, target_height=48):
    """把数字块缩放到固定高度（最近邻），让分类阈值与原始分辨率无关。"""
    x0, y0, x1, y1, _ = box
    patch = mask[y0:y1 + 1, x0:x1 + 1]
    height, width = patch.shape
    if height <= 0 or width <= 0:
        return np.zeros((target_height, 1), dtype=bool)
    target_width = max(4, int(round(width * target_height / height)))
    # 最近邻重采样（不装 scipy：用整数索引就够，数字是二值图）
    rows = (np.arange(target_height) * height / target_height).astype(int)
    rows = np.clip(rows, 0, height - 1)
    cols = (np.arange(target_width) * width / target_width).astype(int)
    cols = np.clip(cols, 0, width - 1)
    return patch[rows][:, cols]


def _profile(mask, box):
    """把数字块压成一组几何统计量（先把尺寸归一化到 48px 高，尺度无关）。"""
    patch = _normalize_patch(mask, box, 48)
    height, width = patch.shape
    rows, cols = 16, 8
    row_ratio = []
    for gy in range(rows):
        ya = int(gy * height / rows)
        yb = max(ya + 1, int((gy + 1) * height / rows))
        row_ratio.append(float(patch[ya:yb].mean()))
    col_ratio = []
    for gx in range(cols):
        xa = int(gx * width / cols)
        xb = max(xa + 1, int((gx + 1) * width / cols))
        col_ratio.append(float(patch[:, xa:xb].mean()))
    x0, y0, x1, y1, _ = box
    return {
        # 宽高比用**归一化前**的真实比例（数字 1 的特征，不能被重采样抹平）
        "ratio": (x1 - x0 + 1) / max(1, (y1 - y0 + 1)),
        "top": float(sum(row_ratio[0:3]) / 3),
        "upper": float(sum(row_ratio[3:8]) / 5),
        "middle": float(sum(row_ratio[7:9]) / 2),
        "lower": float(sum(row_ratio[9:13]) / 4),
        "bottom": float(sum(row_ratio[13:16]) / 3),
        "left": float(sum(col_ratio[0:2]) / 2),
        "right": float(sum(col_ratio[6:8]) / 2),
        "center": float(patch[height // 3: height * 2 // 3, width // 3: width * 2 // 3].mean()),
        "middle_cols": float(sum(col_ratio[3:6]) / 3),
        "top_half": float(patch[:height // 2].mean()),
        "bottom_half": float(patch[height // 2:].mean()),
        "row": row_ratio,
        "col": col_ratio,
    }


def classify_digit(mask, box):
    """单个数字块 → '0'–'9'。判据基于两个渲染器的实测字形（见文件头注释）。"""
    p = _profile(mask, box)
    ratio = p["ratio"]
    top = p["top"]; middle = p["middle"]; bottom = p["bottom"]
    left = p["left"]; right = p["right"]; center = p["center"]
    top_half = p["top_half"]; bottom_half = p["bottom_half"]

    # 1：细高竖线（中列几乎全满、左右都空）
    if ratio <= 0.48 and p["middle_cols"] > 0.65:
        return "1"
    # 0：上下都是闭合弧、左右都有竖边、中心空（与 9 的关键差别：9 的下半是斜收、不是闭合弧）
    if left > 0.32 and right > 0.32 and top > 0.28 and bottom > 0.34 and center < 0.28:
        return "0"
    # 5：顶横很实 + 中横也实 + 左竖弱（左侧只有上半有）
    if top > 0.58 and middle > 0.55 and left < 0.42:
        return "5"
    # 9：上实下虚（下半斜收、底横弱）
    if top_half - bottom_half > 0.10 and bottom < 0.40:
        return "9"
    # 6：上细下粗（上半是细弧、下半闭合实心）
    if bottom_half - top_half > 0.12 and top < 0.42 and center >= 0.18:
        return "6"
    # 8：上下均匀、中心实
    if center > 0.40 and top_half > 0.28 and bottom_half > 0.28:
        return "8"
    # 3：右竖强、左竖弱、底部无横
    if right > 0.45 and left < 0.28 and bottom < 0.40:
        return "3"
    # 7：顶横 + 右竖 + 底弱
    if top > 0.50 and bottom < 0.38 and right > 0.32:
        return "7"
    # 2：顶横 + 底横
    if top > 0.42 and bottom > 0.42:
        return "2"
    # 4：中横突出、顶部空、左竖弱、底部空
    if middle > 0.55 and top < 0.42 and left < 0.32 and bottom < 0.42:
        return "4"
    if bottom_half > top_half:
        return "6"
    return "2"


def find_equals_signs(mask):
    """找「=」：上下两条平行短横线。返回 [(x0, y0, x1, y1)]（覆盖整个等号）。"""
    boxes = connected_components(mask)
    bars = []
    for (x0, y0, x1, y1, area) in boxes:
        width = x1 - x0 + 1
        height = y1 - y0 + 1
        if 6 <= width <= 60 and 1 <= height <= 12 and width / max(1, height) >= 2.2:
            bars.append((x0, y0, x1, y1))
    equals = []
    for top in bars:
        for bottom in bars:
            if bottom is top or bottom[1] <= top[1]:
                continue
            gap = bottom[1] - (top[3] + 1)
            if 4 <= gap <= 22 and abs(top[0] - bottom[0]) <= 6 and abs(top[2] - bottom[2]) <= 6:
                equals.append((min(top[0], bottom[0]), top[1], max(top[2], bottom[2]), bottom[3]))
    return equals


def read_after_equals(mask, equals_box):
    """读「=」右边的 1–3 个数字。

    注意谱面写法是「♩ = 66」：等号左边的音符符号可能与上横线粘连，
    所以数字搜索从「等号右端 + 半个等号宽」开始，避免把符干/符头当成数字。
    """
    x0, y0, x1, y1 = equals_box
    equals_width = max(6, x1 - x0 + 1)
    center_y = (y0 + y1) / 2
    candidates = []
    for box in connected_components(mask):
        bx0, by0, bx1, by1, area = box
        bw = bx1 - bx0 + 1
        bh = by1 - by0 + 1
        if not (4 <= bw <= 60 and 12 <= bh <= 90):
            continue
        if not (0.22 <= bw / bh <= 1.35):
            continue
        # 数字必须与等号中线大致同一行（数字比等号高，允许 ±0.9 个字高）
        bc_y = (by0 + by1) / 2
        if abs(bc_y - center_y) > max(bh, 22) * 0.9:
            continue
        # 水平位置：从等号右端往后 0.3–2.6 个等号宽（避开左侧的 ♩ 符干）
        offset = bx0 - x1
        if offset < max(3, equals_width * 0.3):
            continue
        if offset > equals_width * 2.6 + 40:
            continue
        candidates.append(box)
    if not candidates:
        return ""
    candidates.sort(key=lambda item: item[0])
    group = [candidates[0]]
    for box in candidates[1:]:
        prev = group[-1]
        gap = box[0] - prev[2]
        unit = max(10, prev[3] - prev[1] + 1)
        if gap > unit * 0.75:
            break
        overlap = min(prev[3], box[3]) - max(prev[1], box[1]) + 1
        if overlap < unit * 0.4:
            break
        group.append(box)
        if len(group) >= 3:
            break
    return "".join(classify_digit(mask, box) for box in group[:3])


def tempos_in_page(gray):
    """一页里所有「=XXX」速度标记。返回 [{x, y, bpm, raw}]。"""
    found = []
    mask = binarize(gray)
    for equals_box in find_equals_signs(mask):
        raw = read_after_equals(mask, equals_box)
        matched = re.fullmatch(r"(\d{2,3})", raw or "")
        if not matched:
            continue
        value = int(matched.group(1))
        if not TEMPO_MIN <= value <= TEMPO_MAX:
            continue
        x0, y0, x1, y1 = equals_box
        found.append({"x": int((x0 + x1) / 2), "y": int((y0 + y1) / 2), "bpm": value, "raw": raw})
    return found


def main():
    parser = argparse.ArgumentParser(description="从谱面图读速度标记数字")
    parser.add_argument("images", help="页面图片目录（pageNN.png）")
    parser.add_argument("--pages", default="", help="只处理指定页，如 1-3,5")
    parser.add_argument("--out", default="tempo-ocr.json")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    pages_filter = set()
    if args.pages:
        for part in args.pages.split(","):
            if "-" in part:
                start, end = part.split("-", 1)
                pages_filter.update(range(int(start), int(end) + 1))
            else:
                pages_filter.add(int(part))

    results = {}
    for image_path in sorted(Path(args.images).glob("*.png")):
        matched = re.search(r"(\d+)", image_path.stem)
        if not matched:
            continue
        page = int(matched.group(1))
        if pages_filter and page not in pages_filter:
            continue
        gray = load_gray(image_path)
        found = tempos_in_page(gray)
        results[page] = found
        print(f"page{page}: {len(found)} 处 " + ", ".join(str(item["bpm"]) for item in found))
        if args.debug:
            for item in found:
                print(f"   x={item['x']} y={item['y']} raw={item['raw']!r}")
    Path(args.out).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print("已写出", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
