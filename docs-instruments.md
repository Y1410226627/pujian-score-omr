# 乐器音源清单

本机可用的采样音源共 **82 种**（另有 6 种不用装即可用的合成音色）。

安装方式：双击 `安装真实音源.bat`，或运行 `py -3 tools/install_soundfonts.py`。只想装某几类时用 `--only china percussion strings winds`；先看清单用 `--list`。

没装某一类时也能用：选中该音色会自动退回「同类合成音色」，不会没有声音。

## 中国民族乐器（17 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 二胡 | 循环 | strings | 弓弦，循环撑长音；CC0 样本（sfzinstruments/aliexpress-erhu） |
| 中胡 | 循环 | strings | 近似中提琴采样；不是中胡实录 |
| 高胡 | 循环 | strings | 近似小提琴采样；不是高胡实录 |
| 琵琶 | 自然衰减 | soft | 弹拨，点一次响一下；FluidR3 弹拨音色（GM 太鼓/拨弦近似） |
| 中阮 | 自然衰减 | soft | Meta Open Sound 尼龙弦吉他近似；不是中阮实录 |
| 大阮 | 自然衰减 | strings | 近似原声贝斯采样；不是大阮实录 |
| 柳琴 | 自然衰减 | soft | Meta Open Sound 钢弦吉他近似；不是柳琴实录 |
| 古筝 | 自然衰减 | soft | 弹拨，FluidR3 竖琴/齐特近似 |
| 笛子 | 循环 | organ | 吹管，FluidR3 长笛/管风琴近似 |
| 曲笛 | 循环 | organ | 近似长笛采样；不是曲笛实录 |
| 箫 | 循环 | organ | 吹管，FluidR3 长笛近似 |
| 埙 | 循环 | organ | 近似陶笛采样；不是埙实录 |
| 管子 | 循环 | organ | 近似唢呐采样；不是管子实录 |
| 笙 | 循环 | organ | 簧管，FluidR3 簧风琴近似 |
| 唢呐 | 循环 | organ | 簧管，FluidR3 唢呐近似（GM 112 对应） |
| 扬琴 | 自然衰减 | soft | 击弦，FluidR3 洋琴音色 |
| 云锣 | 自然衰减 | soft | 近似管钟采样；有音高，不是云锣实录 |

## 中国打击乐（6 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 碰铃 | 自然衰减 | soft | VCSL 指钹单次采样近似；CC0 |
| 木鱼 | 自然衰减 | soft | VCSL 木块单次采样近似，三层力度；CC0 |
| 小锣 | 自然衰减 | soft | VCSL Gong 1 弱奏采样近似；CC0 |
| 大锣 | 自然衰减 | soft | VCSL Gong 1 强奏采样近似；CC0 |
| 钹 | 自然衰减 | soft | VCSL 交响钹单次采样近似；CC0 |
| 排鼓 | 自然衰减 | soft | VCSL 通鼓单次采样近似；CC0 |

## 钢琴 / 键盘（5 种）

| 音色 | 长音 | 没装时退回 | 来源 |
| --- | --- | --- | --- |
| 真实钢琴 | 自然衰减 | piano | Meta Open Sound 钢琴（4 层力度，88 键，CC0）；旧版 Salamander 作下载失败回退 |
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
| 尼龙弦吉他 | 自然衰减 | soft | Meta Open Sound 尼龙弦（3 层，CC0） |
| 民谣吉他 | 自然衰减 | soft | Meta Open Sound 钢弦（3 层，CC0） |
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

合计：采样音源 **82** 种 + 合成音色 **6** 种 = **88** 种可选音色。
