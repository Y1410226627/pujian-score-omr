#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""安装「真实音色（采样音源）」到项目内 `.assets/soundfonts/`（只在本机，不进 git）。

音源来源（都是免费可再分发的，需要署名）：
  · 钢琴：Salamander Grand Piano V3（CC BY 3.0，Alexander Holm），
    用 darosh/samples-piano-mp3 打包好的 mp3 分层包（MIT 打包）。
  · 人声（女声/男声/混声合唱）：Sonatina Symphonic Orchestra（CC Sampling Plus 1.0，
    Mattias Westlund / Peter Eastman）。本安装器把原始 WAV 转成 24 kHz 单声道，
    并采用 SFZ 里的循环点——属于「修改」，署名与改动说明写在生成的 LICENSES.md 里。
  · 其他乐器：FluidR3_GM 的预渲染 mp3（CC BY 3.0，Frank Wen / gleitz/midi-js-soundfonts）。

为什么要单独装、不放进仓库：体积（几十 MB）+ 第三方作品许可，更适合由使用者本机下载。

用法：
  py -3 tools/install_soundfonts.py                 # 安装全部
  py -3 tools/install_soundfonts.py --only voice    # 只装人声（女声/男声/混声合唱）
  py -3 tools/install_soundfonts.py --only china percussion
  py -3 tools/install_soundfonts.py --force         # 已装的也重新下载
  py -3 tools/install_soundfonts.py --list          # 看有哪些类别
"""
import argparse
import base64
import concurrent.futures
import json
import re
import struct
import sys
import tarfile
import time
import urllib.request
from urllib.parse import quote
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / ".assets" / "soundfonts"
REGISTRY = "https://registry.npmjs.org"
JSDELIVR = "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM"
VCSL_BASE = "https://cdn.jsdelivr.net/gh/sgossner/VCSL@master/"
VCSL_TARGET_RATE = 24000
SSO_BASE = "https://cdn.jsdelivr.net/gh/peastman/sso@master/Sonatina%20Symphonic%20Orchestra/"
META_OPEN_BASE = "https://raw.githubusercontent.com/facebookincubator/Meta-open-sound/main/systems/instruments/"
META_OPEN_BANKS = {
    "meta-piano": {"banks": {"piano_real"}, "label": "真实钢琴（Meta Open·4层采样）"},
    "meta-nylon-guitar": {
        "banks": {"nylon_guitar_real", "zhongruan_real"},
        "label": "尼龙弦吉他（Meta Open·3层采样）",
    },
    "meta-steel-guitar": {
        "banks": {"steel_guitar_real", "liuqin_real"},
        "label": "钢弦吉他（Meta Open·3层采样）",
    },
}
META_OPEN_EXPECTED_SAMPLES = {
    "meta-piano": 352,
    "meta-nylon-guitar": 348,
    "meta-steel-guitar": 375,
}

NOTE_BASE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
SHARP_IN_NAME = "s"   # 文件名里的升号统一写 s（# 在 URL 里是片段分隔符，浏览器会 404）


def note_to_midi(name):
    """A0 / C#4 / Bb0 / Ds4 / g4 → MIDI 编号（C4 = 60，A4 = 69）。

    大小写不敏感：SSO 的 SFZ 用小写音名（pitch_keycenter=a#3），FluidR3 用大写。
    """
    matched = re.fullmatch(r"([A-Ga-g])([#bsm]?)(-?\d+)", name)
    if not matched:
        raise ValueError("无法解析音名：" + name)
    letter, accidental, octave = matched.groups()
    offset = {"": 0, "#": 1, "b": -1, "s": 1}[accidental]
    midi = 12 * (int(octave) + 1) + NOTE_BASE[letter.upper()] + offset
    if not 0 <= midi <= 127:
        raise ValueError("音名越界：" + name)
    return midi


JSDELIVR_MIRRORS = ("https://testingcf.jsdelivr.net", "https://fastly.jsdelivr.net")


def download(url, description, retries=3, timeout=180):
    """带重试的下载，返回 bytes。

    jsDelivr 对「还没被缓存过」的文件请求上游时有速率限制：连续下载几十个后官方域名会返回
    403 Forbidden（实测 SSO 的 42 个合唱样本下到第 30 个左右就开始 403）。同一份文件在不同
    镜像域名（TestingCF / Fastly）上是各自独立的缓存，所以这里按「官方 → TestingCF → Fastly」
    的顺序换域名重试。
    """
    candidates = [url]
    if "cdn.jsdelivr.net" in url:
        for mirror in JSDELIVR_MIRRORS:
            candidates.append(url.replace("https://cdn.jsdelivr.net", mirror))
    last_error = None
    for attempt in range(1, retries + 1):
        for candidate in candidates:
            try:
                request = urllib.request.Request(candidate, headers={"User-Agent": "pujian-soundfont-installer/1.0"})
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    return response.read()
            except Exception as error:  # noqa: BLE001
                last_error = error
        if attempt < retries:
            print("    第 {} 次下载失败（{}），换镜像重试…".format(attempt, last_error))
            time.sleep(1.5)
    raise RuntimeError("下载失败：{}（{}）".format(description, last_error))


def install_meta_open(selected, force):
    """按需安装 Meta Open Sound 的 CC0 钢琴与吉他 Web OGG 样本。"""
    ready = set()
    for instrument, metadata in META_OPEN_BANKS.items():
        if selected is not None and not (metadata["banks"] & selected):
            continue
        base = META_OPEN_BASE + instrument
        target_dir = ASSETS / "meta-open" / instrument
        target_dir.mkdir(parents=True, exist_ok=True)
        try:
            index = json.loads(download(base + "/manifest.json", instrument + " 清单").decode("utf-8"))
        except Exception as error:  # noqa: BLE001
            print("  Meta Open {}：清单读取失败（{}），保留现有音色。".format(instrument, error))
            continue
        samples = index.get("samples", [])
        completed = 0
        failures = 0
        pending = []
        for sample in samples:
            filename = Path(sample.get("file", "")).name
            if not filename.endswith(".wav"):
                continue
            target = target_dir / (filename[:-4] + ".ogg")
            if target.is_file() and target.stat().st_size > 1000 and not force:
                completed += 1
                continue
            pending.append((target, base + "/ogg/" + quote(target.name)))

        def fetch_one(item):
            target, url = item
            target.write_bytes(download(url, instrument + "/" + target.name, retries=2))
            return target

        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as executor:
            futures = {executor.submit(fetch_one, item): item[0] for item in pending}
            for future in concurrent.futures.as_completed(futures):
                try:
                    future.result()
                    completed += 1
                except Exception as error:  # noqa: BLE001
                    failures += 1
                    print("    跳过 {}（{}）".format(futures[future].name, error))
        print("  Meta Open {}：{}/{} 个 OGG 就绪{}".format(
            instrument, completed, len(samples), "，失败 {} 个".format(failures) if failures else ""))
        if completed == len(samples) and len(samples) == META_OPEN_EXPECTED_SAMPLES[instrument]:
            ready.add(instrument)
    return ready


# ============================================================
# 一、钢琴：Salamander（mp3 分层包）
# ============================================================
SALAMANDER_LAYERS = [
    {"npm": "@audio-samples/piano-mp3-velocity4", "tag": "v04", "velocity": 0.25},
    {"npm": "@audio-samples/piano-mp3-velocity12", "tag": "v12", "velocity": 0.85},
]


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
        print("  下载钢琴样本 {} …".format(layer["tag"]))
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
                if source is not None:
                    (target_dir / name).write_bytes(source.read())
        try:
            archive.unlink()
        except OSError:
            pass
        rename_sharp_notes(target_dir)
        print("  已解包 {} 个 mp3".format(len(list(target_dir.glob("*.mp3")))))


# ============================================================
# 二、FluidR3_GM：其他乐器（每个乐器一个 data URI 表 → 拆成每个音一个 mp3）
# ============================================================
# key: 清单里的 bank 名；instrument: FluidR3 文件名；continuous: 是否需要循环撑长音
FLUIDR3_BANKS = {
    # 弦乐细分
    "violin_real": {"instrument": "violin", "label": "小提琴（采样）", "continuous": True, "category": "strings"},
    "viola_real": {"instrument": "viola", "label": "中提琴（采样）", "continuous": True, "category": "strings"},
    "cello_real": {"instrument": "cello", "label": "大提琴（采样）", "continuous": True, "category": "strings"},
    "contrabass_real": {"instrument": "contrabass", "label": "低音提琴（采样）", "continuous": True, "category": "strings"},
    "pizzicato_real": {"instrument": "pizzicato_strings", "label": "拨弦（采样）", "continuous": False, "category": "strings"},
    "tremolo_real": {"instrument": "tremolo_strings", "label": "震音弦乐（采样）", "continuous": True, "category": "strings"},
    "strings_real": {"instrument": "string_ensemble_1", "label": "真实弦乐（采样）", "continuous": True, "category": "strings"},
    "harp_real": {"instrument": "orchestral_harp", "label": "竖琴（采样）", "continuous": False, "category": "strings"},
    # 管乐
    "flute_real": {"instrument": "flute", "label": "长笛（采样）", "continuous": True, "category": "winds"},
    "clarinet_real": {"instrument": "clarinet", "label": "单簧管（采样）", "continuous": True, "category": "winds"},
    "oboe_real": {"instrument": "oboe", "label": "双簧管（采样）", "continuous": True, "category": "winds"},
    "bassoon_real": {"instrument": "bassoon", "label": "大管（采样）", "continuous": True, "category": "winds"},
    "trumpet_real": {"instrument": "trumpet", "label": "小号（采样）", "continuous": True, "category": "winds"},
    "horn_real": {"instrument": "french_horn", "label": "圆号（采样）", "continuous": True, "category": "winds"},
    # soundbanks.js 的 SAMPLED_TIMBRES 里注册了 synth_choir_real（合成合唱音色），
    # 之前安装脚本没登记这一项，导致选它时 manifest 里找不到、加载不到样本。
    "synth_choir_real": {"instrument": "synth_choir", "label": "合成合唱（采样）", "continuous": True, "category": "synth"},
    "trombone_real": {"instrument": "trombone", "label": "长号（采样）", "continuous": True, "category": "winds"},
    # 键盘 / 音色
    "church_organ_real": {"instrument": "church_organ", "label": "教堂管风琴（采样）", "continuous": True, "category": "piano"},
    "electric_piano_real": {"instrument": "electric_piano_1", "label": "电钢琴（采样）", "continuous": False, "category": "piano"},
    "harpsichord_real": {"instrument": "harpsichord", "label": "羽管键琴（采样）", "continuous": False, "category": "piano"},
    "vibraphone_real": {"instrument": "vibraphone", "label": "颤音琴（采样）", "continuous": False, "category": "piano"},
    "pad_real": {"instrument": "pad_2_warm", "label": "温暖铺底（采样）", "continuous": True, "category": "piano"},
    # 其他音色
    "voice_oohs_real": {"instrument": "voice_oohs", "label": "人声「哦」（采样）", "continuous": True, "category": "piano"},
    # —— 中国民族乐器：没有专门样本时，用 GM 里音色最接近的乐器（诚实标注「近似」）——
    "guzheng_real": {"instrument": "orchestral_harp", "label": "古筝（采样·近似竖琴）", "continuous": False, "category": "china"},
    "pipa_real": {"instrument": "banjo", "label": "琵琶（采样·近似班卓）", "continuous": False, "category": "china"},
    # —— 新增民族器乐近似采样（音源名与说明直接标明并非该件乐器实录）——
    "zhonghu_real": {"instrument": "viola", "label": "中胡（采样·近似中提琴）", "continuous": True, "category": "china"},
    "gaohu_real": {"instrument": "violin", "label": "高胡（采样·近似小提琴）", "continuous": True, "category": "china"},
    "zhongruan_real": {"instrument": "acoustic_guitar_nylon", "label": "中阮（采样·近似尼龙弦吉他）", "continuous": False, "category": "china"},
    "daruan_real": {"instrument": "acoustic_bass", "label": "大阮（采样·近似原声贝斯）", "continuous": False, "category": "china"},
    "liuqin_real": {"instrument": "banjo", "label": "柳琴（采样·近似班卓琴）", "continuous": False, "category": "china"},
    "guanzi_real": {"instrument": "shanai", "label": "管子（采样·近似唢呐）", "continuous": True, "category": "china"},
    "xun_real": {"instrument": "ocarina", "label": "埙（采样·近似陶笛）", "continuous": True, "category": "china"},
    "qudi_real": {"instrument": "flute", "label": "曲笛（采样·近似长笛）", "continuous": True, "category": "china"},
    "yunluo_real": {"instrument": "tubular_bells", "label": "云锣（采样·近似管钟）", "continuous": False, "category": "china"},
    "dizi_real": {"instrument": "flute", "label": "笛子（采样·近似长笛）", "continuous": True, "category": "china"},
    "xiao_real": {"instrument": "shakuhachi", "label": "箫（采样·近似尺八）", "continuous": True, "category": "china"},
    "sheng_real": {"instrument": "harmonica", "label": "笙（采样·近似口琴）", "continuous": True, "category": "china"},
    "suona_real": {"instrument": "shanai", "label": "唢呐（采样·近似唢呐音色 shanai）", "continuous": True, "category": "china"},
    "yangqin_real": {"instrument": "dulcimer", "label": "扬琴（采样·近似洋琴）", "continuous": False, "category": "china"},
    # —— 管乐补充 ——
    "piccolo_real": {"instrument": "piccolo", "label": "短笛（采样）", "continuous": True, "category": "winds"},
    "english_horn_real": {"instrument": "english_horn", "label": "英国管（采样）", "continuous": True, "category": "winds"},
    "recorder_real": {"instrument": "recorder", "label": "竖笛（采样）", "continuous": True, "category": "winds"},
    "ocarina_real": {"instrument": "ocarina", "label": "陶笛（采样）", "continuous": True, "category": "winds"},
    "pan_flute_real": {"instrument": "pan_flute", "label": "排箫（采样）", "continuous": True, "category": "world"},
    "whistle_real": {"instrument": "whistle", "label": "哨笛（采样）", "continuous": True, "category": "world"},
    "shakuhachi_real": {"instrument": "shakuhachi", "label": "尺八（采样）", "continuous": True, "category": "world"},
    # —— 铜管 ——
    "tuba_real": {"instrument": "tuba", "label": "大号（采样）", "continuous": True, "category": "brass"},
    "french_horn_real": {"instrument": "french_horn", "label": "圆号（采样，close mic）", "continuous": True, "category": "brass"},
    "brass_section_real": {"instrument": "brass_section", "label": "铜管合奏（采样）", "continuous": True, "category": "brass"},
    # —— 萨克斯 ——
    "soprano_sax_real": {"instrument": "soprano_sax", "label": "高音萨克斯（采样）", "continuous": True, "category": "sax"},
    "alto_sax_real": {"instrument": "alto_sax", "label": "中音萨克斯（采样）", "continuous": True, "category": "sax"},
    "tenor_sax_real": {"instrument": "tenor_sax", "label": "次中音萨克斯（采样）", "continuous": True, "category": "sax"},
    "baritone_sax_real": {"instrument": "baritone_sax", "label": "上低音萨克斯（采样）", "continuous": True, "category": "sax"},
    # —— 弹拨 / 吉他 ——
    "nylon_guitar_real": {"instrument": "acoustic_guitar_nylon", "label": "尼龙弦吉他（采样）", "continuous": False, "category": "plucked"},
    "steel_guitar_real": {"instrument": "acoustic_guitar_steel", "label": "民谣吉他（采样）", "continuous": False, "category": "plucked"},
    "electric_guitar_real": {"instrument": "electric_guitar_clean", "label": "电吉他（采样）", "continuous": False, "category": "plucked"},
    "banjo_real": {"instrument": "banjo", "label": "班卓琴（采样）", "continuous": False, "category": "plucked"},
    "sitar_real": {"instrument": "sitar", "label": "西塔琴（采样）", "continuous": False, "category": "plucked"},
    "shamisen_real": {"instrument": "shamisen", "label": "三味线（采样）", "continuous": False, "category": "world"},
    "koto_real": {"instrument": "koto", "label": "日本筝（采样）", "continuous": False, "category": "world"},
    "kalimba_real": {"instrument": "kalimba", "label": "拇指琴（采样）", "continuous": False, "category": "world"},
    # —— 贝斯 ——
    "acoustic_bass_real": {"instrument": "acoustic_bass", "label": "原声贝斯（采样）", "continuous": False, "category": "bass"},
    "electric_bass_real": {"instrument": "electric_bass_finger", "label": "电贝斯（采样）", "continuous": False, "category": "bass"},
    "fretless_bass_real": {"instrument": "fretless_bass", "label": "无品贝斯（采样）", "continuous": True, "category": "bass"},
    # —— 打击 / 旋律打击乐 ——
    "marimba_real": {"instrument": "marimba", "label": "马林巴（采样）", "continuous": False, "category": "percussion"},
    "xylophone_real": {"instrument": "xylophone", "label": "木琴（采样）", "continuous": False, "category": "percussion"},
    "glockenspiel_real": {"instrument": "glockenspiel", "label": "钟琴（采样）", "continuous": False, "category": "percussion"},
    "celesta_real": {"instrument": "celesta", "label": "钢片琴（采样）", "continuous": False, "category": "percussion"},
    "tubular_bells_real": {"instrument": "tubular_bells", "label": "管钟（采样）", "continuous": False, "category": "percussion"},
    "steel_drums_real": {"instrument": "steel_drums", "label": "钢鼓（采样）", "continuous": False, "category": "percussion"},
    "timpani_real": {"instrument": "timpani", "label": "定音鼓（采样）", "continuous": False, "category": "percussion"},
    # —— 合成 / 键盘补充 ——
    "accordion_real": {"instrument": "accordion", "label": "手风琴（采样）", "continuous": True, "category": "piano"},
    "synth_lead_real": {"instrument": "lead_1_square", "label": "合成主音（采样）", "continuous": True, "category": "piano"},
}


# VCSL 单次打击采样。每个音色保留真实敲击录音并在浏览器中播放完整自然衰减；
# 这些采样是近似音色（例如 VCSL Gong 1 不是中国小锣/大锣的专门录音）。
VCSL_BANKS = {
    "pengling_real": {
        "label": "碰铃（采样·近似指钹）", "category": "percussion",
        "layers": [(0.8, "Idiophones/Struck Idiophones/Finger Cymbals/Fing_Cymb.wav", "finger_cymbals.wav")],
    },
    "muyu_real": {
        "label": "木鱼（采样·近似木块）", "category": "percussion",
        "layers": [
            (0.2, "Idiophones/Struck Idiophones/Woodblock/wood_click_pp_rr1.wav", "soft.wav"),
            (0.55, "Idiophones/Struck Idiophones/Woodblock/wood_click3_vl1.wav", "medium.wav"),
            (0.9, "Idiophones/Struck Idiophones/Woodblock/wood_click_ff.wav", "loud.wav"),
        ],
    },
    "xiaoluo_real": {
        "label": "小锣（采样·近似 VCSL Gong 1）", "category": "percussion",
        "layers": [(0.8, "Idiophones/Struck Idiophones/Gong 1/gong_2_mp.wav", "gong_soft.wav")],
    },
    "daluo_real": {
        "label": "大锣（采样·近似 VCSL Gong 1）", "category": "percussion",
        "layers": [(0.8, "Idiophones/Struck Idiophones/Gong 1/gong_fff.wav", "gong_forte.wav")],
    },
    "bo_real": {
        "label": "钹（采样·近似交响钹）", "category": "percussion",
        "layers": [(0.8, "Idiophones/Struck Idiophones/Clash Cymbals 1/cymbal_crash1_mf1.wav", "cymbal_crash.wav")],
    },
    "paigu_real": {
        "label": "排鼓（采样·近似通鼓）", "category": "percussion",
        "layers": [(0.8, "Membranophones/Struck Membranophones/Tom 1/Stick/TomH_HitS_v4_rr1_Mid.wav", "tom_hit.wav")],
    },
}


def install_fluidr3(selected, force):
    for bank, meta in FLUIDR3_BANKS.items():
        if selected and bank not in selected:
            continue
        instrument = meta["instrument"]
        target_dir = ASSETS / "fluidr3" / instrument
        existing = list(target_dir.glob("*.mp3")) if target_dir.is_dir() else []
        if len(existing) >= 80 and not force:
            print("{} 已安装（{} 个样本），跳过。".format(instrument, len(existing)))
            continue
        target_dir.mkdir(parents=True, exist_ok=True)
        url = "{}/{}-mp3.js".format(JSDELIVR, instrument)
        print("  下载 {} …".format(instrument))
        text = download(url, instrument + ".mp3 样本表").decode("utf-8", errors="replace")
        pattern = re.compile(r'"([A-G](?:#|b)?-?\d+)":\s*"data:audio/mp3;base64,([A-Za-z0-9+/=]+)"')
        count = 0
        for note, payload in pattern.findall(text):
            try:
                raw = base64.b64decode(payload)
            except Exception:  # noqa: BLE001
                continue
            (target_dir / (note + ".mp3")).write_bytes(raw)
            count += 1
        print("    已拆出 {} 个 mp3".format(count))


def install_vcsl(selected, force):
    """下载并转成 24 kHz 单声道 WAV 的 VCSL CC0 打击乐单次样本。"""
    for bank, meta in VCSL_BANKS.items():
        if selected and bank not in selected:
            continue
        for _, relative_source, filename in meta["layers"]:
            target = ASSETS / "vcsl" / bank / filename
            if target.is_file() and target.stat().st_size > 1000 and not force:
                continue
            raw = ASSETS / "vcsl" / "_raw" / bank / filename
            raw.parent.mkdir(parents=True, exist_ok=True)
            target.parent.mkdir(parents=True, exist_ok=True)
            if force or not raw.is_file() or raw.stat().st_size < 1000:
                url = VCSL_BASE + quote(relative_source, safe="/")
                print("  下载 VCSL {} …".format(bank))
                try:
                    payload = download(url, relative_source, retries=3, timeout=180)
                except RuntimeError:
                    # GitHub 源站回退：jsDelivr 偶尔会对尚未缓存的大 WAV 返回 503。
                    github_raw = "https://raw.githubusercontent.com/sgossner/VCSL/master/" + quote(relative_source, safe="/")
                    payload = download(github_raw, relative_source + "（GitHub 源站）", retries=2, timeout=180)
                raw.write_bytes(payload)
            samples = read_wav_mono_any(raw)
            write_wav_16(target, samples, VCSL_TARGET_RATE)
            try:
                raw.unlink()
            except OSError:
                pass
            print("    已转换 {} → {}".format(filename, target.relative_to(ROOT)))


# ============================================================
# 二、B 中国民乐：二胡（aliexpress-erhu，CC0）
# ============================================================
ERHU_REPO = "https://github.com/sfzinstruments/aliexpress-erhu"
ERHU_RAW = "https://raw.githubusercontent.com/sfzinstruments/aliexpress-erhu/master"
ERHU_SAMPLE_DIR = "Samples/sus"
ERHU_TARGET_RATE = 24000
NOTE_TO_MIDI = {"c": 0, "cs": 1, "db": 1, "d": 2, "ds": 3, "eb": 3, "e": 4, "f": 5,
                "fs": 6, "gb": 6, "g": 7, "gs": 8, "ab": 8, "a": 9, "as": 10, "bb": 10, "b": 11}


def list_erhu_samples():
    """从 GitHub 目录页里抠出 sus 采样文件名（不用 API，避免配额）。"""
    import re
    html = download(ERHU_REPO + "/tree/master/" + ERHU_SAMPLE_DIR, "二胡样本目录页").decode("utf-8", "replace")
    names = sorted(set(re.findall(r'"name":"(erhu_[a-g][sb]?\d_sus_rr\d\.wav)"', html)))
    return names


def erhu_sample_midi(name):
    """erhu_a5_sus_rr1.wav → 实测录音基频对应的 MIDI 编号。"""
    import re
    matched = re.match(r"erhu_([a-g])([sb]?)(\d)_sus_rr\d\.wav", name)
    if not matched:
        return None
    letter, accidental, octave = matched.groups()
    pitch = NOTE_TO_MIDI.get(letter + accidental)
    if pitch is None:
        return None
    # aliexpress-erhu filenames use an octave label one octave above the
    # rendered WAV fundamental (e.g. erhu_a5_sus_rr1.wav measures near A4).
    return 12 * int(octave) + pitch


def install_erhu(force):
    target_dir = ASSETS / "erhu" / "sus"
    target_dir.mkdir(parents=True, exist_ok=True)
    try:
        names = list_erhu_samples()
    except RuntimeError as error:
        print("  二胡：目录页读取失败（{}），跳过".format(error))
        return
    # 每个音取第一条 round-robin 就够用，省一半体积
    keep = [name for name in names if name.endswith("rr1.wav")]
    print("  二胡：{} 个音 × round-robin，取 {} 个".format(len(names), len(keep)))
    done = 0
    for name in keep:
        target = target_dir / name
        if target.is_file() and target.stat().st_size > 1000 and not force:
            done += 1
            continue
        try:
            raw = download(ERHU_RAW + "/" + ERHU_SAMPLE_DIR + "/" + name, name, retries=2, timeout=120)
        except RuntimeError as error:
            print("    跳过 {}（{}）".format(name, error))
            continue
        source = ASSETS / "erhu" / ("_raw_" + name)
        source.write_bytes(raw)
        try:
            samples = read_wav_mono_any(source)
            write_wav_16(target, samples, ERHU_TARGET_RATE)
            done += 1
        finally:
            try:
                source.unlink()
            except OSError:
                pass
    print("  二胡：{} 个样本已就绪 → {}".format(done, target_dir.relative_to(ROOT)))


def erhu_bank():
    """把已转换的二胡样本组织成清单条目。"""
    directory = ASSETS / "erhu" / "sus"
    if not directory.is_dir():
        return {}
    notes = {}
    for wav in sorted(directory.glob("erhu_*_sus_rr1.wav")):
        midi = erhu_sample_midi(wav.name)
        if midi is None:
            continue
        notes[str(midi)] = {"path": wav.relative_to(ASSETS).as_posix()}
    if not notes:
        return {}
    return {
        "erhu_real": {
            "label": "二胡（采样）", "continuous": True, "decodeRate": ERHU_TARGET_RATE,
            "category": "china", "loopSeconds": [0.6, 1.8],
            "layers": [{"velocity": 0.8, "notes": notes}],
        }
    }


# ============================================================
# 三、Sonatina SSO：女声/男声/混声合唱（WAV → 24 kHz 单声道，带 SFZ 循环点）
# ============================================================
SSO_CHORUS_SFZ = [
    "Chorus%20-%20Performance/includes/mixed-chorus.sfz",
    "Chorus%20-%20Performance/includes/large-chorus.sfz",
]
SSO_SAMPLE_DIR = "Samples-looped/Chorus/"
SSO_TARGET_RATE = 24000


def design_antialias_kernel(source_rate, target_rate=SSO_TARGET_RATE, taps=63):
    """设计重采样前的抗混叠低通（汉宁窗 sinc）。

    为什么不用「几点滑动平均」：9 点滑动平均在 44.1 kHz 下的 −3 dB 点只有约 2 kHz，
    会把合唱的高频「明亮度」（女声的 2–4 kHz 共振峰）压掉，听感发闷。
    这里把截止频率放在目标采样率奈奎斯特的 88%（24 kHz → 10.5 kHz）附近，
    通带内基本平直，只滤掉会折叠回音频带的成分。
    """
    import numpy as np

    cutoff_hz = min(source_rate * 0.45, target_rate * 0.5 * 0.88)
    normalized = cutoff_hz / source_rate
    offsets = np.arange(taps, dtype=np.float64) - (taps - 1) / 2.0
    kernel = 2.0 * normalized * np.sinc(2.0 * normalized * offsets) * np.hamming(taps)
    return (kernel / kernel.sum()).astype(np.float32)


def read_wav_mono_24k(path):
    """读 44.1 kHz 立体声 WAV → 24 kHz 单声道 float（先抗混叠低通再重采样）。"""
    import numpy as np

    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        rate = handle.getframerate()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise RuntimeError("只支持 16-bit WAV：" + path.name)
    data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    if rate != SSO_TARGET_RATE:
        data = np.convolve(data, design_antialias_kernel(rate), mode="same")
        target_length = int(round(len(data) * SSO_TARGET_RATE / rate))
        positions = np.arange(target_length, dtype=np.float64) * (rate / SSO_TARGET_RATE)
        data = np.interp(positions, np.arange(len(data), dtype=np.float64), data)
    return data.astype(np.float32)



def read_wav_mono_any(path):
    """读任意位深（16/24/32-bit）WAV → 24 kHz 单声道 float。

    二胡样本是 24-bit PCM，而原来的 read_wav_mono_24k 只处理 16-bit；
    这里按字节宽度解开，再走同一条抗混叠 + 重采样通道，保证音色不被改变。
    """
    import numpy as np

    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        rate = handle.getframerate()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
    if width == 2:
        data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 3:
        raw = np.frombuffer(frames, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        value = raw[:, 0] | (raw[:, 1] << 8) | (raw[:, 2] << 16)
        value = np.where(value >= 1 << 23, value - (1 << 24), value)
        data = (value.astype(np.float32) / float(1 << 23))
    elif width == 4:
        data = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        raise RuntimeError("不支持的 WAV 位深：{} 位".format(width * 8))
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    if rate != SSO_TARGET_RATE:
        data = np.convolve(data, design_antialias_kernel(rate), mode="same")
        target_length = int(round(len(data) * SSO_TARGET_RATE / rate))
        positions = np.arange(target_length, dtype=np.float64) * (rate / SSO_TARGET_RATE)
        data = np.interp(positions, np.arange(len(data), dtype=np.float64), data)
    return data.astype(np.float32)

def write_wav_16(path, samples, rate):
    clipped = [max(-1.0, min(1.0, float(value))) for value in samples]
    payload = struct.pack("<{}h".format(len(clipped)), *(int(round(value * 32767)) for value in clipped))
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(payload)


def mono_sample_name(name):
    """把合唱样本文件名统一成「mono 目录里的安全名」：`#` → `s`。

    浏览器 fetch 的 URL 里 `#` 后面会被当成片段（`chorus-female-a#4.wav` 实际请求的是
    `chorus-female-a`），样本会 404 被跳过——和钢琴 mp3 是同一个坑（见 rename_sharp_notes）。
    """
    return Path(name).stem.replace("#", SHARP_IN_NAME) + ".wav"


def parse_sfz_regions(text):
    """解析 SFZ 的 <region>：只取 sample / lokey / hikey / pitch_keycenter / loop / tune / volume。"""
    regions = []
    for block in text.split("<region>"):
        if "sample=" not in block:
            continue
        region = {}
        for line in block.splitlines():
            line = line.strip()
            if not line or line.startswith("//") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            region[key.strip()] = value.strip()
        regions.append(region)
    return regions


def install_sso_chorus(selected, force):
    """下载 SSO 的男女声合唱样本（一次下载、三个 bank 共用），并转成 24 kHz 单声道 WAV。"""
    want = {"choir_female", "choir_male", "choir_real"}
    if selected and not (selected & want):
        return
    raw_dir = ASSETS / "sso" / "_raw"
    mono_dir = ASSETS / "sso" / "mono"
    raw_dir.mkdir(parents=True, exist_ok=True)
    mono_dir.mkdir(parents=True, exist_ok=True)

    # 1) 下载两个 SFZ 并保存（之后 build_manifest 还要用循环点）
    regions = {}
    for sfz_path in SSO_CHORUS_SFZ:
        text = download(SSO_BASE + sfz_path, Path(sfz_path).name).decode("utf-8", errors="replace")
        cache = raw_dir / Path(sfz_path).name
        cache.write_text(text, encoding="utf-8")
        for region in parse_sfz_regions(text):
            sample = region.get("sample")
            if not sample or "chorus-" not in sample:
                continue
            name = sample.split("/")[-1]
            regions.setdefault(name, region)
    print("  SSO 合唱 SFZ 共 {} 个采样区域".format(len(regions)))

    # 2) 下载样本
    names = sorted(regions.keys())
    for index, name in enumerate(names, start=1):
        wav_path = raw_dir / name
        mono_path = mono_dir / mono_sample_name(name)
        # 已经转换过的样本不必再下载原始 WAV（原始文件转换完就删了，否则重跑一次要重下 55 MB）。
        if mono_path.is_file() and mono_path.stat().st_size > 1000 and not force:
            if index % 15 == 0 or index == len(names):
                print("    已准备 {}/{} 个样本".format(index, len(names)))
            continue
        if not wav_path.is_file() or wav_path.stat().st_size < 1000 or force:
            url = SSO_BASE + SSO_SAMPLE_DIR + name.replace("#", "%23")
            try:
                wav_path.write_bytes(download(url, name, retries=3, timeout=120))
            except RuntimeError as error:
                print("    跳过 {}（{}）".format(name, error))
                continue
        if index % 15 == 0 or index == len(names):
            print("    已准备 {}/{} 个样本".format(index, len(names)))

    # 3) 转 24 kHz 单声道
    converted = 0
    for name in names:
        wav_path = raw_dir / name
        mono_path = mono_dir / mono_sample_name(name)
        if not wav_path.is_file():
            continue
        if mono_path.is_file() and not force and mono_path.stat().st_size > 1000:
            continue
        samples = read_wav_mono_24k(wav_path)
        write_wav_16(mono_path, samples, SSO_TARGET_RATE)
        converted += 1
    print("  SSO 合唱：{} 个样本，本次转换 {} 个 → {}".format(len(names), converted, mono_dir.relative_to(ROOT)))
    # 原始 44.1 kHz WAV（约 58 MB）只是转换原料：转换完成后删掉，省磁盘。
    # 需要重新转换时再跑一次安装器（会重新下载；SFZ 缓存保留在 _raw/*.sfz，清单还需要它）。
    removed = 0
    for raw in raw_dir.glob("*.wav"):
        mono = mono_dir / mono_sample_name(raw.name)
        if mono.is_file():
            try:
                raw.unlink()
                removed += 1
            except OSError:
                pass
    if removed:
        print("    已清理 {} 个原始 WAV（转换原料）".format(removed))


def sso_chorus_banks():
    """把已下载的 SSO 合唱样本组织成三个 bank 的清单数据。"""
    raw_dir = ASSETS / "sso" / "_raw"
    mono_dir = ASSETS / "sso" / "mono"
    if not mono_dir.is_dir():
        return {}
    regions = {}
    for sfz_path in SSO_CHORUS_SFZ:
        cache = raw_dir / Path(sfz_path).name
        if not cache.is_file():
            continue
        for region in parse_sfz_regions(cache.read_text(encoding="utf-8", errors="replace")):
            sample = region.get("sample")
            if not sample or "chorus-" not in sample:
                continue
            name = sample.split("/")[-1]
            regions.setdefault(name, region)
    female = {}
    male = {}
    for name, region in regions.items():
        mono_path = mono_dir / mono_sample_name(name)
        if not mono_path.is_file():
            continue
        try:
            midi = note_to_midi(region.get("pitch_keycenter") or "")
        except ValueError:
            continue
        entry = {
            "path": mono_path.relative_to(ASSETS).as_posix(),
            "tune": round(float(region.get("tune", "0") or 0) / 100.0, 3),
            "gainDb": round(float(region.get("volume", "0") or 0), 2),
        }
        loop_start = region.get("loop_start")
        loop_end = region.get("loop_end")
        if loop_start and loop_end:
            # SFZ 的循环点是 44.1 kHz 的采样数 → 换成 24 kHz 秒数
            entry["loopStart"] = round(float(loop_start) / 44100.0, 4)
            entry["loopEnd"] = round(float(loop_end) / 44100.0, 4)
        if "female" in name:
            female[str(midi)] = entry
        elif "male" in name:
            male[str(midi)] = entry
    banks = {}
    if female:
        banks["choir_female"] = {
            "label": "真实女声合唱（采样）", "continuous": True, "decodeRate": 24000, "category": "voice",
            "layers": [{"velocity": 0.8, "notes": female}],
        }
    if male:
        banks["choir_male"] = {
            "label": "真实男声合唱（采样）", "continuous": True, "decodeRate": 24000, "category": "voice",
            "layers": [{"velocity": 0.8, "notes": male}],
        }
    # 混声：高音区用女声、低音区用男声（同音高时女声优先）
    mixed = dict(male)
    mixed.update(female)
    if mixed:
        banks["choir_real"] = {
            "label": "真实混声合唱（采样）", "continuous": True, "decodeRate": 24000, "category": "voice",
            "layers": [{"velocity": 0.8, "notes": mixed}],
        }
    return banks


# ============================================================
# 四、生成清单
# ============================================================
META_OPEN_VELOCITIES = {
    "piano_real": (0.12, 0.37, 0.65, 0.92),
    "guitar": (0.18, 0.56, 0.92),
}
GUITAR_OPEN_MIDI = {"LowE": 40, "A": 45, "D": 50, "G": 55, "B": 59, "HighE": 64}


def meta_open_banks():
    """Build complete 88-key banks from the installed Meta Open OGG previews."""
    banks = {}
    base = ASSETS / "meta-open"

    piano_dir = base / "meta-piano"
    piano_files = list(piano_dir.glob("*.ogg")) if piano_dir.is_dir() else []
    if len(piano_files) >= META_OPEN_EXPECTED_SAMPLES["meta-piano"]:
        piano_layers = []
        for layer_number, velocity in enumerate(META_OPEN_VELOCITIES["piano_real"], 1):
            notes = {}
            for path in piano_files:
                match = re.fullmatch(r"INSPiano_Vel(\d{2})_([A-G]s?\d)_01\.ogg", path.name)
                if not match or int(match.group(1)) != layer_number:
                    continue
                notes[str(note_to_midi(match.group(2)))] = {"path": path.relative_to(ASSETS).as_posix()}
            if notes:
                piano_layers.append({"velocity": velocity, "notes": notes})
        if len(piano_layers) == 4 and all(len(layer["notes"]) == 88 for layer in piano_layers):
            banks["piano_real"] = {
                "label": META_OPEN_BANKS["meta-piano"]["label"], "continuous": False,
                "decodeRate": 24000, "trimSeconds": 5.5, "category": "piano", "layers": piano_layers,
            }

    def build_guitar(instrument, bank_ids, label, is_nylon):
        directory = base / instrument
        files = list(directory.glob("*.ogg")) if directory.is_dir() else []
        if len(files) < META_OPEN_EXPECTED_SAMPLES[instrument]:
            return
        # MIDI note → candidate captures. Overlapping string zones are resolved by
        # the lowest playable string, keeping the guitar's body character coherent.
        by_layer = {1: {}, 2: {}, 3: {}}
        for path in files:
            if is_nylon:
                match = re.fullmatch(
                    r"INSGuitarNylon_String(LowE|HighE|A|D|G|B)_Vel(\d{2})(?:Finger|Pick)_([A-G]s?\d)_01\.ogg",
                    path.name,
                )
            else:
                match = re.fullmatch(
                    r"INSGuitarSteel_String(LowE|HighE|A|D|G|B)_Vel(\d{2})_([A-G]s?\d)_01\.ogg",
                    path.name,
                )
            if not match:
                continue
            string_name, layer_text, note_name = match.groups()
            layer_number = int(layer_text)
            source_midi = note_to_midi(note_name)
            by_layer[layer_number].setdefault(source_midi, []).append((
                GUITAR_OPEN_MIDI[string_name], path, source_midi,
            ))

        fluid_meta = FLUIDR3_BANKS.get(bank_ids[0])
        fluid_dir = ASSETS / "fluidr3" / (fluid_meta["instrument"] if fluid_meta else "")
        fluid_notes = {}
        for path in fluid_dir.glob("*.mp3") if fluid_dir.is_dir() else []:
            try:
                fluid_notes[note_to_midi(path.stem)] = path
            except ValueError:
                continue

        result_layers = []
        for layer_number, velocity in enumerate(META_OPEN_VELOCITIES["guitar"], 1):
            samples = by_layer[layer_number]
            notes = {}
            for target_midi in range(21, 109):
                candidates = [
                    item for source_midi, captures in samples.items()
                    if abs(source_midi - target_midi) <= 2
                    for item in captures
                ]
                if candidates:
                    exact = [item for item in candidates if item[2] == target_midi]
                    preferred = exact or candidates
                    playable_low_strings = [
                        item for item in preferred
                        if item[0] <= target_midi and target_midi - item[0] <= 12
                    ]
                    pool = playable_low_strings or preferred
                    string_open, path, source_midi = min(
                        pool, key=lambda item: (item[0], abs(item[2] - target_midi), item[2]))
                    entry = {"path": path.relative_to(ASSETS).as_posix()}
                    if source_midi != target_midi:
                        entry["tune"] = source_midi - target_midi
                    notes[str(target_midi)] = entry
                elif target_midi in fluid_notes:
                    notes[str(target_midi)] = {"path": fluid_notes[target_midi].relative_to(ASSETS).as_posix()}
            if notes:
                result_layers.append({"velocity": velocity, "notes": notes})

        if len(result_layers) == 3 and all(len(layer["notes"]) == 88 for layer in result_layers):
            spec = {
                "label": label, "continuous": False, "oneShot": True,
                "decodeRate": 24000, "trimSeconds": 5.5, "category": "plucked",
                "layers": result_layers,
            }
            for bank_id in bank_ids:
                banks[bank_id] = dict(spec)

    nylon_label = META_OPEN_BANKS["meta-nylon-guitar"]["label"]
    steel_label = META_OPEN_BANKS["meta-steel-guitar"]["label"]
    build_guitar("meta-nylon-guitar", ("nylon_guitar_real", "zhongruan_real"), nylon_label, True)
    build_guitar("meta-steel-guitar", ("steel_guitar_real", "liuqin_real"), steel_label, False)
    if "zhongruan_real" in banks:
        banks["zhongruan_real"]["label"] = "中阮（采样·近似尼龙弦吉他，CC0）"
        banks["zhongruan_real"]["category"] = "china"
    if "liuqin_real" in banks:
        banks["liuqin_real"]["label"] = "柳琴（采样·近似钢弦吉他，CC0）"
        banks["liuqin_real"]["category"] = "china"
    return banks


def build_manifest():
    banks = {}

    # 钢琴
    layers = []
    for layer in SALAMANDER_LAYERS:
        directory = ASSETS / "salamander" / layer["tag"]
        notes = {}
        for mp3 in sorted(directory.glob("*.mp3")):
            matched = re.fullmatch(r"([A-G](?:#|b|s)?\d+)v\d+\.mp3", mp3.name)
            if not matched:
                continue
            try:
                notes[str(note_to_midi(matched.group(1)))] = {"path": mp3.relative_to(ASSETS).as_posix()}
            except ValueError:
                continue
        if notes:
            layers.append({"velocity": layer["velocity"], "notes": notes})
    if layers:
        banks["piano_real"] = {
            "label": "真实钢琴（采样）", "continuous": False, "decodeRate": 32000,
            "trimSeconds": 5.5, "category": "piano", "layers": layers,
        }

    # FluidR3 的其他乐器
    for bank, meta in FLUIDR3_BANKS.items():
        directory = ASSETS / "fluidr3" / meta["instrument"]
        notes = {}
        for mp3 in sorted(directory.glob("*.mp3")):
            try:
                notes[str(note_to_midi(mp3.stem))] = {"path": mp3.relative_to(ASSETS).as_posix()}
            except ValueError:
                continue
        if notes:
            spec = {
                "label": meta["label"], "continuous": meta["continuous"], "decodeRate": 24000,
                "category": meta.get("category", ""),
                "layers": [{"velocity": 0.8, "notes": notes}],
            }
            if meta["continuous"]:
                spec["loopSeconds"] = [1.0, 2.5]
            banks[bank] = spec

    # Meta Open Sound replaces the low-layer piano/guitar banks when installed.
    banks.update(meta_open_banks())

    # VCSL 单次打击乐：一个样本映射到固定 MIDI 音高 60，播放时不移调。
    for bank, meta in VCSL_BANKS.items():
        layers = []
        for velocity, _, filename in meta["layers"]:
            sample = ASSETS / "vcsl" / bank / filename
            if sample.is_file():
                layers.append({
                    "velocity": velocity,
                    "notes": {"60": {"path": sample.relative_to(ASSETS).as_posix()}},
                })
        if layers:
            banks[bank] = {
                "label": meta["label"], "continuous": False, "oneShot": True,
                "fixedPitch": True, "decodeRate": VCSL_TARGET_RATE,
                "category": meta["category"], "trimSeconds": 30,
                "fadeOutSeconds": 0.18, "layers": layers,
            }

    # 二胡
    banks.update(erhu_bank())

    # SSO 合唱（女性/男性/混声）
    banks.update(sso_chorus_banks())

    manifest = {
        "version": 3,
        "banks": banks,
        "licenses": [
            {"bank": "piano_real", "name": "Salamander Grand Piano V3", "author": "Alexander Holm",
             "license": "CC BY 3.0", "url": "https://archive.org/details/SalamanderGrandPianoV3",
             "packaging": "https://github.com/darosh/samples-piano-mp3"},
            {"bank": "choir_female / choir_male / choir_real", "name": "Sonatina Symphonic Orchestra（合唱）",
             "author": "Mattias Westlund / Peter Eastman", "license": "CC Sampling Plus 1.0",
             "url": "https://github.com/peastman/sso",
             "changes": "已转换为 24 kHz 单声道 WAV，并使用 SFZ 中的循环点"},
            {"bank": "erhu_real", "name": "aliexpress-erhu（二胡）",
             "author": "sfzinstruments 社区", "license": "CC0 1.0",
             "url": "https://github.com/sfzinstruments/aliexpress-erhu",
             "changes": "转换为 24 kHz 单声道 WAV，只保留第一轮 round-robin"},
            {"bank": "piano_real / nylon_guitar_real / steel_guitar_real / zhongruan_real / liuqin_real",
             "name": "Meta Open Sound", "author": "Meta Creative Audio",
             "license": "CC0 1.0", "url": "https://github.com/facebookincubator/Meta-open-sound",
             "changes": "使用官方 OGG Web 采样；吉他按弦区与力度层映射，标注音域外回退至 FluidR3"},
            {"bank": "其他采样乐器", "name": "FluidR3_GM（预渲染 mp3）", "author": "Frank Wen",
             "license": "CC BY 3.0", "url": "https://github.com/gleitz/midi-js-soundfonts"},
            {"bank": "pengling_real / muyu_real / xiaoluo_real / daluo_real / bo_real / paigu_real",
             "name": "Versilian Community Sample Library（VCSL）", "author": "Versilian Studios LLC",
             "license": "CC0 1.0", "url": "https://github.com/sgossner/VCSL",
             "changes": "转换为 24 kHz 单声道 WAV；完整播放采样自然衰减，木鱼保留力度层"},
        ],
    }
    manifest_path = ASSETS / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    licenses = ASSETS / "LICENSES.md"
    licenses.write_text(
        "# 采样音源许可与署名\n\n"
        "本项目**不重新分发**这些音频样本；它们由 `tools/install_soundfonts.py` 在使用者本机下载并转换。\n"
        "如果你把本项目用于公开场合，请保留下面的署名：\n\n"
        "## Meta Open Sound（钢琴、尼龙弦吉他、钢弦吉他）\n"
        "- 作者：Meta Creative Audio\n"
        "- 许可：CC0 1.0 https://creativecommons.org/publicdomain/zero/1.0/\n"
        "- 来源：https://github.com/facebookincubator/Meta-open-sound\n"
        "- **改动**：使用官方 OGG Web 采样；吉他映射至可用弦区与力度层，音域外使用 FluidR3 回退。\n\n"
        "## 钢琴：Salamander Grand Piano V3\n"
        "- 作者：Alexander Holm\n"
        "- 许可：CC BY 3.0 https://creativecommons.org/licenses/by/3.0/\n"
        "- 来源：https://archive.org/details/SalamanderGrandPianoV3\n"
        "- mp3 打包：https://github.com/darosh/samples-piano-mp3 （MIT）\n\n"
        "## 合唱（女声/男声/混声）：Sonatina Symphonic Orchestra\n"
        "- 作者：Mattias Westlund / Peter Eastman\n"
        "- 许可：CC Sampling Plus 1.0（已退役的许可）https://creativecommons.org/licenses/sampling+/1.0/\n"
        "- 来源：https://github.com/peastman/sso\n"
        "- **改动**：本安装器把原始 44.1 kHz 立体声 WAV 转换为 24 kHz 单声道 WAV，并采用 SFZ 中的循环点。\n\n"
        "## 其他乐器：FluidR3_GM\n"
        "- 作者：Frank Wen\n- 许可：CC BY 3.0 https://creativecommons.org/licenses/by/3.0/\n"
        "- 预渲染 mp3：https://github.com/gleitz/midi-js-soundfonts\n",
        encoding="utf-8",
    )
    with licenses.open("a", encoding="utf-8") as handle:
        handle.write(
            "\n## 打击乐：Versilian Community Sample Library（VCSL）\n"
            "- 作者：Versilian Studios LLC\n"
            "- 许可：CC0 1.0（公共领域奉献）https://creativecommons.org/publicdomain/zero/1.0/\n"
            "- 来源：https://github.com/sgossner/VCSL\n"
            "- **改动**：本安装器只下载所需敲击样本，并转换为 24 kHz 单声道 WAV。\n"
            "- 部分中国乐器（锣、钹、排鼓、碰铃、木鱼）使用相近乐器录音，界面已注明近似音色。\n"
        )
    print("\n清单已写入：{}".format(manifest_path))
    print("可用音源 {} 个：{}".format(len(banks), "、".join(sorted(banks))))


CATEGORY_BANKS = {
    "all": {bank for bank in FLUIDR3_BANKS} | set(VCSL_BANKS) | {"piano_real", "choir_female", "choir_male", "choir_real", "erhu_real"},
    "china": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "china"} | {"erhu_real"},
    "world": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "world"},
    "piano": {"piano_real"} | {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "piano"},
    "keys": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "piano"},
    "voice": {"choir_female", "choir_male", "choir_real"},
    "strings": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "strings"},
    "winds": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "winds"},
    "brass": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "brass"},
    "sax": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "sax"},
    "plucked": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "plucked"},
    "bass": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "bass"},
    "percussion": {bank for bank, meta in FLUIDR3_BANKS.items() if meta.get("category") == "percussion"} | set(VCSL_BANKS),
}


def main():
    parser = argparse.ArgumentParser(description="安装谱见的真实音色（采样音源）")
    parser.add_argument("--force", action="store_true", help="已安装也重新下载")
    parser.add_argument("--only", nargs="+", default=None,
                        help="只装指定类别（china/percussion/piano/voice/strings/winds/keys）或 bank 名")
    parser.add_argument("--list", action="store_true", help="列出可用类别与音源名")
    args = parser.parse_args()

    print("=" * 64)
    print("  安装真实音色（采样音源）→", ASSETS)
    print("=" * 64)
    if args.list:
        for category, banks in CATEGORY_BANKS.items():
            print("  {:8s} {}".format(category, "、".join(sorted(banks))))
        sys.exit(0)

    selected = None
    if args.only:
        selected = set()
        for item in args.only:
            selected |= CATEGORY_BANKS.get(item, {item})
        print("只安装：", "、".join(sorted(selected)))

    ASSETS.mkdir(parents=True, exist_ok=True)
    meta_ready = install_meta_open(selected, args.force)
    if (not selected or "piano_real" in selected) and "meta-piano" not in meta_ready:
        install_piano(args.force)
    install_fluidr3(selected, args.force)
    if not selected or selected & set(VCSL_BANKS):
        install_vcsl(selected, args.force)
    if not selected or "china" in selected or "erhu_real" in selected:
        install_erhu(args.force)
    install_sso_chorus(selected, args.force)
    build_manifest()
    print("\n完成。回到谱见页面刷新：音色下拉里会出现新装的「真实…（采样）」选项；"
          "没装的音色会自动退回同类合成音色。")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print("\n安装失败：" + str(error))
        sys.exit(1)
