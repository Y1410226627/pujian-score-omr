# GitHub 乐谱识别项目调研

调研日期：2026-10-16。通过已连接的 GitHub 搜索和各仓库 README/仓库元数据核对。项目说明与许可证可能更新，准备集成或发布前应再核对原仓库。

## 结论

有多个可借鉴的公开项目，也找到专门处理简谱的 OMR 和更接近本项目形态的 Web/桌面应用；但没有一个覆盖用户符号清单中的所有谱种和演奏指示，并能保证准确演奏。不同仓库解决的是不同子任务：识别、简谱转换、排版显示、播放不能混为一谈。实际识别仍需人工校对。

对本项目最有参考价值的组合是：

1. 用 **homr 或 Audiveris** 研究“图像/PDF → MusicXML”的识谱流程。
2. 把 MusicXML 作为识别与演奏之间的交换格式，先支持可校正的音高、时值、休止符、小节和多声部。
3. 用 **OpenSheetMusicDisplay** 参考网页端的 MusicXML 五线谱显示；它本身不是识谱器，也不自带播放。
4. 用当前项目的音频播放逻辑或 MIDI 工具输出演奏；识别结果必须可由用户修改。

## 候选仓库

| 项目 | 适合参考什么 | 已知边界 | 许可证/维护情况 |
|---|---|---|---|
| [homr](https://github.com/liebharc/homr) | 相机照片/乐谱输入到 MusicXML；有分割、谱表定位、符号序列识别与导出流程，和本项目的目标最接近。 | README 的限制说明目前主要关注高音/低音谱号的音高和节奏，忽略力度、奏法、重升降号等符号；模型结果仍可能出错。需安装 Python 3.11/3.12 及推理依赖，首次可能要下载模型。 | AGPL-3.0；仓库说明训练数据许可另需查看。调研时近期仍有提交。 |
| [score2midi](https://github.com/reki2000/score2midi) | 与本项目很接近的 Web 架构：React 上传多页图片，FastAPI 调用 oemer 和 music21，导出 MIDI/MusicXML，并提供容器化与部署方案。 | README 只列 JPEG/PNG 输入；作者估计印刷、单声部到简单多声部约 70–90%，手写谱和密集复调会明显下降；跨页按声部序号拼接也有限制。该精度是作者自述，不是独立评测。 | MIT；2026 年仍有提交。README 提醒 oemer 在较新 Python 版本可能有依赖问题，Docker 是其推荐启动方式。 |
| [SumisoraOMR](https://github.com/Tsukamotoshio/SumisoraOMR) | Windows 桌面流程：PDF 用 Audiveris、PNG/JPG 用 homr，转换为简谱 PDF；还带简谱文本校对、移调、可选 MIDI 生成和播放。很值得参考其多引擎选择、人工校对和一键桌面应用流程。 | 它是“五线谱转简谱”工具，不等于能完整理解和演奏所有原谱符号。README 列出无歌词、复杂和弦/超过四声部可能丢音、少见拍号和中途转调可能不准；PDF 路径依赖 Java，模型首次下载。 | AGPL-3.0；近期仍有提交。GitHub Releases 提供 Setup/Portable 包；调研时最新 Setup 约 537 MB。 |
| [OrpheusNet](https://github.com/Akane0721/OrpheusNet) | 专门针对简谱图像的 OMR：切分和识别数字、八度/节奏标记及部分元信息，用音乐语法组装后输出 MIDI；README 还描述 Flask 上传网页。 | 研究型实现，README 的高准确率是其数据集上的自述指标，不能外推到任意扫描件；未显示完整校对编辑器，也不能覆盖全部五线谱、TAB、现代记谱等。 | MIT；2024 年有更新。 |
| [OMR Melody Generator](https://github.com/Trumanchho/omr-jianpu-melody-generator) | 简谱图像 → CNN 符号序列 → MIDI；含 React/Flask 网页、播放、节拍/调性调整和手动修正界面，是简谱编辑交互的直接参考。 | README 自述数据集只有 3435 张、符号类别有限；连线/粗下划线会影响切分，延音线不识别，编辑界面仍较简陋。仓库元数据没有标出许可证，复用前须查清授权。 | 数据和限制信息见 README；不能把其演示结果当成通用准确率。 |
| [Audiveris](https://github.com/Audiveris/audiveris) | 成熟的桌面 OMR、识别后人工修正、大型乐谱处理，以及导出 MusicXML 的工作流；适合研究如何让用户修正识谱错误。 | 它明确说明无法保证所有乐谱 100% 识别；导出的 MusicXML 只包含内部识别信息的一个子集。更像可独立运行的 Java 应用/引擎，不是现成的网页组件。 | AGPL-3.0；提供 Windows、Linux、macOS 安装包，仓库仍在维护。 |
| [oemer](https://github.com/BreezeWhite/oemer) | 端到端 OMR 的算法结构；包含谱线/符号分割、音符与节奏解析，并输出 MusicXML 和分析图。对拍照倾斜乐谱有处理思路。 | 模型面向西方记谱法；项目提示手写谱或其他记谱类型可能无法工作。 | MIT；代码许可较宽松，但训练数据和模型文件也应单独核对。最近一次仓库提交早于 homr。 |
| [oemer_tab](https://github.com/KazmaWed/oemer_tab) | 在 oemer 上增加吉他/贝斯 TAB 谱线和品位数字识别，同时生成 MusicXML TAB 部分和调弦信息。可参考如何把 TAB 与普通五线谱配对。 | TAB 时值取自同图中的标准五线谱，因为 TAB 品位数字本身不编码时值；目前文档列出的调弦为标准吉他 EADGBE 和贝斯 EADG。 | MIT；较新的专用扩展，但首次使用要下载模型。 |
| [Polyphonic-TrOMR](https://github.com/NetEase/Polyphonic-TrOMR) | Transformer 端到端识别多声部图像的研究参考；有推理脚本和示例输出，可借鉴音符序列解码。 | README 标明训练代码之后再开放；示例输出是项目自己的符号编码，不是可直接接入的 MusicXML API。仓库提交较早，更适合研究论文/模型思路。 | Apache-2.0。 |
| [Mozart](https://github.com/aashrafh/Mozart) | 简化的图像到文本识谱教学/原型思路；README 提到后续可转换为 MIDI 或音频。 | 采用简化的文本表示，不能据此判断其覆盖完整乐谱语义；调研时仓库最近提交在 2022 年。 | Apache-2.0。 |
| [OMR-Datasets](https://github.com/apacha/OMR-Datasets) | 查找训练集和评测集，涵盖印刷谱、手写谱、符号分类、谱线处理和端到端任务。 | 它是数据集目录，不是可直接识谱的应用。目录中特定数据集各有许可和引用要求，不能把目录仓库的 MIT 许可证当成所有数据集的授权。 | 目录为 MIT；数据集许可逐项确认。 |
| [OpenSheetMusicDisplay](https://github.com/opensheetmusicdisplay/opensheetmusicdisplay) | 在浏览器中把 MusicXML 渲染为乐谱；README 也列出 MusicXML 吉他指法谱显示。适合将来替换/增强当前的简易乐谱展示。 | 只负责显示，不识别图片、不提供完整编辑器；README 当前说明核心版本不带播放。它的 MusicXML 支持也有范围限制。 | BSD-3-Clause；TypeScript，仓库仍有更新。 |
| [Tonejs/Midi](https://github.com/Tonejs/Midi) | 浏览器/JavaScript 中解析和写入 MIDI，方便实现 MIDI 导入导出或把音符事件传给播放器。 | MIDI 文件工具，不识别乐谱图像，也不负责合成声音。 | MIT；最近提交较早，接入前需确认与当前依赖版本兼容。 |
| [PDF-to-GP5](https://github.com/F100Pilot/PDF-to-GP5) | 吉他/贝斯 TAB PDF/图片 → Guitar Pro 文件，并带浏览器练习播放器、速度控制、循环和乐谱校正；有 Windows 安装包和便携包，适合作为 TAB 子产品与启动流程参考。 | 含可选文本的编辑器 PDF 转换最可靠；图片/扫描件 OCR 属实验性，作者要求逐项检查。其公开“不支持/部分支持”清单包括连音组节奏、摇摆、调号、部分力度奏法、颤音、鼓等。 | MIT；2026 年仍有提交。GitHub Releases 提供 Setup/Portable 包；调研时最新 Setup 约 174 MB。README 提供逐项符号覆盖文档。 |
| [Music-Tabbler](https://github.com/Hebleh/Music-Tabbler) | 本地化 PDF/图片 TAB 编辑器，自动几何/OCR 只作可撤销建议，用户可在原图上改品位和弦线，也可按调弦转换并排练查看。适合借鉴“机器提出、用户确认”的交互。 | 面向 TAB 的视觉编辑与调弦转换，不重建完整节奏或普通五线谱，也不是通用演奏引擎。README 明确 OCR 会漏检/拆分符号。 | MIT；有近期代码与自动检查记录，但不声称通用 OCR 准确率。 |
| [musicxml_to_jianpu](https://github.com/lzh9102/musicxml_to_jianpu) | 把 MusicXML 转成简谱/LilyPond 的桥接参考，可借鉴如何从结构化音符生成简谱。支持简单音符、休止、变音、延音线和多轨。 | 不识别图片；实验性且功能子集有限，只支持单声部，作品中途改变调号/拍号时不支持。 | MIT；2022 年后未见新提交。 |
| [jianpu-ly](https://github.com/ssb22/jianpu-ly) | 简谱文本排版器，支持歌词、节奏、连音、反复、力度、和弦、多声部等不少语义，可参考简谱的文本表示和排版。 | 主要从简谱文本生成 LilyPond 排版，不是图像识别；MusicXML 导入是实验性功能。 | Apache-2.0；仓库仍有更新。 |

## 对现有项目的落地建议

建议把识谱引擎做成独立的本地处理步骤，而不是把图像识别算法继续堆进浏览器里的简单像素检测：

```text
PDF/图片 → 预处理与分页 → OMR 引擎 → MusicXML/结构化音符
                                 ↓
                       用户校对音符和节奏
                                 ↓
                    乐谱显示 + 播放 + MIDI 导出
```

若先做传统五线谱，`score2midi` 最接近当前网页项目的端到端结构，可对照其图像上传、服务端 OMR、MusicXML/MIDI 导出和分页处理；识别引擎可评估 homr 或 Audiveris。若先做简谱，`OrpheusNet` 和 `OMR Melody Generator` 是专用识别参考，`SumisoraOMR` 展示了五线谱到简谱、人工校对和桌面打包的完整产品流程。许可证需要按选定仓库与依赖逐项确认：homr/Audiveris/SumisoraOMR 是 AGPL-3.0；score2midi、OrpheusNet 是 MIT；数据集、模型权重和第三方组件可能另有条款。

之后再分别扩展：简谱识别、吉他 TAB、打击乐谱号、歌词与演奏文字、力度/奏法、复调与多乐器、微分音及非常规记谱。每一类需要单独准备带标注的样本和验收用例；仅仅识别到一个符号字符，不等于已知道它在当前谱号、调号、节奏和乐器语境下应如何演奏。

## 搜索结果的范围

继续扩大搜索后，找到了 `OrpheusNet`、`OMR Melody Generator` 和 `SumisoraOMR` 等简谱相关仓库；TAB 方向还找到 `oemer_tab`、[PDF-to-GP5](https://github.com/F100Pilot/PDF-to-GP5) 和 [Music-Tabbler](https://github.com/Hebleh/Music-Tabbler)。它们分工不同：oemer_tab 是五线谱+TAB 的图像识别，PDF-to-GP5 面向 Guitar Pro/TAB 练习，Music-Tabbler 侧重可人工校正的 TAB 编辑。TAB 图像 OCR 的仓库自身也明确要求校对，且在节奏、调号、装饰、力度、鼓等方面存在限制。

手写谱检索到的 [homr_competition](https://github.com/syxarevo/homr_competition) 只处理单声部灰度谱的研究/课程实现；[FAAM-dataset](https://github.com/nicholascornia89/FAAM-dataset) 主要针对历史乐谱上的手写批注数据，不是手写音符的通用识谱器。历史管风琴指法谱另有 [Organ-Tablature-Ocr](https://github.com/umr-ds/Organ-Tablature-Ocr) 的特定数据和模型，面向 16 世纪德国管风琴谱，不可等同于现代吉他 TAB。

OSMD README 提及的简谱显示/播放属于赞助者相关早期访问信息，不能当作核心开源版已完整支持简谱识别的依据。
