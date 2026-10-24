# -*- coding: utf-8 -*-
"""生成一份「大谱」MusicXML 夹具，用于复现真实大乐谱下的卡顿。

4 个声部 × 160 小节 × 4/4，每声部每小节 4 个四分音符（含少量和弦），
约 4×160×4≈2560 个音符，84 BPM 下约 7.6 分钟；带标题/速度/拍号/调号，
走真实的「导入 MusicXML」路径（解析 → commitScore → 画音符列表/谱面）。

用法：.venv\\Scripts\\python.exe tools/make_big_musicxml.py
输出：.cache/perf/big-4v-160m.musicxml
"""
import io
import os

PARTS = 4
MEASURES = 160
# 各声部音域：女高/女低/男高/男低
BASE_MIDI = [72, 67, 60, 55]
RHYTHM = [1, 0.5, 0.5, 1]  # 每小节 4 拍：四分、八分、八分、四分
DURATION_TYPES = {1: "quarter", 0.5: "eighth"}


def pitch_xml(midi):
    names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    midi = max(0, min(127, midi))
    name = names[midi % 12]
    octave = midi // 12 - 1
    alter = ""
    if "#" in name:
        alter = "<alter>1</alter>"
        name = name[0]
    return "<step>%s</step>%s<octave>%d</octave>" % (name, alter, octave)


def note_xml(midi, beats, chord=False):
    note_type = DURATION_TYPES.get(beats, "quarter")
    divisions = int(round(beats * 2))  # divisions=2 → 单位=八分音符
    head = "<chord/>" if chord else ""
    return ("<note>%s<pitch>%s</pitch><duration>%d</duration>"
            "<type>%s</type></note>") % (head, pitch_xml(midi), divisions, note_type)


def build():
    lines = []
    lines.append('<?xml version="1.0" encoding="UTF-8"?>')
    lines.append('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">')
    lines.append('<score-partwise version="3.1">')
    lines.append('<work><work-title>大谱压力测试</work-title></work>')
    lines.append('<part-list>')
    for part in range(PARTS):
        lines.append('<score-part id="P%d"><part-name>声部%d</part-name></score-part>' % (part + 1, part + 1))
    lines.append('</part-list>')
    for part in range(PARTS):
        lines.append('<part id="P%d">' % (part + 1))
        for measure in range(1, MEASURES + 1):
            lines.append('<measure number="%d">' % measure)
            if part == 0 and measure == 1:
                lines.append('<attributes><divisions>2</divisions><key><fifths>0</fifths></key>'
                             '<time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef>'
                             '<measure-style><multiple-rest>1</multiple-rest></measure-style></attributes>')
                lines.append('<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>'
                             '<per-minute>84</per-minute></metronome></direction-type><sound tempo="84"/></direction>')
            # 每小节按 RHYTHM 写音符；和弦：每 8 小节在最后一拍叠一个三度
            for index, beats in enumerate(RHYTHM):
                midi = BASE_MIDI[part] + (measure % 5) - 2 + (index % 3)
                lines.append(note_xml(midi, beats))
                if measure % 8 == 0 and index == len(RHYTHM) - 1:
                    lines.append(note_xml(midi + 4, beats, chord=True))
            lines.append('</measure>')
        lines.append('</part>')
    lines.append('</score-partwise>')
    return "\n".join(lines)


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".cache", "perf")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "big-4v-160m.musicxml")
    text = build()
    io.open(path, "w", encoding="utf-8", newline="\n").write(text)
    notes = PARTS * MEASURES * len(RHYTHM) + (MEASURES // 8) * PARTS
    print("已生成", path)
    print("体积 %.1f KB，约 %d 个音符" % (len(text.encode("utf-8")) / 1024, notes))


if __name__ == "__main__":
    main()
