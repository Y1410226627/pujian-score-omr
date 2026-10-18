#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""简谱（数字谱）识别引擎。

输入：计算机排版的简谱页面图片（PNG / JPEG）。
输出：内部音符模型 JSON —— 不生成 MusicXML，由前端转换成与导入 MusicXML 同构的音符结构。

    {
      "parts": [{"name": "声部1", "notes": [{"midi": 69, "startBeat": 0.0, "durationBeats": 4.0}]}],
      "measureCount": 12,
      "beatsPerMeasure": 4.0,
      "warnings": ["..."]
    }

管线：二值化 → 系统切分 → 行带切分 → 符号分类（数字/小节线/点/横线）→ 数字模板匹配
      → 时值与八度判定（减时线分层、附点、延长号、上下八度点）→ 小节网格与拍位
      → 声部归属（块序对齐 + 分叉小节判定）→ 音符模型。

依赖：opencv-python、numpy、Pillow（随 .venv 中 homr 一并安装）。
命令行：python jianpu.py 页面.png [--dump] [--json 输出.json] [--do 65] [--beats 4]
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw, ImageFont
except ImportError as error:  # cv2/PIL 缺失时给出可读提示，供服务端转成 503
    print(json.dumps({"error": "简谱识别缺少依赖：{}。请先安装 opencv-python、numpy、Pillow。".format(error)},
                     ensure_ascii=False))
    sys.exit(2)

DIGITS = "01234567"
# 括号等非数字符号：必须显式建模板并判否，否则「(」「)」会被当成数字 0
# （《从前慢》的引子段落就用括号框起，实测会被读成 0 并顶掉一拍）。
REJECT_GLYPHS = ("(", ")")
MAJOR_SCALE = (0, 2, 4, 5, 7, 9, 11)   # 数字 1-7 相对 do 的半音数
BINARIZE_THRESHOLD = 180
CHORD_GAP = 14                          # 同 x 相邻小于该值视为和弦（同时发音）
MATCH_THRESHOLD = 0.5                   # 数字模板匹配接受阈值
SYSTEM_MIN_HEIGHT = 100                 # 系统块最小高度
LINE_MERGE_GAP = 12                     # 行带相邻合并上限
LINE_ASSIGN_MAX_DIST = 40               # 连通域归入行带的最大纵向距离
BLOCK_REL_GAP = 0.18                    # 兜底：系统内同一声部标签的行 rel 连块上限
SUB_REL_GAP = 0.06                      # 块内子声部 rel 聚类上限
LEVEL_MERGE_GAP = 8                     # （回退用）减时线同层合并的 y 差上限；实际按 LEVEL_MERGE_RATIO × 字高
LEVEL_MERGE_RATIO = 0.35                # 同一条减时线被印刷劈成两段时的 y 容差（相对字高）
BAR_TOLERANCE = 10                      # 假小节线跨行验证的 x 容差
MIN_ROW_DIGITS = 2                      # 一行至少要有这么多个数字才算声部行（否则视作印刷碎片）
TRIPLET_RATIO = 2.0 / 3.0               # 三连音：3 个音符占 2 个的时值
TRIPLET_MARK_MIN_SCORE = 0.65           # （保留）三连音记号匹配阈值
TRIPLET_MARK_MAX_GAP = 60               # 记号离本行基准线的最大距离
# 三连音自动处理默认**关闭**。已做的加固：
# ① 记号改为扫描整个系统的字形（它常自成一条窄行带）；② 「叠置和弦」护栏——与本行数字
# 同 x 同高（约一个字形高 15–33px）的字形是和弦音、不是记号（此前误判会**静默丢音**：119 → 117）；
# ③ 读数 A 不排除任何字形，只有被「拍号」裁判采纳时才剔除记号。
# **决定性事实（2026-10-18 实测）**：三连音记号印得比数字小（17×20px，数字是 18×27px），
# 模板匹配只拿到 **0.497**，卡在 MATCH_THRESHOLD=0.5 之下 → 记号**根本没被认成「3」**，
# 所以永远找不到记号。真正的修法要动「字形归一化」，一动就会让敕勒歌 p11 少 1 个音
# （基准是人工逐小节核对过的 119，不能破）。因此保持关闭：对超拍小节**如实报警告**。
# 详细数据与修法建议见「下一步优化方向.md」零/六节。
TRIPLETS_ENABLED = False


def find_font():
    """找一个用于渲染数字模板的粗体无衬线字体。"""
    windir = os.environ.get("WINDIR", r"C:\Windows")
    candidates = [Path(windir) / "Fonts" / name for name in ("arialbd.ttf", "ariblk.ttf", "arial.ttf", "segoeuib.ttf")]
    try:
        import PIL
        pil_fonts = Path(PIL.__file__).resolve().parent / "fonts"
        candidates += [pil_fonts / name for name in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf")]
    except Exception:
        pass
    for path in candidates:
        if path.is_file():
            return path
    raise RuntimeError("找不到可用的数字模板字体（尝试过 arialbd/arial/DejaVuSans）。")


FONT_PATH = find_font()


# ---------------- 基础切分 ----------------

def binarize(gray):
    return (gray < BINARIZE_THRESHOLD).astype(np.uint8)


def find_bands(mask, min_height=8):
    """按行填充的空/非空区间切带。"""
    row_fill = mask.sum(axis=1)
    bands, in_band, start = [], False, 0
    for y, value in enumerate(row_fill):
        if value > 0 and not in_band:
            in_band, start = True, y
        elif value == 0 and in_band:
            in_band = False
            bands.append((start, y))
    if in_band:
        bands.append((start, len(row_fill)))
    return [(a, b) for a, b in bands if b - a >= min_height]


def find_systems(mask):
    """整页自上而下的系统块（高 > SYSTEM_MIN_HEIGHT）。"""
    return [(a, b) for a, b in find_bands(mask, min_height=8) if b - a > SYSTEM_MIN_HEIGHT]


def components(mask):
    """连通域 [(x, y, w, h, area)]。"""
    count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    return [tuple(int(v) for v in stats[i][:5]) for i in range(1, count)]


def is_glyph(box):
    """数字字形的大小范围（可容纳 1-7 与八度点/少量噪声）。

    范围写得比较宽（字高 16–32px、宽 6–24px），是为了同时容纳 3× 与 3.8× 两种渲染：
    字高约 23 与 24px，「1」这类窄字宽只有 9–10px。真正挡住噪声的是后面的模板匹配。
    """
    _x, _y, w, h, _area = box
    return 16 <= h <= 32 and 6 <= w <= 24


def split_lines(sys_mask, comps):
    """把系统块切成行带。

    系统内相邻行常被八度点/下划线/弧线桥接，直接水平投影切不开；
    改用「数字字形域的 y 直方图 run 检测」：run 峰 ≥2 且高 ≥10 才算一行，
    再把每个连通域按 y 中心归入最近的行带。
    """
    height = sys_mask.shape[0]
    hist = np.zeros(height, dtype=int)
    for box in comps:
        if is_glyph(box):
            _x, y, _w, h, _area = box
            hist[y:y + h] += 1
    runs, in_run, start = [], False, 0
    for y, value in enumerate(hist):
        if value > 0 and not in_run:
            in_run, start = True, y
        elif value == 0 and in_run:
            in_run = False
            runs.append((start, y, int(hist[start:y].max())))
    if in_run:
        runs.append((start, height, int(hist[start:].max())))
    bands = [[a, b] for a, b, peak in runs if peak >= 2 and b - a >= 10]
    if not bands:
        return []
    merged = [bands[0]]
    for band in bands[1:]:
        if band[0] - merged[-1][1] < LINE_MERGE_GAP:
            merged[-1][1] = band[1]
        else:
            merged.append(band)
    lines = [[] for _ in merged]
    for box in comps:
        center_y = box[1] + box[3] / 2
        dists = [0 if a <= center_y <= b else min(abs(center_y - a), abs(center_y - b)) for a, b in merged]
        index = min(range(len(merged)), key=lambda i: dists[i])
        if dists[index] <= LINE_ASSIGN_MAX_DIST:
            lines[index].append(box)
    return [line for line in lines if line]


# ---------------- 数字模板匹配 ----------------

def render_glyph(char, size=64):
    """用字体渲染一个数字，裁到笔画外框后归一化到 32×32。

    试过「保持长宽比 + 居中留白」的归一化（见临时实验）：它能把被丢掉的窄「1」和偏小的
    三连音记号「3」找回来（从前慢 p2 158 → 167 音符、超拍警告 3 → 2），**但会让敕勒歌 p11
    少 1 个音（119 → 118）**，破坏已人工核对过的基准。因此这里仍用直接拉伸——
    两种归一化必须与 glyph_image 用同一种，否则模板与字形对不齐。
    """
    font = ImageFont.truetype(str(FONT_PATH), size)
    image = Image.new("L", (size * 2, size * 2), 0)
    ImageDraw.Draw(image).text((size // 2, size // 2), char, font=font, fill=255)
    arr = np.array(image)
    ys, xs = np.where(arr > 100)
    if len(xs) == 0:
        return None
    return cv2.resize(arr[ys.min():ys.max() + 1, xs.min():xs.max() + 1], (32, 32), interpolation=cv2.INTER_AREA)


def glyph_image(mask, box):
    x, y, w, h, _area = box
    return cv2.resize(mask[y:y + h, x:x + w] * 255, (32, 32), interpolation=cv2.INTER_AREA)


# 字体模板只渲染一次（用字体渲染 9 个数/符号模板要几十毫秒，而 recognize() 每页都会被调用——
# 多页整本识别时这份开销会白白重复 N 次）。
_TEMPLATE_CACHE = {}


def render_templates():
    """数字模板 + 必须被判否的非数字符号模板（键以 reject: 开头）。结果在进程内缓存。"""
    if "templates" not in _TEMPLATE_CACHE:
        templates = {digit: render_glyph(digit) for digit in DIGITS}
        for char in REJECT_GLYPHS:
            image = render_glyph(char)
            if image is not None:
                templates["reject:" + char] = image
        _TEMPLATE_CACHE["templates"] = templates
    return _TEMPLATE_CACHE["templates"]


def match_digit(image32, templates):
    """返回 (数字, 分数)；分数低于阈值、或最像的是非数字符号时，数字为 None。"""
    scores = {key: float(cv2.matchTemplate(image32, template, cv2.TM_CCOEFF_NORMED)[0, 0])
              for key, template in templates.items()}
    best = max(scores, key=scores.get)
    if best.startswith("reject:") or scores[best] < MATCH_THRESHOLD:
        return (None, scores[best])
    return (best, scores[best])


# ---------------- 行内符号解析 ----------------

def find_bar_columns(sys_mask, y_from, y_to, min_run):
    """在一段纵向范围里，按「每列最长连续黑像素」找出贯通的长竖线所在 x —— 小节线。

    为什么不沿用「细高连通域」判据（w<=8 且 h>1.6*med_h）：小节线一旦与**连音弧/减时线相连**
    （实测《从前慢》p3 第 2 系统正是如此），那些笔画会和小节线并成**同一个连通域**，
    连通域随之变宽，w<=8 立刻失效 → 真小节线被漏掉 → 两小节并成一个、
    使**其后所有小节的起拍整体偏移**（听起来就是「莫名多停一下」「不对拍」）。
    按列统计竖向连续黑像素则不受「和谁相连」影响：小节线那一列必然有 50px 以上的连续黑，
    而数字只有字形高（约 27px）、连音弧只有几个像素。
    """
    y_from = max(0, int(y_from))
    y_to = min(sys_mask.shape[0], int(y_to))
    if y_to - y_from < min_run:
        return []
    strip = sys_mask[y_from:y_to] > 0
    run = np.zeros(strip.shape, dtype=np.int32)
    run[0] = strip[0].astype(np.int32)
    for y in range(1, strip.shape[0]):
        run[y] = (run[y - 1] + 1) * strip[y]
    longest = run.max(axis=0)                      # 每列的最长连续黑像素长度
    groups = []
    for x in np.where(longest >= min_run)[0]:
        if groups and x - groups[-1][-1] <= 2:
            groups[-1].append(int(x))
        else:
            groups.append([int(x)])
    return [float(np.mean(group)) for group in groups]


def parse_line(line, sys_mask, music_start_x, templates, med_h, exclude=()):
    """一行内的数字与符号。

    丢弃 music_start_x 左侧的连通域（声部标签、力度记号）；
    exclude 里的字形也被跳过（例如已被认定为三连音记号的「3」）。

    所有尺寸判据都写成 med_h（本行字高中位数）的比例，不写死像素——
    否则换一个渲染比例，横线/点/小节线的分类就会整体失效：
    同一页在 1785×2523（3×）与 1840×2600（3.8×，应用实际渲染尺寸）下字高是 23 与 24px、
    横线厚度是 2 与 3–4px，写死 h<=6 / box[3]-3 / ±9px 的判据必有一边失效。
    """
    parsed = {"digits": [], "dots": [], "maybe_dots": [], "bars_x": [], "horizontals": [], "dropped": 0}
    excluded = set(exclude) if exclude else set()
    glyphs = sorted((b for b in line if is_glyph(b) and b[0] + b[2] >= music_start_x + 10), key=lambda b: b[0])
    for box in glyphs:
        if tuple(box) in excluded:
            continue
        digit, _score = match_digit(glyph_image(sys_mask, box), templates)
        if digit is None:
            parsed["dropped"] += 1
            continue
        parsed["digits"].append((box[0], digit, box))
    dot_max = max(4, int(round(0.38 * med_h)))          # 八度点/附点的大小上限
    # 横向笔画的厚度上限：减时线/延长号实测 2–4px（3× 渲染的延长号是 15×4）。
    # 这个上限必须够宽——收紧到 3px 会把 prolongation dash「-」整类丢掉，
    # 于是「4 - 5 -」这种两拍长音被读成两拍，整小节时值全错。
    horiz_max = max(3, int(round(0.20 * med_h)))
    horiz_min_w = max(6, int(round(0.45 * med_h)))      # 横向笔画的最小长度
    # 小方点（八度点/附点）与「短横线」的区分：两者都小，但点是**近乎正方形**、
    # 横线是**扁的**（宽 ≥ 2.5× 高）。判据按**像素**算而不是按比例：横线必须至少 2px 厚、
    # 且宽高比 ≥ 2.5。1px 高的连通域在简谱里既可能是印刷成一条细线的短横线、
    # 也可能是被二值化压扁的圆点（实测八度点会渲染成 27×1），不能只靠比例判断——交给
    # attach_symbols 按「离谁近、在字的哪个方位」再决定。
    for x, y, w, h, area in line:
        if x + w < music_start_x + 10:
            continue
        if h > 1.6 * med_h and w <= 8 and area >= 40:
            parsed["bars_x"].append(x + w // 2)          # 小节线/终止线（未与别的笔画相连时）
        elif h <= dot_max and w <= dot_max and area >= 18 and w < 2.5 * h:
            parsed["dots"].append((x + w / 2, y + h / 2))  # 八度点或附点
        elif h <= horiz_max and w >= horiz_min_w and w >= 2.5 * h:
            parsed["horizontals"].append((x, y + h / 2, w))  # 减时线或延长号
        elif h <= dot_max and w <= 2.5 * dot_max:
            # 介于两者之间的小连通域（例如被压扁成 1px 的圆点、或印刷毛刺）：
            # 先当成「可能的小点」记下来，由 attach_symbols 按方位归属；归不上就当噪声丢弃。
            parsed["maybe_dots"].append((x + w / 2, y + h / 2))
    # 补充：按列竖向连续黑像素找小节线，救回「与连音弧/减时线相连、连通域被撑宽」的那些。
    if glyphs:
        y_top = min(b[1] for b in glyphs) - max(8, int(0.5 * med_h))
        y_bottom = max(b[1] + b[3] for b in glyphs) + max(8, int(0.5 * med_h))
        for center in find_bar_columns(sys_mask, y_top, y_bottom, int(1.6 * med_h)):
            if center + 10 >= music_start_x:
                parsed["bars_x"].append(center)
    parsed["bars_x"].sort()
    return parsed


def is_staff_row(parsed):
    """一个行带是否算「声部行」。

    判据：必须含有小节线，且数字不少于 MIN_ROW_DIGITS。
    简谱里每条小节线只落在某一条声部行带内，因此声部行必然带小节线；
    而歌词行 / 印刷碎片不含小节线，只会漏出个别数字（实测《从前慢》《敕勒歌》全页成立）。
    用它挡掉歌词行，既避免把系统内的块结构桥接成一大块（派生假声部、重复读数），
    也避免歌词里漏出的数字被当成音符。
    """
    return bool(parsed["bars_x"]) and len(parsed["digits"]) >= MIN_ROW_DIGITS


def attach_symbols(parsed):
    """把点与横线挂到数字上：每箱 -> {aug, octave, under}。

    这里的判据全部用**该数字自己的字框**来度量（dot 距离 = k × 字高、减时线 = 字底之下
    k × 字高以内），因此与渲染比例无关。原来的写法是 dot 距离 ≤30px、八度点 ≤14px、
    减时线减 3px、延长号 ±9px——这些都只在一种字号下成立，换尺寸后会把附点读成八度点、
    或把延长号读成减时线，直接改变时值。
    """
    digits = parsed["digits"]
    info = {id(box): {"aug": False, "octave": 0, "under": 0} for _x, _d, box in digits}
    # 行字高中位数：用它当尺度基准，而不是每个数字自己的字高。
    # 为什么不能只用自身字高：八度点偶尔会被连笔/减时线切掉一截（实测「7」只剩 16px 高，
    # 而正常字高 23px），按 0.8×16 算出来差 1px 就漏掉那个低八度点 → 音高整整错一个八度。
    row_h = float(np.median([box[3] for _x, _d, box in digits])) if digits else 0.0
    # 先归属确定的点，再归属「可能是点」的模糊连通域（见 parse_line 里的 maybe_dots 说明）。
    for dot_x, dot_y in list(parsed["dots"]) + list(parsed.get("maybe_dots") or []):
        # 候选数字：点必须落在字框附近（横向 1.2 字高、纵向 0.8 字高内，按该数字自身的字高算）
        candidates = []
        for x, _d, box in digits:
            _h, _w = box[3], box[2]
            # 候选范围要**宽于**判定范围：八度点可能隔着一条减时线（实测中心距 0.8–1.2 字高），
            # 这里给到 1.6 字高，真正的归属由下面的方向判据决定。
            reach_x = 1.6 * _h
            reach_y = 1.6 * _h
            dx = abs(dot_x - (x + _w / 2))
            dy = abs(dot_y - (box[1] + _h / 2))
            if dx < reach_x and dy < reach_y:
                candidates.append((dx + dy * 0.6, box))
        if not candidates:
            continue
        _score, box = min(candidates)
        _x, y, w, h, _area = box
        center_x, top, bottom = box[0] + w / 2, y, y + h
        # 用**行字高**（row_h）做尺度：八度点在字顶/字底之外 0.8 行字高以内；
        # 附点在字身右下 0.25–1.0 字宽处。
        #   八度点与字底之间有时隔着一条减时线，实测距离可达 0.65 行字高（3× 渲染约 15px），
        #   所以容差取 0.8 行字高；旧写死值 14px 在 3.8× 下会差一点点把点漏掉。
        #   上下界必须在字框**之外**（bottom+1 / top-1）：允许落在字框边上会把字身里的
        #   笔画（尤其「6」的封闭圈底部）误当成八度点，直接把音高算错一个八度。
        if abs(dot_x - center_x) <= 0.35 * w and bottom + 1 <= dot_y <= bottom + 0.8 * row_h:
            info[id(box)]["octave"] -= 1                  # 低八度点
        elif abs(dot_x - center_x) <= 0.35 * w and top - 0.8 * row_h <= dot_y <= top - 1:
            info[id(box)]["octave"] += 1                  # 高八度点
        elif 0.4 * w <= dot_x - center_x <= 1.0 * w + 0.1 * row_h and y + h * 0.4 <= dot_y <= bottom + 0.9 * row_h:
            info[id(box)]["aug"] = True                   # 附点
    # 减时线按 y 分层合并；每层覆盖到的数字 under +1（层数 = 减时线层数）
    # 判据：横线的 y 在数字**字底之下**（容差 0.15 字高，约 3px@23px 字高）
    levels = []
    for dash_x, dash_y, dash_w in parsed["horizontals"]:
        below = [box for _x, _d, box in digits
                 if _is_below(dash_y, box) and dash_x < box[0] + box[2] and dash_x + dash_w > box[0]]
        if not below:
            continue
        for level in levels:
            if (abs(level[0] - dash_y) < _merge_gap(below) and
                    not (dash_x > level[2] or dash_x + dash_w < level[1])):
                level[0] = (level[0] + dash_y) / 2
                level[1] = min(level[1], dash_x)
                level[2] = max(level[2], dash_x + dash_w)
                break
        else:
            levels.append([dash_y, dash_x, dash_x + dash_w])
    for level_y, level_x0, level_x1 in levels:
        covered = [box for _x, _d, box in digits
                   if box[0] + box[2] > level_x0 and box[0] < level_x1 and _is_below(level_y, box)]
        for box in covered:
            info[id(box)]["under"] += 1
    return info


def _is_below(dash_y, box, tolerance_ratio=0.15):
    """横线是否在这个数字的字底之下（容差按字高比例，默认 0.15 字高）。"""
    return dash_y >= box[1] + box[3] - max(1.0, tolerance_ratio * box[3])


def _merge_gap(boxes):
    """判定「同一条减时线被印刷劈成两段」的 y 容差：按参与判定的数字字高比例。"""
    heights = [box[3] for box in boxes]
    if not heights:
        return LEVEL_MERGE_GAP
    return max(2.0, LEVEL_MERGE_RATIO * float(np.median(heights)))


def group_chords(digits_in_unit, gap=CHORD_GAP):
    """同 x 相邻（< gap）的数字归为一组：竖排即和弦，视为同时发音。"""
    groups = []
    for item in sorted(digits_in_unit, key=lambda entry: entry[0]):
        if groups and item[0] - groups[-1][-1][0] <= gap:
            groups[-1].append(item)
        else:
            groups.append([item])
    return groups


def count_dashes(dashes, x_from, x_to, midlines, glyph_h=None):
    """x 位于 (x_from, x_to)、且与给定中线同高（±0.4 字高）的横线 = 延长号「-」。

    `glyph_h` 是本行字高中位数：延长号与数字同高，所以容差按字高比例算，
    不能写死 ±9px（那只在一种渲染尺寸下成立）。
    """
    tolerance = 0.4 * glyph_h if glyph_h else 9.0
    return sum(1 for dash_x, dash_y in dashes
               if x_from < dash_x < x_to and any(abs(dash_y - mid_y) <= tolerance for mid_y in midlines))


def has_triplet_bracket(glyphs, mark):
    """三连音记号两侧是否有一对小方括号。

    这是比模板得分更可靠的结构判据：三连音的「3」常与小方括号一起印，
    而谱面上单独出现的「3」（比如小节号、力度记号）没有括号——用它挡掉这类误判。
    """
    center = mark[1] + mark[3] / 2

    def flank(x_from, x_to):
        return any(x_from <= box[0] <= x_to and box[3] <= 24 and box[2] >= 10
                   and abs((box[1] + box[3] / 2) - center) <= 15
                   for box in glyphs)

    return flank(0, mark[0] + 2) and flank(mark[0] + mark[2] - 2, 10 ** 9)


def find_line_triplets(row_digits, glyphs, sys_mask, templates, other_spans=()):
    """找出这一行数字上方的小「3」——三连音记号（连同小方括号一起印）。

    `row_digits` 是本行的数字 [(x, d, box)]，用来定基准线：
    取整行字形的**中位中心**（对个别偏高的字形稳健，不会像「最小 y」那样被记号本身带跑）。
    `glyphs` 是整个系统的字形候选（记号常自成一条窄行带，只看本行会看不到它）。
    记号必须同时满足：
      · 在基准线之上 12–60px；
      · 匹配为「3」，且两侧带方括号；
      · **不落在别的声部行的数字纵向范围内**——否则它其实是那一行的一个真音符，
        当记号排除就会直接丢掉一个音符（实测丢过 3 个）。
    返回 (要从数字里排除的字形, 记号中心 x 列表)。
    """
    if not row_digits:
        return [], []
    baseline = float(np.median([box[1] + box[3] / 2 for _x, _d, box in row_digits]))
    mark_boxes, mark_xs = [], []
    for box in glyphs:
        center = box[1] + box[3] / 2
        mark_x = box[0] + box[2] / 2
        if not (12 <= baseline - center <= TRIPLET_MARK_MAX_GAP):
            continue
        if any(not (box[1] + box[3] < top - 2 or box[1] > bottom + 2) for top, bottom in other_spans):
            continue
        # 记号必须「浮」在本行数字之上：若本行在几乎相同的 x 与高度处已经有一个数字，
        # 那它就是**叠置和弦的一个音**（男中常用八度叠置，印成上下两个「3」），
        # 不是记号。当成记号剔除会**静默丢掉一个真音符**（实测敕勒歌 p11 因此 119 → 117）。
        if any(abs((row_box[0] + row_box[2] / 2) - mark_x) <= 12
               and abs((row_box[1] + row_box[3] / 2) - center) <= 20
               for _x, _d, row_box in row_digits):
            continue
        digit, score = match_digit(glyph_image(sys_mask, box), templates)
        if digit != "3" or score < MATCH_THRESHOLD:
            continue
        if not has_triplet_bracket(glyphs, box):
            continue
        mark_boxes.append(box)
        mark_xs.append(mark_x)
    return mark_boxes, mark_xs


def parse_unit(ld, digits_in_unit, key_do_midi, x0, x1, use_triplets=True, skip_marks=True):
    """一个（行 × 小节）单元 -> (notes, rests, cursor, triplet_count)。

    时值规则：下划线 n 层 = 1/2^n 拍；附点 ×1.5；延长号「-」每根 +1 拍；0 = 休止。
    三连音：本行数字上方有带方括号的「3」记号时，被它覆盖的连续三个音符整组时值 ×2/3。
    skip_marks=False 时把「疑似三连音记号」也当成普通音符——用于「宁可报超拍，
    也不静默丢音」的兜底读数（记号其实是上一行真音符时就不会被丢掉）。
    延长号只统计落在本小节 x 区间 [x0, x1) 内、且与前一组数字同中线的横线。
    """
    info = ld["info"]
    dashes = [(dash[0], dash[1]) for dash in ld["parsed"]["horizontals"]]
    # 本行字高中位数：延长号容差、三连音窗口都按它缩放（不写死像素，理由见 parse_line 的说明）。
    glyph_h = float(np.median([box[3] for _x, _d, box in digits_in_unit])) if digits_in_unit else 0.0
    notes, rests, cursor = [], [], 0.0
    triplet_groups, triplet_count = set(), 0
    mark_keys = {tuple(box) for box in ld.get("triplet_boxes", [])} if skip_marks else set()
    groups = group_chords([entry for entry in digits_in_unit if tuple(entry[2]) not in mark_keys])
    marks = [mark for mark in ld.get("triplets", []) if x0 <= mark < x1] if use_triplets else []
    for mark in marks:
        # 三连音覆盖的是**连续三个**先后音符（不是同 x 叠置的和弦组），因此这里在
        # 「相邻三组」的窗口里找：窗口的 x 跨度要包含记号即可。
        # 证据已经足够强——记号本身必须是被方括号包着的「3」，谱面上单独出现的 3 不会带括号；
        # 因此这里不再额外要求三组的下划线层数一致（三个四分音符的三连音本来就没有下划线）。
        for index in range(len(groups) - 2):
            window = groups[index:index + 3]
            left = window[0][0][0]
            right = max(_x + _box[2] for group in window for _x, _d, _box in group)
            if left - 0.9 * glyph_h <= mark <= right + 0.9 * glyph_h:
                triplet_groups.update(range(index, index + 3))
                triplet_count += 1
                break
    previous = None     # (组 x, [组内各音中线])
    last_items = []     # 上一组发出的音符/休止（延长号加在它们身上）
    for index, group in enumerate(groups):
        group_x = group[0][0]
        midlines = [box[1] + box[3] / 2 for _x, _d, box in group]
        if previous is not None:
            gaps = count_dashes(dashes, previous[0], group_x, previous[1], glyph_h)
            if gaps:
                for item in last_items:
                    item["durationBeats"] += gaps
                cursor += gaps
        base = min((1.0 / (2 ** info[id(box)]["under"])) * (1.5 if info[id(box)]["aug"] else 1.0)
                   for _x, _d, box in group)
        if index in triplet_groups:
            base *= TRIPLET_RATIO
        last_items = []
        for x, digit, box in group:
            meta = info[id(box)]
            midi = None if digit == "0" else key_do_midi + MAJOR_SCALE[int(digit) - 1] + 12 * meta["octave"]
            item = {"midi": midi, "startBeat": cursor, "durationBeats": base,
                    "x": x, "y": box[1] + box[3] / 2}
            (rests if midi is None else notes).append(item)
            last_items.append(item)
        previous = (group_x, midlines)
        cursor += base
    # 单元末尾的延长号：限制在本小节右边界内（否则会吞掉后续小节的「-」）
    if previous is not None:
        tail = count_dashes(dashes, previous[0], x1, previous[1], glyph_h)
        if tail:
            for item in last_items:
                item["durationBeats"] += tail
            cursor += tail
    return notes, rests, cursor, triplet_count


def cluster(values, gap):
    """一维聚类，返回按序排列的簇中心。"""
    clusters = []
    for value in sorted(values):
        if clusters and value - clusters[-1][-1] <= gap:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [float(np.mean(cluster)) for cluster in clusters]


# ---------------- 识谱自检 ----------------

def check_measure_lengths(measure_len, beats_per_measure, pickup=False, note_counts=None):
    """逐小节核对总拍数（识谱自检）。

    这是「准确率」的兜底：识别错误绝大多数会表现为某一小节的拍数对不上——
    漏了一个数字、减时线看错、延长号被当成圆滑线……都会让该小节多出或少于拍号。
    这里如实报出来，让使用者优先核对这几小节，而不是悄悄把错的地方补满。

    乐理上合法的「不完整」不算错，必须放过：
      - **弱起小节**（pickup=True 时的第 1 小节）：只含引导音，本来就短；
      - **最后一小节不满**：可能是乐曲结束处，也可能只是这一页在这里换页；
      - **不含任何音符的短小节**：里面只有休止/空白，补满拍号是正确做法，不是错误
        （例如某声部还没进入的整小节休止）。只有「有音符却装不满」才是可疑的。

    返回 ``{"ok": bool, "issues": [...]}``；issues 每项
    ``{"measure": 小节号（从 1 起）, "kind": "over"/"short", "actual": 实际拍数, "expected": 拍号}``。
    """
    numbers = sorted(measure_len)
    issues = []
    for index, number in enumerate(numbers):
        content = float(measure_len[number])
        is_first, is_last = index == 0, index == len(numbers) - 1
        note_count = None if note_counts is None else int(note_counts.get(number, 0))
        if content > beats_per_measure + 0.01:
            # 「多出拍数」无论在哪一小节都值得报：它会把后面所有小节的起拍整体推后。
            issues.append({"measure": number + 1, "kind": "over",
                           "actual": round(content, 3), "expected": beats_per_measure,
                           "noteCount": note_count})
        elif content < beats_per_measure - 0.01:
            if is_last or (pickup and is_first):
                continue
            if note_count is not None and note_count == 0:
                continue
            issues.append({"measure": number + 1, "kind": "short",
                           "actual": round(content, 3), "expected": beats_per_measure,
                           "noteCount": note_count})
    return {"ok": not issues, "issues": issues}

# ---------------- 主流程 ----------------

def recognize(png_path, do_midi=65, beats_per_measure=4.0):
    gray = cv2.imread(str(png_path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        return {"error": "无法读取图片：{}".format(png_path)}
    mask = binarize(gray)
    templates = render_templates()
    warnings = []

    # ---- 每系统：行带 + 符号解析 + 小节网格 ----
    systems_info = []
    for system_top, system_bottom in find_systems(mask):
        sys_mask = mask[system_top:system_bottom]
        comps = components(sys_mask)
        glyph_xs = [box[0] for box in comps if is_glyph(box)]
        if not glyph_xs:
            continue
        system_height = system_bottom - system_top
        # 声部花括号/方括号：竖跨半个系统、位于最左的那条，用来划出「乐谱内容起点」。
        # 必须靠这条竖线定起点，而不是靠「最左的字形」——因为声部标签（SOPRANO/ALTO/女高…）
        # 本身也会产生字形，若把标签算进内容区，标签里的字母（尤其 O）会被误读成数字 0。
        tall_lines = [box for box in comps if box[3] > 0.5 * system_height and box[2] <= 40]
        if tall_lines:
            leftmost = min(tall_lines, key=lambda box: box[0])
            music_start_x = leftmost[0] + leftmost[2]
        else:
            music_start_x = min(glyph_xs) - 20
        lines = split_lines(sys_mask, comps)
        glyphs_by_line = [[box for box in line if is_glyph(box) and box[0] + box[2] >= music_start_x + 10]
                          for line in lines]
        med_h = int(np.median([box[3] for boxes in glyphs_by_line for box in boxes])) if any(glyphs_by_line) else 23
        line_datas, line_bars, skipped_rows = [], [], 0
        for line in lines:
            parsed = parse_line(line, sys_mask, music_start_x, templates, med_h)
            if not parsed["digits"]:
                continue
            if not is_staff_row(parsed):
                # 声部行一定含有小节线（小节线只落在某一条声部行带内）。
                # 不含小节线的「行」是歌词行/印刷碎片：它们只会漏出个别数字。
                # 若把这种行当声部行，会把系统内的块结构桥接成一大块，派生假声部与重复读数
                # （实测《从前慢》p2：应为 4 声部却读出 5 个、同一批数字出现两套读数）。
                skipped_rows += 1
                continue
            info = attach_symbols(parsed)
            row_mid = float(np.median([box[1] + box[3] / 2 for _x, _d, box in parsed["digits"]]))
            rel = row_mid / system_height
            line_datas.append({"parsed": parsed, "info": info, "rel": rel,
                               "triplets": [], "triplet_boxes": []})
            line_bars.append(set(parsed["bars_x"]))
        if not line_datas:
            continue
        if skipped_rows:
            warnings.append("忽略了 {} 个不含小节线或数字过少的行片段（疑似歌词行/印刷碎片，未计入声部）。".format(
                skipped_rows))
        # 三连音记号：在声部行「基准线之上 12–60px」的窗口里找小「3」。
        # 记号印在数字上方、常常落在两条行带之间的空白里（自成一条窄行带），
        # 只看本行行带会完全看不到它，因此这里扫描整个系统的字形。
        if TRIPLETS_ENABLED:
            staff_spans = [(min(box[1] for _x, _d, box in ld["parsed"]["digits"]),
                            max(box[1] + box[3] for _x, _d, box in ld["parsed"]["digits"]))
                           for ld in line_datas]
            system_glyphs = [box for line in lines for box in line
                             if is_glyph(box) and box[0] + box[2] >= music_start_x + 10]
            for ld_index, ld in enumerate(line_datas):
                # 排除「别的声部行的数字纵向范围」：记号若落在这里，它其实是那一行的真音符，
                # 当成记号剔除就会静默丢音（实测敕勒歌 p11 曾因此 119 → 116）。
                other_spans = [span for other_index, span in enumerate(staff_spans)
                               if other_index != ld_index]
                mark_boxes, mark_xs = find_line_triplets(ld["parsed"]["digits"], system_glyphs,
                                                         sys_mask, templates, other_spans)
                ld["triplet_boxes"], ld["triplets"] = mark_boxes, mark_xs
            if any(ld["triplets"] for ld in line_datas):
                warnings.append("检测到三连音记号（实验性）：本页按三连音处理，请逐音核对。")
        # 假小节线过滤：把各行候选按 x 聚类，只保留在 ≥2 行中同位置出现的
        # （弧线、延长号、力度记号偶尔会被误判成细高竖线，孤立出现时剔除）
        kept_bars = []
        clusters = []
        for bar_x in sorted({b for bars in line_bars for b in bars}):
            if clusters and bar_x - clusters[-1][-1] <= BAR_TOLERANCE:
                clusters[-1].append(bar_x)
            else:
                clusters.append([bar_x])
        for cluster_xs in clusters:
            center = float(np.mean(cluster_xs))
            votes = sum(1 for bars in line_bars if any(abs(b - center) <= BAR_TOLERANCE for b in bars))
            if votes >= 2 or len(line_datas) == 1:
                kept_bars.append(center)
        # 小节网格止于最后一根小节线：右侧页边距不是一小节，否则会凭空多出一个空小节
        # 把其后的系统整体推后一整小节。
        bounds = [music_start_x - 5] + sorted(kept_bars)
        if len(bounds) < 2:
            bounds = [music_start_x - 5, mask.shape[1]]
        systems_info.append({"index": len(systems_info), "top": system_top, "line_datas": line_datas,
                             "bounds": bounds, "system_height": system_height})

    # ---- 单元：每系统 × 每小节 × 每行 ----
    # 这里只建「有哪些单元」；具体音符在下面的单元循环里按小节区间取。
    units = []
    measure_of = {}
    for system_index, info in enumerate(systems_info):
        for measure_index in range(len(info["bounds"]) - 1):
            x0, x1 = info["bounds"][measure_index], info["bounds"][measure_index + 1]
            gmi = len(measure_of)
            measure_of[(system_index, measure_index)] = gmi
            for ld in info["line_datas"]:
                in_unit = [(x, d, box) for x, d, box in ld["parsed"]["digits"] if x0 <= x < x1]
                if not in_unit:
                    continue
                rel = float(np.median([box[1] + box[3] / 2 for _x, _d, box in in_unit])) / info["system_height"]
                units.append({"gmi": gmi, "rel": rel, "ld": ld, "system": info, "system_index": system_index,
                              "measure_index": measure_index, "x0": x0, "x1": x1})
    if not units:
        return {"parts": [], "measureCount": 0, "beatsPerMeasure": beats_per_measure,
                "warnings": ["未识别到简谱内容（这页可能不是简谱）。"]}
    # ---- 声部结构：系统内按 rel 连块（块序 = 自上而下），跨系统按块序对齐 ----
    # ---- 声部结构：系统内按 rel 连块（块序 = 自上而下），跨系统按块序对齐 ----
    # 判据：rel 间距 ≤ BLOCK_REL_GAP。**保持原样，不要换成绝对像素/字高倍数**：
    # 实测《敕勒歌》p11 的同一对「女高」双行，在有歌词的系统里行距是 86.5px、
    # 没有歌词的系统里是 42.5px（3.76 vs 1.77 字高），任何按行距的固定阈值都会一边对一边错。
    # rel（行中心/系统高度）恰好把这种「歌词把行距撑开、系统也变高」的情况抵掉，
    # 是现有 4 声部（33/24/51/11）结果能成立的原因。原来的怀疑已被实测推翻。
    for info in systems_info:
        rows = sorted(info["line_datas"], key=lambda ld: ld["rel"])
        blocks, current = [], [rows[0]]
        for ld in rows[1:]:
            if ld["rel"] - current[-1]["rel"] <= BLOCK_REL_GAP:
                current.append(ld)
            else:
                blocks.append(current)
                current = [ld]
        blocks.append(current)
        info["blocks"] = blocks
        for block_index, block in enumerate(blocks):
            for ld in block:
                ld["block_index"] = block_index

    # ---- 块内子声部：由「同块内 ≥2 行同时有内容」的小节（分叉小节）决定 ----
    # 只在同一个块内统计，避免不同声部（女高 + 女中）同小节都有内容时误判为分叉。
    row_measures = {}     # (系统, 行) -> 有内容的小节集合
    block_measures = {}   # (系统, 块) -> {小节: 有内容的行集合}
    for unit in units:
        system_index, block_index = unit["system_index"], unit["ld"]["block_index"]
        row_measures.setdefault((system_index, id(unit["ld"])), set()).add(unit["gmi"])
        block_measures.setdefault((system_index, block_index), {}).setdefault(unit["gmi"], set()).add(id(unit["ld"]))
    block_split = {key: {gmi for gmi, rows in measures.items() if len(rows) >= 2}
                   for key, measures in block_measures.items()}
    block_subs = {}
    for info in systems_info:
        system_index = info["index"]
        for block_index, block in enumerate(info["blocks"]):
            key = (system_index, block_index)
            split_rows = [ld for ld in block
                          if row_measures.get((system_index, id(ld)), set()) & block_split.get(key, set())]
            if split_rows:
                block_subs[key] = cluster({ld["rel"] for ld in split_rows}, SUB_REL_GAP)
            else:
                block_subs[key] = [float(np.mean([ld["rel"] for ld in block]))]

    # ---- 拍位推算 + 逐音符声部归属 ----
    # 所有小节槽位都先登记为 0 拍：整小节休止（或声部尚未进入）的空小节同样占满拍号时长，
    # 否则它会被漏出偏移表，导致其后所有小节的起拍整体提前。
    measure_len = {gmi: 0.0 for gmi in measure_of.values()}
    part_measures = {}
    triplet_measures = []
    for unit in units:
        ld = unit["ld"]
        digits_in_unit = [(x, d, box) for x, d, box in ld["parsed"]["digits"]
                          if unit["x0"] <= x < unit["x1"]]
        # 读数 A：不缩放、且**不排除任何字形**（疑似三连音记号也先当普通音符留着）。
        # 只有在下面的读数 B 被「拍号」裁判采纳时，才真的按三连音处理并剔除记号——
        # 这样「记号其实是本行的一个真音符/叠置和弦的一个音」时绝不会被静默丢掉。
        notes, _rests, cursor, _count = parse_unit(ld, digits_in_unit, do_midi, unit["x0"], unit["x1"],
                                                  use_triplets=False, skip_marks=False)
        triplets = 0
        if ld.get("triplets"):
            # 读数 B：排除记号 + 按三连音缩放。用「拍号」当裁判：
            # 只有在 A 超拍、且 B 比 A 更接近拍号时才认这条三连音。
            b_notes, _b_rests, b_cursor, b_count = parse_unit(ld, digits_in_unit, do_midi, unit["x0"], unit["x1"],
                                                              use_triplets=True, skip_marks=True)
            if (b_count and cursor > beats_per_measure + 0.01
                    and abs(b_cursor - beats_per_measure) < abs(cursor - beats_per_measure) - 1e-9):
                notes, cursor, triplets = b_notes, b_cursor, b_count
            # 裁判不采纳时什么都不做：读数 A 本来就没排除任何字形，
            # 于是「宁可报超拍，也不静默丢音」自动成立。
        if triplets:
            triplet_measures.append(unit["gmi"])
        # 行内解析用的是「系统裁剪图」，y 要加回系统上边距才是整页像素坐标。
        for note in notes:
            note["pageY"] = note["y"] + unit["system"]["top"]
        measure_len[unit["gmi"]] = max(measure_len.get(unit["gmi"], 0.0), cursor)
        subs = block_subs[(unit["system_index"], unit["ld"]["block_index"])]
        system_height = unit["system"]["system_height"]
        spread = (max(n["y"] for n in notes) - min(n["y"] for n in notes)) / system_height if notes else 0.0
        is_split = unit["gmi"] in block_split.get((unit["system_index"], unit["ld"]["block_index"]), set())
        for note in notes:
            if len(subs) == 1:
                indices = [0]
            elif is_split or spread >= 0.03:
                # 分叉小节（或该行本身含多个音高层）：每个音符按自身高度归最近子声部
                rel = note["y"] / system_height
                indices = [min(range(len(subs)), key=lambda i: abs(subs[i] - rel))]
            else:
                # 齐唱小节：单个音高层复制给块内全部子声部
                indices = list(range(len(subs)))
            for sub_index in indices:
                bucket = part_measures.setdefault((unit["ld"]["block_index"], sub_index), {})
                bucket.setdefault(unit["gmi"], []).append(note)

    # ---- 全局小节长度与偏移 ----
    if triplet_measures:
        warnings.append("第 {} 小节按三连音记号处理（该组 3 个音符的时值 ×2/3）。".format(
            "、".join(str(gmi + 1) for gmi in sorted(set(triplet_measures)))))
    gmis = sorted(measure_len)
    # 弱起小节（anacrusis / pickup）：
    # 乐理上，乐曲第一个小节常常不是完整小节——它只包含「最后一拍（或几拍）」的引导音，
    # 紧接着的下一小节才开始完整小节。常见判断法是**末小节与本小节互补**：
    # 若「第 1 小节拍数 + 末小节拍数 ≈ 一个完整小节」，就按弱起处理（首小节只占它实际的拍数）。
    # 不处理的话，弱起会被补成一整小节，导致**整首曲子的起拍全部后移**，听起来就是「慢半拍进不来」。
    # 判据从严：必须首末两小节都有内容、首小节明显短于拍号、且两者之和接近拍号（容差 0.25 拍），
    # 否则一律按「首小节补满」处理（宁可保守，不要凭空缩短）。
    pickup = False
    if len(gmis) >= 2:
        first, last = gmis[0], gmis[-1]
        first_len, last_len = measure_len[first], measure_len[last]
        if (0.05 < first_len < beats_per_measure - 0.25 and last_len > 0.05
                and abs((first_len + last_len) - beats_per_measure) <= 0.25):
            pickup = True
            warnings.append(
                "第 1 小节按**弱起小节**处理（{0:g} 拍 + 末小节 {1:g} 拍 ≈ 一个 {2:g} 拍小节），"
                "起拍从第 1 小节的第 0 拍开始。".format(first_len, last_len, beats_per_measure))
    # ---- 识谱自检：逐小节核对拍数（最有效的错音定位手段）----
    # 必须在下面「把小节补满拍号」之前做，否则短小节会被补成满小节，错误就看不出来了。
    notes_per_measure = {}
    for measure_notes in part_measures.values():
        for measure_index, measure_notes_list in measure_notes.items():
            notes_per_measure[measure_index] = notes_per_measure.get(measure_index, 0) + len(measure_notes_list)
    self_check = check_measure_lengths(measure_len, beats_per_measure, pickup, notes_per_measure)
    if self_check["issues"]:
        over = [issue for issue in self_check["issues"] if issue["kind"] == "over"]
        short = [issue for issue in self_check["issues"] if issue["kind"] == "short"]
        def describe(issues):
            """「第 3 小节（4.5 拍）、第 5 小节（5 拍）」这样的可读列表，最多列 6 处。"""
            shown = "、".join("第 {} 小节（{:g} 拍）".format(issue["measure"], issue["actual"])
                             for issue in issues[:6])
            return shown + ("等 {} 处".format(len(issues)) if len(issues) > 6 else "")
        if over:
            warnings.append("{}超出拍号 {:g}/4。".format(describe(over), beats_per_measure))
        if short:
            warnings.append("{}少于拍号 {:g}/4。".format(describe(short), beats_per_measure))
        # 超出/不足在像素层面最常见的两个结构性原因（都不是阈值问题，不要靠调阈值「消警告」）：
        # ① 连音弧/延音线的平段被当成了减时线 → 某个音少算一半时值 → 总拍数变少；
        # ② 反过来，连音弧被当成延长号「-」→ 多算拍数。
        # 这里只如实提示「去核对哪一小节的哪一拍」，不做自动修正（自动改会把本来正确的小节带偏）。
        warnings.append(
            "　自检提示：以上小节的拍数与拍号对不上，通常是某个音的减时线/附点/延长号被读错"
            "（漏读会变少、多看一条横线会变多）。请对照谱面优先核对这些小节；本工具不会自行改动时值。")
    for gmi in gmis:
        # 超出拍号的小节也按「至少一个完整小节」占位，避免后面所有小节的起拍被这次错误带偏。
        if pickup and gmi == gmis[0]:
            # 弱起小节只占它实际的拍数，不补满
            measure_len[gmi] = max(measure_len[gmi], 0.25)
        else:
            measure_len[gmi] = max(measure_len[gmi], beats_per_measure)
    offsets, acc = {}, 0.0
    for gmi in gmis:
        offsets[gmi] = acc
        acc += measure_len[gmi]

    parts = []
    for (block_index, sub_index) in sorted(part_measures):
        merged = []
        for gmi, notes in part_measures[(block_index, sub_index)].items():
            for note in notes:
                # x/y 是数字在页面图片上的像素坐标：前端可直接据此在谱面画点、点选定位。
                merged.append({"midi": note["midi"],
                               "startBeat": round(offsets[gmi] + note["startBeat"], 4),
                               "durationBeats": round(note["durationBeats"], 4),
                               "x": round(float(note["x"]), 1), "y": round(float(note["pageY"]), 1)})
        merged.sort(key=lambda note: (note["startBeat"], note["midi"]))
        parts.append({"name": "声部{}".format(len(parts) + 1), "notes": merged})
    tie_candidates = find_tie_candidates(parts)
    if tie_candidates:
        positions = "；".join(
            "声部{} 第 {:g} 拍起".format(part_index + 1, onset) for part_index, onset in tie_candidates[:6])
        more = "" if len(tie_candidates) <= 6 else "等共 {} 处".format(len(tie_candidates))
        warnings.append(
            "检测到同音高、首尾相接的音（{}{}）。乐理上这类可用**延音线**连成一个长音；"
            "但也可能只是同音反复或圆滑线，本工具不自动合并，请按谱面确认。".format(positions, more))
    return {"parts": parts, "measureCount": len(gmis), "beatsPerMeasure": beats_per_measure,
            "warnings": warnings, "selfCheck": self_check}


def find_tie_candidates(parts):
    """找出「同音高、首尾相接」的相邻音 —— 可能是延音线（tie）的位置。

    乐理依据（见 README「乐理约定」）：
      · **延音线（tie / 连结线）**：连接**相同音高**的两个音，时值相加，实际只唱（奏）一次；
      · **圆滑线（slur）**：连接**不同音高**的音，只要求连贯，**不改变**音高与时值。
    只看「同音高 + 前后首尾相接」这两条，在谱面上**不足以**区分延音线与同音反复：
    实测《敕勒歌》p11 第一系统就有「3 - - - | 3 - - -」用弧线跨小节相连，
    但同音同值的这两个音既可能是一个 8 拍长音，也可能是两次发音。
    按项目「绝不静默造音/丢音」的原则，这里**只报告位置**、不自动合并——
    让用户在界面上按谱面判断（界面会显示这条提示，可据此在音符列表里改时值）。

    返回 [(声部下标, 起拍)]，每个「后一个音」算一处。
    """
    if not parts:
        return []
    tolerance = 0.02
    found = []
    for part_index, part in enumerate(parts):
        notes = sorted(part.get("notes") or [], key=lambda n: (n["startBeat"], n["midi"]))
        for previous, note in zip(notes, notes[1:]):
            if note["midi"] is None or previous["midi"] != note["midi"]:
                continue
            if abs((previous["startBeat"] + previous["durationBeats"]) - note["startBeat"]) <= tolerance:
                found.append((part_index, note["startBeat"]))
    return found


def dump_structure(png_path):
    """调试：打印系统/行/块/子声部/小节长度。"""
    gray = cv2.imread(str(png_path), cv2.IMREAD_GRAYSCALE)
    mask = binarize(gray)
    templates = render_templates()
    for system_index, (top, bottom) in enumerate(find_systems(mask)):
        sys_mask = mask[top:bottom]
        comps = components(sys_mask)
        glyph_xs = [box[0] for box in comps if is_glyph(box)]
        height = bottom - top
        tall_lines = [box for box in comps if box[3] > 0.5 * height and box[2] <= 40]
        if tall_lines:
            leftmost = min(tall_lines, key=lambda box: box[0])
            music_start_x = leftmost[0] + leftmost[2]
        else:
            music_start_x = min(glyph_xs) - 20
        lines = split_lines(sys_mask, comps)
        glyphs_by_line = [[box for box in line if is_glyph(box) and box[0] + box[2] >= music_start_x + 10]
                          for line in lines]
        med_h = int(np.median([box[3] for boxes in glyphs_by_line for box in boxes])) if any(glyphs_by_line) else 23
        print("系统{} y={}..{} h={} music_start_x={}".format(system_index, top, bottom, height, music_start_x))
        bar_votes = {}
        for line in lines:
            parsed = parse_line(line, sys_mask, music_start_x, templates, med_h)
            if not parsed["digits"]:
                continue
            rel = float(np.median([box[1] + box[3] / 2 for _x, _d, box in parsed["digits"]])) / height
            for bar_x in parsed["bars_x"]:
                bar_votes[bar_x] = bar_votes.get(bar_x, 0) + 1
            mark = "" if is_staff_row(parsed) else "  ← 非声部行（无小节线或数字过少，已忽略）"
            print("  行 rel={:.3f} digits={} dropped={} bars={}{}".format(
                rel, "".join(d for _x, d, _b in sorted(parsed["digits"])), parsed["dropped"],
                parsed["bars_x"], mark))
        print("  小节线票数={}".format(dict(sorted(bar_votes.items()))))
        tall = sorted((box for box in comps if box[3] >= 25 and box[2] <= 12), key=lambda b: b[0])
        print("  高瘦竖线候选(x,y,w,h)={}".format([tuple(b) for b in tall]))


def summarize(result):
    """紧凑人类可读摘要：每声部一行「midi@起拍+时值」。"""
    print("小节数 {}，每小节 {:g} 拍".format(result.get("measureCount", 0), result.get("beatsPerMeasure", 4)))
    for warning in result.get("warnings", []):
        print("警告：" + warning)
    for part in result.get("parts", []):
        notes = part["notes"]
        sequence = " ".join("{}@{}+{}".format(n["midi"], n["startBeat"], n["durationBeats"]) for n in notes)
        print("{} ({} 个音)：{}".format(part["name"], len(notes), sequence))


def main():
    parser = argparse.ArgumentParser(description="简谱（数字谱）识别")
    parser.add_argument("image", nargs="+", help="简谱页面 PNG/JPEG 路径（可给多张，配合 --batch）")
    parser.add_argument("--json", dest="json_out", help="把结果写入 JSON 文件（传 - 表示只输出到屏幕）")
    parser.add_argument("--summary", action="store_true", help="打印紧凑摘要")
    parser.add_argument("--dump", action="store_true", help="打印版面结构（调试）")
    parser.add_argument("--batch", action="store_true",
                        help="多页模式：一次传入多张图片，输出 {\"pages\": [...]}；单页失败不影响其它页")
    parser.add_argument("--do", type=int, default=65, help="1=X 中 X 的 MIDI 音高（默认 65 = F4，即 1=F）")
    parser.add_argument("--beats", type=float, default=4.0, help="每小节拍数（默认 4）")
    args = parser.parse_args()

    # --json - 表示"只打印、不写文件"（否则会生成一个名字叫 - 的文件——踩过这个坑）
    if args.json_out == "-":
        args.json_out = None
    if args.dump:
        dump_structure(args.image[0])
        return
    if args.batch:
        pages = []
        for path in args.image:
            try:
                pages.append(recognize(path, do_midi=args.do, beats_per_measure=args.beats))
            except Exception as error:                            # noqa: BLE001
                # 单页失败不中断整批：与前端「单页失败照常继续」的策略保持一致。
                pages.append({"error": "简谱识别失败：{}".format(error)})
        text = json.dumps({"pages": pages}, ensure_ascii=False, indent=1)
        if args.json_out:
            Path(args.json_out).write_text(text, encoding="utf-8")
        print(text)
        if pages and all("error" in page for page in pages):
            sys.exit(1)
        return
    if len(args.image) > 1:
        print("一次传入多张图片请加 --batch。", file=sys.stderr)
        sys.exit(2)
    result = recognize(args.image[0], do_midi=args.do, beats_per_measure=args.beats)
    text = json.dumps(result, ensure_ascii=False, indent=1)
    if args.json_out:
        Path(args.json_out).write_text(text, encoding="utf-8")
    if args.summary:
        summarize(result)
    else:
        print(text)
    if result.get("error"):
        sys.exit(1)


if __name__ == "__main__":
    main()



