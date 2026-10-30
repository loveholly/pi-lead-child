import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { redactSecretText } from "./redaction.ts";
import { TICKET_ACTION_INPUT_SCHEMAS } from "./ticket-actions.ts";
import { UI_ACTION_INPUT_SCHEMAS, UI_ACTION_TARGET_TYPES, isUiActionTargetType, type UiActionTargetType } from "./ui-actions.ts";
import { UserActionRequestSchema, userActionProblems } from "./user-actions.ts";

// Lead 生成的富交互卡片（generative UI，2026-10-15 用户决定，.scratch/generative-ui/spec.md）。
//
// Lead 用 render_ui 工具发出一块 surface：一组节点（组件实例），节点只能是下面组件目录里登记过的组件，
// props 必须符合各自的 schema。发出的是数据，不是代码：不能带 HTML、脚本、样式或外部链接。
// 服务端（Lead 工具）和客户端用同一个 validateUiSurface 校验。不合格的 surface 不渲染半截，
// 客户端改为显示 fallbackText，Lead 收到带路径的错误。
//
// 线上：surface 跟在 render_ui 的 lead.tool.updated 事件里（payload.surface），客户端要在连接上
// 声明 include=ui_surfaces 才会收到（事件类型表本身不变，见 index.ts 的 gatewayEventOptIn）。
// 刷新时 GET /v1/conversation/turns?include=surfaces 每一轮带上 surfaces（foldTurnSurfaces 折叠同一批事件）。
//
// 事实不抄进 surface：工单和决策用编号引用（TicketRef.ticket、DataTable 的 { ticket } 格子、ChoiceGroup.decision），
// 客户端渲染时从 TicketSummary 和决策请求实时读取，旧卡片不会显示过期的状态。
// Stats、Steps、Progress、Timeline、BarChart 里的数字和状态是画卡时的快照，用于外部数据和 Lead 自己的计划。

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const UI_CATALOG_VERSION = 1;

export const UI_SURFACE_LIMITS = {
  nodes: 64,
  depth: 6,
  bytes: 16 * 1024,
  text: 2_000,
} as const;

const IdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
const ToneSchema = Type.Union([
  Type.Literal("neutral"), Type.Literal("info"), Type.Literal("success"), Type.Literal("warning"), Type.Literal("danger"),
]);
export type UiTone = Static<typeof ToneSchema>;

export const UiFactStatusSchema = Type.Union([
  Type.Literal("reproduced"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("info"),
]);

const ChoiceSchema = StrictObject({
  id: Type.String({ pattern: "^[a-z0-9_-]{1,40}$" }),
  label: Type.String({ minLength: 1, maxLength: 60 }),
  consequence: Type.Optional(Type.String({ maxLength: 200 })),
});

// 展示信息的组件（目录 v2）里，一个节点最多放多少项。整张卡还受 UI_SURFACE_LIMITS 的 16 KB 限制。
export const UI_COMPONENT_LIMITS = {
  tableColumns: 8,
  tableRows: 50,
  stats: 6,
  steps: 20,
  timeline: 30,
  bars: 24,
  // v3 积木（2026-10-27）。
  tileEyebrow: 12,
  tileValue: 8,
  tileCaption: 24,
  // 小标题和说明在图块里只占一行，图块的宽度固定（sm、md 两档）。按显示宽度算：汉字算 2，其他字符算 1.2。
  // 2026-10-27 评测：sm 图块的「周二 10-27」（11.2）显示成「周二 10-…」；md 的说明「主队领先 3 分」（13.6）放得下。
  // 上限按图块的宽度和字号算：小标题 12 号，sm 9、md 13；说明 11 号，sm 10、md 15。
  tileEyebrowWidth: { sm: 9, md: 13 },
  tileCaptionWidth: { sm: 10, md: 15 },
  tilesPerCard: 4,
  segments: 8,
  messageShow: 5,
  messagesPerCard: 1,
  // 同类合并（Group，2026-10-28 用户定）：一张卡最多 3 组，每组点开是各自的浮层。
  groupsPerCard: 3,
  groupLabel: 40,
  groupTag: 12,
} as const;

// 强调等级：只改颜色和字重，不改尺寸（v3 第 3 节）。具体怎么画由主题决定。
const EmphasisSchema = Type.Union([Type.Literal("quiet"), Type.Literal("normal"), Type.Literal("strong")]);
export type UiEmphasis = Static<typeof EmphasisSchema>;

// 状态绑定（v3 积木 3，2026-10-27）：色调和文字从这张工单的当前状态实时取，不写死快照。
//   stage     现在的状态：色调和状态词由 App 统一映射（和工单卡、收件箱同一种说法），Lead 不写映射。
//   remindAt  提醒的时刻：clock 写时:分，date 写「周四 10-29 14:00」，remaining 写「还有 3 天 1 小时」（缺省）。
//             Tile 绑定它、format 是 date 时，图块是一页日历：小标题写月份，大值写日期。
// 取不到时显示 Lead 写的快照文字（Text 的 text、Tile 的 caption），没有快照时显示同宽的占位。
export const UI_BINDING_FIELDS = ["stage", "remindAt"] as const;
const BindingSchema = StrictObject({
  ticket: Type.Integer({ minimum: 1 }),
  field: Type.Union(UI_BINDING_FIELDS.map((field) => Type.Literal(field))),
  format: Type.Optional(Type.Union([
    Type.Literal("status"), Type.Literal("clock"), Type.Literal("date"), Type.Literal("remaining"),
  ])),
});
export type UiBinding = Static<typeof BindingSchema>;

// 时间选项的写法（Field 的 datetime，v3 积木 6）：按下时由客户端按本地时区换算成具体时刻，旧卡片的选项不会过期。
//   ISO 时刻              2026-10-29T14:00:00+08:00
//   多久以后              +30m、+2h、+1d、+3h30m
//   几天以后的某个时刻    +1d 09:00（明天 09:00）
//   下一个星期几的某个时刻 mon 09:00（下周一 09:00；今天是周一时是下周的周一）
const DATETIME_PRESET = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})|\+\d{1,3}[mhd]|\+\d{1,3}h\d{1,2}m|\+\d{1,2}d [0-2]\d:[0-5]\d|(?:mon|tue|wed|thu|fri|sat|sun) [0-2]\d:[0-5]\d)$/;
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** 一个时间选项现在对应的时刻（ISO）。写法不对时为 null。 */
export function resolveDatetimePreset(value: string, now: Date = new Date()): string | null {
  if (!DATETIME_PRESET.test(value)) return null;
  if (/^\d{4}-/.test(value)) {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  }
  const mixed = /^\+(\d+)h(\d+)m$/.exec(value);
  if (mixed) return new Date(now.getTime() + Number(mixed[1]) * 3_600_000 + Number(mixed[2]) * 60_000).toISOString();
  const relative = /^\+(\d+)([mhd])$/.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"];
    return new Date(now.getTime() + amount * unit).toISOString();
  }
  const [day, clock] = value.split(" ") as [string, string];
  const [hours, minutes] = clock.split(":").map(Number) as [number, number];
  if (hours > 23) return null;
  const at = new Date(now);
  at.setSeconds(0, 0);
  if (day.startsWith("+")) {
    at.setDate(at.getDate() + Number(day.slice(1, -1)));
  } else {
    const target = WEEKDAYS.indexOf(day as typeof WEEKDAYS[number]);
    const ahead = (target - at.getDay() + 7) % 7 || 7;
    at.setDate(at.getDate() + ahead);
  }
  at.setHours(hours, minutes);
  return at.toISOString();
}

// 事项（模式组件）前导图块的参数：和 Tile 一样（v3 积木 1）。
const ItemLeadSchema = StrictObject({
  eyebrow: Type.Optional(Type.String({ minLength: 1, maxLength: 12 })),
  value: Type.Union([Type.Number(), Type.String({ minLength: 1, maxLength: 8 })]),
  caption: Type.Optional(Type.String({ minLength: 1, maxLength: 24 })),
  tone: Type.Optional(ToneSchema),
  size: Type.Optional(Type.Union([Type.Literal("sm"), Type.Literal("md")])),
  emphasis: Type.Optional(EmphasisSchema),
  bind: Type.Optional(BindingSchema),
});

// 卡片上的按钮引用的对象：工单（编号是数字），或者操作层里工单以外的目标（ui-actions.ts，编号是字符串）。
const ActionTargetSchema = Type.Union([
  StrictObject({ type: Type.Literal("ticket"), id: Type.Integer({ minimum: 1 }) }),
  StrictObject({ type: Type.Union(UI_ACTION_TARGET_TYPES.map((type) => Type.Literal(type))), id: Type.String({ minLength: 1, maxLength: 64 }) }),
]);
// 写成显式的类型：从 Union(…map(Literal)) 推出来的类型丢了字面量（只剩 "ticket"）。
export type UiActionButtonTarget = { type: "ticket"; id: number } | { type: UiActionTargetType; id: string };

const AlignSchema = Type.Union([Type.Literal("left"), Type.Literal("center"), Type.Literal("right")]);

// 表格的一格：文字、数字、工单引用，或者带色调的标签。
// 工单只写编号，编号、标题和状态在客户端从 TicketSummary 实时读取，不抄进格子里。
// 标签用于外部系统的状态（例如 CI 通过、服务异常），这些不是账本里的事实。
const TableCellSchema = Type.Union([
  Type.String({ maxLength: 200 }),
  Type.Number(),
  StrictObject({ ticket: Type.Integer({ minimum: 1 }) }),
  StrictObject({ badge: Type.String({ minLength: 1, maxLength: 40 }), tone: Type.Optional(ToneSchema) }),
]);
export type UiTableCell = Static<typeof TableCellSchema>;

const StepStateSchema = Type.Union([
  Type.Literal("done"), Type.Literal("current"), Type.Literal("pending"), Type.Literal("failed"), Type.Literal("skipped"),
]);
export type UiStepState = Static<typeof StepStateSchema>;

// 组件目录。容器（Stack、Section）可以有 children，其余都是叶子。
// v2（2026-10-19 用户决定）追加了展示信息的组件：DataTable、Stats、Steps、Progress、Timeline、BarChart。
// 只追加组件，UI_CATALOG_VERSION 不变：validateUiSurface 要求版本相等，改版本会让旧客户端拒绝所有卡片。
// 旧客户端遇到不认识的组件时，整张卡显示 fallbackText。
export const UI_CATALOG = {
  Stack: {
    container: true,
    props: StrictObject({
      direction: Type.Optional(Type.Union([Type.Literal("row"), Type.Literal("column")])),
      gap: Type.Optional(Type.Union([Type.Literal("sm"), Type.Literal("md"), Type.Literal("lg")])),
    }),
  },
  Section: {
    container: true,
    props: StrictObject({
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      tone: Type.Optional(ToneSchema),
    }),
  },
  Text: {
    container: false,
    props: StrictObject({
      text: Type.String({ minLength: 1, maxLength: UI_SURFACE_LIMITS.text }),
      variant: Type.Optional(Type.Union([Type.Literal("body"), Type.Literal("caption"), Type.Literal("title")])),
      tone: Type.Optional(ToneSchema),
      // 实时的文字（v3 积木 3）：取到时代替 text；text 是取不到时显示的快照。
      bind: Type.Optional(BindingSchema),
    }),
  },
  Badge: {
    container: false,
    props: StrictObject({
      text: Type.String({ minLength: 1, maxLength: 40 }),
      tone: Type.Optional(ToneSchema),
    }),
  },
  FactList: {
    container: false,
    props: StrictObject({
      items: Type.Array(StrictObject({
        label: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
        text: Type.String({ minLength: 1, maxLength: 500 }),
        status: Type.Optional(UiFactStatusSchema),
      }), { minItems: 1, maxItems: 20 }),
    }),
  },
  // 紧凑的工单头：编号、标题、状态都从 TicketSummary 实时读取，可以点开工单。
  TicketRef: {
    container: false,
    props: StrictObject({ ticket: Type.Integer({ minimum: 1 }) }),
  },
  // 让用户做决定：选项、每个选项的后果、Lead 的推荐。服务端在 surface 定稿时为它建一条决策请求，
  // 把编号写进 decision；用户的选择走现有的决策请求接口（授权照常），之后叫醒 Lead 去执行。
  ChoiceGroup: {
    container: false,
    props: StrictObject({
      ticket: Type.Integer({ minimum: 1 }),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      choices: Type.Array(ChoiceSchema, { minItems: 1, maxItems: 6 }),
      recommendation: Type.Optional(StrictObject({
        choiceId: Type.String({ minLength: 1 }),
        reason: Type.String({ minLength: 1, maxLength: 300 }),
      })),
      decision: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  },
  // 请用户连接一个第三方账号（或者重新授权）。服务名、状态和按钮都从 /v1/connections 实时读取，
  // 按钮走和设置页一样的连接流程。reason 是 Lead 写的一句话：为什么要连。
  ConnectionConnect: {
    container: false,
    props: StrictObject({
      connection: Type.String({ pattern: "^[a-z][a-z0-9-]{0,39}$" }),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }),
  },
  // 一次写入外部账号的确认。内容（要写什么、参数、状态）从 /v1/connections/confirmations/:id 实时读取；
  // 「允许」走那条只有用户能按到的路由，daemon 执行存下的那一次调用。
  ConnectionConfirm: {
    container: false,
    props: StrictObject({
      confirmation: Type.String({ pattern: "^cfm_[A-Za-z0-9_-]{8,40}$" }),
    }),
  },
  // 一次记忆切换的确认（例如换 embedding 要重建索引）。内容和状态从 GET /v1/memory 的 pendingSwitch 实时读取；
  // 「切换 / 先不」走 POST /v1/memory/switches/:id/confirm，那条路由只有用户能按到。
  MemorySwitchConfirm: {
    container: false,
    props: StrictObject({
      switch: Type.String({ pattern: "^msw_[A-Za-z0-9_-]{8,40}$" }),
    }),
  },
  // 引用工单正文或一条 checkpoint 的原文（2026-10-19）。Lead 转述子 agent 的报告时编造过不存在的文件，
  // 所以转述改成引用：Lead 只给位置（工单、正文还是 checkpoint、哪一节或者包含哪句话），服务端（render_ui）从账本取原文，
  // 写进 text、label 和 truncated。Lead 自己填的 text 会被覆盖。客户端照原样显示 text，写出出处，可以点开工单。
  SourceQuote: {
    container: false,
    props: StrictObject({
      ticket: Type.Integer({ minimum: 1 }),
      source: Type.Union([Type.Literal("body"), Type.Literal("checkpoint")]),
      checkpoint: Type.Optional(Type.Integer({ minimum: 1 })),
      // 从包含这段文字的那一行开始的一节（例如「【独立核查报告】」）。
      heading: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      // 包含这段原文的那一段。必须逐字出现在原文里。
      contains: Type.Optional(Type.String({ minLength: 2, maxLength: 300 })),
      // 以下由服务端填。
      text: Type.Optional(Type.String({ minLength: 1, maxLength: UI_SURFACE_LIMITS.text })),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      truncated: Type.Optional(Type.Boolean()),
    }),
  },
  // Lead 提议的一次常设指令修改（更放开的那一档，工单 10）。内容和状态从 GET /v1/standing-order-proposals/:approval
  // 实时读取；「批准 / 不批准」走 POST /v1/standing-order-proposals/:approval/decision，那条路由只有用户能按到。
  StandingOrderChangeConfirm: {
    container: false,
    props: StrictObject({
      approval: Type.Integer({ minimum: 1 }),
    }),
  },
  // 表格：多维对比、状态总览。每一行的格数和 columns 一样。
  DataTable: {
    container: false,
    props: StrictObject({
      columns: Type.Array(StrictObject({
        label: Type.String({ minLength: 1, maxLength: 40 }),
        align: Type.Optional(AlignSchema),
      }), { minItems: 1, maxItems: UI_COMPONENT_LIMITS.tableColumns }),
      rows: Type.Array(
        Type.Array(TableCellSchema, { maxItems: UI_COMPONENT_LIMITS.tableColumns }),
        { minItems: 1, maxItems: UI_COMPONENT_LIMITS.tableRows },
      ),
    }),
  },
  // 一组数字指标块：标签、数值、单位，以及和以前比的变化（tone 给变化上色）。画卡时的快照。
  Stats: {
    container: false,
    props: StrictObject({
      items: Type.Array(StrictObject({
        label: Type.String({ minLength: 1, maxLength: 40 }),
        value: Type.Union([Type.Number(), Type.String({ minLength: 1, maxLength: 24 })]),
        unit: Type.Optional(Type.String({ minLength: 1, maxLength: 12 })),
        change: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
        tone: Type.Optional(ToneSchema),
      }), { minItems: 1, maxItems: UI_COMPONENT_LIMITS.stats }),
    }),
  },
  // 计划或流程的步骤，每步一个状态。画卡时的快照。
  Steps: {
    container: false,
    props: StrictObject({
      items: Type.Array(StrictObject({
        label: Type.String({ minLength: 1, maxLength: 120 }),
        state: StepStateSchema,
        detail: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      }), { minItems: 1, maxItems: UI_COMPONENT_LIMITS.steps }),
    }),
  },
  // 单个进度条。value 是 0 到 1；不给 value 表示进度未知。画卡时的快照。
  Progress: {
    container: false,
    props: StrictObject({
      label: Type.String({ minLength: 1, maxLength: 120 }),
      value: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      caption: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      tone: Type.Optional(ToneSchema),
    }),
  },
  // 按时间排的事件。at 是显示用的短文字，例如「10-19 09:58」。
  Timeline: {
    container: false,
    props: StrictObject({
      items: Type.Array(StrictObject({
        at: Type.String({ minLength: 1, maxLength: 40 }),
        text: Type.String({ minLength: 1, maxLength: 500 }),
        tone: Type.Optional(ToneSchema),
      }), { minItems: 1, maxItems: UI_COMPONENT_LIMITS.timeline }),
    }),
  },
  // 条形图，用 View 画，不需要图表库。horizontal（默认）比较类别；vertical 按时间看趋势。
  // max 是满格的值，缺省用最大的那根。
  BarChart: {
    container: false,
    props: StrictObject({
      bars: Type.Array(StrictObject({
        label: Type.String({ minLength: 1, maxLength: 40 }),
        value: Type.Number({ minimum: 0 }),
        tone: Type.Optional(ToneSchema),
      }), { minItems: 1, maxItems: UI_COMPONENT_LIMITS.bars }),
      unit: Type.Optional(Type.String({ minLength: 1, maxLength: 12 })),
      orientation: Type.Optional(Type.Union([Type.Literal("horizontal"), Type.Literal("vertical")])),
      max: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    }),
  },
  // v3 积木（2026-10-27，.scratch/genui-catalog-v3/spec.md 积木 1、2、7、10）。
  // 图块：上面一条小标题，中间一个大的短值，下面一行说明（日期、比分、登机口、版本号）。
  // 宽和高只由 size 和主题决定，不随 value 变：value 太长就校验失败，不截断。
  Tile: {
    container: false,
    props: StrictObject({
      eyebrow: Type.Optional(Type.String({ minLength: 1, maxLength: UI_COMPONENT_LIMITS.tileEyebrow })),
      value: Type.Union([Type.Number(), Type.String({ minLength: 1, maxLength: UI_COMPONENT_LIMITS.tileValue })]),
      caption: Type.Optional(Type.String({ minLength: 1, maxLength: UI_COMPONENT_LIMITS.tileCaption })),
      tone: Type.Optional(ToneSchema),
      size: Type.Optional(Type.Union([Type.Literal("sm"), Type.Literal("md")])),
      emphasis: Type.Optional(EmphasisSchema),
      // 色调跟着这张工单现在的状态（优先于 tone）；绑定的是时间字段时，说明那一行也实时写这个时间。
      bind: Type.Optional(BindingSchema),
    }),
  },
  // 前导 + 正文（媒体对象）：正好两个子节点，第一个是固定宽的前导（Tile 或 Badge），第二个撑满剩下的宽度。
  // attach：前导贴着卡片的边，前导和正文之间怎么分隔由主题画。
  Media: {
    container: true,
    props: StrictObject({
      attach: Type.Optional(Type.Boolean()),
      align: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("center")])),
    }),
  },
  // 一排小格：每格一个标签和一个色调（几项检查、几个服务、几个环境）。summary 是跟在后面的一句话。
  Segments: {
    container: false,
    props: StrictObject({
      items: Type.Array(StrictObject({
        label: Type.String({ minLength: 1, maxLength: 12 }),
        tone: Type.Optional(ToneSchema),
      }), { minItems: 1, maxItems: UI_COMPONENT_LIMITS.segments }),
      summary: Type.Optional(Type.String({ minLength: 1, maxLength: 24 })),
    }),
  },
  // 引用别人说的话：别人的话只能引用，不能手写。Lead 只给外部消息卡的编号，服务端（render_ui）从这张卡的对话里取原文，
  // 写进 sender、messages 和 total；Lead 自己写的会被覆盖。latest 只露出最新一条（一行），stack 叠出最近 show 条。
  Message: {
    container: false,
    props: StrictObject({
      ref: StrictObject({ type: Type.Literal("channel_card"), id: Type.Integer({ minimum: 1 }) }),
      mode: Type.Union([Type.Literal("latest"), Type.Literal("stack")]),
      show: Type.Optional(Type.Integer({ minimum: 1, maximum: UI_COMPONENT_LIMITS.messageShow })),
      // 以下由服务端填。
      sender: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      messages: Type.Optional(Type.Array(StrictObject({
        at: Type.String({ minLength: 1, maxLength: 40 }),
        text: Type.String({ minLength: 1, maxLength: UI_SURFACE_LIMITS.text }),
      }), { maxItems: UI_COMPONENT_LIMITS.messageShow })),
      total: Type.Optional(Type.Integer({ minimum: 0 })),
    }),
  },
  // 对象组件（三层的最上层，2026-10-27，.scratch/genui-catalog-v3/three-layers.md）：账本里的一个对象，只给编号。
  // 内容、状态和能做的操作都由 App 实时取，画成和系统卡同一张卡。Lead 写不了里面的字（P8.3）。
  // 一条提醒：票根（日期、标题、剩余时间），点开改时间、取消。
  Reminder: {
    container: false,
    props: StrictObject({ reminder: Type.Integer({ minimum: 1 }) }),
  },
  // 一张外部消息卡（Slack 等，工单 11）：对方说的话、Fairy 的建议、能做的操作，和会话里那张同一张。
  ChannelCard: {
    container: false,
    props: StrictObject({ card: Type.Integer({ minimum: 1 }) }),
  },
  // 一条介入请求：child 要你审批的一步（approval），或者要你回答的一个决定（decision，决策请求）。
  // 审批的三个按钮、决定的选项都由 App 按这条请求现在的状态画；处理过的收成一行结束行。
  Intervention: {
    container: false,
    props: StrictObject({
      kind: Type.Union([Type.Literal("approval"), Type.Literal("decision")]),
      id: Type.Integer({ minimum: 1 }),
      // 以下由服务端填：请求属于哪张工单，和 child 写这一步时的检查点（卡片头部写 child 自己的话）。
      ticket: Type.Optional(Type.Integer({ minimum: 1 })),
      checkpoint: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  },
  // 模式组件「事项」（三层的中间层，patterns.md P9.5）：一件事，前导是一个短值的图块，正文是标题和一行说明（或者一句话）。
  // attach 时图块贴着卡片的边（票根）。children 里的 Action（最多 1 个）放在右边；别的 children 是点开以后才看的细节，
  // 这时卡片可以点，从原位置撑开成浮层（和 Disclosure 一样）。航班、比分、发布、一组待办都是它，不按业务分组件。
  Item: {
    container: true,
    props: StrictObject({
      lead: ItemLeadSchema,
      attach: Type.Optional(Type.Boolean()),
      title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      meta: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
      // 说明那一行实时读（例如剩余时间）；取不到时用 meta。
      metaBind: Type.Optional(BindingSchema),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
    }),
  },
  // 收起和展开（v3 积木 4）：children 里不在 detail 的是收起态，留在会话列表里，高度固定（lines 行）；
  // 点一下从原位置撑开成浮层（AnchoredPanel），detail 的子节点在浮层里。会话列表不变高。label 是给读屏的浮层名字。
  Disclosure: {
    container: true,
    props: StrictObject({
      label: Type.String({ minLength: 1, maxLength: 60 }),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      detail: Type.Array(IdSchema, { maxItems: UI_SURFACE_LIMITS.nodes }),
    }),
  },
  // 卡片上的一个按钮（v3 积木 5）：做操作层里登记过的一个操作，和页面上的同一个按钮、Lead 的工具是同一个函数。
  // 能不能按由那个函数判断（不能时按钮变灰、写原因，不消失）；用户按下时 actor 是用户本人。
  Action: {
    container: false,
    props: StrictObject({
      target: ActionTargetSchema,
      action: Type.String({ minLength: 1, maxLength: 40 }),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
      role: Type.Union([Type.Literal("primary"), Type.Literal("default"), Type.Literal("quiet")]),
    }),
  },
  // 给一个 Action 的一个参数提供输入（v3 积木 6）：几个常用选项，加一个自由输入。只能放在 Disclosure 的展开态里。
  // datetime 的选项按 resolveDatetimePreset 的写法写，按下时才换算成时刻。
  Field: {
    container: false,
    props: StrictObject({
      for: IdSchema,
      param: Type.String({ minLength: 1, maxLength: 40 }),
      kind: Type.Union([Type.Literal("datetime"), Type.Literal("choice")]),
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 20 })),
      presets: Type.Array(StrictObject({
        label: Type.String({ minLength: 1, maxLength: 12 }),
        value: Type.String({ minLength: 1, maxLength: 64 }),
      }), { minItems: 1, maxItems: 6 }),
      freeInput: Type.Optional(Type.Boolean()),
    }),
  },
  // 请用户做一件事（通用，2026-10-19，user-actions.ts）。action 是系统给的「需要用户做什么」：工具的返回、事件、
  // 当前局面里都有，Lead 原样放进来。客户端按 action.kind 画控件，控件只走 action.target 这个对象自己的路由
  // （授权走连接流程，写入确认走那一次确认，选择和审批去「待你」，验收打开工单，改规则的确认走那一张确认卡）。不按服务写特例。
  UserAction: {
    container: false,
    props: StrictObject({
      action: UserActionRequestSchema,
    }),
  },
  // 同类合并（2026-10-28，改版稿第 2 版第 5 组）：几件同类的事收成一行「标签 · 做了什么 · N 件」，
  // 点开从原位置撑开成浮层，children 一件一行。件数由客户端数 children，Lead 不写数字。
  Group: {
    container: true,
    props: StrictObject({
      label: Type.String({ minLength: 1, maxLength: UI_COMPONENT_LIMITS.groupLabel }),
      tag: Type.Optional(Type.String({ minLength: 1, maxLength: UI_COMPONENT_LIMITS.groupTag })),
      tone: Type.Optional(Type.Union([Type.Literal("neutral"), Type.Literal("warning")])),
    }),
  },
} as const satisfies Record<string, { container: boolean; props: TSchema }>;

export type UiComponentType = keyof typeof UI_CATALOG;
export const UI_COMPONENT_TYPES = Object.keys(UI_CATALOG) as UiComponentType[];

// 每个组件给 Lead 看的用法（render_ui 的说明由它拼出来，uiCatalogGuide）。以前说明是手写的，和目录对不上：
// 漏了 ConnectionConnect、ConnectionConfirm、MemorySwitchConfirm（2026-10-19 审查）。新组件只在这里写一次。
export const UI_CATALOG_USAGE: Readonly<Record<UiComponentType, string>> = {
  Stack: "Stack { direction?: row|column, gap?: sm|md|lg }：排版容器，可以有 children",
  Section: "Section { title?, tone? }：带标题的一组，可以有 children",
  Text: "Text { text, variant?: body|caption|title, tone?, bind? }：bind 见 Tile；给了 bind 时 text 是取不到实时值时的快照",
  Badge: "Badge { text, tone? }",
  FactList: "FactList { items: [{ label?, text, status?: reproduced|passed|failed|info }] }",
  TicketRef: "TicketRef { ticket }：紧凑的工单头，状态实时读取，用户点它打开工单",
  ChoiceGroup: "ChoiceGroup { ticket, prompt?, choices: [{ id, label, consequence? }], recommendation?: { choiceId, reason } }："
    + "请用户在你给的几个选项里选一个。系统建一条决策请求，用户选完会叫醒你",
  ConnectionConnect: "ConnectionConnect { connection, reason? }：请用户连接或重新授权一个账号（connection 是连接的 key）",
  ConnectionConfirm: "ConnectionConfirm { confirmation }：一次写入外部账号的确认（call_connection_tool 给的 confirmation_id）",
  MemorySwitchConfirm: "MemorySwitchConfirm { switch }：一次记忆切换的确认",
  StandingOrderChangeConfirm: "StandingOrderChangeConfirm { approval }：你提议的常设指令修改（propose_standing_order_change 给的 approval_id），"
    + "只有用户能按批准",
  SourceQuote: "SourceQuote { ticket, source: body|checkpoint, checkpoint?, heading?, contains? }：引用工单正文或一条 checkpoint 的原文。"
    + "你只给位置，系统从账本取原文显示（你写的 text 会被换掉）。heading 取从含这段文字的那一行开始的一节（例如「【独立核查报告】」），"
    + "contains 取包含这句原话的那一段（要逐字抄）。转述子 agent 的报告、核查结论、checkpoint 时用它，不要重新打一遍",
  DataTable: `DataTable { columns: [{ label, align?: left|center|right }], rows: [[格子, …]] }：表格，最多 ${UI_COMPONENT_LIMITS.tableColumns} 列、`
    + `${UI_COMPONENT_LIMITS.tableRows} 行，每行的格数和 columns 一样。格子是文字、数字、{ ticket }（工单编号，实时显示标题和状态）`
    + "或 { badge, tone? }（外部系统的状态，例如 CI 通过）。数字列自动右对齐",
  Stats: `Stats { items: [{ label, value, unit?, change?, tone? }] }：一组数字指标块，最多 ${UI_COMPONENT_LIMITS.stats} 个；`
    + "change 写和以前比的变化，tone 给 change 上色",
  Steps: `Steps { items: [{ label, state: done|current|pending|failed|skipped, detail? }] }：步骤，最多 ${UI_COMPONENT_LIMITS.steps} 步`,
  Progress: "Progress { label, value?: 0 到 1, caption?, tone? }：进度条；不知道进度时不给 value",
  Timeline: `Timeline { items: [{ at, text, tone? }] }：按时间排的事件，最多 ${UI_COMPONENT_LIMITS.timeline} 条；at 是短的时间文字，例如 10-19 09:58`,
  BarChart: `BarChart { bars: [{ label, value, tone? }], unit?, orientation?: horizontal|vertical, max? }：条形图，最多 ${UI_COMPONENT_LIMITS.bars} 根，`
    + "value 不小于 0。horizontal（默认）比较类别，vertical 按时间看趋势；max 是满格的值，缺省用最大的那根",
  Tile: `Tile { eyebrow?, value, caption?, tone?, size?: sm|md, emphasis?: quiet|normal|strong }：一个短值的图块，`
    + `上面一条小标题（最多 ${UI_COMPONENT_LIMITS.tileEyebrow} 字），中间一个大值（数字或最多 ${UI_COMPONENT_LIMITS.tileValue} 字），`
    + `下面一行说明。小标题和说明都只占一行：汉字算 2、其他算 1.2，小标题 sm 最多 ${UI_COMPONENT_LIMITS.tileEyebrowWidth.sm}、md 最多 ${UI_COMPONENT_LIMITS.tileEyebrowWidth.md}，`
    + `说明 sm 最多 ${UI_COMPONENT_LIMITS.tileCaptionWidth.sm}、md 最多 ${UI_COMPONENT_LIMITS.tileCaptionWidth.md}。一张卡最多 ${UI_COMPONENT_LIMITS.tilesPerCard} 个。`
    + "适合「一个短值 + 一段说明」的信息：日期、比分、登机口、版本号、倒数。"
    + "bind { ticket, field: stage|remindAt, format?: status|clock|date|remaining }：色调跟着这张工单现在的状态，"
    + "field 是 remindAt 时说明行实时写这个时间（remaining 是「还有 3 天 1 小时」）；format 是 date 时图块是一页日历，小标题写月份、大值写日期，改了时间跟着变",
  Media: "Media { attach?, align?: start|center }：正好两个子节点，左边是固定宽的前导（Tile 或 Badge），右边是正文（通常是 Stack）。"
    + "attach 让前导贴着卡片的边，像一张票根",
  Segments: `Segments { items: [{ label, tone? }], summary? }：一排小格，每格一个结果，最多 ${UI_COMPONENT_LIMITS.segments} 格。`
    + "几项检查、几个服务、几个环境各自的结果用它；一个比例用 Progress",
  Message: `Message { ref: { type: channel_card, id }, mode: latest|stack, show? }：引用别人在外部通道里说的话（外部消息卡的编号）。`
    + "你只给编号，系统从这张卡的对话里取原文、发信人和时间显示，你写的原文会被换掉。latest 只露出最新一条，"
    + `stack 叠出最近 show 条（最多 ${UI_COMPONENT_LIMITS.messageShow}）。一张卡最多 1 个。转述别人的话时用它，不要重新打一遍`,
  Reminder: "Reminder { reminder }：账本里的一条提醒（create_reminder 给的编号）。你只给编号，App 画整张提醒卡："
    + "日期、标题、剩余时间，点开能改时间、取消，状态实时变。卡片只讲这一条提醒时，根节点就是它，不用再拼",
  ChannelCard: "ChannelCard { card }：一张外部消息卡（消息事件和 read_channel_conversation 里写的卡号）。你只给编号，App 画整张卡："
    + "对方的话、你的建议回复、信心和能做的操作，和会话里那张是同一张，状态实时变。讲某条外部消息时用它，"
    + "不要用 Message 和 Text 自己拼；只想引用对方说的一两句、放进别的卡里时才用 Message。"
    + "你建议了回复时，用 notify_user 带上这条消息事件和你写的草稿，草稿放到卡上，卡上就是你的建议",
  Intervention: "Intervention { kind: approval|decision, id }：一条介入请求。approval 是 list_approvals 里的审批编号，"
    + "decision 是决策请求的编号。你只给编号，App 画整张卡：child 要做什么、命令原文、审批的三个按钮或者决定的选项；"
    + "处理过的收成一行。讲某个审批或决定时用它，不要自己画按钮；要你自己出题让用户选时才用 ChoiceGroup",
  Item: "Item { lead: { eyebrow?, value, caption?, tone?, size?, emphasis?, bind? }, attach?, title?, text?, meta?, metaBind?, label? }："
    + "一件事：左边一个短值的图块（参数和 Tile 一样），右边是 title（一行标题）加 meta（一行灰字说明），或者 text（一句话）。"
    + "attach 让图块贴着卡片的边，像一张票根（只讲这一件事时用）。children 里放一个 Action 就是右边的按钮；"
    + "别的 children 是点开以后才看的细节（例如一张 DataTable），卡片会变成可以点开的。"
    + "航班、比分、发布、日程、一组待办这类「一件事 + 一个关键短值」都用它，不要用 Media 和 Tile 自己拼",
  Disclosure: "Disclosure { label, lines?: 1-4, detail: [子节点 id] }：收起和展开。children 里不在 detail 的是收起态（留在会话里，最多 lines 行），"
    + "用户点一下从原位置撑开成浮层，detail 的子节点在浮层里。一张卡最多 1 个，不能嵌套。低频的操作和细节放进 detail",
  Action: "Action { target: { type: ticket, id: 编号 } 或 { type: 目标类型, id: 字符串 }, action, input?, label?, role: primary|default|quiet }："
    + "卡片上的一个按钮，做 list_ticket_actions 或 list_actions 里的一个操作，用户按下时是用户本人做。一张卡最多 1 个 primary。"
    + "只属于用户本人去设置里点的操作（user_direct）不能做成按钮，用 UserAction",
  Field: "Field { for: Action 节点的 id, param, kind: datetime|choice, label?, presets: [{ label, value }], freeInput? }：给那个按钮的一个参数提供选项。"
    + "只能放在 Disclosure 的 detail 里。datetime 的 value 写 +30m、+2h、+1d 09:00（明天 09:00）、mon 09:00（下周一 09:00）或 ISO 时刻，"
    + "按下时才换算；freeInput 让用户自己填一个时刻",
  UserAction: "UserAction { action: { kind, target, title, reason } }：请用户做一件事。action 原样抄系统给你的 user_action"
    + "（工具结果、事件、当前局面里都有），不要自己编 target。kind 是 authorize（连接）、reauthorize（重新授权）、"
    + "confirm_write（确认写入）、choose（选择）、approve（审批）、accept（验收）、confirm_rule_change（放行一次被拦下的改规则操作）、"
    + "confirm_timer（外部的人要求设的定时器，请用户决定设不设）。"
    + "客户端按 kind 画按钮，按钮只做这一件事",
  Group: "Group { label, tag?, tone?: neutral|warning }：几件同类的事收成一行「标签 · 做了什么 · N 件」，点开是浮层，children 一件一行"
    + "（Item 或 Text）。件数由客户端数，label 里不要写数字。同一个对象上、结果一样的几件事用它；失败的、要用户处理的那几件不放进去，"
    + "单独写在组的前面。一张卡最多 3 个，不能嵌套，也不能放进 Disclosure；组里的 Item 不带细节",
};

// 用户能在卡片上直接点、做成一件事的组件。卡片要用户做事时，至少要有一个（render_ui 的检查）。
export const UI_ACTIONABLE_COMPONENTS: ReadonlySet<UiComponentType> = new Set<UiComponentType>([
  "ChoiceGroup", "ConnectionConnect", "ConnectionConfirm", "MemorySwitchConfirm", "StandingOrderChangeConfirm", "UserAction", "Action", "Reminder",
  "ChannelCard", "Intervention",
]);

/** 卡片上有没有用户能点、做成一件事的控件。 */
export function surfaceOffersUserControl(surface: Pick<UiSurface, "nodes">): boolean {
  return surface.nodes.some((node) => UI_ACTIONABLE_COMPONENTS.has(node.type as UiComponentType));
}

/** render_ui 说明里的组件清单：每个组件一行（UI_CATALOG_USAGE）。 */
export function uiCatalogGuide(): string {
  return UI_COMPONENT_TYPES.map((type) => `- ${UI_CATALOG_USAGE[type]}`).join("\n");
}

export const UiNodeSchema = StrictObject({
  id: IdSchema,
  type: Type.String({ minLength: 1, maxLength: 40 }),
  props: Type.Record(Type.String(), Type.Unknown()),
  children: Type.Optional(Type.Array(IdSchema, { maxItems: UI_SURFACE_LIMITS.nodes })),
});
export type UiNode = Static<typeof UiNodeSchema>;

export const UiSurfaceSchema = StrictObject({
  id: IdSchema,
  catalogVersion: Type.Integer({ minimum: 1 }),
  root: IdSchema,
  fallbackText: Type.String({ minLength: 1, maxLength: UI_SURFACE_LIMITS.text }),
  nodes: Type.Array(UiNodeSchema, { minItems: 1 }),
});
export type UiSurface = Static<typeof UiSurfaceSchema>;

// 一轮回复里的一块 surface：callId 是生成它的 render_ui 调用，textOffset 是那时这一轮已经说了多少字。
export const UiSurfacePlacementSchema = StrictObject({
  callId: Type.String({ minLength: 1 }),
  textOffset: Type.Integer({ minimum: 0 }),
  // 这一次调用还没有定稿版本，surface 是流式中途的版本。客户端据此让后面的流式版本替换它。
  partial: Type.Optional(Type.Literal(true)),
  surface: UiSurfaceSchema,
});
export type UiSurfacePlacement = Static<typeof UiSurfacePlacementSchema>;

// code 给客户端判断原因用，不用读 message 的文字（2026-10-20）：
//   unknown_component：组件目录里没有这个组件；newer_catalog：surface 的组件目录版本比这里的新。
export type UiSurfaceErrorCode = "unknown_component" | "newer_catalog";
export type UiSurfaceError = { path: string; message: string; code?: UiSurfaceErrorCode };
export type UiSurfaceValidation = { ok: true; surface: UiSurface } | { ok: false; errors: UiSurfaceError[] };

export function validateUiSurface(input: unknown): UiSurfaceValidation {
  const errors: UiSurfaceError[] = [];
  const fail = (path: string, message: string, code?: UiSurfaceErrorCode): UiSurfaceValidation =>
    ({ ok: false, errors: [...errors, { path, message, ...(code ? { code } : {}) }] });
  if (!Value.Check(UiSurfaceSchema, input)) return fail("/", "surface 的结构不对：要有 id、catalogVersion、root、fallbackText 和 nodes");
  const surface = input;
  if (surface.catalogVersion !== UI_CATALOG_VERSION) {
    return fail("/catalogVersion", `不认识组件目录版本 ${surface.catalogVersion}`, surface.catalogVersion > UI_CATALOG_VERSION ? "newer_catalog" : undefined);
  }
  if (new TextEncoder().encode(JSON.stringify(surface)).length > UI_SURFACE_LIMITS.bytes) {
    return fail("/", `surface 超过 ${UI_SURFACE_LIMITS.bytes} 字节`);
  }
  if (surface.nodes.length > UI_SURFACE_LIMITS.nodes) return fail("/nodes", `节点超过 ${UI_SURFACE_LIMITS.nodes} 个`);

  const byId = new Map<string, UiNode>();
  for (const [index, node] of surface.nodes.entries()) {
    if (byId.has(node.id)) return fail(`/nodes/${index}/id`, `节点 id 重复：${node.id}`);
    byId.set(node.id, node);
    const entry = (UI_CATALOG as Record<string, { container: boolean; props: TSchema }>)[node.type];
    if (!entry) return fail(`/nodes/${index}/type`, `组件目录里没有 ${node.type}（可用：${UI_COMPONENT_TYPES.join("、")}）`, "unknown_component");
    if (!Value.Check(entry.props, node.props)) {
      // 写出第一个不对的字段和原因（2026-10-27 评测：Lead 只收到「props 不符合目录」，不知道是 value 太长）。
      // 同一个字段的几条原因一起写（Union 的每一种写法各有一条，只写第一条会误导）。
      const found = [...Value.Errors(entry.props, node.props)] as Array<{ instancePath?: string; path?: string; message?: string }>;
      const where = found[0]?.instancePath ?? found[0]?.path ?? "";
      const reasons = [...new Set(found.filter((error) => (error.instancePath ?? error.path ?? "") === where).map((error) => error.message).filter(Boolean))].slice(0, 3);
      return fail(`/nodes/${index}/props`, `${node.type} 的 props 不符合目录：${where || "props"} ${reasons.join("，或者 ") || "多了、少了或类型不对"}`);
    }
    if (!entry.container && node.children?.length) return fail(`/nodes/${index}/children`, `${node.type} 不能有子节点`);
    const rule = propsRuleError(node);
    if (rule) return fail(`/nodes/${index}/props${rule.path}`, rule.message);
  }

  if (!byId.has(surface.root)) return fail("/root", `root 指向不存在的节点 ${surface.root}`);
  const reached = new Set<string>();
  const walk = (id: string, depth: number, path: readonly string[]): UiSurfaceValidation | null => {
    if (path.includes(id)) return fail("/nodes", `节点成环：${[...path, id].join(" → ")}`);
    if (depth > UI_SURFACE_LIMITS.depth) return fail("/nodes", `层级超过 ${UI_SURFACE_LIMITS.depth} 层`);
    const node = byId.get(id);
    if (!node) return fail("/nodes", `子节点 ${id} 不存在`);
    reached.add(id);
    for (const child of node.children ?? []) {
      const error = walk(child, depth + 1, [...path, id]);
      if (error) return error;
    }
    return null;
  };
  const graphError = walk(surface.root, 1, []);
  if (graphError) return graphError;
  const orphan = surface.nodes.find((node) => !reached.has(node.id));
  if (orphan) return fail("/nodes", `节点 ${orphan.id} 从 root 走不到`);
  const graph = graphRuleError(surface.nodes, byId);
  if (graph) return fail(graph.path, graph.message);
  return { ok: true, surface };
}

/**
 * 卡片不合格，是因为它用了比这里新的组件目录：有这里没有的组件，或者目录版本更新。
 * 客户端收到的卡都经过服务端校验，这时说明 App 比服务端旧，刷新到新版本后就能显示（2026-10-20）。
 */
export function surfaceNeedsNewerCatalog(result: UiSurfaceValidation): boolean {
  return !result.ok && result.errors.some((error) => error.code === "unknown_component" || error.code === "newer_catalog");
}

// 跨节点的规则（v3 积木）：Media 的两个子节点，每张卡里图块和引用的上限。path 相对于整张卡。
function graphRuleError(nodes: readonly UiNode[], byId: ReadonlyMap<string, UiNode>): UiSurfaceError | null {
  for (const [index, node] of nodes.entries()) {
    if (node.type !== "Media") continue;
    const children = node.children ?? [];
    if (children.length !== 2) return { path: `/nodes/${index}/children`, message: `Media 要正好两个子节点（前导、正文），现在是 ${children.length} 个` };
    const lead = byId.get(children[0]!);
    if (lead && lead.type !== "Tile" && lead.type !== "Badge") {
      return { path: `/nodes/${index}/children/0`, message: `Media 的前导只能是 Tile 或 Badge，不能是 ${lead.type}` };
    }
  }
  for (const [index, node] of nodes.entries()) {
    if (node.type !== "Item") continue;
    const actions = (node.children ?? []).filter((id) => byId.get(id)?.type === "Action");
    if (actions.length > 1) return { path: `/nodes/${index}/children`, message: "Item 最多一个 Action（放在右边）；更多的按钮放进细节里的 Stack" };
  }
  // 组里的 Item 在浮层里，不占会话列表的位置，不算进图块的上限。
  const grouped = new Set(nodes.filter((node) => node.type === "Group").flatMap((node) => node.children ?? []));
  const tiles = nodes.filter((node) => (node.type === "Tile" || node.type === "Item") && !grouped.has(node.id)).length;
  if (tiles > UI_COMPONENT_LIMITS.tilesPerCard) return { path: "/nodes", message: `一张卡最多 ${UI_COMPONENT_LIMITS.tilesPerCard} 个 Tile，现在是 ${tiles} 个` };
  const messages = nodes.filter((node) => node.type === "Message").length;
  if (messages > UI_COMPONENT_LIMITS.messagesPerCard) return { path: "/nodes", message: `一张卡最多 ${UI_COMPONENT_LIMITS.messagesPerCard} 个 Message` };
  return groupRuleError(nodes, byId) ?? disclosureRuleError(nodes, byId) ?? actionRuleError(nodes, byId);
}

// Group：一张卡最多 3 个；至少一件；组里只放 Item 和 Text，Item 不带细节（浮层里不再开浮层）；
// 不能放进 Disclosure、带细节的 Item 或者另一个 Group 里。
function groupRuleError(nodes: readonly UiNode[], byId: ReadonlyMap<string, UiNode>): UiSurfaceError | null {
  const groups = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.type === "Group");
  if (groups.length > UI_COMPONENT_LIMITS.groupsPerCard) {
    return { path: "/nodes", message: `一张卡最多 ${UI_COMPONENT_LIMITS.groupsPerCard} 个 Group，现在是 ${groups.length} 个` };
  }
  for (const { node, index } of groups) {
    const children = node.children ?? [];
    if (!children.length) return { path: `/nodes/${index}/children`, message: "Group 至少要有一件（children 里的 Item 或 Text）" };
    for (const [at, id] of children.entries()) {
      const child = byId.get(id);
      if (child && child.type !== "Item" && child.type !== "Text") {
        return { path: `/nodes/${index}/children/${at}`, message: `Group 里只放 Item 或 Text，不能放 ${child.type}` };
      }
      if (child?.type === "Item" && (child.children ?? []).some((below) => byId.get(below)?.type !== "Action")) {
        return { path: `/nodes/${index}/children/${at}`, message: "Group 里的 Item 不带细节：组已经在浮层里，浮层里不再开浮层" };
      }
    }
  }
  for (const holder of nodes) {
    const below = (holder.children ?? []).flatMap((id) => [...subtree(id, byId)]);
    if (holder.type === "Group" && below.some((id) => byId.get(id)?.type === "Group")) return { path: "/nodes", message: "Group 不能嵌套" };
    const opens = holder.type === "Disclosure" || (holder.type === "Item" && (holder.children ?? []).some((id) => byId.get(id)?.type !== "Action"));
    if (opens && below.some((id) => byId.get(id)?.type === "Group")) {
      return { path: "/nodes", message: `Group 不能放进 ${holder.type} 的展开态里：它自己就会点开` };
    }
  }
  return null;
}

// 这个节点和它下面的所有节点。
function subtree(id: string, byId: ReadonlyMap<string, UiNode>, into = new Set<string>()): Set<string> {
  if (into.has(id)) return into;
  into.add(id);
  for (const child of byId.get(id)?.children ?? []) subtree(child, byId, into);
  return into;
}

// Disclosure：最多 1 个、不能嵌套；detail 都是它的子节点，至少留一个子节点在收起态。Field 只能在展开态里（不占会话列表的高度）。
function disclosureRuleError(nodes: readonly UiNode[], byId: ReadonlyMap<string, UiNode>): UiSurfaceError | null {
  // 有细节的 Item 也会撑开成浮层：它的细节算展开态，它和 Disclosure 一起算「一张卡最多一个」、不能互相嵌套。
  const openers = nodes.filter((node) => node.type === "Disclosure"
    || (node.type === "Item" && (node.children ?? []).some((id) => byId.get(id)?.type !== "Action")));
  if (openers.length > 1) return { path: "/nodes", message: "一张卡最多一个能点开的 Disclosure 或带细节的 Item" };
  const expanded = new Set<string>();
  for (const item of openers.filter((node) => node.type === "Item")) {
    for (const id of item.children ?? []) if (byId.get(id)?.type !== "Action") for (const below of subtree(id, byId)) expanded.add(below);
  }
  const disclosures = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.type === "Disclosure");
  if (disclosures.length > 1) return { path: "/nodes", message: "一张卡最多 1 个 Disclosure" };
  for (const { node, index } of disclosures) {
    const children = node.children ?? [];
    const detail = (node.props as { detail: string[] }).detail;
    const stray = detail.find((id) => !children.includes(id));
    if (stray) return { path: `/nodes/${index}/props/detail`, message: `detail 里的 ${stray} 不是这个 Disclosure 的子节点` };
    if (children.every((id) => detail.includes(id))) {
      return {
        path: `/nodes/${index}/props/detail`,
        message: "Disclosure 要至少留一个子节点在收起态：children 里不在 detail 的节点就是卡片平时的样子（例如一个 Media），点开以后才出现 detail",
      };
    }
    const inside = [...children].flatMap((id) => [...subtree(id, byId)]);
    if (inside.some((id) => byId.get(id)?.type === "Disclosure")) return { path: `/nodes/${index}/children`, message: "Disclosure 不能嵌套" };
    for (const id of detail) for (const below of subtree(id, byId)) expanded.add(below);
  }
  const field = nodes.findIndex((node) => node.type === "Field" && !expanded.has(node.id));
  if (field >= 0) return { path: `/nodes/${field}`, message: "Field 只能放在 Disclosure 的 detail 或 Item 的细节里（展开以后才出现，不占会话列表的高度）" };
  return null;
}

// 一个操作的输入 schema：工单操作在 ticket-actions.ts，别的目标在 ui-actions.ts。没有这个操作时为 null。
function actionInputSchema(target: UiActionButtonTarget, action: string): TSchema | null {
  const type: string = target.type;
  if (type === "ticket") return (TICKET_ACTION_INPUT_SCHEMAS as Record<string, TSchema>)[action] ?? null;
  if (!isUiActionTargetType(type)) return null;
  return (UI_ACTION_INPUT_SCHEMAS[type] as Record<string, TSchema>)[action] ?? null;
}

// schema 里登记的参数名（对象 schema 的 properties；几种写法的 Union 取并集）。
function schemaParams(schema: TSchema): Set<string> {
  const record = schema as { properties?: Record<string, TSchema>; anyOf?: TSchema[] };
  if (record.properties) return new Set(Object.keys(record.properties));
  return new Set((record.anyOf ?? []).flatMap((part) => [...schemaParams(part)]));
}

function paramSchema(schema: TSchema, param: string): TSchema | null {
  const record = schema as { properties?: Record<string, TSchema>; anyOf?: TSchema[] };
  if (record.properties?.[param]) return record.properties[param]!;
  for (const part of record.anyOf ?? []) {
    const found = paramSchema(part, param);
    if (found) return found;
  }
  return null;
}

// Action：操作要在这个目标类型的注册表里，input 只写登记过的参数，一张卡最多 1 个 primary。
// Field：for 指向同一张卡里的 Action，param 是那个操作登记过的参数，选项的值要合格。
function actionRuleError(nodes: readonly UiNode[], byId: ReadonlyMap<string, UiNode>): UiSurfaceError | null {
  let primaries = 0;
  // 先查按钮、再查 Field：按钮的操作不对时，报按钮，不报依赖它的 Field。
  for (const [index, node] of nodes.entries()) {
    if (node.type === "Action") {
      const props = node.props as Static<typeof UI_CATALOG.Action.props>;
      const schema = actionInputSchema(props.target, props.action);
      if (!schema) return { path: `/nodes/${index}/props/action`, message: `${props.target.type} 没有操作 ${props.action}（先用 list_ticket_actions 或 list_actions 查）` };
      const params = schemaParams(schema);
      const unknown = Object.keys(props.input ?? {}).find((key) => !params.has(key));
      if (unknown) return { path: `/nodes/${index}/props/input/${unknown}`, message: `${props.action} 没有参数 ${unknown}（可用：${[...params].join("、") || "无"}）` };
      if (props.role === "primary") primaries += 1;
    }
  }
  for (const [index, node] of nodes.entries()) {
    if (node.type === "Field") {
      const props = node.props as Static<typeof UI_CATALOG.Field.props>;
      const button = byId.get(props.for);
      if (!button || button.type !== "Action") return { path: `/nodes/${index}/props/for`, message: `Field 的 for 要指向这张卡里的一个 Action，${props.for} 不是` };
      const action = button.props as Static<typeof UI_CATALOG.Action.props>;
      const schema = actionInputSchema(action.target, action.action);
      const param = schema ? paramSchema(schema, props.param) : null;
      if (!param) return { path: `/nodes/${index}/props/param`, message: `${action.action} 没有参数 ${props.param}` };
      const preset = props.presets.findIndex((entry) => props.kind === "datetime"
        ? resolveDatetimePreset(entry.value) === null
        : !Value.Check(param, entry.value));
      if (preset >= 0) {
        return {
          path: `/nodes/${index}/props/presets/${preset}/value`,
          message: props.kind === "datetime"
            ? `时间选项「${props.presets[preset]!.value}」的写法不对：写 +30m、+2h、+3h30m、+1d 09:00、mon 09:00 或 ISO 时刻`
            : `选项「${props.presets[preset]!.value}」不是 ${props.param} 能取的值`,
        };
      }
    }
  }
  if (primaries > 1) return { path: "/nodes", message: "一张卡最多 1 个 role 是 primary 的 Action" };
  return null;
}

// schema 表达不了的规则，只看已经通过 schema 的 props。返回的 path 相对于这个节点的 props。
function propsRuleError(node: UiNode): UiSurfaceError | null {
  if (node.type === "UserAction") {
    const problems = userActionProblems((node.props as { action?: unknown }).action);
    if (problems.length) return { path: "/action", message: problems.join("；") };
  }
  if (node.type === "SourceQuote") {
    const props = node.props as Static<typeof UI_CATALOG.SourceQuote.props>;
    if (props.source === "checkpoint" && props.checkpoint === undefined) {
      return { path: "/checkpoint", message: "source 是 checkpoint 时要给 checkpoint 的编号" };
    }
  }
  if (node.type === "ChoiceGroup") {
    const props = node.props as Static<typeof UI_CATALOG.ChoiceGroup.props>;
    const ids = props.choices.map((choice) => choice.id);
    if (new Set(ids).size !== ids.length) return { path: "/choices", message: "选项 id 重复" };
    if (props.recommendation && !ids.includes(props.recommendation.choiceId)) {
      return { path: "/recommendation/choiceId", message: `推荐的选项 ${props.recommendation.choiceId} 不在 choices 里` };
    }
  }
  if (node.type === "DataTable") {
    const props = node.props as Static<typeof UI_CATALOG.DataTable.props>;
    const row = props.rows.findIndex((cells) => cells.length !== props.columns.length);
    if (row >= 0) {
      return { path: `/rows/${row}`, message: `第 ${row + 1} 行有 ${props.rows[row]!.length} 格，要和 columns 一样是 ${props.columns.length} 格` };
    }
  }
  if (node.type === "Item") {
    const props = node.props as Static<typeof UI_CATALOG.Item.props>;
    if (!props.title && !props.text) return { path: "", message: "Item 要有 title 或 text" };
    const lead = propsRuleError({ id: `${node.id}-lead`, type: "Tile", props: props.lead as Record<string, unknown> });
    if (lead) return { path: `/lead${lead.path}`, message: lead.message };
  }
  if (node.type === "Tile") {
    const props = node.props as Static<typeof UI_CATALOG.Tile.props>;
    const size = props.size ?? "md";
    for (const [field, limit] of [["eyebrow", UI_COMPONENT_LIMITS.tileEyebrowWidth[size]], ["caption", UI_COMPONENT_LIMITS.tileCaptionWidth[size]]] as const) {
      const text = props[field];
      if (text !== undefined && tileTextWidth(text) > limit) {
        return {
          path: `/${field}`,
          message: `${size} 图块的 ${field}「${text}」放不下一行（汉字算 2、其他算 1.2，最多 ${limit}）：写短一点，或者换成 md，或者挪进正文`,
        };
      }
    }
  }
  if (node.type === "BarChart") {
    const props = node.props as Static<typeof UI_CATALOG.BarChart.props>;
    const max = props.max;
    const bar = max === undefined ? -1 : props.bars.findIndex((entry) => entry.value > max);
    if (bar >= 0) return { path: `/bars/${bar}/value`, message: `${props.bars[bar]!.label} 的值 ${props.bars[bar]!.value} 超过了 max ${max}` };
  }
  return null;
}

/** 图块里一行文字的显示宽度：汉字和全角符号算 2，其他字符算 1.2（等宽数字和字母大约是汉字的六成宽）。 */
export function tileTextWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[\u2E80-\uFFEF]/.test(char) ? 2 : 1.2;
  return Math.round(width * 10) / 10;
}

// 节点的 props 符合目录，也符合 schema 以外的规则。
function acceptsNode(node: UiNode): boolean {
  const entry = (UI_CATALOG as Record<string, { container: boolean; props: TSchema }>)[node.type];
  return Boolean(entry) && Value.Check(entry!.props, node.props) && !propsRuleError(node);
}

// 流式中途，props 里最后一个数组的最后一项可能还没写完：partial-json 把它解析成 {} 或缺字段的对象，
// 表格的最后一行也可能还缺格子。去掉这一项再试，列表和表格就一项一项地出来，不会整块消失再出现。
// JSON 按顺序写，所以只有最后一个数组属性还在写。
function settleStreamingNode(node: UiNode): UiNode | null {
  const key = Object.keys(node.props).reverse().find((name) => Array.isArray(node.props[name]));
  if (!key) return null;
  const settled = { ...node, props: { ...node.props, [key]: (node.props[key] as unknown[]).slice(0, -1) } };
  return acceptsNode(settled) ? settled : null;
}

// 一次 render_ui 调用的缺省 surface id：流式中途的版本和定稿版本用同一个 id（Lead 没给 surface_id 时）。
export function uiSurfaceIdForCall(callId: string): string {
  return `s_${callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(-60)}`;
}

// 流式：模型还在写 render_ui 的参数时，用已经完整的节点拼一张「生成中」的卡片。
// args 是边写边解析出来的参数（pi-ai 的 toolcall_delta 里的 partial arguments），可能缺字段、缺节点。
// 只留下单独就合格的节点；子节点里还没到的去掉；从 root 走不到的去掉。root 还没到时返回 null。
// spec D7：Lead 可能把 child 的输出（日志、报错）抄进卡片。落库和发出之前，所有文字都去掉密钥。
// 只换字符串的值，不改结构：id、类型和引用的编号原样保留。
export function redactUiSurface(surface: UiSurface): UiSurface {
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return redactSecretText(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clean(entry)]));
    }
    return value;
  };
  return {
    ...surface,
    fallbackText: redactSecretText(surface.fallbackText),
    nodes: surface.nodes.map((node) => ({ ...node, props: clean(node.props) as UiNode["props"] })),
  };
}

// 生成中的 SourceQuote 还没有原文：text、label、truncated 由服务端定稿时从账本填。Lead 自己写在参数里的不显示。
function withoutServerQuote(node: UiNode): UiNode {
  const { text: _text, label: _label, truncated: _truncated, ...location } = node.props as Record<string, unknown>;
  return { ...node, props: location };
}

// 生成中的 Message 还没有原文：sender、messages、total 由服务端定稿时从外部消息卡填。
function withoutServerMessages(node: UiNode): UiNode {
  const { sender: _sender, messages: _messages, total: _total, ...reference } = node.props as Record<string, unknown>;
  return { ...node, props: reference };
}

export function partialUiSurface(args: unknown, callId: string): UiSurface | null {
  if (!args || typeof args !== "object") return null;
  const input = args as { surface_id?: unknown; root?: unknown; nodes?: unknown; fallback_text?: unknown };
  if (typeof input.root !== "string" || !Array.isArray(input.nodes)) return null;
  const nodes: UiNode[] = [];
  for (const candidate of input.nodes) {
    if (!Value.Check(UiNodeSchema, candidate)) continue;
    const accepted = acceptsNode(candidate) ? candidate : settleStreamingNode(candidate);
    if (!accepted) continue;
    if (nodes.some((node) => node.id === accepted.id)) continue;
    nodes.push({ ...accepted, ...(accepted.children ? { children: [...accepted.children] } : {}) });
  }
  const known = new Set(nodes.map((node) => node.id));
  for (const node of nodes) if (node.children) node.children = node.children.filter((child) => known.has(child));
  // 流式中途 Disclosure 的展开态可能还没写到：只留已经到了的。
  for (const node of nodes) {
    if (node.type === "Disclosure" && Array.isArray(node.props.detail)) {
      node.props = { ...node.props, detail: (node.props.detail as string[]).filter((id) => node.children?.includes(id)) };
    }
  }
  if (!known.has(input.root)) return null;
  const reached = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const walk = (id: string, depth: number) => {
    if (reached.has(id) || depth > UI_SURFACE_LIMITS.depth) return;
    reached.add(id);
    for (const child of byId.get(id)?.children ?? []) walk(child, depth + 1);
  };
  walk(input.root, 1);
  const surface: UiSurface = {
    id: typeof input.surface_id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(input.surface_id) ? input.surface_id : uiSurfaceIdForCall(callId),
    catalogVersion: UI_CATALOG_VERSION,
    root: input.root,
    fallbackText: typeof input.fallback_text === "string" && input.fallback_text.trim() ? input.fallback_text : "正在生成卡片…",
    nodes: nodes.filter((node) => reached.has(node.id)).map((node) => node.children
      ? { ...node, children: node.children.filter((child) => reached.has(child)) }
      : node.type === "SourceQuote" ? withoutServerQuote(node) : node.type === "Message" ? withoutServerMessages(node) : node),
  };
  const checked = validateUiSurface(surface);
  return checked.ok ? redactUiSurface(checked.surface) : null;
}

// 一张卡什么时候换掉另一张（2026-10-24）。实时事件（App 的 reducer）和刷新时的折叠（foldTurnSurfaces）用同一套规则：
// - 同一次调用：定稿版替换流式中途的版本；定稿以后不再被中途的版本盖掉。
// - 同一轮里同一个 surface id（spec D3，「同一个 id 再画一次就是替换」）：重画的定稿版替换旧卡。
//   重画还在流时继续显示旧的定稿版，不出现第二张「正在生成…」的卡。
// - 调用失败（lead.tool.failed）：它不会再有定稿版，流式中途的版本撤掉。
// 线上 2026-10-24：校验失败的那次留下了一张停在「正在生成…」的卡，Lead 用同一个 id 重画，用户看到两张。
export type UiSurfaceCard = { callId: string; partial: boolean; surface: { id: string } };

// 这次调用的卡片现在能不能显示：同一个 id 已经有别的调用定稿的版本时，流式中途的版本不显示。
export function surfaceShadowedByFinal(cards: Iterable<UiSurfaceCard>, next: UiSurfaceCard): boolean {
  if (!next.partial) return false;
  for (const card of cards) {
    if (card.callId !== next.callId && card.surface.id === next.surface.id && !card.partial) return true;
  }
  return false;
}

// 定稿版要换掉的别的调用的卡（同一个 surface id）。
export function surfacesReplacedBy(cards: Iterable<UiSurfaceCard>, next: UiSurfaceCard): string[] {
  if (next.partial) return [];
  return [...cards].filter((card) => card.callId !== next.callId && card.surface.id === next.surface.id).map((card) => card.callId);
}

// 一轮里的 surface（事件按 seq 排好）：规则见上面。不合格的跳过：它们在生成时已经报给 Lead，用户看到的是 fallbackText。
// events 里除了带 surface 的 lead.tool.updated，还有 render_ui 的 lead.tool.failed。
export function foldTurnSurfaces(
  events: ReadonlyArray<{ type: string; payload: Record<string, unknown> }>,
): UiSurfacePlacement[] {
  const byCall = new Map<string, Omit<UiSurfacePlacement, "partial"> & { partial: boolean }>();
  for (const event of events) {
    if (event.type === "lead.tool.failed") {
      const callId = event.payload.toolCallId;
      if (typeof callId === "string" && byCall.get(callId)?.partial) byCall.delete(callId);
      continue;
    }
    const surface = event.payload.surface;
    if (!surface || typeof surface !== "object") continue;
    const checked = validateUiSurface(surface);
    if (!checked.ok) continue;
    const partial = event.payload.partial === true;
    const callId = typeof event.payload.toolCallId === "string" ? event.payload.toolCallId : checked.surface.id;
    const previous = byCall.get(callId);
    if (previous && !previous.partial && partial) continue;
    const next = {
      callId,
      textOffset: typeof event.payload.textOffset === "number" && event.payload.textOffset >= 0 ? Math.floor(event.payload.textOffset) : 0,
      surface: checked.surface,
      partial,
    };
    if (surfaceShadowedByFinal(byCall.values(), next)) continue;
    for (const replaced of surfacesReplacedBy(byCall.values(), next)) byCall.delete(replaced);
    byCall.set(callId, next);
  }
  return [...byCall.values()].map(({ partial, ...placement }) => (partial ? { ...placement, partial: true as const } : placement));
}
