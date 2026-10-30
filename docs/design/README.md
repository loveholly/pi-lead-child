# 设计规范

这套规范规定 pi-lead-child 的界面长什么样、怎么交互。适用范围是会话、工作台、工单详情、设置页，以及 Lead 用 `render_ui` 画的卡片（genui）。人和 agent 都按它工作。

> 状态：初稿（2026-10-26）。来源是当天在画布上和用户一起定下的设计。用户已经确认这 4 处取舍：「等你」用琥珀色；字体用 Plus Jakarta Sans，字号用比例尺上的 7 档；动效只用 4 档时长；阴影分 2 档。还确认了两项：iOS 用锚定浮层加玻璃背景，图标用 Lucide。画布：<https://claude.ai/artifact/CaEmidya9ZrBN83GPdPq88>

## 规范分两层

| 层 | 文件 | 管什么 | 换主题时变不变 |
|---|---|---|---|
| 系统层 | [`system/patterns.md`](system/patterns.md) | 交互模式、信息结构、作者和信任、动效的语义、平台适配、可及性、文案 | 不变 |
| 主题层 | [`themes/default.md`](themes/default.md) | 颜色、字体、字号、圆角、边框、阴影、图标、动效的时长和曲线、装饰、每种卡片的具体样子 | 每套主题各写一份 |

- 系统层回答的是「是什么、怎么用、怎么动」。
- 主题层回答的是「长什么样」。
- 换一套主题，用户在每张卡上看到的信息、能做的操作、交互方式都不变，变的只是外观。

当前只有一套主题：**清爽主题**（`themes/default.md`），它是缺省主题。

## 谁读什么

| 你要做的事 | 按顺序读 |
|---|---|
| 写或改任何 UI（`apps/companion`、`packages/components`） | 本文 → `system/patterns.md` → `themes/default.md` → [`packages/components/README.md`](../../packages/components/README.md)（token 和组件 API） |
| 写或改 genui 的组件、校验、渲染 | 上面四份，再加 [`docs/genui-design.md`](../genui-design.md) |
| 改 Lead 画卡的提示词或 skill | `system/patterns.md` 里标「Lead」的规则，再加 `packages/lead/src/skills/genui-cards/SKILL.md` |
| 出视觉稿 | `system/patterns.md` → `themes/default.md`；画布用默认的设计系统工件（待建） |

## 规则怎么写

1. **每条规则有编号。** 系统层用 `P` 加编号（例如 `P2.3`），主题层用一个字母表示类别，再加编号（例如 `C-4` 是颜色的第 4 条）。评审时直接引用编号，例如「违反 P1.2」。
2. **写成正向的规格。** 写「状态用 7px 圆点加同色文字」，不写「禁止用色条」。一条规则只对它所在的那一层和那一套主题有效。
3. **规格用 token 名或确定的数值。** 不写「清爽」「高级」这类形容词。数值必须能在 `packages/components/src/theme/tokens.ts` 里找到；找不到，先加 token 再写规则。
4. **每条规则有理由。** 一句话说清为什么。主题层的规则尽量附一个画布上的正例。

## 没有规则覆盖时怎么办

1. 先找相近的规则和通用模式（`system/patterns.md` 第 9 节）。新卡片一般是某个通用模式的一个实例。
2. 还是找不到，就先问用户，把答案补成一条规则，再动手。
3. 不在一次任务里临时发明新样式。要换外观，改主题文件，或者新加一套主题。

## 提交前的检查

做完 UI 改动，提交前逐项对照：

1. 颜色、间距、字号、圆角都来自 token，没有裸数字和裸色值（组件自己的规格和 1–3px 光学对齐除外，见 `packages/components/README.md`）。
2. 会话列表不会因为这次改动变高或跳动（`P1`）。展开只发生在锚定浮层里（`P2`）。
3. 一个区域最多一个主按钮（`P5.1`）。
4. 状态用当前主题规定的方式表达，并且不只靠颜色（`P7.2`、`P13.3`）。
5. 新卡片能说出它是哪个通用模式的实例（`P9`），谁是作者（`P8`）。

## 维护

- 改了样式或交互的代码，在同一个提交里改对应的规则。
- 画布上做出的决定，写进规则时注明日期。
- 已经确定、还没写的文件：
  - `system/semantics.md`：token 的角色名、状态和色调的语义、各种对象的信息槽位。
  - `system/cards/*.md`：每种卡的结构和状态机，不写样式。
  - `themes/_template.md`：主题必须回答的清单。
  - `assets/default/`：清爽主题的正例截图。

## 相关文档

- [`packages/components/README.md`](../../packages/components/README.md)：token、语义间距和字号、密度、外观偏好、三端一致的保证。
- [`docs/genui-design.md`](../genui-design.md)：genui 现在的组件目录和规则。
- `.scratch/genui-catalog-v3/spec.md`：genui 组件目录 v3 的方案草稿，包括积木、系统组件、机制、动效组件和覆盖矩阵。
- `AGENTS.md` 的 UI Tokens、UI Actions 两节。
