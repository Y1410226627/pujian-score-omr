"""生成 OMR 验收素材：单行高音谱号、5/4 拍、五个四分音符。

重要：音高由**谱面坐标反推**（pitch_at），并同时写出 ground-truth JSON，
避免出现「注释说是 E4 G4 B4 D5 F5、实际画成 E4 F4 G4 A4 B4」这类图文漂移。
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


FIXTURE_DIR = Path(__file__).parent / "fixtures"
OUTPUT_PNG = FIXTURE_DIR / "known_treble_quarters.png"
OUTPUT_TRUTH = FIXTURE_DIR / "known_treble_quarters.ground-truth.json"

# —— 谱面几何 ——
STAFF_TOP = 210
STAFF_GAP = 25                       # 相邻谱线间距
STAFF_BOTTOM = STAFF_TOP + 4 * STAFF_GAP   # 最下线 y=310
HALF_STEP = STAFF_GAP / 2            # 相邻音级（线↔间）的像素距离

# 高音谱号：最下线为 E4，向上每半格升一个自然音级
TREBLE_BOTTOM = ("E", 4)
LETTERS = ["C", "D", "E", "F", "G", "A", "B"]

# 五个四分音符，自下而上落在五条谱线上：E4 G4 B4 D5 F5
NOTE_X = [500, 650, 800, 950, 1100]
NOTE_Y = [STAFF_BOTTOM - index * STAFF_GAP for index in range(5)]
TIME_SIGNATURE = (5, 4)


def pitch_at(y):
    """由 y 坐标反推高音谱号下的音名（最下线 = E4）。"""
    steps = round((STAFF_BOTTOM - y) / HALF_STEP)
    index = LETTERS.index(TREBLE_BOTTOM[0]) + steps
    octave = TREBLE_BOTTOM[1] + index // 7
    return LETTERS[index % 7], octave


def load_font(candidates, size):
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    raise SystemExit("找不到可用的乐谱字体：{}".format(candidates))


def main():
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (1600, 520), "white")
    draw = ImageDraw.Draw(image)

    for index in range(5):
        y = STAFF_TOP + index * STAFF_GAP
        draw.line((100, y, 1500, y), fill="black", width=2)

    clef_font = load_font([r"C:\Windows\Fonts\seguisym.ttf", r"C:\Windows\Fonts\DejaVuSans.ttf"], 132)
    draw.text((140, 175), "𝄞", font=clef_font, fill="black")

    time_font = load_font([r"C:\Windows\Fonts\cambria.ttc", r"C:\Windows\Fonts\times.ttf"], 48)
    draw.text((285, 226), str(TIME_SIGNATURE[0]), font=time_font, fill="black")
    draw.text((285, 270), str(TIME_SIGNATURE[1]), font=time_font, fill="black")

    middle_line_y = STAFF_TOP + 2 * STAFF_GAP
    notes = []
    for position, (x, y) in enumerate(zip(NOTE_X, NOTE_Y)):
        notehead = Image.new("RGBA", (32, 24), (255, 255, 255, 0))
        note_draw = ImageDraw.Draw(notehead)
        note_draw.ellipse((3, 4, 29, 20), fill="black")
        notehead = notehead.rotate(20, resample=Image.Resampling.BICUBIC, expand=True)
        image.paste(notehead, (x - notehead.width // 2, y - notehead.height // 2), notehead)

        # 记谱规范：中线以下符干向上（画在右侧），中线及以上符干向下（画在左侧）
        if y > middle_line_y:
            draw.line((x + 10, y, x + 10, y - 82), fill="black", width=3)
        else:
            draw.line((x - 10, y, x - 10, y + 82), fill="black", width=3)

        step, octave = pitch_at(y)
        notes.append({
            "step": step,
            "octave": octave,
            "onsetBeats": position,
            "durationBeats": 1,
        })

    draw.line((1250, STAFF_TOP, 1250, STAFF_BOTTOM), fill="black", width=3)
    image.save(OUTPUT_PNG)

    OUTPUT_TRUTH.write_text(json.dumps({
        "source": "tests/generate_omr_fixture.py",
        "clef": "G2",
        "timeSignature": "{}/{}".format(*TIME_SIGNATURE),
        "measureCount": 1,
        "notes": notes,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(OUTPUT_PNG)
    print(OUTPUT_TRUTH)


if __name__ == "__main__":
    main()
