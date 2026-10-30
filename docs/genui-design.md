# Generative UI 设计规范

本文写给两类人：写卡片组件的人（`packages/protocol`、`apps/companion`），以及改 Lead 提示词和 skill 的人。
Lead 画卡时读的是 skill `packages/lead/src/skills/genui-cards/SKILL.md`，不读本文。

本文只记录现在的设计和代码（master 91cf6377 加上 genui-cards，2026-10-20）。改了代码，同时改本文。

相关的决定和代码：

- 方案 A「安静对话」和流式声明式卡片：`.scratch/generative-ui/spec.md`（2026-10-15）。
- 组件目录 v2（DataTable、Stats、Steps、Progress、Timeline、BarChart）：同一份 spec 的 v2 一节（2026-10-19）。
- 组件目录和校验：`packages/protocol/src/ui-surfaces.ts`。
- 渲染：`apps/companion/src/features/genui/SurfaceView.tsx`、`InfoViews.tsx`、`tones.ts`。
- 设计 token：`packages/components/src/theme/tokens.ts`。

## 1. 原则

1. **卡片是数据，不是代码。** Lead 用 `render_ui` 发出一组节点。节点只能用组件目录里的组件，props 必须符合 schema。服务端和 App 用同一个 `validateUiSurface` 校验。卡片里不能有 HTML、脚本、样式或外部链接。
2. **账本里的事实用引用。** 工单、Run、决策的状态用编号引用（`TicketRef`、表格的 `{ ticket }` 格子、`ChoiceGroup.decision`）。App 渲染时从 `TicketSummary` 实时读取，旧卡片不会显示过期的状态。这是 AGENTS.md 的不变量：所有界面都从同一个 `TicketSummary` 取当前状态。
3. **其余的数字和状态是快照。** Stats、Steps、Progress、Timeline、BarChart 的值是画卡时的值，不会自动更新。数据有时效时，卡片里写明数据的时间。
4. **安静。** 一张卡只讲一件事。一两句话能说完的写正文，不画卡。正文不重复卡片的内容：同一个结论只写一次。正文写了结论，卡片只放细节；卡片里有结论，正文只写一句卡片里没有的话，或者不写（2026-10-24）。不加多余的标签，不加推测性的「下一步」按钮（2026-10-17 画布决定）。
5. **按信息的形状选组件**，见第 3 节。不管信息是不是要用户操作，复杂的信息能可视化，就用组件画（2026-10-19 用户决定）。
6. **能降级。** `fallbackText` 是这张卡完整的文字版本。不能显示卡片的地方（plc chat、Slack、推送、旧版 App）只显示它。

## 2. 谁决定什么

| 维度 | 谁决定 | 控制点 |
|---|---|---|
| 选哪些组件、怎么嵌套、顺序 | Lead | `nodes`、`children`、`root` |
| 信息密度（几张卡、几个节点、几行几列） | Lead，有硬上限 | `UI_SURFACE_LIMITS`、`UI_COMPONENT_LIMITS` |
| 色彩 | Lead 只选语义色调 | `tone`：neutral、info、success、warning、danger |
| 组件之间的间距 | Lead 只选三档 | `Stack.gap`：sm、md、lg |
| 组件内部的间距、字号、圆角、具体色值 | App：语义 token，再按用户的外观偏好（设置 → 外观）换值 | `InfoViews.tsx`、`tokens.ts`、`theme/preferences.ts` |
| 动效 | App | 见第 7 节 |

Lead 碰不到的维度，不写进 skill；写进本文，约束写组件的人。

## 3. 组件目录

| 组件 | 用来展示 | 每个节点的上限 | 数据 |
|---|---|---|---|
| Stack | 纵向或横向排列子节点 | — | — |
| Section | 带标题的一组子节点 | — | — |
| Text | 一段文字：body、caption、title | 2,000 字 | 快照 |
| Badge | 一个短标签 | 40 字 | 快照 |
| FactList | 带标签和状态的事实清单 | 20 条 | 快照 |
| TicketRef | 一张工单的紧凑头：编号、标题、状态 | 1 张 | 实时 |
| ChoiceGroup | 请用户做决定：选项、后果、推荐 | 6 个选项 | 决策请求 |
| ConnectionConnect / ConnectionConfirm | 连接第三方账号、确认一次写入 | 1 个 | 实时 |
| MemorySwitchConfirm | 确认一次记忆切换 | 1 个 | 实时 |
| StandingOrderChangeConfirm | 批准一次常设指令修改 | 1 个 | 实时 |
| UserAction | 请用户做一件事：授权、重新授权、确认写入、选择、审批、验收、放行一次被拦下的改规则操作；`action` 原样来自系统的 user_action | 1 个 | 实时 |
| SourceQuote | 引用工单正文或一条 checkpoint 的原文；Lead 只给位置，系统从账本取原文 | 1 段 | 实时 |
| DataTable | 多维对比、状态总览 | 8 列、50 行 | 工单格子实时，其余快照 |
| Stats | 一组数字指标，带和以前比的变化 | 6 个 | 快照 |
| Steps | 计划或流程的步骤，每步一个状态 | 20 步 | 快照 |
| Progress | 一个进度条；进度未知时不给 value | 1 个 | 快照 |
| Timeline | 按时间排的事件 | 30 条 | 快照 |
| BarChart | 数量比较（横向）、趋势（竖向） | 24 根 | 快照 |

整张卡的硬上限：64 个节点、6 层、序列化后 16 KB。超过上限时，工具返回带路径的错误，Lead 在同一轮改正。

信息的形状和组件的对应：

| 信息的形状 | 组件 |
|---|---|
| 多个对象比较多个属性；多张工单的状态 | DataTable（工单用 `{ ticket }` 格子） |
| 几个关键数字和变化 | Stats |
| 计划、流程、做到哪一步 | Steps |
| 一件事的完成比例 | Progress |
| 按时间发生的事 | Timeline |
| 类别之间的数量比较 | BarChart 横向 |
| 按时间的趋势 | BarChart 竖向 |
| 一张工单 | TicketRef |
| 要用户在给定的选项里选 | ChoiceGroup，放在决定卡里 |
| 要用户做一件事（授权、确认、审批、验收） | UserAction |
| 转述报告、核查结论、checkpoint 的原话 | SourceQuote |
| 架构、模块关系 | 不用卡片：正文的代码块里用字符画图 |

## 4. 布局和间距

卡片外框（`SurfaceView`）：

- `Card`，圆角 `xl`，内边距 `card`（标准 12），宽度占满会话列。值随密度和外观偏好变，下同。
- 普通卡片：1 px 边框 `border-soft`。卡片里有 ChoiceGroup 时：1.5 px 边框 `warning-line`。
- 会话列宽 700（`measure.conversation`）。手机宽 375 时，卡片内可用宽度约 309。

容器：

- `Stack.gap`：sm = `chips`（标准 6），md = `card-row`（标准 8，缺省），lg = `card-section`（标准 12）。2026-10-22 起是语义 token。
  - 卡片的根节点用 lg，分开几个区块。
  - 同一个区块里的几个组件用 md。
  - 紧凑的一行（几个 Badge）用 sm，配 `direction: row`。
- `Section`：标题 `label`、半粗、次要色；标题和内容之间 `group-label`。
- 嵌套建议不超过 3 层（硬上限 6 层）。

写组件时：

- 组件不加外边距。组件之间的距离只由父容器的 gap 决定。
- 组件内部只用语义 token（`packages/components/README.md`「语义间距和语义字号」），不写数字。组件自己的几何（图表柱间距、表格格子、轨道线）保留数字并写 `spacing-exempt` 注释。
- 圆角用 token：卡片 `xl`，指标块 `lg`，表格格子里的按钮 `sm`。

## 5. 文字和数字

- Text：title 用 `card-title`（标准 14/20）粗体；body 用 `body`（13/20）；caption 用 `note`（12/18），缺省次要色。字号和行高随外观偏好的档位变。
- 组件里的标签一行，放不下就截断（`numberOfLines={1}`）；说明文字可以换行。
- 数字用 `formatNumber`：千分位，最多两位小数（`InfoViews.tsx`）。表格里的数字列右对齐、等宽。判断「数字列」和 Markdown 表格用同一个规则（`isNumericColumn`）。
- 时间写短格式，例如「10-19 09:58」，用等宽字体。

## 6. 色彩

`tone` 在 App 里的颜色（`tones.ts`）：

| tone | 标签（Badge） | 文字 | 填充（条形、进度条、圆点） | 含义 |
|---|---|---|---|---|
| neutral | neutral | default | text-muted | 缺省，没有特别含义 |
| info | accent | accent | accent | 提示 |
| success | success | success-dark | success | 完成、通过、变好 |
| warning | warning | warning-dark | warning | 需要注意、变差 |
| danger | danger | danger-dark | danger | 真正的故障 |

规则：

- danger 只用于真正的故障，不用于强调。
- 一张卡里的色调不超过 2–3 种。不给每一项都上色：色调只标出例外。
- 填充色缺省用 accent（蓝），和 info 一样。所以只给一根柱子设 info 看不出区别；要突出一根，其余的设 neutral（灰）。
- 用户欠着决定时，状态标签和卡片边框是琥珀色（`warning-line`）。这一点由 App 根据 `TicketSummary` 决定，不由 Lead 决定。
- 状态不能只靠颜色表达：每个状态都有文字或无障碍标签。

## 7. 动效

- 卡片本身没有入场动画。
- 流式生成时，组件一项一项地出现：`partialUiSurface` 去掉还没写完的最后一项再校验（`settleStreamingNode`），表格一行一行地长出来，不会整块消失再出现。卡片底部显示「正在生成…」，选项在定稿前不能点。
- 快照组件不做「还在进行中」的动效：不转圈、不闪烁、不做假的进度动画。旧卡片不能看起来像在实时更新。进度未知时写「进度未知」，进度条留空。
- App 的动效只用于用户触发的展开、收起、滑入。时长用这几档：130、170、220、260 ms（例如对话坞 260/220，AnchoredPanel 220）。所有动效遵守系统的「减弱动态效果」（Reanimated `ReduceMotion.System`）。

## 8. 信息密度

硬上限见第 3 节。下面是建议值，写进 Lead 的 skill：

- 一张卡最多 4 个区块。超过时拆成两张卡，或者删掉读者用不上的部分。
- 一轮回复通常只画一张卡。spec 定的硬上限是每轮 5 张，还没有实现。
- DataTable 最多 6 列。手机上表格在卡片里横向滑动；有工单格子的列至少 300 宽，手机上一屏基本只看到这一列。
- Stats 最多 4 个：桌面一行 4 块，手机一行 2 块。
- Steps 最多 8 步，Timeline 最多 10 条。
- 竖向 BarChart 不超过 8 根时，每根都标数值和标签；超过 8 根时只标最大值和首尾的标签。

## 9. 交互

- 只有决定卡、确认卡和 UserAction 有按钮（`UI_ACTIONABLE_COMPONENTS`）。用户的选择走决策请求或者确认接口，授权照常；选完叫醒 Lead 去执行。
- 卡片要用户做事时，必须至少有一个能点的控件，render_ui 会检查。
- 工单引用可以点：打开工单；提醒打开日程。
- 不加推测性的「下一步」按钮。

## 10. 降级

- `fallbackText` 必填。它要能单独读懂：一两句话，写出结论和最关键的数字。
- App 校验整张卡。有一个节点不合格，或者组件 App 不认识，整张卡只显示 `fallbackText`，不画半截。
- 卡片显示在 Lead 画它的位置（`textOffset`，App 的 `buildAssistantTurn`）：之前写的字在卡片上面，之后写的字在卡片下面。流式输出时页面只在底部增长，卡片不会被后写的字往下推（2026-10-24）。
- 一轮里同一个 surface id 只显示一张卡（2026-10-24）。实时事件和刷新时的折叠用同一套规则（protocol 的 `foldTurnSurfaces` 上面的注释）：
  - 重画的定稿版替换旧卡。重画还在流时，继续显示旧的定稿版。
  - `render_ui` 失败的调用不会再有定稿版，它流式中途的版本撤掉，不停在「正在生成…」。
- App 不认识卡里的组件时（错误的 `code` 是 `unknown_component` 或 `newer_catalog`），说明服务端的组件目录比 App 新。App 在 `fallbackText` 前面加一行说明。其他原因的不合格只显示 `fallbackText`（2026-10-20）。
  - daemon 提供的网页和当前页面的版本不一样：说明写「这张卡需要新版本，刷新后显示」，并给刷新按钮。
  - 版本一样，或者不知道 daemon 提供的版本：说明写「这张卡用了当前版本还不支持的组件」，不给刷新按钮。例如部署了 daemon、没有运行 `build:web` 时，刷新拿到的还是同一个页面。
  - App 不自动刷新，因为用户可能正在输入。用户收起顶栏的提示，不影响卡片上的说明。
- daemon 在网页旁边提供 `/web-build.json`，里面是它现在提供的网页版本。网页每次连上、每次回到前台时读一次，和自己构建时内联的版本比较。两个版本不一样时，会话顶栏显示一条安静的提示「有新版本，刷新后生效」。用户收起提示以后，同一个版本不再提示（2026-10-20，protocol 的 `web-build.ts`）。
- 只追加组件时，不改 `UI_CATALOG_VERSION`。`validateUiSurface` 要求版本相等，改了版本，旧客户端会拒绝所有卡片。
- 卡片落库和发出之前，所有字符串都经过 `redactUiSurface` 去掉密钥。

## 11. 新增一个组件

1. 在 `UI_CATALOG` 里加 schema；上限放进 `UI_COMPONENT_LIMITS`；schema 表达不了的规则写进 `propsRuleError`。
2. 不改 `UI_CATALOG_VERSION`。
3. 在 `InfoViews.tsx` 里渲染，在 `SurfaceView.tsx` 里接上。只用 `@pi-lead-child/components` 的组件和 token。快照数据不加动效。图形加 `role="img"` 和 `aria-label`。
4. 在 `UI_CATALOG_USAGE` 里写这个组件的一行说明。render_ui 的工具描述用 `uiCatalogGuide()` 从它生成，数字从 `UI_COMPONENT_LIMITS` 读。
5. 改 skill `genui-cards`：组件说明和配方。测试会检查 skill 提到了目录里的每一个组件。
6. 加测试：protocol 校验、companion 渲染、Lead 的 render-ui。
7. 在浏览器里看：桌面宽度和手机宽度，用 `.scratch/genui-eval/` 的脚本种卡片截图。

## 12. 已知问题

- Section 的 schema 接受 `tone`，但 App 没有用它（`SurfaceView.tsx` 的 Section 分支）。要么画出来，要么从 schema 里去掉。
- 组件库没有深色主题。
- 每轮最多 5 张卡的上限没有实现。
- 手机上，带工单格子的 DataTable 第一列占满一屏。
- BarChart 没设 tone 的柱子和 info 同色。另一个做法是：有柱子设了 tone 时，App 把没设 tone 的画成浅色。现在由 skill 要求 Lead 给其余的柱子设 neutral。
- 折线图需要 `react-native-svg`，它的版本必须和 Expo SDK 57 完全一致。还没有做。
