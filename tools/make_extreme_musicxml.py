# -*- coding: utf-8 -*-
"""生成「极端规模」MusicXML 夹具：几十个声部、超长时间，用来压播放调度与导出链路。

用法：
  .venv\\Scripts\\python.exe tools/make_extreme_musicxml.py 40 100    # 40 声部 × 100 小节
  .venv\\Scripts\\python.exe tools/make_extreme_musicxml.py 40 440    # 40 声部 × 440 小节（约 20.9 分钟）
输出：.cache/perf/extreme-{parts}v-{measures}m.musicxml
"""
import io
import os
import sys

BPM = 84
BEATS_PER_MEASURE = 4


def pitch_xml(midi):
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    midi = max(0, min(127, int(midi)))
    name = names[midi % 12]
    octave = midi // 12 - 1
    alter = ""
    if "#" in name:
        alter = "<alter>1</alter>"
        name = name[0]
    return "<step>%s</step>%s<octave>%d</octave>" % (name, alter, octave)


def build(parts, measures, distinct=None):
    lines = []
    lines.append('<?xml version="1.0" encoding="UTF-8"?>')
    lines.append('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">')
    lines.append('<score-partwise version="3.1">')
    lines.append('<work><work-title>极端规模压力测试（%d 声部%s × %d 小节）</work-title></work>' % (parts, ("，其中 %d 个不同声部、其余为复制" % distinct) if distinct else "", measures))
    lines.append('<part-list>')
    for part in range(parts):
        lines.append('<score-part id="P%d"><part-name>声部%d</part-name></score-part>' % (part + 1, part + 1))
    lines.append('</part-list>')
    distinct_count = distinct if distinct else parts
    for part in range(parts):
        # 声部音域铺开：低音区 → 高音区，保证几十个声部时各声部不会全挤在同一个八度。
        # distinct < parts 时，后面的是前面声部的「完全一样」的复制（模拟批量复制的叠加层）。
        base = 48 + round((part % distinct_count) * 30 / max(1, distinct_count - 1))
        lines.append('<part id="P%d">' % (part + 1))
        for measure in range(1, measures + 1):
            lines.append('<measure number="%d">' % measure)
            if measure == 1:
                lines.append('<attributes><divisions>2</divisions><key><fifths>0</fifths></key>'
                             '<time><beats>%d</beats><beat-type>4</beat-type></time>'
                             '<clef><sign>G</sign><line>2</line></clef></attributes>'
                             % BEATS_PER_MEASURE)
                if part == 0:
                    lines.append('<direction placement="above"><direction-type><metronome>'
                                 '<beat-unit>quarter</beat-unit><per-minute>%d</per-minute>'
                                 '</metronome></direction-type><sound tempo="%d"/></direction>' % (BPM, BPM))
            for beat in range(BEATS_PER_MEASURE):
                midi = base + (measure % 5) - 2 + (beat % 3)
                lines.append('<note><pitch>%s</pitch><duration>2</duration><type>quarter</type></note>'
                             % pitch_xml(midi))
            lines.append('</measure>')
        lines.append('</part>')
    lines.append('</score-partwise>')
    return "\n".join(lines)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    parts = int(sys.argv[1])
    measures = int(sys.argv[2])
    distinct = int(sys.argv[3]) if len(sys.argv) > 3 else None
    if distinct is not None and (distinct < 1 or distinct > parts):
        print("distinct 必须在 1..parts 之间")
        sys.exit(1)
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".cache", "perf")
    os.makedirs(out_dir, exist_ok=True)
    name = "extreme-%dv-%dm" % (parts, measures) + (("-d%d" % distinct) if distinct else "") + ".musicxml"
    path = os.path.join(out_dir, name)
    text = build(parts, measures, distinct)
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    notes = parts * measures * BEATS_PER_MEASURE
    seconds = measures * BEATS_PER_MEASURE * 60 / BPM
    print("已生成", path)
    print("体积 %.1f MB，%d 个音符，约 %.1f 分钟（%d 秒）" % (len(text.encode("utf-8")) / 1048576, notes, seconds / 60, round(seconds)))


if __name__ == "__main__":
    main()
