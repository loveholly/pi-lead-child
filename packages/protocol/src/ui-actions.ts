// UI 操作的契约（2026-10-22 用户定的规则，仓库 AGENTS.md「UI Actions」，.scratch/ui-action-parity/plan.md P01）。
// UI 上每一个调用后端的操作都是一个操作、两个入口：页面调的 HTTP 路由和 Lead 的工具。两个入口调用 engine 的同一个函数
// （ui-actions/ 的 runUiAction），「现在能不能做」也由同一个函数判断。
//
// 操作按「目标类型」登记。工单（ticket）的操作在 ticket-actions.ts，有自己的路由和 Lead 工具（list_ticket_actions、ticket_action）。
// 这里登记工单以外的目标，Lead 用 list_actions、perform_action 两个通用工具。以后的目标类型（项目、通知、连接、记忆、主人操作）
// 按 plan.md 的 P05–P07 加进来：在 UI_ACTION_TARGET_TYPES 和 UI_ACTION_INPUT_SCHEMAS 各加一项，再在 engine 的
// ui-actions/catalog.ts 写定义。
//
// 这个文件不 import index.ts（index.ts 从这里 re-export，反过来会循环）。
import { Type, type Static, type TProperties, type TSchema } from "typebox";
import { CHANNEL_CARD_NOTE_MAX, CHANNEL_CARD_TEXT_MAX, CHANNEL_EMOJI_NAME_PATTERN } from "./channels.ts";
import { ChannelPolicyParamsSchema, ChannelPolicyReplayRequestSchema, ChannelPolicyTestRequestSchema } from "./channel-confidence.ts";
import {
  ChannelHandbookSchema, HandbookProposalRequestSchema, HandbookRehearsalRequestSchema, HandbookSuggestionKeySchema,
} from "./channel-handbook.ts";
import { registerEventKind, type EventKindDefinition } from "./events.ts";
import { LeadModelChoiceSchema } from "./lead-models.ts";
import {
  FastModelIdRequestSchema, RemoveModelProviderRequestSchema, SaveFastModelRequestSchema, SaveModelProviderRequestSchema,
  SetBrainChainRequestSchema, SetFastChainRequestSchema,
} from "./model-settings.ts";
import { SetSummaryModelRequestSchema, SummaryModelSlotRequestSchema } from "./memory-hindsight.ts";
import { CoreMemoryUpdateRequestSchema } from "./core-memory.ts";
import { ReminderRescheduleRequestSchema } from "./reminders.ts";
import { ReplyStyleExtractRequestSchema, ReplyStyleUpdateRequestSchema } from "./reply-style.ts";
import { RuleChangeDecisionSchema } from "./rule-change-confirmations.ts";
import { TimerRequestDecisionSchema } from "./timer-origins.ts";
import {
  ViewRenameRequestSchema, WidgetCreateRequestSchema, WidgetReorderRequestSchema, WidgetUpdateRequestSchema,
} from "./widget-requests.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// ── 权限 ──────────────────────────────────────────────────────────────────────────

// 谁能做（工单操作和别的目标共用这一份）：
//   user_only     只属于你。Lead 只在你本人当前这一轮（已认证、凭证有效）里代你做，账本记 actor=lead、onBehalfOf=user。
//   lead_allowed  Lead 可以按自己的判断做，账本记 actor=lead。
//   delegated     托管或长期授权范围内 Lead 自己做；不在范围内时同 user_only。
//   user_direct   授予 Lead 权力或带密钥的操作。Lead 能调用，但总是拿到结构化的拒绝，拒绝里写明你去哪里点。
// 对外（external）和不可逆（irreversible）的操作另有一条：每次都要你在这一轮明确要求，托管也不能代替。
export const ACTION_PERMISSIONS = ["user_only", "lead_allowed", "delegated", "user_direct"] as const;
export type ActionPermission = typeof ACTION_PERMISSIONS[number];
export const ActionPermissionSchema = Type.Union([
  Type.Literal("user_only"), Type.Literal("lead_allowed"), Type.Literal("delegated"), Type.Literal("user_direct"),
]);

// ── 目标和操作 ────────────────────────────────────────────────────────────────────

// 工单以外的目标类型。目标的编号写成字符串（执行器是 codex、claude、pi；设备、审批、决定请求是编号）。
//   runtime   执行器（设置 → 执行 → 执行器）。
//   device    配对过的设备的凭证（设置 → 设备 → 已配对设备）。
//   approval  child 执行不可逆动作前的审批（会话里的审批卡、工单详情的介入卡）。
//   decision  决定请求（工单详情的介入卡、会话里的决定卡）。
//   channel_card  外部消息卡（会话里 Slack 这类来源的卡）。卡上的按钮和 Lead 代你回复走同一个操作（用户 2026-10-23）。
//   channel_conversation  外部来源里的一个对话（私信某个人、频道、thread）。Lead 代你直接发消息，不经过卡片（用户 2026-10-23）。
//     编号是来源给的对话编号：slack:@U123（私信这个人）、slack:C123:main（频道）、slack:C123:<thread 的 ts>，和收到的消息的对象键一样。
//   channel_policy  一个来源的「自动代你处理」：开关、授权表和信心模型的参数（设置 → 消息通道，2026-10-23）。编号是来源，例如 slack。
//   channel_handbook  交接说明（设置 → 消息通道 → 自动代你处理，方案 B，2026-10-30，channel-handbook.ts）。编号只有 handbook。
//   lead_model  Lead 自己用的模型和推理强度（会话输入框右下角，2026-10-26，lead-models.ts）。编号只有 lead。
//   reminder   一条提醒（会话里的提醒卡、响铃卡、横幅、收件箱，P03、P04）。编号是提醒的编号（工单编号）。
//   workspace  一张工单的工作区（工单详情的工作区一栏，P04）。编号是工作区的编号。
//   milestone  工单的一个日期节点（日程、左栏，P04）。编号是节点的编号。
//   rule_change  改规则被拦下以后的一次性确认卡（spec D10 的放行，工单 09，rule-change-confirmations.ts）。编号是 rcc_ 开头的确认号。
//   lead_queue  Lead 忙时排着的一个对话的外部消息（主对话输入框上方的排队状态栏，工单 10，lead-queue.ts）。
//     编号是对话的对象键，例如 slack:@U123。
//   timer  一个定时器：跟进、提醒或者规则（提醒列表里外部的人要求设的那几行，spec D16，工单 12，timer-origins.ts）。
//     编号是 follow_up:12、reminder:5、trigger:3。
//   timer_request  外部的人要求设的定时器的确认卡（spec D16，工单 12）。编号是 tmr_ 开头的确认号。
//   follow_up  Lead 忙时用户排着的一条追问（主对话输入框上方的状态栏，用户 2026-10-28，lead-follow-ups.ts）。
//     编号是用户那一轮的 turn id。
//   reply_style  代回复风格（设置 → 消息通道 → 代回复风格，2026-10-28，reply-style.ts）。编号只有 user。
//   model_settings  设置 → 模型：大脑和直觉的分工、服务商、直觉的每一条（2026-10-29，model-settings.ts）。编号只有 models。
//   memory_settings  设置 → 记忆的 Hindsight 部分：摘要模型、重试失败的写入（2026-10-29，memory-hindsight.ts）。编号只有 memory。
//   core_memory  一条常驻偏好（设置 → 记忆 → 常驻偏好，2026-10-29，core-memory.ts）。编号是它的编号（GET /v1/memory/preferences 的 id）。
//   core_memory_change  常驻偏好的一次改动（Lead 动态的「撤销」按钮、常驻偏好列表）。编号是改动编号（changeId）。
//   memory_fact  Hindsight 从笔记里提取的一条事实（search_notes 结果里的记忆 id，设置 → 记忆的失效列表，2026-10-29）。
//     编号是 Hindsight 的记忆编号。
//   setup_hint  会话里一张建议去配某项设置的卡（首次启动引导，2026-10-30，.scratch/onboarding）。编号是卡的编号（hintId）。
//   widget_board  视图面板（会话顶栏右边的入口，2026-10-30，widgets.ts）：建控件、排顺序、视图改名。编号只有 widgets。
//   widget  一个自定义控件（视图面板里的一块）：改（包括移到别的视图）、删。编号是控件的编号（GET /v1/widgets 的 id）。
export const UI_ACTION_TARGET_TYPES = [
  "runtime", "device", "approval", "decision", "channel_card", "channel_conversation", "channel_policy", "channel_handbook", "lead_model",
  "reminder", "workspace", "milestone", "rule_change", "lead_queue", "timer", "timer_request", "follow_up", "reply_style",
  "model_settings", "memory_settings", "core_memory", "core_memory_change", "memory_fact", "setup_hint",
  "widget_board", "widget",
] as const;
export type UiActionTargetType = typeof UI_ACTION_TARGET_TYPES[number];

export function isUiActionTargetType(value: string): value is UiActionTargetType {
  return (UI_ACTION_TARGET_TYPES as readonly string[]).includes(value);
}

const Empty = StrictObject({});
// 外部消息卡的动作都可以带「看到的版本」：卡已经变了时拒绝，免得按旧的样子做决定（页面的按钮带它，Lead 可以不带）。
const CardVersion = { expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })) };
const CardOnly = StrictObject(CardVersion);

// 每个目标类型的操作和输入。顺序就是呈现顺序。reason 不在这里：它在请求的顶层（两个入口都有）。
export const UI_ACTION_INPUT_SCHEMAS = {
  runtime: {
    // 停用：派发、选核查员、选型建议和自动换人都跳过它。
    disable: Empty,
    // 启用。
    enable: Empty,
  },
  device: {
    // 作废这个凭证：这台设备马上断开，要重新配对。
    revoke: Empty,
  },
  approval: {
    // 批准、拒绝，或者批准且这张工单里同类动作以后不再问。
    resolve: StrictObject({
      decision: Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("approve_session")]),
    }),
  },
  decision: {
    // 选一个选项、回答一句话，或者不处理（不处理的原因写在 reason）。
    resolve: Type.Union([
      StrictObject({ decision: Type.Literal("select"), optionId: Type.String({ minLength: 1, maxLength: 200 }) }),
      StrictObject({ decision: Type.Literal("respond"), resolution: Type.String({ minLength: 1, maxLength: 20_000 }) }),
      StrictObject({ decision: Type.Literal("dismiss") }),
    ]),
  },
  // 顺序和名字照 channels.ts 的 CHANNEL_CARD_ACTIONS（卡上的按钮）。
  channel_card: {
    // 把卡上的草稿发出去（助手写的草稿带「confirmed by 你」的署名）。
    send_draft: CardOnly,
    // 你说会自己回。
    reply_myself: CardOnly,
    // 稍后再提醒。
    snooze: CardOnly,
    // 不回。
    dismiss: CardOnly,
    // 撤回自动回复（撤回窗口里）。
    undo_auto_reply: CardOnly,
    // 把你的原话发出去，不加署名。
    send_edited: StrictObject({ ...CardVersion, text: Type.String({ minLength: 1, maxLength: CHANNEL_CARD_TEXT_MAX }) }),
    // 停掉卡上在跑的子 agent 工单。
    cancel_lookup: CardOnly,
    // 卡上的事在别处做完了：卡结束，缺省在对方的消息上回 ✅（emoji 换一个，react: false 不回）。note 写做了什么。
    handled: StrictObject({
      ...CardVersion,
      note: Type.String({ minLength: 1, maxLength: CHANNEL_CARD_NOTE_MAX }),
      emoji: Type.Optional(Type.String({ pattern: CHANNEL_EMOJI_NAME_PATTERN })),
      react: Type.Optional(Type.Boolean()),
    }),
  },
  channel_conversation: {
    // 发一条消息。words：user 是你的原话，原样发，不加署名；assistant 是 Lead 组织的话，带「confirmed by 你」的署名。
    // 这个对话里有等你的卡时，卡跟着结束（已回复）。cardId：这条消息做的是另一个对话里那张卡上的事，那张卡也结束（handled）。
    // Lead 不在你这一轮里发的（定时器、外部消息叫醒的一轮）：Lead 自己判断，署名写 auto-reply，回复等你的卡时留撤回窗口
    // （统一消息事件 spec D9，用户 2026-10-29 去掉了信心检验）。event：回复的是哪条消息事件（Lead 的 reply_to_source 填）。
    // refusal：用固定的话拒绝（工单 06），text 只能是那句固定的话，
    // 授权表的涉密是「用固定的话拒绝」时才发，不过信心检验，带 auto-reply 署名，留撤回窗口。
    send_message: StrictObject({
      text: Type.String({ minLength: 1, maxLength: CHANNEL_CARD_TEXT_MAX }),
      words: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
      cardId: Type.Optional(Type.Integer({ minimum: 1 })),
      event: Type.Optional(Type.Integer({ minimum: 1 })),
      refusal: Type.Optional(Type.Boolean()),
    }),
    // 在一条消息上回表情：缺省是对方在这个对话里最后一条消息，seq 指定一条（事件编号，read_channel_conversation 的消息上有）。
    // remove：撤掉自己回的这个表情（例如回错了，换一个）。
    react: StrictObject({
      emoji: Type.String({ pattern: CHANNEL_EMOJI_NAME_PATTERN }),
      seq: Type.Optional(Type.Integer({ minimum: 1 })),
      remove: Type.Optional(Type.Boolean()),
    }),
  },
  // 设置 → 消息通道 → 自动代你处理（channel-confidence.ts）。update 和 tighten 的输入是改完以后的一整份。
  channel_policy: {
    // 改开关、授权表或信心模型的参数（可以放宽）。只有你本人能做。
    update: ChannelPolicyParamsSchema,
    // 只收紧（关掉开关、提高门槛……）。有一项放宽时拒绝。
    tighten: ChannelPolicyParamsSchema,
    // 测一条消息：按给的参数算结论。只读，不发任何东西。
    test: ChannelPolicyTestRequestSchema,
    // 评估过去 24 小时的消息：按现在生效的和给的两份参数各算一遍。只读。
    replay: ChannelPolicyReplayRequestSchema,
  },
  // 设置 → 消息通道 → 自动代你处理（交接说明，channel-handbook.ts）。update 和 tighten 的输入是改完以后的一整份。
  channel_handbook: {
    // 改交接说明（可以放宽：一句的做法、对方的上限、打开开关、加一句）。只有你本人能做。
    update: ChannelHandbookSchema,
    // 只收紧（一句改严、上限改严、关掉开关）。有一项放宽时拒绝。
    tighten: ChannelHandbookSchema,
    // 预演一条消息：收件判断真的选一句，按交接说明算结论。只读，不发任何东西。
    rehearse: HandbookRehearsalRequestSchema,
    // 把一句随口的话整理成交接说明里的一句。只读，不保存。
    propose: HandbookProposalRequestSchema,
    // 页边批注（issue 08）：看建议（只读）、接受一条（改交接说明，放宽的只有你本人能接受）、不用了（以后不再出现）。
    suggestions: Type.Object({}, { additionalProperties: false }),
    accept_suggestion: HandbookSuggestionKeySchema,
    dismiss_suggestion: HandbookSuggestionKeySchema,
  },
  lead_model: {
    // 换 Lead 的模型和推理强度。写进 config.json 的 lead.models（排第一），Lead 空闲时马上换，正在回答时这一轮结束后换。
    switch: LeadModelChoiceSchema,
  },
  reminder: {
    // 知道了：到点的提醒确认掉（fired → acked）。acked 是终态。
    ack: Empty,
    // 改时间：remindAt 是新的时刻（ISO），snoozeMinutes 是「多少分钟以后再提醒」，都不给时是 10 分钟以后。
    // 到点的提醒回到等待（fired → scheduled，system 代做），已确认、已取消的不能改。
    reschedule: ReminderRescheduleRequestSchema,
  },
  workspace: {
    // 释放：工单结束以后交还工作区（共享的工作区）。隔离 worktree 用工单的「合并」或「放弃改动」收尾。
    release: StrictObject({ mergeStatus: Type.Optional(Type.Union([Type.Literal("merged"), Type.Literal("abandoned")])) }),
    // 清理：删掉已经释放的工作区。隔离 worktree 的清理删掉 worktree 目录，不可逆：要就地确认，input 带 confirm: true，
    // 没带时操作层拒绝（needs_confirmation），拒绝里写明会发生什么。共享工作区不用确认。
    cleanup: StrictObject({ confirm: Type.Optional(Type.Literal(true)) }),
  },
  milestone: {
    // 改一个节点：改时间、全天、显示名，标完成（done）、没赶上（missed）、取消（cancelled）或恢复（planned）。只改给出的字段。
    // index.ts 的 MilestonePatchRequestSchema（POST /v1/milestones/:id 的请求体）就是它。
    update: StrictObject({
      at: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      allDay: Type.Optional(Type.Boolean()),
      label: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
      state: Type.Optional(Type.Union([
        Type.Literal("planned"), Type.Literal("done"), Type.Literal("missed"), Type.Literal("cancelled"),
      ])),
    }),
  },
  rule_change: {
    // 你在确认卡上的决定：confirm 执行卡上存下的那一个操作（参数不能换），decline 不改。只有你本人能做。
    resolve: StrictObject({ decision: RuleChangeDecisionSchema }),
  },
  lead_queue: {
    // 排到下一个：这一轮结束以后，Lead 先处理这个对话排着的消息。
    move_next: Empty,
    // 移出队列：你自己处理，这几条消息的卡结束（和卡上的「我自己回」一样），Lead 不再处理它们。
    remove: Empty,
  },
  timer: {
    // 取消：跟进不再叫醒 Lead，提醒取消（cancelled，终态），规则停用。
    cancel: Empty,
  },
  timer_request: {
    // 你在确认卡上的决定：confirm 照存下的参数设这个定时器，decline 不设。只有你本人能做。
    resolve: StrictObject({ decision: TimerRequestDecisionSchema }),
  },
  follow_up: {
    // 插进这一轮：这条排着的追问插进 Lead 正在做的这一轮（pi 的 steer），和发送时选「插话」一样。
    steer: Empty,
    // 不再发给 Lead：Lead 不回答它，你的话照旧留在会话里。只有你本人能做。
    cancel: Empty,
  },
  reply_style: {
    // 改代回复风格：replace 换掉整段，append 在后面追加一段（带日期小标题，原来的内容不动）。
    update: ReplyStyleUpdateRequestSchema,
    // 从最近 N 天用户本人的消息里提炼风格特征，交给用户预览。只读，什么都不写。
    extract: ReplyStyleExtractRequestSchema,
  },
  model_settings: {
    // 大脑的分工：第一个主用，后面最多 3 个备用（写进 config.json 的 lead.models）。
    set_brain_chain: SetBrainChainRequestSchema,
    // 接入或修改一个服务商（lead.providers）。带 key：只有你本人能做。
    save_provider: SaveModelProviderRequestSchema,
    // 删掉一个服务商。它的模型在分工里时拒绝。
    remove_provider: RemoveModelProviderRequestSchema,
    // 添加或修改一条直觉（决策模型）。带 key：只有你本人能做。
    save_fast_model: SaveFastModelRequestSchema,
    // 删掉一条直觉。它在分工里时拒绝。
    remove_fast_model: FastModelIdRequestSchema,
    // 直觉的分工（0–4 条），以及都用不了时问大脑的哪个模型。
    set_fast_chain: SetFastChainRequestSchema,
    // 测一条直觉能不能用：发一次很小的判断。只读。
    test_fast_model: FastModelIdRequestSchema,
  },
  memory_settings: {
    // 选摘要模型（缺省或整理观察）。model 为 null 时改回自动或跟缺省一样。改了以后记忆服务重启。
    set_summary_model: SetSummaryModelRequestSchema,
    // 测一个槽现在用的摘要模型：用它的服务商发一次很小的补全。只读。
    test_summary_model: SummaryModelSlotRequestSchema,
    // 失败的笔记写入重新排队（修好原因以后）。
    retry_failed_writes: Empty,
  },
  core_memory: {
    // 改标题、正文（只改给出的，至少一项）。依据写在 reason。
    update: CoreMemoryUpdateRequestSchema,
    // 删掉这条。能撤销。
    delete: Empty,
  },
  core_memory_change: {
    // 撤销这次改动：修改恢复成改前的样子；新加的删掉；删掉的按原样重建一条。这条在这次改动之后又改过时拒绝。
    undo: Empty,
  },
  memory_fact: {
    // 让这条事实失效：以后召回不到它，由它整理出的观察也删掉。依据写在 reason。观察不能失效。
    invalidate: Empty,
    // 恢复：这条事实重新有效。
    restore: Empty,
  },
  setup_hint: {
    // 以后再说：这一项 7 天内不再提。
    snooze: Empty,
    // 不用再提：这一项以后都不提。
    dismiss: Empty,
  },
  widget_board: {
    // 建一个控件：标题、模板（写法和 render_ui 一样）、所在的视图（不给时是缺省的视图）。新控件排在最上面。
    create: WidgetCreateRequestSchema,
    // 排顺序：全部控件的编号，从上到下。
    reorder: WidgetReorderRequestSchema,
    // 视图改名：这个视图里的控件一起换到新名字下。
    rename_view: ViewRenameRequestSchema,
  },
  widget: {
    // 改标题、模板、所在的视图、数据源，至少一样。
    update: WidgetUpdateRequestSchema,
    // 马上跑一次数据源；暂停了的也接着跑。
    refresh: Empty,
    // 删掉这个控件。删了不能恢复：要带 confirm: true（页面在按钮上就地确认）。
    delete: StrictObject({ confirm: Type.Optional(Type.Literal(true)) }),
  },
} as const satisfies Record<UiActionTargetType, Record<string, TSchema>>;

type UiActionSchemas = typeof UI_ACTION_INPUT_SCHEMAS;
export type UiActionIdOf<T extends UiActionTargetType> = keyof UiActionSchemas[T] & string;
export type UiActionInputOf<T extends UiActionTargetType, K extends UiActionIdOf<T>> =
  UiActionSchemas[T][K] extends TSchema ? Static<UiActionSchemas[T][K]> : never;

/** 所有工单以外的操作编号（去重）。Lead 的 perform_action 用它做 action 的枚举。 */
export const UI_ACTION_IDS: readonly string[] = [
  ...new Set(UI_ACTION_TARGET_TYPES.flatMap((type) => Object.keys(UI_ACTION_INPUT_SCHEMAS[type]))),
];

// ── 页面入口：GET /v1/actions/:type/:id、POST /v1/actions/:type/:id/:action ──────────────
// genui 卡片上的按钮（Action，2026-10-27）用这两条：和 Lead 的 list_actions、perform_action 是同一个函数的两个入口。
// 原来按目标写的路由（/v1/reminders/:id/reschedule……）照旧可用。

export const UiActionViewSchema = StrictObject({
  target: StrictObject({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
  // 不用枚举：以后加了操作，旧客户端按严格的 schema 校验也不会整张清单失败。
  id: Type.String({ minLength: 1, maxLength: 64 }),
  label: Type.String(),
  permission: ActionPermissionSchema,
  external: Type.Boolean(),
  irreversible: Type.Boolean(),
  // 用户自己去哪里点。
  where: Type.String(),
  // 要就地确认时，确认条上的那一句；不用确认时为 null。
  confirm: Nullable(Type.String()),
  available: Type.Boolean(),
  // 不能做的原因，用户能看懂的一句话。能做时为 null。
  reason: Nullable(Type.String()),
});
export type UiActionView = Static<typeof UiActionViewSchema>;

export const UiActionsResponseSchema = StrictObject({
  target: StrictObject({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
  actions: Type.Array(UiActionViewSchema),
});
export type UiActionsResponse = Static<typeof UiActionsResponseSchema>;

export const UiActionRunRequestSchema = StrictObject({
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
});
export type UiActionRunRequest = Static<typeof UiActionRunRequestSchema>;

export const UiActionRunResponseSchema = StrictObject({
  target: StrictObject({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
  action: Type.String({ minLength: 1 }),
  result: Type.Unknown(),
});
export type UiActionRunResponse = Static<typeof UiActionRunResponseSchema>;

// ── 账本 ──────────────────────────────────────────────────────────────────────────

// 每次经过操作层做成一个工单以外的操作，记一条 ui_action.performed（store 的事件日志，级别 record）。
// 两个入口记的是同一条：只有 source、actor（你或者 Lead）和「代谁、凭哪一轮」不同。
// 工单操作不记它：工单的账本是 activities 和 stage 的变化（ticket-actions/）。
export const UI_ACTION_PERFORMED_KIND = "ui_action.performed";

export const UiActionPerformedPayloadSchema = Type.Object({
  target: Type.Object({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }),
  action: Type.String({ minLength: 1 }),
  label: Type.String(),
  actor: Type.Union([Type.Literal("user"), Type.Literal("lead")]),
  // 凭什么做：user 你本人；on_behalf Lead 在你这一轮里代你做；lead Lead 自己的权限；delegated 托管授权。
  authority: Type.Union([
    Type.Literal("user"), Type.Literal("on_behalf"), Type.Literal("lead"), Type.Literal("delegated"),
  ]),
  onBehalfOf: Type.Optional(Type.Literal("user")),
  sourceTurnId: Type.Optional(Type.String({ minLength: 1 })),
  reason: Type.String(),
  // 发出请求的凭证：页面入口是你的凭证，Lead 代你做时是那一轮来自的凭证，Lead 自己做时为 null。
  // 本机 plc.sock 换来的临时 admin 凭证编号是 0，所以不设下限。
  bindingId: Nullable(Type.Integer()),
  // 这个操作自己的记录，例如执行器停用前后的状态。
  detail: Type.Record(Type.String(), Type.Unknown()),
});
export type UiActionPerformedPayload = Static<typeof UiActionPerformedPayloadSchema>;

export const UI_ACTION_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: UI_ACTION_PERFORMED_KIND,
    sources: ["user", "lead"],
    // 你在页面上做了 Lead 请你去做的操作：等这个目标的 Lead 醒来。Lead 自己做的不了结等待（source 是 lead）。
    waitSignal: "user_action",
    payload: UiActionPerformedPayloadSchema,
    description: "经过操作层做成的一个工单以外的操作（UI Actions）：目标、操作、谁做的、凭什么。",
  },
];

for (const definition of UI_ACTION_EVENT_KINDS) registerEventKind(definition);
