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
  py -3 tools/install_soundfonts.py --only strings winds keys piano
  py -3 tools/install_soundfonts.py --force         # 已装的也重新下载
  py -3 tools/install_soundfonts.py --list          # 看有哪些类别
"""
import argparse
import base64
import json
import re
import struct
import sys
import tarfile
import time
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / ".assets" / "soundfonts"
REGISTRY = "https://registry.npmjs.org"
JSDELIVR = "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/FluidR3_GM"
SSO_BASE = "https://cdn.jsdelivr.net/gh/peastman/sso@master/Sonatina%20Symphonic%20Orchestra/"

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
    "trombone_real": {"instrument": "trombone", "label": "长号（采样）", "continuous": True, "category": "winds"},
    # 键盘 / 音色
    "church_organ_real": {"instrument": "church_organ", "label": "教堂管风琴（采样）", "continuous": True, "category": "keys"},
    "electric_piano_real": {"instrument": "electric_piano_1", "label": "电钢琴（采样）", "continuous": False, "category": "keys"},
    "harpsichord_real": {"instrument": "harpsichord", "label": "羽管键琴（采样）", "continuous": False, "category": "keys"},
    "vibraphone_real": {"instrument": "vibraphone", "label": "颤音琴（采样）", "continuous": False, "category": "keys"},
    "pad_real": {"instrument": "pad_2_warm", "label": "温暖铺底（采样）", "continuous": True, "category": "keys"},
    # 其他音色
    "voice_oohs_real": {"instrument": "voice_oohs", "label": "人声「哦」（采样）", "continuous": True, "category": "keys"},
    "synth_choir_real": {"instrument": "synth_choir", "label": "合成人声合唱（采样）", "continuous": True, "category": "keys"},
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
    """erhu_d5_sus_rr1.wav → MIDI 编号（d5 → D5 = 74）。"""
    import re
    matched = re.match(r"erhu_([a-g])([sb]?)(\d)_sus_rr\d\.wav", name)
    if not matched:
        return None
    letter, accidental, octave = matched.groups()
    pitch = NOTE_TO_MIDI.get(letter + accidental)
    if pitch is None:
        return None
    return 12 * (int(octave) + 1) + pitch


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
            "label": "真实女声合唱（采样）", "continuous": True, "decodeRate": 24000,
            "layers": [{"velocity": 0.8, "notes": female}],
        }
    if male:
        banks["choir_male"] = {
            "label": "真实男声合唱（采样）", "continuous": True, "decodeRate": 24000,
            "layers": [{"velocity": 0.8, "notes": male}],
        }
    # 混声：高音区用女声、低音区用男声（同音高时女声优先）
    mixed = dict(male)
    mixed.update(female)
    if mixed:
        banks["choir_real"] = {
            "label": "真实混声合唱（采样）", "continuous": True, "decodeRate": 24000,
            "layers": [{"velocity": 0.8, "notes": mixed}],
        }
    return banks


# ============================================================
# 四、生成清单
# ============================================================
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
            "trimSeconds": 5.5, "layers": layers,
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
                "layers": [{"velocity": 0.8, "notes": notes}],
            }
            if meta["continuous"]:
                spec["loopSeconds"] = [1.0, 2.5]
            banks[bank] = spec

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
            {"bank": "其他采样乐器", "name": "FluidR3_GM（预渲染 mp3）", "author": "Frank Wen",
             "license": "CC BY 3.0", "url": "https://github.com/gleitz/midi-js-soundfonts"},
        ],
    }
    manifest_path = ASSETS / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    licenses = ASSETS / "LICENSES.md"
    licenses.write_text(
        "# 采样音源许可与署名\n\n"
        "本项目**不重新分发**这些音频样本；它们由 `tools/install_soundfonts.py` 在使用者本机下载并转换。\n"
        "如果你把本项目用于公开场合，请保留下面的署名：\n\n"
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
    print("\n清单已写入：{}".format(manifest_path))
    print("可用音源 {} 个：{}".format(len(banks), "、".join(sorted(banks))))


CATEGORY_BANKS = {
    "china": {"erhu_real"},
    "piano": {"piano_real"},
    "voice": {"choir_female", "choir_male", "choir_real"},
    "strings": {bank for bank, meta in FLUIDR3_BANKS.items() if meta["category"] == "strings"},
    "winds": {bank for bank, meta in FLUIDR3_BANKS.items() if meta["category"] == "winds"},
    "keys": {bank for bank, meta in FLUIDR3_BANKS.items() if meta["category"] == "keys"},
}


def main():
    parser = argparse.ArgumentParser(description="安装谱见的真实音色（采样音源）")
    parser.add_argument("--force", action="store_true", help="已安装也重新下载")
    parser.add_argument("--only", nargs="+", default=None,
                        help="只装指定类别（piano/voice/strings/winds/keys）或 bank 名")
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
    if not selected or "piano_real" in selected:
        install_piano(args.force)
    install_fluidr3(selected, args.force)
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
