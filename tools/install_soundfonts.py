#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""安装「真实音色（采样音源）」到项目内 `.assets/soundfonts/`（只在本机，不进 git）。

为什么采样音源要单独装、不直接放进仓库：
  · 体积：钢琴两层 + 人声/弦乐两个 GM 乐器，mp3 合计约 16 MB（解码后占内存几十 MB）；
  · 许可：钢琴样本是 CC BY 3.0（Salamander Grand Piano V3 / Alexander Holm），
    人声、弦乐来自 FluidR3_GM（CC BY 3.0）。放进本仓库需要一并分发许可与署名，
    而这些都是第三方作品，更适合由使用者在安装时自行下载。
本脚本把「下载 → 校验 → 解包 → 生成清单」一次做完；装好后 app 会自动出现
「真实钢琴(采样) / 真实合唱人声(采样) / 真实弦乐(采样)」三个音色选项。

来源与许可（详见 .assets/soundfonts/LICENSES.md）：
  钢琴：Salamander Grand Piano V3（CC BY 3.0，Alexander Holm）
        npm 包 @audio-samples/piano-mp3-velocity4 / velocity12（MIT 打包，样本 CC BY 3.0）
        https://github.com/darosh/samples-piano-mp3
  人声/弦乐：FluidR3_GM 的预渲染 mp3（CC BY 3.0，Frank Wen）
        https://github.com/gleitz/midi-js-soundfonts

用法：
  py -3 tools/install_soundfonts.py            # 安装（已装好的会跳过）
  py -3 tools/install_soundfonts.py --force    # 强制重新下载
  py -3 tools/install_soundfonts.py --only piano
"""
import argparse
import base64
import json
import re
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / ".assets" / "soundfonts"
REGISTRY = "https://registry.npmjs.org"
JSDELIVR = "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM"

# 钢琴：Salamander V3 的两层力度（soft / loud）
SALAMANDER_LAYERS = [
    {"npm": "@audio-samples/piano-mp3-velocity4", "tag": "v04", "velocity": 0.25},
    {"npm": "@audio-samples/piano-mp3-velocity12", "tag": "v12", "velocity": 0.85},
]
# FluidR3_GM 里要用的乐器（文件名 → 清单里的 bank 名）
FLUIDR3_BANKS = {
    "choir_aahs": {"bank": "choir_real", "label": "真实合唱人声（采样）"},
    "string_ensemble_1": {"bank": "strings_real", "label": "真实弦乐（采样）"},
}

NOTE_BASE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
# 文件名里的升号统一写 s（D#1v4.mp3 → Ds1v4.mp3）：
# "#" 在 URL 里是「片段分隔符」，浏览器请求 D#1v4.mp3 只会请求 D，必然 404。
SHARP_IN_NAME = "s"


def note_to_midi(name):
    """把 A0 / C#4 / Bb0 这样的音名换成 MIDI 编号（C4 = 60，A4 = 69）。

    注意：MIDI.js 的 soundfont 文件用降号写黑键（Bb0 / Db1 / Eb…），
    Salamander 用升号（D#4），两种都要认——踩过这个坑，只认升号会漏掉 36 个音。
    """
    matched = re.fullmatch(r"([A-G])([#bsm]?)(-?\d+)", name)
    if not matched:
        raise ValueError("无法解析音名：" + name)
    letter, accidental, octave = matched.groups()
    offset = {"": 0, "#": 1, "b": -1, "s": 1}[accidental]
    midi = 12 * (int(octave) + 1) + NOTE_BASE[letter] + offset
    if not 0 <= midi <= 127:
        raise ValueError("音名越界：" + name)
    return midi


def download(url, description, retries=3):
    """带重试的下载，返回 bytes。"""
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            print("  下载 {} …（第 {} 次）".format(description, attempt))
            request = urllib.request.Request(url, headers={"User-Agent": "pujian-soundfont-installer/1.0"})
            with urllib.request.urlopen(request, timeout=300) as response:
                data = response.read()
            print("    完成，{:.1f} MB".format(len(data) / 1048576))
            return data
        except Exception as error:  # noqa: BLE001
            last_error = error
            print("    失败：{}".format(error))
    raise RuntimeError("下载失败：{}（{}）".format(description, last_error))


def rename_sharp_notes(target_dir):
    """把文件名里的 # 改成 s（URL 里 # 会被当成片段，浏览器取不到 D#1v4.mp3）。"""
    renamed = 0
    for mp3 in target_dir.glob("*.mp3"):
        if "#" not in mp3.name:
            continue
        target = mp3.with_name(mp3.name.replace("#", SHARP_IN_NAME))
        if target.exists():
            mp3.unlink()
        else:
            mp3.rename(target)
        renamed += 1
    if renamed:
        print("  已把 {} 个文件名里的 # 改成 {}".format(renamed, SHARP_IN_NAME))


def install_piano(force):
    """下载两层 Salamander 钢琴样本，解成 {A0v4.mp3 …}。"""
    version = "1.0.5"
    for layer in SALAMANDER_LAYERS:
        target_dir = ASSETS / "salamander" / layer["tag"]
        existing = list(target_dir.glob("*.mp3")) if target_dir.is_dir() else []
        if len(existing) >= 30 and not force:
            print("钢琴 {} 已安装（{} 个样本），跳过。".format(layer["tag"], len(existing)))
            rename_sharp_notes(target_dir)
            continue
        target_dir.mkdir(parents=True, exist_ok=True)
        package = layer["npm"].split("/")[1]
        url = "{}/{}/-/{}-{}.tgz".format(REGISTRY, layer["npm"], package, version)
        data = download(url, "钢琴样本 " + layer["tag"])
        archive = ROOT / ".cache" / (package + "-" + version + ".tgz")
        archive.parent.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(data)
        with tarfile.open(archive, "r:gz") as tar:
            for member in tar.getmembers():
                name = Path(member.name).name
                if not name.endswith(".mp3"):
                    continue
                source = tar.extractfile(member)
                if source is None:
                    continue
                (target_dir / name).write_bytes(source.read())
        print("  已解包 {} 个 mp3 → {}".format(len(list(target_dir.glob('*.mp3'))), target_dir.relative_to(ROOT)))
        try:
            archive.unlink()
        except OSError:
            pass
        rename_sharp_notes(target_dir)


def install_fluidr3(only, force):
    """下载 FluidR3_GM 预渲染的 mp3（一个 js 文件里是 data URI 表），拆成每个音一个 mp3。"""
    for instrument, meta in FLUIDR3_BANKS.items():
        bank = meta["bank"]
        if only and bank not in only:
            continue
        target_dir = ASSETS / "fluidr3" / instrument
        existing = list(target_dir.glob("*.mp3")) if target_dir.is_dir() else []
        if len(existing) >= 80 and not force:
            print("{} 已安装（{} 个样本），跳过。".format(instrument, len(existing)))
            continue
        target_dir.mkdir(parents=True, exist_ok=True)
        url = "{}/{}-mp3.js".format(JSDELIVR, instrument)
        text = download(url, "{}.mp3 样本表".format(instrument)).decode("utf-8", errors="replace")
        pattern = re.compile(r'"([A-G](?:#|b)?-?\d+)":\s*"data:audio/mp3;base64,([A-Za-z0-9+/=]+)"')
        count = 0
        for note, payload in pattern.findall(text):
            try:
                raw = base64.b64decode(payload)
            except Exception:  # noqa: BLE001
                continue
            (target_dir / (note + ".mp3")).write_bytes(raw)
            count += 1
        print("  已拆出 {} 个 mp3 → {}".format(count, target_dir.relative_to(ROOT)))


def build_manifest():
    """扫描已安装的文件，生成 app 读取的清单。"""
    banks = {}

    # 钢琴：两个力度层，每层 30 个基础音（每 3 个半音一个采样）
    layers = []
    for layer in SALAMANDER_LAYERS:
        directory = ASSETS / "salamander" / layer["tag"]
        notes = {}
        for mp3 in sorted(directory.glob("*.mp3")):
            matched = re.fullmatch(r"([A-G](?:#|b|s)?\d+)v\d+\.mp3", mp3.name)
            if not matched:
                continue
            notes[str(note_to_midi(matched.group(1)))] = mp3.relative_to(ASSETS).as_posix()
        if notes:
            layers.append({"velocity": layer["velocity"], "notes": notes})
    if layers:
        banks["piano_real"] = {
            "label": "真实钢琴（采样）",
            "continuous": False,
            "decodeRate": 32000,       # 采样率越高越亮，但内存也越大；32 kHz 是听感/内存的折中
            "trimSeconds": 5.5,        # 只保留前 5.5 秒（原始样本最长 25 秒，全留内存吃不消）
            "layers": layers,
        }

    # 人声/弦乐：单层，3.13 秒循环样本（循环点由前端按零交叉吸附）
    for instrument, meta in FLUIDR3_BANKS.items():
        directory = ASSETS / "fluidr3" / instrument
        notes = {}
        for mp3 in sorted(directory.glob("*.mp3")):
            try:
                notes[str(note_to_midi(mp3.stem))] = mp3.relative_to(ASSETS).as_posix()
            except ValueError:
                continue
        if notes:
            banks[meta["bank"]] = {
                "label": meta["label"],
                "continuous": True,
                "decodeRate": 24000,
                "loopSeconds": [1.0, 2.5],   # 在样本的 1.0–2.5 秒之间循环（实测零交叉处无爆音）
                "layers": [{"velocity": 0.8, "notes": notes}],
            }

    manifest = {
        "version": 1,
        "generatedAt": None,
        "banks": banks,
        "licenses": [
            {
                "bank": "piano_real",
                "name": "Salamander Grand Piano V3",
                "author": "Alexander Holm",
                "license": "CC BY 3.0",
                "url": "https://archive.org/details/SalamanderGrandPianoV3",
                "packaging": "https://github.com/darosh/samples-piano-mp3",
            },
            {
                "bank": "choir_real / strings_real",
                "name": "FluidR3_GM（预渲染 mp3）",
                "author": "Frank Wen",
                "license": "CC BY 3.0",
                "url": "https://github.com/gleitz/midi-js-soundfonts",
            },
        ],
    }
    manifest_path = ASSETS / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    licenses = ASSETS / "LICENSES.md"
    licenses.write_text(
        "# 采样音源许可与署名\n\n"
        "本项目**不重新分发**这些音频样本；它们由 `tools/install_soundfonts.py` 在使用者本机下载。\n"
        "如果你把本项目用于公开场合，请保留下面的署名：\n\n"
        "## 钢琴：Salamander Grand Piano V3\n"
        "- 作者：Alexander Holm\n"
        "- 许可：Creative Commons Attribution 3.0（CC BY 3.0）https://creativecommons.org/licenses/by/3.0/\n"
        "- 来源：https://archive.org/details/SalamanderGrandPianoV3\n"
        "- 本安装器使用的 mp3 打包：https://github.com/darosh/samples-piano-mp3 （MIT）\n\n"
        "## 人声 / 弦乐：FluidR3_GM\n"
        "- 作者：Frank Wen\n"
        "- 许可：Creative Commons Attribution 3.0（CC BY 3.0）https://creativecommons.org/licenses/by/3.0/\n"
        "- 预渲染 mp3：https://github.com/gleitz/midi-js-soundfonts\n",
        encoding="utf-8",
    )
    print("\n清单已写入：{}".format(manifest_path))
    print("可用音源：{}".format("、".join(sorted(banks)) or "（无）"))


def main():
    parser = argparse.ArgumentParser(description="安装谱见的真实音色（采样音源）")
    parser.add_argument("--force", action="store_true", help="已安装也重新下载")
    parser.add_argument("--only", nargs="+", default=None,
                        help="只安装指定音源：piano_real / choir_real / strings_real")
    args = parser.parse_args()
    only = set(args.only) if args.only else None

    print("=" * 62)
    print("  安装真实音色（采样音源）→", ASSETS)
    print("=" * 62)
    ASSETS.mkdir(parents=True, exist_ok=True)
    if not only or "piano_real" in only:
        install_piano(args.force)
    install_fluidr3(only, args.force)
    build_manifest()
    print("\n完成。回到谱见页面：刷新后「全局音色」里会出现『真实钢琴（采样）』"
          "『真实合唱人声（采样）』『真实弦乐（采样）』。")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print("\n安装失败：" + str(error))
        sys.exit(1)
