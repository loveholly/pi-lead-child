// 工单以外的 UI 操作的定义（仓库 AGENTS.md「UI Actions」，.scratch/ui-action-parity/plan.md P01）。形状照工单操作
// （ticket-actions/types.ts）：每个操作只定义一次，写明目标类型、输入（protocol 的 UI_ACTION_INPUT_SCHEMAS）、谁能做、
// 是否对外、是否不可逆、用户去哪里点、现在能不能做（available）、真正执行（run）。页面（HTTP）和 Lead（list_actions、
// perform_action）都经过 index.ts 的 runUiAction，所以两个入口做同样的检查，记同样的账本，只是 actor 不同。
import type { RuntimeDisabledBy, RuntimeId, RuntimeSwitchBy } from "@pi-lead-child/core";
import type {
  ActionPermission, ChannelCardAction, ChannelCardDto, ChannelPolicyParams, ChannelPolicyReplayResult, ChannelPolicyTestRequest, ChannelPolicyTestResult,
  FollowUpActionResult, LeadModelCatalog, LeadQueue, LeadModelChoice, LeadModelSwitchResult, MemoryHindsightDto, MemoryTestResponse,
  HandbookRehearsal, HandbookRehearsalRequest, ModelSettingsDto, SetSummaryModelRequest, SummaryModelSlot,
  RuntimeSettingsDto, RuntimeSettingsRequest, SaveFastModelRequest, SaveModelProviderRequest, Scope, SetBrainChainRequest,
  SetFastChainRequest, TimerOrigin, UiActionTargetType, UserActionRequest,
} from "@pi-lead-child/protocol";
import type { Db, OwnerActionInput } from "@pi-lead-child/store";
import type { ChannelOpenCard, ChannelReaction, ChannelSentMessage } from "../channels/types.js";
import type { ActionAttribution } from "../ticket-actions/attribution.js";
import type { SmartTextComplete } from "../smart-model/types.js";
import type { TicketActionHost } from "../ticket-actions/lifecycle.js";
import type { PullRequestRunner } from "../coordinator/delivery.js";
import type { NotesMemory } from "../memory/notes-memory.js";
import type { WidgetCommandRunner } from "../pipeline/widget-source-runner.js";
import type { ExternalContentSource, RuleChangeConfirm } from "./external-content.js";
import {
  TicketActionError,
  type Availability, type TicketActionAuthority, type TicketActionCaller, type TicketActionErrorCode,
} from "../ticket-actions/types.js";

// 谁在调用：和工单操作一样。页面是你本人（带上发出请求的凭证和来源），Lead 带上当前这一轮的 id。
// externalContent：这一轮带着外部内容（external-content.ts），写明是哪些。daemon 记，Lead 改不了。没有时为 null 或不给。
// confirmation：用户在改规则的确认卡上点了「确认这一次」，系统凭这张卡、以 Lead 代用户的名义执行卡上存下的那一个操作
// （rule-change-confirmations.ts）。只有确认卡的执行会给它；操作层只认卡上存下的操作和参数。Lead 的工具不给它。
// timerOrigin：这次动定时器是谁要求的（timers.ts，spec D16）。Lead 的工具按这一轮的来历算，模型改不了；不给时按 by 算。
export type UiActionCaller =
  | Extract<TicketActionCaller, { kind: "user" }>
  | (Extract<TicketActionCaller, { kind: "lead" }> & {
    externalContent?: readonly ExternalContentSource[] | null;
    confirmation?: { id: string; bindingId: number };
    timerOrigin?: TimerOrigin | null;
  });
export type UiActionAuthority = TicketActionAuthority;

// 执行器的开关（apps/daemon 的 runtime-settings.ts 的 RuntimeSettings）。设置页和 Lead 都经过操作层调它的 update。
export interface RuntimeSwitchService {
  get(): RuntimeSettingsDto;
  // 这个执行器是谁停用的。没停用、或者来历不明时为 null（按用户停用的处理）。
  disabledBy(runtime: RuntimeId): RuntimeDisabledBy | null;
  update(request: RuntimeSettingsRequest, by: RuntimeSwitchBy): Promise<RuntimeSettingsDto>;
}

// 操作层要的服务。它们在 daemon 里建（engine 不 import daemon），由两个入口各自交进来，是同一个对象。
// 没有的服务（测试、还在启动）：用到它的操作报「还没有启动」。
export interface UiActionServices {
  runtimeSettings?: RuntimeSwitchService;
  // 外部消息卡（daemon 的通道 hub）。通道在 Lead 会话之后才建好，没有接任何来源时没有它。
  channelCards?: ChannelCardActionService;
  // 往外部来源的一个对话里直接发消息（通道 hub 的 sendMessage），不经过卡片。和 channelCards 同时有。
  channelMessages?: ChannelMessageService;
  // 自动代你处理的「测一条消息」（通道 hub 的 testPolicy）：要快模型和来源的上下文。和 channelCards 同时有。
  channelPolicyTests?: ChannelPolicyTestService;
  // 交接说明的「预演一条消息」（通道 hub 的 rehearseHandbook）：要快模型。和 channelCards 同时有。
  channelHandbookRehearsal?: { rehearse(request: HandbookRehearsalRequest): Promise<HandbookRehearsal> };
  // Lead 自己的模型（daemon 的 lead-models.ts）。Lead 的会话建好以后才有。
  leadModels?: LeadModelService;
  // Lead 忙时排着的外部消息（daemon 的 lead-input.ts，工单 10）。Lead 的会话建好以后才有。
  leadQueue?: LeadQueueService;
  // Lead 忙时用户排着的追问（daemon 的 server.ts，用户 2026-10-28）。Lead 的会话建好以后才有。
  followUps?: FollowUpQueueService;
  // 设置 → 模型（daemon 的 model-settings.ts，2026-10-29）。Lead 的会话建好以后才有（换大脑的模型要用会话）。
  modelSettings?: ModelSettingsService;
  // 设置 → 记忆的 Hindsight 部分（daemon 的 memory-controller.ts，2026-10-29）。daemon 托管记忆服务时才有。
  memorySettings?: MemorySettingsService;
  // Lead 的笔记记忆（daemon 的 NotesMemory：写 notes，再交给 Hindsight）。常驻偏好的改、删、撤销经过它。
  // 没有时（测试）操作层用一个不接后端的 NotesMemory：笔记照样写进 notes，daemon 下一次同步再交给 Hindsight。
  notesMemory?: NotesMemory;
  // 控件的数据源跑命令用的（daemon 里是 Lead 的 bash 沙箱，和后台检查同一个）。建、改数据源时先跑一次，看输出能不能画成卡。
  // 没有时（测试、没接沙箱）带数据源的建和改被拒绝。
  widgetCommands?: WidgetCommandRunner;
  // 便宜模型的自由文本补全（Lead 的 SmartModel 的 LLM 后端，和把对话整理成事实的是同一个）。代回复风格的提炼用它。
  // Lead 的会话建好以后才有；没有 LLM 后端时返回 null。
  textModel?: () => SmartTextComplete | null;
  // 工单操作的宿主（daemon 的用户操作服务，和页面上的工单操作是同一个）：确认卡放行 Lead 被拦下的工单操作时用它。
  ticketActions?: { host: TicketActionHost; pullRequestRunner?: PullRequestRunner };
}

// 用户排着的一条追问（protocol 的 lead-follow-ups.ts）。
export interface FollowUpEntry {
  // 用户那一轮的 turn id，也是操作层 follow_up 的目标编号。
  turnId: string;
  // 用户的原话（给 Lead 看时截短）。
  text: string;
  // 用户发出它的时间（ISO）。
  at: string;
  // 它不在 pi 的队列里，要等这一轮结束后单独开一轮（daemon 的 carryOverTurns）：插不进正在跑的这一轮。
  heldForOwnTurn: boolean;
  // heldForOwnTurn 时为什么要单独开一轮，用户能看懂的一句话（不带句号）。不给时按「这一轮读过外部内容」说。
  heldReason?: string | null;
}

// 用户排着的追问（daemon 的 queuedInputs 和 carryOverTurns）。状态栏和 Lead 都经过操作层调它。
// steer、cancel 执行时再核对一次：这条还排着（没有在这期间交给 Lead），否则抛 UiActionError。
export interface FollowUpQueueService {
  // 排着的追问，按用户发出的先后。
  snapshot(): FollowUpEntry[];
  // 插进 Lead 正在做的这一轮：pi 的队列按原来的先后放回去，这一条改成 steer。
  steer(turnId: string): Promise<FollowUpActionResult>;
  // 不再发给 Lead：从 pi 的队列（或者等单独开一轮的队列）里拿掉，这一轮不再被回答。by 写进账本，例如「user via Mac 网页（binding 3）」。
  cancel(turnId: string, by: string): Promise<FollowUpActionResult>;
}

// Lead 忙时排着的外部消息（protocol 的 lead-queue.ts）。状态栏、面板和 Lead 都经过操作层调它。
export interface LeadQueueService {
  // 排着的对话（按 Lead 处理的顺序）和 Lead 在不在一轮里。
  snapshot(): LeadQueue;
  // 排到下一个：这一轮结束以后 Lead 先处理这个对话。返回排好以后的样子。
  moveNext(key: string): LeadQueue;
  // 移出队列：你自己处理。这个对话排着的消息的卡结束（和卡上的「我自己回」一样），Lead 不再处理它们。by 写进卡的账本。
  remove(key: string, by: string): Promise<LeadQueue>;
}

// 设置 → 模型（protocol 的 model-settings.ts）：大脑和直觉的分工、服务商、直觉的每一条。设置页和 Lead 都经过操作层调它。
// 校验不过时抛 UiActionError（invalid_input：说明哪里不对；not_found；unavailable）。
export interface ModelSettingsSummary {
  brain: { chain: string[]; current: string; providers: string[] };
  fast: { chain: string[]; models: Array<{ id: string; name: string; host: string | null; keySet: boolean }>; llmFallback: string | null };
  maxBackups: number;
}

export interface ModelSettingsChange {
  // 一句话说改了什么，账本和 Lead 都用它（不带 key）。
  summary: string;
  // 大脑的分工：now 已经换好；after_turn 这一轮结束以后换；unchanged 主用没变。别的改动没有它。
  applied?: "now" | "after_turn" | "unchanged";
  // 要告诉用户的一句话（例如换了主机，原来的 key 删掉了）。没有时为 null。
  note?: string | null;
  // 新加的那一条直觉的编号。
  id?: string;
}

// 设置 → 记忆的 Hindsight 部分（protocol 的 memory-hindsight.ts）：摘要模型、写入情况。设置页和 Lead 都经过操作层调它。
export interface MemorySettingsSummary {
  enabled: boolean;
  summaryModels: Array<{ slot: string; model: string | null; source: string; problem: string | null }>;
  writes: { notes: number; completed: number; pending: number; failed: number; lastError: string | null };
}

export interface MemorySettingsChange {
  // 一句话说改了什么，账本和 Lead 都用它。
  summary: string;
  // 要告诉用户的一句话（例如记忆服务要重启）。没有时为 null。
  note: string | null;
}

export interface MemorySettingsService {
  // 不查 Hindsight 的概要。list_actions 给 Lead 看的就是它。
  summary(): MemorySettingsSummary;
  // 页面用的整份（加上记忆库的统计）。
  hindsight(): Promise<MemoryHindsightDto>;
  setSummaryModel(request: SetSummaryModelRequest): Promise<MemorySettingsChange>;
  testSummaryModel(slot: SummaryModelSlot): Promise<MemoryTestResponse>;
  retryFailedWrites(): Promise<MemorySettingsChange>;
}

export interface ModelSettingsService {
  // 不拉目录的概要。list_actions 给 Lead 看的就是它。
  summary(): ModelSettingsSummary;
  // 页面用的整份（拉各个服务商的目录）。
  get(): Promise<ModelSettingsDto>;
  setBrainChain(request: SetBrainChainRequest): Promise<ModelSettingsChange>;
  saveProvider(request: SaveModelProviderRequest): Promise<ModelSettingsChange>;
  removeProvider(name: string): Promise<ModelSettingsChange>;
  saveFastModel(request: SaveFastModelRequest): Promise<ModelSettingsChange>;
  removeFastModel(id: string): Promise<ModelSettingsChange>;
  setFastChain(request: SetFastChainRequest): Promise<ModelSettingsChange>;
  testFastModel(id: string): Promise<MemoryTestResponse>;
}

// Lead 的模型和推理强度（protocol 的 lead-models.ts）。会话输入框和 Lead 都经过操作层调它的 switch。
export interface LeadModelService {
  // 正在用的和你选的。不拉目录。
  state(): { current: LeadModelChoice; selected: LeadModelChoice };
  // 可选的模型：所有 provider 的目录，带能不能看图、推理强度和额度封禁。
  catalog(): Promise<LeadModelCatalog>;
  // 换模型：查它在不在目录里、推理强度支不支持（不支持时抛错，说明可选的），写进 config.json 的 lead.models（排第一），
  // Lead 空闲时马上换，正在回答时这一轮结束后换。
  switch(choice: LeadModelChoice): Promise<LeadModelSwitchResult>;
}

export interface ChannelPolicyTestService {
  // 一条消息：请求 A、B 真的打分，再按给的参数算。
  test(source: string, request: ChannelPolicyTestRequest): Promise<ChannelPolicyTestResult>;
  // 过去 24 小时的消息，按 before（现在生效的）和 after（给的）两份参数各算一遍。
  replay(source: string, before: ChannelPolicyParams, after: ChannelPolicyParams): Promise<ChannelPolicyReplayResult>;
}

export interface ChannelMessageService {
  // 这个来源能不能直接发消息。
  canSend(source: string): boolean;
  // 发一条。出错时抛带 code 的 ChannelActionError（not_found：对话找不到；outbound_failed；unavailable）。
  // 这个对话里等你的卡跟着结束；cardId 是这条消息做的那张卡；seenBefore 是你这一轮开始的时间（engine 的 ChannelHub.sendMessage）。
  // forUser：你本人或者 Lead 在你这一轮里代你发。false 是 Lead 自己发的：Lead 判断，署名写 auto-reply，回复等你的卡时留撤回窗口；
  // event 是回复的那条消息事件。refusal：用固定的话拒绝（不是固定的话、授权表不让、外部客户或外部共享的对话时抛 invalid_action）。
  send(conversationId: string, input: {
    text: string; words: "user" | "assistant"; by: string; forUser: boolean; cardId?: number; event?: number; seenBefore?: number | null;
    refusal?: boolean;
  }): Promise<ChannelSentMessage>;
  // 回一个表情（缺省回对方最后一条）。出错时抛带 code 的 ChannelActionError（invalid_action：表情名不对；not_found；outbound_failed）。
  react(conversationId: string, input: { emoji: string; seq?: number; remove?: boolean; by: string; seenBefore?: number | null }): Promise<ChannelReaction>;
  // 还在等你的卡（Lead 发完消息自查用）。
  openCards(): ChannelOpenCard[];
}

// 外部消息卡的动作（engine 的 ChannelHub.act、actionsFor）。by 写进卡的账本，例如「user via Mac 网页（binding 3）」。
// act 出错时抛带 code 的 ChannelActionError（not_found、conflict、invalid_action、outbound_failed、unavailable）。
export interface ChannelCardActionService {
  // 这张卡现在能做的动作（和页面上的按钮是同一份）。
  actionsFor(cardId: number): ChannelCardAction[];
  // forUser：你本人（页面）或者 Lead 在你这一轮里代你做。false 是 Lead 自己做的：回复带 auto-reply 署名（engine 的 ChannelHub.act）。
  act(cardId: number, action: ChannelCardAction, options: {
    by: string; forUser: boolean; expectedVersion?: number; text?: string; note?: string; emoji?: string; react?: boolean;
  }): Promise<ChannelCardDto>;
}

export interface UiActionEnv {
  db: Db;
  services: UiActionServices;
  now: Date;
}

// 一种目标：怎么按编号找到它，给 Lead 看什么。
export interface UiActionTargetKind<T> {
  type: UiActionTargetType;
  // 「执行器」「设备」。
  label: string;
  // 编号长什么样（进工具说明）。
  idHint: string;
  // 找不到时返回 null（操作层报 not_found）。
  load(env: UiActionEnv, id: string): T | null;
  // 一句话的名字，例如「执行器 Codex」。
  name(target: T): string;
  // list_actions 里给 Lead 看的现状。不放密钥。
  describe(target: T): Record<string, unknown>;
}

export interface UiActionRun<T, I> {
  db: Db;
  env: UiActionEnv;
  // 操作之前的目标。
  target: T;
  targetId: string;
  input: I;
  // 为什么做：你给的，或者这个操作的默认说法；Lead 必须给。
  reason: string;
  reasonGiven: boolean;
  by: ActionAttribution;
  authority: UiActionAuthority;
  // Lead 调用时的当前轮次；你本人调用时为 null。它不是授权：授权在 by.onBehalfOf。
  turnId: string | null;
  // Lead 代你做（on_behalf）时你这一轮开始的时间（毫秒）：这以后才出现的你说话时还没见过。别的情况为 null。
  turnStartedAt: number | null;
  // 这次凭的配对凭证：页面入口是发出请求的凭证，Lead 代你做时是那一轮来自的凭证，Lead 自己做时为 null。
  bindingId: number | null;
  // 动定时器的操作：谁要求的（调用方给的 timerOrigin）。没给时为 null，操作按 by 算。
  timerOrigin: TimerOrigin | null;
  // Lead 调用时这一轮带着的外部内容（没有时为 null）。
  externalContent: readonly ExternalContentSource[] | null;
}

export interface UiActionDefinition<T = any, I = any> {
  target: UiActionTargetType;
  id: string;
  label: string;
  // 页面入口要的 scope。
  scope: Scope;
  // 谁能做。多数是固定的；有的按目标现在的状态算（例如启用：Lead 停用的 Lead 自己能启用），那时 permissionNote 写给 Lead 看。
  permission: ActionPermission | ((target: T, env: UiActionEnv) => ActionPermission);
  permissionNote?: string;
  // 只属于用户的这个操作仍然只认用户本人这一轮（ui-actions/authority.ts 第 5 条），例如 child 的审批。
  // 别的 Lead 在哪一轮都能做。加它之前先问用户。
  userTurnOnly?: boolean;
  // 改规则的操作（external-content.ts）：授权表、投递规则（常设指令）、连接配置、设置页的选项。外部的一轮里 Lead 做不了。
  // 每个操作都要写明。新加的操作属于这几类时写 true。
  changesRules: boolean;
  // 不改规则、但外部的一轮里也不能替用户做的操作：例如批准 child 的动作（2026-10-28，放开 userTurnOnly 时留下的一条底线：
  // Slack 里的话不能替用户批准）。值是一句话，说这是什么（不带句号），按目标算时返回 null 表示这次不受限。
  // 外部的一轮里和改规则的操作一样：拒绝，带确认卡。
  externalTurnFloor?: string | ((target: T) => string | null);
  // 写进 Lead（和子 agent）提示词的设置，例如代回复风格：带着外部内容的一轮一律拒绝，用户本人正在说话的一轮也一样
  // （AGENTS.md：名字、人格、风格、外观这类设置）。要和 changesRules: true 一起写。
  promptSetting?: boolean;
  // 外部的一轮里被拒时只拒绝，不带确认卡（用户 2026-10-29：「弹确认卡干什么？我什么时候说过要给我弹确认卡了」）：
  // 不存待确认的操作，不推任何要用户点的东西。值是 Lead 下一步怎么做（一句话，不带句号）。
  // 写了它的操作和 promptSetting 一样，用户本人正在说话的一轮读过外部内容也拒绝。
  // 不写时按缺省：改规则的操作、externalTurnFloor 的操作被拒时带确认卡（工单 09）。
  externalRefusalNext?: string;
  external: boolean;
  // 有的按目标算（例如清理工作区：隔离 worktree 的清理删掉目录，不可逆；共享工作区的不是），那时 permissionNote 写给 Lead 看。
  irreversible: boolean | ((target: T) => boolean);
  // 用户自己去哪里点，例如「设置 → 执行 → 执行器」。Lead 被拒（user_direct、要用户这一轮）时，拒绝里写它。
  // 有的按目标算（例如 Lead 提议的常设指令修改在确认卡上决定）。
  where: string | ((target: T) => string);
  // 给 Lead 的一句话：什么时候用。进 perform_action 的工具说明。
  hint: string;
  // 你没写原因时账本里的说法。
  defaultReason: string;
  available(target: T, env: UiActionEnv): Availability | Promise<Availability>;
  // 要就地确认的操作（不可逆，例如清理隔离 worktree）：确认条上的那一句，说明会发生什么。不用确认时返回 null。
  // 要确认时 input 必须带 confirm: true，否则操作层拒绝（needs_confirmation）。确认的文字来自这里，不由页面或 Lead 写。
  confirm?(target: T): string | null;
  // 只对 delegated：这一次在托管或长期授权范围内。
  delegatedScope?(target: T, env: UiActionEnv): boolean;
  run(run: UiActionRun<T, I>): unknown;
  // Lead 拿到的结果（perform_action 和专用工具的文字和 details）。必须写：run 的结果可能带着不该进 Lead 上下文的东西，
  // 例如审批的原始 payload（child 原样传入，可能有密钥或注入文字）、凭证的哈希。页面入口仍然拿 run 的结果。
  forLead(run: UiActionRun<T, I>, result: unknown): unknown;
  // 只对 Lead 代你做（on_behalf）：目标最晚什么时候出现（毫秒）。它要早于你这一轮开始的时间。你这一轮开始以后才出现的
  // （例如插进这一轮的事件带来的审批），你说话时还没见过，不能算你要求的（审查 2026-10-22 第 2 条）。
  appearedAt?(target: T): number;
  // 只读的操作（例如自动代你处理的「测一条消息」）：什么都没改，不记账本，也不记主人操作。
  readOnly?: boolean;
  // 记进账本（ui_action.performed 的 detail）：这次改了什么。
  detail?(run: UiActionRun<T, I>, result: unknown): Record<string, unknown>;
  // 操作成功以后要记的主人操作（protocol 的 OWNER_ACTIONS）。没有时不给，或者返回 null。
  ownerActionInput?(run: UiActionRun<T, I>, result: unknown): OwnerActionInput | null;
}

export function uiWhereOf<T>(definition: Pick<UiActionDefinition<T>, "where">, target: T): string {
  return typeof definition.where === "string" ? definition.where : definition.where(target);
}

export function uiIrreversibleOf<T>(definition: Pick<UiActionDefinition<T>, "irreversible">, target: T): boolean {
  return typeof definition.irreversible === "boolean" ? definition.irreversible : definition.irreversible(target);
}

export function uiPermissionOf<T>(definition: Pick<UiActionDefinition<T>, "permission">, target: T, env: UiActionEnv): ActionPermission {
  return typeof definition.permission === "string" ? definition.permission : definition.permission(target, env);
}

// Lead 被拒时拿到的结构化拒绝：哪个操作、为什么、用户去哪里点。
export interface UiActionRefusal {
  code: Extract<TicketActionErrorCode, "user_direct" | "needs_user_turn" | "external_turn">;
  target: { type: UiActionTargetType; id: string };
  action: string;
  label: string;
  permission: ActionPermission;
  // 用户自己去哪里点。
  where: string;
  message: string;
  // 只对 external_turn：确认卡（工单 09）要用的数据。id 是系统存下这一个操作的确认号。
  confirm?: RuleChangeConfirm & { id?: string };
  // 只对 external_turn：确认卡的 user_action，Lead 原样放进 UserAction。存不下时没有它。
  userAction?: UserActionRequest;
}

// 操作层的拒绝。和工单操作同一类错误（TicketActionError），入口按 code 映射成 HTTP 状态；Lead 被拒时带着 refusal。
export class UiActionError extends TicketActionError {
  constructor(code: TicketActionErrorCode, message: string, readonly refusal: UiActionRefusal | null = null) {
    super(code, message);
    this.name = "UiActionError";
  }
}
