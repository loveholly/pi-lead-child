// 设计 token 的唯一来源。Tamagui 配置从这里生成，组件在需要原始值的地方（例如图标颜色、
// 原生控件的 seed color）也从这里读。数值来自原 apps/companion 的 design/tokens.ts 和 DESIGN.md。

// 语义色板。键名就是组件和样式属性里写的 token 名，例如 bg="surface"、color="text-muted"。
export const palette = {
  canvas: '#EDEFF3',
  workspace: '#F5F6F8',
  surface: '#FFFFFF',
  'surface-muted': '#F2F4F7',
  'surface-subtle': '#F7F8FA',
  'surface-sunken': '#F4F5F7',
  border: '#E8EAEF',
  'border-soft': '#EEF0F4',
  'border-strong': '#E1E4EA',
  'border-control': '#EAECF0',
  'border-input': '#E4E7EC',
  text: '#10131A',
  'text-strong': '#475467',
  'text-secondary': '#667085',
  'text-muted': '#98A2B3',
  'text-faint': '#B7BDC7',
  'text-ghost': '#C4C9D2',
  // 原来是 #2F6BFF：在白底上是 4.4988:1，差一点不到 WCAG AA（4.5:1）。绿色通道调低 1，变成 4.54:1，看不出差别。
  // 白底上的链接文字和强调色按钮上的白字都按这个比例算。
  accent: '#2F6AFF',
  'accent-strong': '#1E51D6',
  'accent-soft': '#EAF0FF',
  // 比 accent-soft 更浅的底色：会话里 Lead 主动发来的消息（提醒、需要你处理）用它，和普通回复区分开。
  'accent-wash': '#F5F8FF',
  'accent-glow': '#5B8BFF',
  'accent-muted': '#7A9EF5',
  'accent-track': '#8AA9F0',
  success: '#12B76A',
  'success-dark': '#087443',
  'success-soft': '#ECFDF3',
  'success-surface': '#F0FBF5',
  'success-border': '#D3F0DF',
  warning: '#F79009',
  'warning-dark': '#B54708',
  'warning-soft': '#FEF3E2',
  'warning-surface': '#FEF0C7',
  'warning-border': '#FEC84B',
  danger: '#F04438',
  'danger-dark': '#D92D20',
  'danger-soft': '#FEECEB',
  'danger-surface': '#FEF3F2',
  'danger-border': '#FDCDC7',
  'danger-tint': '#FEF0EF',
  // 提醒条和面板的浅底与描边（工单详情的执行提示、阻塞摘要、验收结论）。
  'success-strong': '#039855',
  'success-wash': '#F0FDF4',
  'success-line': '#BBF7D0',
  'warning-wash': '#FFFAEB',
  'warning-cream': '#FFF8EE',
  'warning-line': '#FDE4BC',
  'danger-wash': '#FFF5F4',
  'danger-cream': '#FEF9F8',
  'danger-line': '#F9C7C2',
  'danger-divider': '#F6C9C5',
  violet: '#7A5AF8',
  cyan: '#06AED4',
  'neutral-soft': '#F3F4F6',
  'icon-well': '#E8ECF2',
  // 深色界面（扫码页、扫码入口）上的颜色。
  'ink-raised': '#252A34',
  'ink-muted': '#8F98A8',
  'ink-subtle': '#A8B1C1',
  'ink-accent': '#AFC4FF',
  black: '#0B0D12',
  white: '#FFFFFF',
} as const;

export type ColorToken = keyof typeof palette;

// 间距。键名是像素值，所以 p="18" 就是 18。原设计稿的间距不在 4 的倍数上（例如 9、11、13、18、22、26），
// 按像素命名比 Tailwind 式的步进名更不容易写错。
export const space = {
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  12: 12,
  13: 13,
  14: 14,
  15: 15,
  16: 16,
  18: 18,
  20: 20,
  22: 22,
  24: 24,
  26: 26,
  28: 28,
  30: 30,
  32: 32,
  36: 36,
  40: 40,
  48: 48,
} as const;

// 语义间距（2026-10-21，2026-10-22 定下比例尺和密度）：按两个东西之间的关系取名，同一种关系在每个界面上都是同一个名字。
// 它们和上面的像素间距一样是 space token，写法是 gap="reply-block"；写错名字，类型检查就报错。
// 规则：
//   · 新写或改动的间距，先按关系在这里挑一个名字，不直接写数字；
//   · 这里没有合适的关系时，先加一个新名字（写清楚用在哪两个东西之间），再用它；
//   · 不要因为数值碰巧相同就借用别的名字：关系不同，以后可能分别调整；
//   · 值只取比例尺上的数：4 的倍数，加 2 和 6 两个半步。会话的几个值是用户 2026-10-21 定的，是例外。
//
// 密度（2026-10-22）：同一个名字在紧凑、标准、宽松三档里取不同的值。下表每行是 [紧凑, 标准, 宽松]。
// 标准值注册成全局 space token；紧凑和宽松放在子 theme 里，由 theme/density.ts 的解析器在
// <Density name="compact"> 之内换值。区域由页面在外层声明一次，组件不需要知道自己在哪个区域。
// 工作台的面板和工单详情用紧凑，会话和设置用标准，宽松只在用户的偏好里出现。
export const densities = ['compact', 'standard', 'comfortable'] as const;
export type Density = typeof densities[number];

export const spacingByDensity = {
  // —— 兄弟元素之间（gap / margin）——
  // 一个文字单元里上下相邻的行：标题和副标题，标签和值。
  'text-stack': [2, 2, 4],
  // 图标或圆点和它的文字，在同一行。
  'icon-label': [4, 6, 8],
  // 同一行里并列的几段信息：时间、作者、状态、计数、小徽标；标签和值左右排。
  'inline-item': [6, 8, 12],
  // 一行的主内容列和它旁边固定宽度的东西：前面的头像、图标块，后面的按钮、开关、箭头。
  'side-item': [8, 12, 16],
  // 同一组里相邻的按钮。
  actions: [6, 8, 12],
  // 并排的筛选芯片、标签、小药丸。
  chips: [4, 6, 8],
  // 同一个表单项里的标签、输入框和说明。
  field: [4, 6, 8],
  // 表单里相邻的两个表单项。
  'form-field': [12, 16, 20],
  // 卡片正文里相邻的块：段落、说明、按钮行、灰底框。
  'card-row': [6, 8, 12],
  // 卡片的大区域之间：头部、正文、底部操作区。
  'card-section': [8, 12, 16],
  // 小组标题和它正下方的内容。
  'group-label': [4, 6, 8],
  // 面板里上下排的卡片或条目：收件箱、项目列表、运行记录。
  'stacked-card': [6, 8, 12],
  // 一个页面或详情面板里的大区块；设置页里相邻的两组；页面标题和下面的内容。
  'page-section': [16, 24, 32],
  // 时间线的标记（圆点、竖线）和右边的内容。
  timeline: [8, 12, 16],
  // 时间线里相邻的两条事件。
  'timeline-event': [8, 12, 16],
  // 侧栏、导航里相邻的两项。
  'nav-item': [2, 2, 4],
  // —— 容器的内边距（padding）。两个方向不同时拆成 -x 和 -y ——
  // 会话、工作台、工单详情里的卡片。
  card: [8, 12, 16],
  // 设置页和配对页上的整块卡片。
  'page-card': [12, 16, 24],
  // 卡片里的灰底框：引用、草稿、详情、代码。
  'inset-x': [8, 12, 16],
  'inset-y': [6, 8, 12],
  // 手写的小药丸、状态标签（不含 Badge、Chip 组件）。
  'pill-x': [4, 6, 8],
  'pill-y': [2, 2, 4],
  // 可点的列表行、菜单项。
  'row-x': [8, 12, 16],
  'row-y': [6, 8, 12],
  // 能折叠的一组下面一行一行的子项，左边让开折叠箭头和组的图标（设置 → 模型的模型库：服务商下面的模型，2026-10-29）。
  'group-indent': [28, 32, 40],
  // 提示条、警告条、卡片外的一行状态文字。
  'banner-x': [8, 12, 16],
  'banner-y': [6, 8, 12],
  // 页面和面板的留白：左右、上下、顶部、底部（底部要让最后一项能滚到输入框上方）。
  'page-x': [12, 16, 24],
  'page-y': [12, 16, 24],
  'page-top': [12, 16, 24],
  'page-bottom': [32, 40, 48],
  // 列表上方小组标签的留白。
  'section-label-x': [4, 4, 4],
  'section-label-top': [6, 8, 12],
  'section-label-bottom': [2, 4, 6],
  // 空状态的整块留白。
  'empty-state': [24, 32, 40],
  // 会话输入框（MessageComposer）里面的留白：左右、上下。
  'composer-x': [12, 16, 20],
  'composer-y': [8, 12, 16],
  // 会话输入框里上下相邻的区域：待发的图片、文字、工具栏。
  'composer-row': [4, 8, 12],
  // 并排的图片小图：输入框里待发的图片，会话里你发的图片。
  thumbnails: [6, 8, 12],
} as const;

export const spacing = {
  // 会话流里相邻的两块之间：消息、卡片、日期分隔线、连着的外部消息卡这一组。
  'conversation-block': 14,
  // 一条回复里相邻的两块之间：消息头、段落、标题、列表、表格、代码块、依据、附件。
  'reply-block': 8,
  // 一个列表里相邻的两行之间：Markdown 的列表项、连着的外部消息卡。列表项和引用里面的块也用它。
  'list-row': 6,
  ...(Object.fromEntries(Object.entries(spacingByDensity).map(([name, values]) => [name, values[1]])) as {
    [Name in keyof typeof spacingByDensity]: typeof spacingByDensity[Name][1];
  }),
} as const;

export type SpacingToken = keyof typeof spacing;

export const radius = {
  0: 0,
  xs: 6,
  sm: 8,
  md: 10,
  lg: 11,
  xl: 12,
  '2xl': 14,
  '3xl': 16,
  '4xl': 22,
  full: 9999,
} as const;

export type RadiusToken = keyof typeof radius;

// 行宽，都是 size token。
// prose：一段正文的行宽上限，写法是 maxW="prose"。560 像素在 14 号字下约 40 个汉字。
// conversation：会话的内容列（2026-10-16）。Lead 一侧的回复、任务卡、失败卡、Lead 动态、工单卡都用这一列，
// 宽度一致；手机上是去掉两边留白的全宽，平板和桌面上最宽 700，在会话栏里居中。用 ConversationColumn。
// 700 像素在 14 号字下约 50 个汉字一行，和 Claude、ChatGPT 在 16 号字下约 768 宽的行长相当。
export const measure = {
  prose: 560,
  conversation: 700,
} as const;

// 字号阶梯。键名是像素值：原设计用了很多半像素字号（10.5、11.5、12.5），按像素命名最直接。
export const fontSizes = {
  '9': 9,
  '9.5': 9.5,
  '10': 10,
  '10.5': 10.5,
  '11': 11,
  '11.5': 11.5,
  '12': 12,
  '12.5': 12.5,
  '13': 13,
  '14': 14,
  '14.5': 14.5,
  '15': 15,
  '15.5': 15.5,
  '16': 16,
  '17': 17,
  '18': 18,
  '24': 24,
} as const;

// 语义字号（2026-10-21，2026-10-22 定下七档和密度）：规则和语义间距一样，按文字的用途取名。写法是 size="card-title"。
// 一个名字同时决定字号和行高。字号只取七档：11、12、13、14、16、20、24；最小 11（可读性底线）。
// 下表每行是 [紧凑, 标准, 宽松]，每档是 [字号, 行高]。标准值注册成字号 token，另两档由 theme/density.ts 换。
export const textSizesByDensity = {
  // 整页的大标题。
  'page-title': [[20, 28], [24, 32], [28, 36]],
  // 面板、抽屉、页面里一个区块的标题。
  'section-title': [[13, 18], [14, 20], [16, 24]],
  // 卡片或列表行的标题。
  'card-title': [[13, 18], [14, 20], [16, 22]],
  // 卡片和面板里的正文；整块的占位文字。
  body: [[12, 18], [13, 20], [14, 22]],
  // 标题下面的说明句、状态句。
  secondary: [[11, 16], [12, 18], [13, 20]],
  // 短标签：字段名、行名、状态词。
  label: [[11, 16], [12, 16], [13, 18]],
  // 小字说明、提示、操作后的结果或报错。
  note: [[11, 16], [12, 18], [13, 20]],
  // 时间、计数、编号、作者。
  meta: [[11, 16], [11, 16], [12, 16]],
  // 一组内容上方的小标题。
  eyebrow: [[11, 16], [11, 16], [12, 16]],
  // 等宽文字：路径、编号、引文、日志。
  code: [[11, 16], [12, 18], [13, 20]],
  // 统计数字。
  numeric: [[20, 28], [24, 32], [28, 36]],
  // 指标块里的数值（genui Stats）：比标题大一档，比大数字小。
  'stat-value': [[14, 20], [16, 22], [20, 28]],
  // 图块（genui Tile）中间的大值：日期、比分、登机口。视觉稿是 22，按比例尺取 20（2026-10-27）。
  'tile-value': [[16, 22], [20, 28], [24, 32]],
} as const;

export const textSizes = {
  // 会话里消息的正文：Lead 回复的段落、列表和引用，你发的消息。行高 24（用户 2026-10-23 在界面上调出来的值）。
  'message-body': 14,
  // Lead 回复的结论句（第一段整段加粗）。行高和正文一样是 24，两者相邻时节奏一致。
  'message-lead': 16,
  ...(Object.fromEntries(Object.entries(textSizesByDensity).map(([name, values]) => [name, values[1][0]])) as {
    [Name in keyof typeof textSizesByDensity]: typeof textSizesByDensity[Name][1][0];
  }),
} as const;

// 语义字号自带的行高（标准档，像素）。Text 用 size="card-title" 时自动给出。
// message-* 的行高是用户定的固定值，不随密度和外观偏好的行高档位变。
export const textLeading = {
  ...(Object.fromEntries(
    Object.entries(textSizesByDensity).map(([name, values]) => [name, values[1][1]]),
  ) as { [Name in keyof typeof textSizesByDensity]: typeof textSizesByDensity[Name][1][1] }),
  'message-body': 24,
  'message-lead': 24,
} as const;

export type FontSizeToken = keyof typeof fontSizes | keyof typeof textSizes;

// 字重对应已加载的字体文件。web 和原生都按文件名选字体，不依赖 fontWeight 合成粗体。
export const fontFaces = {
  regular: 'JakartaRegular',
  italic: 'JakartaItalic',
  medium: 'JakartaMedium',
  semibold: 'JakartaSemiBold',
  bold: 'JakartaBold',
  'bold-italic': 'JakartaBoldItalic',
  extrabold: 'JakartaExtraBold',
  'mono-medium': 'JetBrainsMonoMedium',
  'mono-semibold': 'JetBrainsMonoSemiBold',
  'mono-bold': 'JetBrainsMonoBold',
} as const;

export type FontFace = keyof typeof fontFaces;

// 每个字体文件的真实字重。web 上 CSS 的 font-weight 用它，回退的中文字体才按同样的字重显示
// （2026-10-17，见 theme/config.ts）。原生上不用。
export const fontFaceWeights: Record<FontFace, '400' | '500' | '600' | '700' | '800'> = {
  regular: '400',
  italic: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  'bold-italic': '700',
  extrabold: '800',
  'mono-medium': '500',
  'mono-semibold': '600',
  'mono-bold': '700',
};

// 断点（最小宽度）。desktop 是工作台三栏布局的阈值。
export const breakpoints = {
  tablet: 768,
  desktop: 1100,
  wide: 1440,
} as const;

export const zIndex = {
  0: 0,
  1: 1,
  overlay: 20,
  modal: 100,
} as const;
