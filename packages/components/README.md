# @pi-lead-child/components

基础组件库。一套 API，三个平台：web、iOS、Android。

- **Tamagui v3**（`@tamagui/core`）渲染布局、文字和展示类组件，也渲染所有控件的 web 版本。
- **Expo UI**（`@expo/ui`）在 iOS 和 Android 上渲染原生控件：iOS 上是 SwiftUI，Android 上是 Jetpack Compose。

应用只从 `@pi-lead-child/components` 引用 UI，不直接引用 `react-native`、`@expo/ui`、`tamagui` 或 `expo-symbols`。

## 接入

1. 在应用根布局里加载字体，再用 `UIProvider` 包住应用：

   ```tsx
   import { UIProvider, useUIFonts } from '@pi-lead-child/components';

   export default function RootLayout() {
     const [loaded, error] = useUIFonts();
     if (!loaded && !error) return null;
     return <UIProvider>{/* 路由 */}</UIProvider>;
   }
   ```

2. 如果 web 用静态导出，在 `+html.tsx` 的 `<head>` 里放 `<UIServerStyles />`。这样首屏在 JavaScript 加载前就有样式。

## 组件

| 分类 | 组件 | 渲染方式 |
| --- | --- | --- |
| 布局 | `Box` `Row` `Column` `Spacer` `Divider` | 三端 Tamagui |
| 文字 | `Text` `Link` `Code` | 三端 Tamagui |
| 容器 | `Pressable` `Card` `ScrollArea` `Screen` `KeyboardArea` | 三端 Tamagui 或 React Native |
| 展示 | `Icon` `Badge` `Dot` `Avatar` `ProgressBar` `Skeleton` `EmptyState` `ServiceMark`（第三方服务的标志，品牌色在组件里） | 三端 Tamagui |
| 会话 | `TaskCard`（一轮回复的工作步骤）`MessageBubble`（你发的消息） | 三端 Tamagui；TaskCard 的展开按钮 web 是 `<button>`，原生是 Pressable |
| 对话坞 | `ChatDock`（停在面板底部的对话：收起时露出最新一条和输入框，展开时占满）`DockedLayout`（主体在上、对话坞在下，同一时间只有一个滚动区） | 三端 Tamagui；ChatDock 的展开按钮 web 是 `<button>`（展开时按 Esc 收起），原生是 Pressable；把手和预览上滑展开、下滑收起（PanResponder）；展开和收起有动画：在 DockedLayout 里时，对话坞的上沿滑上去、滑下来，预览淡出、对话淡入（Reanimated，三端相同，系统减弱动态效果时不播） |
| 工单详情的块 | `Section`（能折叠的块：标题、出处、右边的摘要；折叠状态由调用方给）`RecordRow`（一条记录：子工单、运行记录、改动的文件）`ActionBar`（底部操作栏，放在 `ChatDock` 的 `bar` 里，和对话坞同一个外框；手机上文字和按钮分两行）`ConfirmBar`（对外操作前的一次确认，换掉 `ActionBar` 的内容）`Sheet`（从底部升起的面板，盖住父容器，带遮罩） | 三端 Tamagui；Sheet 的动画用 Reanimated，web 上按 Esc 关闭，Android 上按返回键关闭 |
| 数据 | `FactList` `Stats` `Steps`（含跳过、受阻）`Progress` `Timeline` `BarChart` `Checklist`（逐条对照：几列判定加勾选，不通过的那条标红带证据）。工单详情和聊天里的生成式界面（genui）共用，只收普通的 props；`Stats` `Steps` `Timeline` 的 `compact` 是工单详情的样子 | 三端 Tamagui |
| 选择 | `ChoiceGroup`（cards：点了就提交的选项卡；radio：单选卡） | 三端 Tamagui |
| 筛选 | `Chip` | 三端 Tamagui |
| 原生控件 | `Button` `IconButton` `TextField` `Switch` `SegmentedControl` `List` `ListItem` | web：Tamagui；iOS/Android：Expo UI |
| 动效 | `SlidePanel` `LayoutTransition` `SwitchTransition` | 三端 Reanimated |
| 平台 | `useBreakpoint` `isWeb` `isIOS` `isAndroid` `platformOS` `openURL` `safeLink` | — |

## 样式属性

Tamagui 组件（`Box`、`Row`、`Column`、`Text`、`Card`、`Pressable` 等）接受 Tamagui v3 的样式属性：

- 只用简写：`p` `px` `py` `pt` `pb` `pl` `pr` `m` `mx` `my` `w` `h` `minW` `maxW` `minH` `maxH`
  `bg` `rounded` `items` `justify` `self` `grow` `shrink` `z` `t` `r` `b` `l`。没有简写的属性用全名，例如 `gap`、`flex`、`borderWidth`。
- token 名不带 `$`：`bg="surface"`、`borderColor="border-soft"`、`rounded="md"`、`p="12"`。
- 条件样式写在同一个值里：`bg={{ default: 'transparent', hover: 'surface-subtle', press: 'surface-muted' }}`。

`Text` 的常用属性：`size`（字号，键名是像素值，例如 `"12.5"`）、`weight`（`regular` `medium` `semibold` `bold` `extrabold`）、
`mono`、`italic`、`tone`（`default` `secondary` `muted` `accent` `danger-dark` 等）、`align`、`leading`（行高，像素）。

## 滚动区

`ScrollArea` 缺省占满父容器的剩余空间（`flex={1}`）。

- 如果滚动区要按内容定高，设 `flex={0}` 和 `maxH`。内容超过 `maxH` 后在内部滚动。不要把 `maxH` 放在外层的 `Box` 上：滚动区会按内容撑开，不会滚动。
- 如果滚动区放在另一个纵向滚动区里面，设 `nested`。Android 需要它才能滚动内层。
- `fillContent` 让内容至少和可视区一样高，空状态可以在可视区里居中。

## 设计 token

`src/theme/tokens.ts` 是唯一的来源：颜色（`palette`）、间距（`space`）、语义间距（`spacing`）、圆角（`radius`）、
字号（`fontSizes`）、语义字号（`textSizes`）、字体文件（`fontFaces`）、正文行宽（`measure`）和断点（`breakpoints`）。需要原始色值时（例如传给第三方组件），从 `palette` 读。

### 语义间距和语义字号

像素 token（`space`、`fontSizes`）只说明数值。语义 token 说明用途：两个东西之间是什么关系，一段文字是什么文字。
它们也是 Tamagui token，写法和像素 token 一样，写错名字时类型检查报错。完整的表在 `src/theme/tokens.ts`
的 `spacingByDensity` 和 `textSizesByDensity`，每个名字旁边写了用在哪里。

比例尺（2026-10-22）：间距只取 4 的倍数，加 2 和 6 两个半步；字号只取 11、12、13、14、16、20、24 七档，最小 11。
会话的几个值是用户定的，是例外：`conversation-block` 14、`reply-block` 8、`list-row` 6、`message-body` 14、`message-lead` 16。

常用的名字：

| token | 标准值 | 用在哪里 |
| --- | --- | --- |
| `gap="conversation-block"` | 14 | 会话流里相邻的两块：消息、卡片、日期分隔线 |
| `gap="reply-block"` | 8 | 一条回复里相邻的两块：段落、标题、列表、表格、代码块 |
| `gap="list-row"` | 6 | Markdown 列表的相邻两项；连着的外部消息卡 |
| `gap="text-stack"` | 2 | 一个文字单元里上下的行：标题和副标题，标签和值 |
| `gap="icon-label"` | 6 | 图标或圆点和它的文字 |
| `gap="inline-item"` | 8 | 同一行里并列的信息：时间、作者、状态、计数 |
| `gap="side-item"` | 12 | 主内容列和旁边固定宽度的东西：头像、按钮、开关、箭头 |
| `gap="actions"` | 8 | 同一组里相邻的按钮 |
| `gap="card-row"` | 8 | 卡片正文里相邻的块 |
| `gap="card-section"` | 12 | 卡片的头部、正文、底部操作区之间 |
| `gap="stacked-card"` | 8 | 面板里上下排的卡片或条目 |
| `gap="page-section"` | 24 | 页面或详情面板里的大区块；设置页里相邻的两组 |
| `p="card"` | 12 | 会话、工作台、工单详情里的卡片 |
| `p="page-card"` | 16 | 设置页和配对页上的整块卡片 |
| `px="inset-x" py="inset-y"` | 12 / 8 | 卡片里的灰底框：引用、草稿、代码 |
| `px="row-x" py="row-y"` | 12 / 8 | 可点的列表行和菜单项 |
| `pl="group-indent"` | 32 | 能折叠的一组下面的子项，左边让开折叠箭头和组的图标（设置 → 模型的模型库） |
| `px="page-x"` | 16 | 页面和面板左右的留白 |
| `size="message-body"` | 14 / 24 | 会话消息正文（行高固定，不随档位变） |
| `size="page-title"` | 24 / 32 | 整页的大标题 |
| `size="section-title"` | 14 / 20 | 面板和页面里一个区块的标题 |
| `size="card-title"` | 14 / 20 | 卡片或列表行的标题 |
| `size="body"` | 13 / 20 | 卡片和面板里的正文 |
| `size="secondary"` | 12 / 18 | 标题下面的说明句、状态句 |
| `size="label"` | 12 / 16 | 字段名、行名、状态词 |
| `size="note"` | 12 / 18 | 小字说明、提示、操作结果 |
| `size="meta"` | 11 / 16 | 时间、计数、编号、作者 |
| `size="code"` | 12 / 18 | 等宽文字：路径、编号、日志 |

语义字号同时决定字号和行高（`size="card-title"` 得到 14/20），不要再写 `leading`。

#### 密度

同一个名字在紧凑、标准、宽松三档里取不同的值（`spacingByDensity` 每行是 `[紧凑, 标准, 宽松]`）。
区域由页面在外层声明一次，组件不需要知道自己在哪个区域：

```tsx
<Density name="compact">   {/* 工作台的面板、工单详情：扫读的列表 */}
  <TicketThread />
</Density>
```

区域的密度来自外观偏好（下一节），缺省：工作台和工单详情紧凑，会话和设置标准。固定一档时写 `<Density name="compact">`。
紧凑区域里可以再放 `<Density zone="conversation">`（工单详情里的对话坞）。
实现见 `src/theme/density.ts`：标准值是全局 token；另两档放在子 theme `light_compact`、`light_comfortable` 里，
布局原语和 `Text` 外面的 `withDensity` 在渲染前换值。

#### 外观偏好

用户在设置 → 外观里调的几个旋钮（`src/theme/preferences.ts`），应用从 daemon 取到后放进 `DesignPreferencesProvider`：

| 旋钮 | 档位 | 作用 |
| --- | --- | --- |
| 密度 | 每个区域：紧凑 / 标准 / 宽松 | `<Density zone>` 取哪一档 |
| 圆角 | 小 / 标准 / 大 | `rounded` token 乘 0.5 / 1 / 1.5（`full` 不变） |
| 字号 | 小一号 / 标准 / 大一号 | 语义字号 ±1，最小 11；会话正文不变 |
| 行高 | 紧 / 标准 / 松 | 语义字号的行高 ±2 |
| 颜色 | 主色、成功、警告、危险、信息 | 同色系按缺省调色板的关系推导；web 上写成 CSS 变量覆盖，原生这一版不改颜色 |

组件不读偏好：所有换值都在 `withDensity` 里做，所以写组件时只管用语义名字。

规则：

1. 新写或改动的间距和字号，先按用途从 `spacingByDensity`、`textSizesByDensity` 里挑一个名字，不直接写数字。
2. 如果没有合适的用途，先在 `src/theme/tokens.ts` 里加一个新名字，三档的值都写上，写清楚它用在哪里，再用它。
3. 不要因为数值碰巧相同就借用别的名字。用途不同，以后可能分别调整。
4. 值只取比例尺上的数。`test/semanticTokens.test.ts` 检查这一条，也检查三档的顺序。
5. 会话正文的行高固定是 24（`message-body`、`message-lead`），不写 `leading`，也不随密度和外观偏好变。
6. 组件自己的规格（按钮、输入框、徽标、芯片、表格格子、图表的几何）保留数字，写在组件或它的 `*.shared.ts` 里，加注释说明。
   1 到 3px 的光学对齐也保留数字。

`measure.prose` 也是一个 size token。写 `maxW="prose"`，正文按约 40 个汉字换行，容器本身仍然可以更宽。
`measure.conversation`（680）是会话的内容列。用 `ConversationColumn`：Lead 一侧所有的块放在这一列里，宽度一致。

## 三端一致的保证

每个原生控件有三个文件：

- `Xxx.types.ts`：props 类型，各平台共用。
- `Xxx.tsx`：web 实现（Tamagui）。
- `Xxx.native.tsx`：iOS 和 Android 实现（Expo UI）。少数平台差异放在 `*.ios.ts` / `*.android.ts` 里。

视觉规格（尺寸、颜色）放在 `Xxx.shared.ts`，两端都从这里取值。

展示类组件（`display/`）三端都由 Tamagui 渲染。如果某个平台的无障碍接法不同，它也分 `Xxx.tsx` 和 `Xxx.native.tsx`，但原生实现不用 Expo UI。
例如 `TaskCard`：两端共用 `TaskCardLayout.tsx`，只有展开按钮不同。

检查方式：

- `npm run typecheck` 做三遍类型检查：web（`tsconfig.test.json`）、iOS（`tsconfig.ios.json`）、Android（`tsconfig.android.json`）。
  后两遍用 `moduleSuffixes` 按 Metro 的规则解析平台文件。
- `test/platform-contract.test.ts` 检查每个原生实现都有对应的 web 实现，导出同样的组件，并且从同一个 types 文件取 props。
- `npm test` 在 jsdom 里渲染 web 实现，检查行为。
