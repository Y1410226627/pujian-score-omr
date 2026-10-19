# 乐器音源清单

本机可用的采样音源共 **67 种**（另有 6 种不用装即可用的合成音色）。

安装方式：双击 `安装真实音源.bat`，或运行 `py -3 tools/install_soundfonts.py`。只想装某几类时用 `--only china strings winds`；先看清单用 `--list`。

没装某一类时也能用：选中该音色会自动退回「同类合成音色」，不会没有声音。

## 中国民族乐器（8 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 二胡 | 循环 | strings | 弓弦，循环撑长音；CC0 样本（sfzinstruments/aliexpress-erhu） |
| 琵琶 | 自然衰减 | soft | 弹拨，点一次响一下；FluidR3 弹拨音色（GM 太鼓/拨弦近似） |
| 古筝 | 自然衰减 | soft | 弹拨，FluidR3 竖琴/齐特近似 |
| 笛子 | 循环 | organ | 吹管，FluidR3 长笛/管风琴近似 |
| 箫 | 循环 | organ | 吹管，FluidR3 长笛近似 |
| 笙 | 循环 | organ | 簧管，FluidR3 簧风琴近似 |
| 唢呐 | 循环 | organ | 簧管，FluidR3 唢呐近似（GM 112 对应） |
| 扬琴 | 自然衰减 | soft | 击弦，FluidR3 洋琴音色 |

## 钢琴 / 键盘（5 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 真实钢琴 | 自然衰减 | piano | Salamander Grand Piano V3（两层力度） |
| 电钢琴 | 自然衰减 | soft | FluidR3 |
| 羽管键琴 | 自然衰减 | soft | FluidR3 |
| 教堂管风琴 | 循环 | organ | FluidR3 |
| 手风琴 | 循环 | organ | FluidR3 |

## 弦乐（7 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 弦乐合奏 | 循环 | strings | FluidR3 |
| 小提琴 | 循环 | strings | FluidR3 |
| 中提琴 | 循环 | strings | FluidR3 |
| 大提琴 | 循环 | strings | FluidR3 |
| 低音提琴 | 循环 | strings | FluidR3 |
| 拨弦 | 自然衰减 | strings | FluidR3 |
| 震音弦乐 | 循环 | strings | FluidR3 |

## 管乐（8 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 长笛 | 循环 | organ | FluidR3 |
| 短笛 | 循环 | organ | FluidR3 |
| 单簧管 | 循环 | organ | FluidR3 |
| 双簧管 | 循环 | organ | FluidR3 |
| 英国管 | 循环 | organ | FluidR3 |
| 大管 | 循环 | organ | FluidR3 |
| 竖笛 | 循环 | organ | FluidR3 |
| 陶笛 | 循环 | organ | FluidR3 |

## 铜管（5 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 小号 | 循环 | organ | FluidR3 |
| 长号 | 循环 | organ | FluidR3 |
| 大号 | 循环 | organ | FluidR3 |
| 圆号 | 循环 | organ | FluidR3 |
| 铜管合奏 | 循环 | organ | FluidR3 |

## 弹拨 / 吉他（6 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 竖琴 | 自然衰减 | soft | FluidR3 |
| 尼龙弦吉他 | 自然衰减 | soft | FluidR3 |
| 民谣吉他 | 自然衰减 | soft | FluidR3 |
| 电吉他 | 自然衰减 | soft | FluidR3 |
| 班卓琴 | 自然衰减 | soft | FluidR3 |
| 西塔琴 | 自然衰减 | soft | FluidR3 |

## 贝斯（3 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 原声贝斯 | 自然衰减 | strings | FluidR3 |
| 电贝斯 | 自然衰减 | strings | FluidR3 |
| 无品贝斯 | 循环 | strings | FluidR3 |

## 萨克斯（4 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 中音萨克斯 | 循环 | organ | FluidR3 |
| 次中音萨克斯 | 循环 | organ | FluidR3 |
| 高音萨克斯 | 循环 | organ | FluidR3 |
| 上低音萨克斯 | 循环 | organ | FluidR3 |

## 打击 / 旋律打击乐（8 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 颤音琴 | 自然衰减 | soft | FluidR3 |
| 马林巴 | 自然衰减 | soft | FluidR3 |
| 木琴 | 自然衰减 | soft | FluidR3 |
| 钟琴 | 自然衰减 | soft | FluidR3 |
| 钢片琴 | 自然衰减 | soft | FluidR3 |
| 管钟 | 自然衰减 | soft | FluidR3 |
| 钢鼓 | 自然衰减 | soft | FluidR3 |
| 定音鼓 | 自然衰减 | strings | FluidR3 |

## 人声（合唱）（4 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 混声合唱 | 循环 | choir | SSO 采样（男女声分别采样后按音域组合） |
| 女声合唱 | 循环 | choir | SSO |
| 男声合唱 | 循环 | choir | SSO |
| 人声「哦」 | 循环 | choir | FluidR3 |

## 合成 / 电子（3 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 温暖铺底 | 循环 | strings | FluidR3 |
| 合成人声合唱 | 循环 | choir | FluidR3 |
| 合成主音 | 循环 | soft | FluidR3 |

## 其他民族乐器（6 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 尺八 | 循环 | organ | FluidR3 |
| 三味线 | 自然衰减 | soft | FluidR3 |
| 日本筝 | 自然衰减 | soft | FluidR3 |
| 拇指琴 | 自然衰减 | soft | FluidR3 |
| 排箫 | 循环 | organ | FluidR3 |
| 哨笛 | 循环 | organ | FluidR3 |

## 合成音色（不用装，开箱可用）

| 音色 | 分组 |
| --- | --- |
| 钢琴（合成）（`piano`） | 钢琴 / 键盘 |
| 弦乐（合成）（`strings`） | 弦乐 |
| 混声合唱（合成）（`choir`） | 人声（合唱） |
| 女声合唱（合成）（`choir_female_synth`） | 人声（合唱） |
| 管风琴（合成）（`organ`） | 钢琴 / 键盘 |
| 电子琴（合成）（`soft`） | 合成 / 电子 |

合计：采样音源 **67** 种 + 合成音色 **6** 种 = **73** 种可选音色。
