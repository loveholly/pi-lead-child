// Lead 的输入（Lead 事件主干 spec D6、D7，工单 04）。系统交给 Lead 的事都从事件日志来，按游标读：
//   · 游标记在 kv 里（store 的 lead-cursor.ts），表示 Lead 已经处理完的最后一个事件序号。Lead 每一轮开始时，
//     daemon 取游标之后的事件；这一轮成功以后游标才前进；失败或重启就从原位置重读，用序号去重。
//   · 每个事件按路由交给 Lead（leadEventRoute）：
//       message：tell、interrupt 级的事，作为一条系统事件交给 Lead（单独一轮；interrupt 在 Lead 忙时插话）；
//       situation：digest、auto、record 级的事，不单独交给 Lead，只写进当前局面（每一轮输入开头的 system_event 信封，
//         不放进系统提示：系统提示一变，整段对话的提示缓存就失效了）；
//       skip：不交给 Lead（用户自己的消息走会话，Lead 自己回合的结果，给用户的即时通知走播报流程，组件的调用记录）。
//   · 外部来源（不是内部来源的）的事件永远不插话，不管级别（busyPlacement）。
//   · 05 的规则层：按根因合并进别的事件的，跟着合并到的那一条交给 Lead，写明合并了哪几张工单（carriedMerges）；
//     到时限升级的原事件不再交，交升级的那一条。当前局面里列出的摘要，这一轮成功以后记成 digested（markEventsDigested）。
//   · 关于 Lead 自己的事（lead.compaction_failed、lead.model_switched，工单 14）：record 级，写在当前局面的
//     「关于你自己」一节，不按预算截断，但最多 MAX_LEAD_SELF_LINES 行（leadSelfLines）。以前它们在 daemon 内存里（leadSelfNotes），重启就丢。
//   · 一件事长时间挡着游标时，后面处理完的序号收紧成区间（foldSettled，工单 14），记住的条目和读的窗口都不会一直涨。
//   · 排着的外部消息（统一消息事件 spec D6、D12，工单 10）：一轮只交一组（leadQueueUnits）。同一个对话里排着的消息合成一组，
//     取 Lead 开始处理时排着的全部，不额外等；系统事件照旧合成一组。用户「排到下一个」的对话排在最前面（promote）。
//     消息事件有了处置（卡结束了、移出了队列）就算处理完，不再交给 Lead。
// 这里只管读、排版和记账，不调模型：什么时候开一轮、插话还是排队由 server.ts 决定。
//
// 取代的旧通路：每一轮开头的 drainNotices 前缀、内存里的 childNotices、lead-wake 每 3 秒的 inbox 扫描。
// inbox 行的状态照旧维护（交给 Lead 时 delivered，这一行的事都处理完时 consumed，并记「看过了」），
// 界面的「Lead 处理中」和 Lead 不能工作时的兜底汇总（listLeadBacklog）还读它。
import {
  carryOverPendingInbox, countEvents, dueDigestBatch, getEvent, getItem, inboxDue, listEvents, listOpenLeadWaits,
  listWorkspaces, loadLeadEventCursor, markEventsDigested, markInbox, normalizeSeqRanges, pendingApprovals,
  recordSeenDispositions, reminderFireState, reminderIdOfFire, returnInboxToPending, saveLeadEventCursor,
  type Db, type EventRecord, type InboxRow, type SeqRange,
} from "@pi-lead-child/store";
import {
  COMPONENT_CALL_KINDS, CONNECTION_STATUS_CHANGED_KIND, CORE_MEMORY_CHANGED_KIND, DAEMON_STARTED_KIND, EVENT_SOURCES, LEAD_SELF_EVENT_KINDS,
  LEAD_WAIT_EXPIRED_KIND, LEAD_WAIT_LIMITS, LEAD_WAIT_SATISFIED_KIND, MEMORY_FACT_CHANGED_KIND, MESSAGE_EVENT_KIND, USER_REQUEST_EXPIRED_KIND,
  OWNER_ACTION_DISOWNED_KIND, OWNER_ACTION_PERFORMED_KIND, PUSHED_SECURITY_ALERT_KINDS, REMINDER_PUSHED_KIND,
  REMINDER_UNACKNOWLEDGED_KIND, reminderNeedsCheck, SYSTEM_TURN_ORIGINS, ticketNeedsUser, ticketNeedsUserLabel,
  TICKET_REPLY_ACTIONS_KIND, LEAD_QUEUE_EXCERPT_MAX,
  type LeadQueueEntry, type SystemTurnOrigin, type TicketSummary,
} from "@pi-lead-child/protocol";
import { localIso } from "@pi-lead-child/core";
import {
  DEFAULT_SITUATION_BUDGET_TOKENS, leadEventBlock, leadInboxEntryEvent, leadInboxEvents, leadMessageEventBlock, leadReminderEventBlock, leadSystemEvent,
  leadWaitEventBlock, renderLeadSituation, ticketRunAnnotation,
  type LeadReminderCardState, type SituationDigestGroup, type SituationRecordGroup,
} from "@pi-lead-child/lead";

// ── 路由（决策边界，纯函数）────────────────────────────────────────────────────────────

const INTERNAL_EVENT_SOURCES: ReadonlySet<string> = new Set(EVENT_SOURCES);
const PUSHED_SECURITY_ALERTS: ReadonlySet<string> = new Set(PUSHED_SECURITY_ALERT_KINDS);

/** 内部来源：daemon 自己的来源（用户、工单、Run、定时器、Lead、系统）。以后的 Slack、webhook 不是。 */
export function isInternalEventSource(source: string): boolean {
  return INTERNAL_EVENT_SOURCES.has(source);
}

export type LeadEventRoute = "message" | "situation" | "skip";

// 系统组件的调用记录（工单 13：decision_model.called、memory.recalled）。它们是遥测，写入时就有处置；
// Lead 自己的回合也会写（召回笔记、SmartModel），放进当前局面只会让每一轮都多几行和局面无关的数字。Lead 用 get_system_usage 查。
const COMPONENT_TELEMETRY_KINDS: ReadonlySet<string> = new Set(Object.values(COMPONENT_CALL_KINDS));

// 关于 Lead 自己的事件（工单 14）：record 级，写在当前局面的「关于你自己」一节。
const LEAD_SELF_KINDS: ReadonlySet<string> = new Set(LEAD_SELF_EVENT_KINDS);

export function leadEventRoute(event: Pick<EventRecord, "kind" | "level"> & { payload?: Record<string, unknown> }): LeadEventRoute {
  // 用户自己的消息走会话（channel_turns），Lead 自己回合的结果当前局面另有一行（最近一次失败）。
  if (event.kind === "user.message" || event.kind.startsWith("lead.turn_")) return "skip";
  if (COMPONENT_TELEMETRY_KINDS.has(event.kind)) return "skip";
  // 工单回复下面的动作按钮（2026-10-19，ticket-reply-actions.ts）：只给界面用。工单对话答完一轮另有 ticket_agent.turn_completed。
  if (event.kind === TICKET_REPLY_ACTIONS_KIND) return "skip";
  // 主人操作（工单 15）：系统自己推送给用户、自己贴会话卡，「不是我」由用户处理，Lead 不用为它开一轮。
  // 工单状态的变化另有 stage.changed，照常进当前局面。
  if (event.kind === OWNER_ACTION_PERFORMED_KIND || event.kind === OWNER_ACTION_DISOWNED_KIND) return "skip";
  // Lead 自己改的常驻偏好（core_memory.changed，2026-10-29）：是它自己做的，写下时就记成看过了，不用再告诉它。
  // 用户撤销了 Lead 的改动（actor 是 user）照常进当前局面：Lead 要知道用户不要这样改。
  // 事实失效（memory_fact.changed）同理。
  if ((event.kind === CORE_MEMORY_CHANGED_KIND || event.kind === MEMORY_FACT_CHANGED_KIND) && event.payload?.actor === "lead") return "skip";
  // 直接推送的安全报警（security-alerts.ts，2026-10-19 审查）同理：系统直接推给用户，不取决于 Lead。
  // 改动可能就是 Lead 派出的 child 做的。Lead 要看时用 query_events。config.json 被手改（tell 级）照常交给 Lead。
  if (PUSHED_SECURITY_ALERTS.has(event.kind)) return "skip";
  // Lead 自己设的跟进：设的时候不用告诉它（是它自己设的），到点时那条到点事件（timer.fired，tell 级）叫醒它。
  if (event.kind.startsWith("inbox.") && event.payload?.inboxKind === "lead_followup" && event.level === "record") return "skip";
  // 通道里只记录的消息（投递方式 record，例如订阅频道里别人的普通消息、没有卡可更新的改和删）只进事件日志：
  // 不开卡，也不进 Lead 的当前局面（slack-takeover spec D12：没有经过助手的消息不进 Lead 的上下文，不花 token）。
  if (event.level === "record" && event.payload?.role === "message" && event.payload?.channelDelivery === "record") return "skip";
  if (event.level === "tell" || event.level === "interrupt") {
    // 给用户的即时通知由播报流程单独请 Lead 说（server.ts 的 notifications 一步），有它自己的送达保证。
    return event.kind === "notification.created" ? "skip" : "message";
  }
  return "situation";
}

/** 提醒到点的事件（timer.fired，timer=reminder，工单 07）。daemon 为它单独开一轮，这一轮说的话挂在提醒卡下面。 */
export function isReminderFireEvent(event: Pick<EventRecord, "kind" | "entityKey" | "payload">): boolean {
  return reminderIdOfFire(event) !== null;
}

/**
 * 一条到点的提醒还要不要交给 Lead（决策边界，纯函数）：这一次到点还没结束（用户还没确认、没改期、没取消），
 * 或者关联了要 Lead 先查的事（工单、check），就交；用户在 Lead 处理它之前已经处理了、又没有要查的事，就不交：
 * 用户已确认时 Lead 一般不说话（spec D11），没有要说的就不为它开一轮。
 */
export function reminderStillForLead(card: { state: string; policy: { ticketId: number | null; check: string | null } }): boolean {
  return card.state === "fired" || reminderNeedsCheck(card.policy);
}

export type BusyPlacement = "steer" | "queue";

/**
 * Lead 正在跑一轮时到达的、要交给 Lead 的事件放在哪里（spec D6 的表）：interrupt 级插进这一轮；
 * 其余的排队，这一轮结束以后单独一轮。外部来源永远排队。整理笔记是 Lead 的内部回合，不往里插。
 */
export function busyPlacement(
  event: Pick<EventRecord, "level" | "source">, running: { origin: SystemTurnOrigin | null },
): BusyPlacement {
  if (event.level !== "interrupt") return "queue";
  if (!isInternalEventSource(event.source)) return "queue";
  if (running.origin === SYSTEM_TURN_ORIGINS.precipitate) return "queue";
  // 为一条到点的提醒单独开的一轮（工单 07）：这一轮说的话挂在那张提醒卡下面，别的事插进来就混在一起了。它很短，排在它后面。
  if (running.origin === SYSTEM_TURN_ORIGINS.reminder) return "queue";
  return "steer";
}

// ── 按批叫醒（digest）────────────────────────────────────────────────────────────────
// 「现在该不该为摘要叫醒 Lead、有哪些事件」。缺省按 05 的常设指令 events.digest_batch 判断（store 的 dueDigestBatch）。
export interface DigestBatchInput {
  now: Date;
  // 游标后面、还没处理完的 digest、auto 级事件：Lead 下一份当前局面里会列出的。
  pending: readonly EventRecord[];
  // 上一次为摘要叫醒 Lead 的时间（daemon 启动时算作启动的时间）。
  lastWakeAt: Date;
  // 用户最近一次回来（离开一段时间以后又在看会话）的时间。
  userReturnedAt: Date | null;
}

export interface DigestBatchDecision {
  wake: boolean;
  // 这一批的 digest 级事件。不该叫醒时是空的。
  events: readonly EventRecord[];
  reason: string;
  // 按等待时间该叫醒的时间（顶栏的「下一次自动调用」用）。没有在等的摘要时是 null。
  dueAt: Date | null;
}

export type DigestBatchPolicy = (db: Db, input: DigestBatchInput) => DigestBatchDecision;

/**
 * 缺省：按常设指令 events.digest_batch（dueDigestBatch）。最早的一条等满 maxWaitMs（种子是 25 分钟），或者用户回来了，就叫醒。
 * 只算 Lead 下一份当前局面里会看到的（input.pending）：游标前面的旧事件（工单 04 之前写的）和已经列给 Lead、
 * 等着别的处置的事件不为它们叫醒，不然它们一直没有 digested 的处置，每次轮询都叫醒一次 Lead。
 * auto 级的事自己不叫醒 Lead（spec D3：做完进摘要），跟着下一份当前局面交给 Lead。
 */
export const defaultDigestBatch: DigestBatchPolicy = (db, input) => {
  const visible = new Set(input.pending.filter((event) => event.level === "digest").map((event) => event.seq));
  const idle: DigestBatchDecision = { wake: false, events: [], reason: "没有在等的摘要", dueAt: null };
  if (!visible.size) return idle;
  const userReturned = input.userReturnedAt !== null && input.userReturnedAt.getTime() > input.lastWakeAt.getTime();
  const batch = dueDigestBatch(db, input.now, { userReturned, limit: 1000 });
  const events = batch.events.filter((event) => visible.has(event.seq));
  if (!events.length || !batch.dueAt || !batch.oldestReceivedAt) return idle;
  // 等多久由常设指令定：dueDigestBatch 的 dueAt 是最早一条的收到时间加 maxWaitMs。这里从 Lead 看得到的最早一条算。
  const maxWaitMs = Date.parse(batch.dueAt) - Date.parse(batch.oldestReceivedAt);
  const dueAt = new Date(Date.parse(events[0]!.receivedAt) + maxWaitMs);
  if (batch.reason === "user_returned") return { wake: true, events, reason: "用户回来了", dueAt };
  if (input.now.getTime() >= dueAt.getTime()) return { wake: true, events, reason: "最早的一条等满了", dueAt };
  return { wake: false, events: [], reason: "最早的一条还没等满", dueAt };
};

// ── 游标和每一轮的记账 ─────────────────────────────────────────────────────────────────

export type LeadRunKind = "user" | "events" | "digest" | "notification" | "internal";

export interface LeadInputOptions {
  db: Db;
  // 工单摘要（和网关、App 同一份 TicketSummary）：当前局面的「在进行的工单」。
  tickets?: () => TicketSummary[];
  budgetTokens?: number;
  now?: () => Date;
  log?: (line: string) => void;
  // 一次读游标后面的多少条事件（最多 1000）。
  readLimit?: number;
  // 对话通道的道（工单 11，spec D14）：给出有变化的对象键，返回其中是道的那些，各一行摘要（另加还有没结束的卡的道）。
  // 道里的事件不按对象列进「上一轮以后的变化」，当前局面里只放这一行。
  lanes?: (objectKeys: readonly string[]) => Map<string, string>;
  // 多久没有动静的工单在当前局面里折叠成一行（毫秒，2026-10-19）。不给或者不是正数时用 DEFAULT_IDLE_TICKET_MS。
  idleTicketMs?: number;
}

// 长期没有动静的工单折叠成一行（2026-10-19）：审查期间 Lead 的当前局面里列着 8 月的旧工单，每一轮都占上下文。
// 缺省 3 天，config.json 的 lead.situation.idleTicketHours 或环境变量 PLC_LEAD_IDLE_TICKET_HOURS 可以改（daemon 读）。
export const DEFAULT_IDLE_TICKET_MS = 72 * 3_600_000;
const MAX_IDLE_TICKET_IDS = 20;

/**
 * 一张工单是不是长期没有动静（决策边界，纯函数）：最近一次变化（更新、换 stage、Run 的活动）早于 now - idleMs，
 * 没有在跑的 Run，没有要用户处理的 blocker，没有 Lead 在处理的异常，也不在等用户。等用户的工单在「等用户决定的事」里另有一行。
 */
export function ticketIsIdle(ticket: TicketSummary, now: Date, idleMs: number): boolean {
  if (ticket.runtime.activeAttemptId !== null) return false;
  if (ticket.attention.blockerCount > 0 || ticket.attention.leadHandling) return false;
  if (ticketNeedsUser(ticket)) return false;
  const times = [ticket.updatedAt, ticket.stageChangedAt ?? null, ticket.runtime.lastActivityAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  if (!times.length) return false;
  return Math.max(...times) < now.getTime() - idleMs;
}

export interface TakenMessages {
  events: EventRecord[];
  // 交给 Lead 的文字：每件事一个 <system_event>。
  text: string;
  inboxIds: number[];
}

export interface SituationContext {
  // 用户排着队、还没交给 Lead 的消息有几条。
  queuedUserMessages: number;
  // 等着请 Lead 播报的即时通知有几条。
  queuedNotifications?: number;
  // Lead 的上下文用了多少（lead 的 contextUsageLine，lead-self-routing spec C）：写在「关于你自己」一节的第一行。
  contextUsage?: string | null;
}

interface RunState {
  kind: LeadRunKind;
  // 这一次运行的编号（摘要的处置 digested 带它，daemon 没有给轮次编号时用）。
  id: string;
  // 这一轮交给 Lead 的当前局面里「在进行的工单、未解决的问题、等用户决定的事」这一段（用来判断下一份有没有变化）。
  sentStatic?: string;
  // 作为消息交给这一轮的事件（开头给的，和插话插进来的）。
  inFlight: Map<number, EventRecord>;
  // 这一轮的当前局面里列出或计数过的事件。
  shown: Set<number>;
}

const INBOX_CORRELATION = /^inbox:(\d+)$/u;
const TERMINAL_STAGES = new Set(["done", "cancelled", "acked"]);
const PURPOSE_LABELS: Record<string, string> = {
  execution: "执行", review: "核查", integration: "合并", outcome_repair: "补交成果", learning: "学习", conversation: "工单对话",
};
const MAX_SITUATION_TICKETS = 40;
const MAX_RECORD_NOTES = 3;
const MAX_MERGED_LABELS = 5;
const LEAD_FAILURE_WINDOW_MS = 24 * 3_600_000;
const READ_CACHE_MS = 1_000;
// 游标后面要看的事件（不在已处理的区间里的）超过这么多条时收紧（工单 14，foldSettled）。
// 一次读游标后面最多 1000 条（readAfter），所以要在窗口被处理完的事件占满之前收紧。
export const SETTLED_FOLD_THRESHOLD = 500;

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
// 本地的「时:分」（提醒卡片的状态用）。
const clock = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : localIso(at).slice(11, 16);
};
// 本地的「月-日 时:分」（等待可能跨天）。
const shortTime = (iso: string): string => {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : localIso(at).slice(5, 16).replace("T", " ");
};
// 「3 天」「36 小时」。
const formatSpan = (ms: number): string => (ms % 86_400_000 === 0 ? `${ms / 86_400_000} 天` : `${Math.round(ms / 3_600_000)} 小时`);
const idOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);
const oneLine = (text: string, max = 160) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

export class LeadInput {
  private readonly db: Db;
  private readonly options: LeadInputOptions;
  private cursorSeq: number;
  // 游标后面已经处理完的序号。收紧以后并进 settledRanges（工单 14）。
  private readonly settled: Set<number>;
  // 游标后面已经处理完的连续区间，按起点排，互不重叠。换成新数组表示变了（readAfter 的缓存按它判断）。
  private settledRanges: SeqRange[];
  private run: RunState | null = null;
  // 上一次成功的一轮交给 Lead 的「在进行的工单、未解决的问题、等用户决定的事」。下一份和它一样时只写一行「没有变化」。
  // 上下文压缩以后（forgetSentSituation）、daemon 重启以后不知道 Lead 还记得什么，整段再给一次。
  private lastSentStatic: string | null = null;
  private afterCache: {
    cursor: number; ranges: SeqRange[]; head: number; at: number; events: EventRecord[]; unread: number;
  } | null = null;
  // 用户「排到下一个」的对话（工单 10）：对象键 → 第几次排的（后排的在更前面）。只在内存里：daemon 重启以后按先后排。
  // 这个对话排着的消息交出去了，或者都移出了队列，就忘掉它：以后再来的消息按先后排。
  private readonly promoted = new Map<string, number>();
  private promotions = 0;

  constructor(options: LeadInputOptions) {
    this.db = options.db;
    this.options = options;
    const saved = loadLeadEventCursor(this.db);
    if (saved) {
      this.cursorSeq = saved.seq;
      this.settled = new Set(saved.settled);
      this.settledRanges = saved.ranges;
      return;
    }
    // 第一次建立游标（新库，或者工单 04 之前的库）：游标放在日志的末尾，以前的事件不再交给 Lead。
    // 还没处理完的 inbox 行（以前由每一轮开头的 drainNotices 交给 Lead）各转成一条新的事件，排在游标后面，交一次。
    this.cursorSeq = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
    this.settled = new Set();
    this.settledRanges = [];
    this.save();
    const carried = carryOverPendingInbox(this.db);
    if (carried) options.log?.(`lead input: started the event cursor at #${this.cursorSeq}, carried over ${carried} pending inbox row(s)`);
  }

  /** 游标的位置（测试和日志用）。 */
  cursor(): { seq: number; settled: number[]; ranges: SeqRange[] } {
    return {
      seq: this.cursorSeq,
      settled: [...this.settled].sort((a, b) => a - b),
      ranges: this.settledRanges.map(([from, to]): SeqRange => [from, to]),
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private save(): void {
    saveLeadEventCursor(this.db, { seq: this.cursorSeq, settled: [...this.settled], ranges: this.settledRanges });
  }

  // 游标后面已经处理完：单个记着的，或者在收紧以后的区间里（区间按起点排，二分查找）。
  private isSettled(seq: number): boolean {
    if (this.settled.has(seq)) return true;
    let low = 0;
    let high = this.settledRanges.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [from, to] = this.settledRanges[middle]!;
      if (seq < from) high = middle - 1;
      else if (seq > to) low = middle + 1;
      else return true;
    }
    return false;
  }

  // 游标后面的事件，跳过收紧以后的区间（那里都处理完了）。daemon 每次轮询都要读（测试里每 20 毫秒一次），
  // 所以日志的末尾、游标和区间都没变、又刚读过时用上一次的。不能缓存太久：事件的级别会被改（05 的到时限升级）。
  private readAfter(): { events: EventRecord[]; unread: number } {
    const head = (this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
    const now = Date.now();
    const cached = this.afterCache;
    if (cached && cached.cursor === this.cursorSeq && cached.ranges === this.settledRanges && cached.head === head
      && now - cached.at < READ_CACHE_MS) return cached;
    const limit = Math.min(this.options.readLimit ?? 1000, 1000);
    const excludeRanges = this.settledRanges;
    const events = listEvents(this.db, { sinceSeq: this.cursorSeq, excludeRanges, limit });
    const unread = events.length === limit ? countEvents(this.db, { sinceSeq: events.at(-1)!.seq, excludeRanges }) : 0;
    this.afterCache = { cursor: this.cursorSeq, ranges: excludeRanges, head, at: now, events, unread };
    return this.afterCache;
  }

  private inboxRow(event: EventRecord, cache: Map<number, InboxRow | null>): InboxRow | null {
    const match = INBOX_CORRELATION.exec(event.correlationId ?? "");
    if (!match) return null;
    const id = Number(match[1]);
    if (!cache.has(id)) {
      cache.set(id, (this.db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as InboxRow | undefined) ?? null);
    }
    return cache.get(id) ?? null;
  }

  // 处理完了：游标后面已经处理过的，不交给 Lead 的，被别的事件取代了的，或者它那一行 inbox 已经消化掉了
  // （Lead 处理完了，或者取消了跟进）。到点的提醒在交给 Lead 之前用户已经处理了、又没有要查的事，也算处理完（工单 07）。
  private done(event: EventRecord, cache: Map<number, InboxRow | null>): boolean {
    if (this.isSettled(event.seq) || leadEventRoute(event) === "skip") return true;
    if (isReminderFireEvent(event) && !this.run?.inFlight.has(event.seq)
      && !reminderStillForLead(reminderFireState(this.db, event))) return true;
    // 05 的到时限升级把原事件记成 superseded，另写一条 event.escalated：升级的那一条接着交给 Lead，原事件不再交。
    // 按根因合并进来的（也是 superseded）不算处理完：它跟着合并到的那一条交给 Lead（carriedMerges）。
    if (event.disposition === "superseded" && mergedTargetOf(event) === null) return true;
    // 外部通道的消息事件有了处置（工单 10）：卡结束了（你自己回、不回、在来源里回了），或者移出了队列。Lead 不再处理它。
    if (event.kind === MESSAGE_EVENT_KIND && event.disposition !== null) return true;
    return this.inboxRow(event, cache)?.state === "consumed";
  }

  // 按根因合并进来、跟着合并到的那一条一起交给 Lead 的事件（spec D3：同一个根因 Lead 说一次），按合并到的那一条的序号分组。
  // 合并到的那一条已经交过了（处理完了、在这一轮的路上、在游标前面）时不在这里：合并进来的这一条单独交，
  // Lead 才知道又有一张工单因为同一个根因出了事。
  private carriedMerges(events: readonly EventRecord[], cache: Map<number, InboxRow | null>): Map<number, EventRecord[]> {
    const carried = new Map<number, EventRecord[]>();
    const open = (event: EventRecord) => !this.done(event, cache) && !this.run?.inFlight.has(event.seq);
    let bySeq: Map<number, EventRecord> | null = null;
    for (const event of events) {
      const target = mergedTargetOf(event);
      if (target === null) continue;
      bySeq ??= new Map(events.map((candidate) => [candidate.seq, candidate] as const));
      const primary = bySeq.get(target);
      if (!primary || mergedTargetOf(primary) !== null || !open(event) || !open(primary)) continue;
      carried.set(primary.seq, [...(carried.get(primary.seq) ?? []), event]);
    }
    return carried;
  }

  /** 游标后面、要作为消息交给 Lead、还没处理完、也不在路上的事件，按发生的先后。合并进别的事件、跟着它交的不算。 */
  pendingMessages(): EventRecord[] {
    const cache = new Map<number, InboxRow | null>();
    const { events } = this.readAfter();
    const carried = flattenSeqs(this.carriedMerges(events, cache));
    return events.filter((event) => leadEventRoute(event) === "message"
      && !this.done(event, cache) && !this.run?.inFlight.has(event.seq) && !carried.has(event.seq));
  }

  /**
   * 下一轮交给 Lead 的事（工单 10）：排在最前面的一组。到点的提醒不在这里（它各自单独一轮，daemon 的 wakeForEvents）。
   * 一组是同一个对话里排着的外部消息（Lead 开始处理时排着的全部），或者所有排着的系统事件。
   */
  nextMessages(): EventRecord[] {
    return this.queueUnits()[0]?.events ?? [];
  }

  /** 排着的外部消息，按对话分组，按 Lead 处理的顺序（状态栏和面板用，工单 10）。系统事件不在这里。 */
  queue(): LeadQueueEntry[] {
    const units = this.queueUnits();
    return units.flatMap((unit, index) => (unit.key === null ? [] : [queueEntryOf(unit.key, unit.events, index === 0)]));
  }

  /** 这个对话里排着、还没交给 Lead 的外部消息。没有时是空的。 */
  queuedMessages(key: string): EventRecord[] {
    return this.queueUnits().find((unit) => unit.key === key)?.events ?? [];
  }

  /** 用户把这个对话排到下一个（操作层的 lead_queue / move_next）。这个对话没有排着的消息时返回 false。 */
  promote(key: string): boolean {
    if (!this.queuedMessages(key).length) return false;
    this.promoted.set(key, ++this.promotions);
    return true;
  }

  /** 事件的处置在别处改了（移出队列）：下一次重新读，不用一秒内的缓存。 */
  refresh(): void {
    this.afterCache = null;
  }

  // 排着的事分组排好（leadQueueUnits）。没有排着的消息的对话，忘掉它的「排到下一个」。
  private queueUnits(): LeadQueueUnit[] {
    const pending = this.pendingMessages().filter((event) => !isReminderFireEvent(event));
    const live = new Set(pending.flatMap((event) => {
      const key = queueKeyOf(event);
      return key === null ? [] : [key];
    }));
    for (const key of [...this.promoted.keys()]) if (!live.has(key)) this.promoted.delete(key);
    return leadQueueUnits(pending, this.promoted);
  }

  /** 游标后面、还没处理完的 digest、auto 级事件（按批叫醒 Lead 用）。 */
  pendingDigest(): EventRecord[] {
    const cache = new Map<number, InboxRow | null>();
    return this.readAfter().events.filter((event) => leadEventRoute(event) === "situation"
      && (event.level === "digest" || event.level === "auto") && !this.done(event, cache));
  }

  /** Lead 忙时到达、要插进正在跑的这一轮的事件（spec D6：interrupt 级，内部来源）。 */
  pendingInterrupts(running: { origin: SystemTurnOrigin | null }): EventRecord[] {
    return this.pendingMessages().filter((event) => busyPlacement(event, running) === "steer");
  }

  /** 一次运行开始（daemon 的 runTurnNow）。上一次没有收尾的记账作废。 */
  beginRun(kind: LeadRunKind): void {
    this.run = { kind, id: this.runId(), inFlight: new Map(), shown: new Set() };
  }

  private runId(): string {
    return `lead-run:${this.now().toISOString()}`;
  }

  runKind(): LeadRunKind | null {
    return this.run?.kind ?? null;
  }

  /**
   * Lead 拿走了这件事没有：交给了正在跑的一轮，或者已经处理完（游标越过了它，或者记成处理完）。通道的入站层据此决定
   * 对方改的消息并不并进排着的那条消息事件（统一消息事件 spec D6）。
   */
  taken(seq: number): boolean {
    return seq <= this.cursorSeq || this.isSettled(seq) || this.run?.inFlight.has(seq) === true;
  }

  /**
   * 交给这一轮的事件（Lead 自己发起、为了处理这些事的一轮；或者插进正在跑的一轮的 interrupt 级事件）。
   * 标成在路上，这一轮成功才算处理完。对应的 inbox 行标成 delivered。
   */
  // steered：这些事插进 Lead 正在跑的一轮（interrupt 级）。到点的提醒在两种情况下的说法不一样（leadReminderEventBlock）。
  takeMessages(options: { events?: EventRecord[]; limit?: number; steered?: boolean } = {}): TakenMessages {
    const run = this.run ?? (this.run = { kind: "events", id: this.runId(), inFlight: new Map(), shown: new Set() });
    const events = (options.events ?? this.pendingMessages()).slice(0, options.limit ?? 30);
    const cache = new Map<number, InboxRow | null>();
    // 在把它们标成在路上之前算：合并到的那一条在路上时，合并进来的不再跟着它。
    const merges = this.carriedMerges(this.readAfter().events, cache);
    const blocks: string[] = [];
    const inboxIds: number[] = [];
    const delivered: EventRecord[] = [];
    // 同一个对话里一起交的几条外部消息（工单 10）：每条都带着一份上下文包（工单 04），内容大半重复，只给最新的那一份。
    const newestContext = new Map<string, number>();
    for (const event of events) {
      const key = queueKeyOf(event);
      if (key !== null && isRecord(event.payload.context)) newestContext.set(key, Math.max(newestContext.get(key) ?? 0, event.seq));
    }
    for (const event of events) {
      run.inFlight.set(event.seq, event);
      delivered.push(event);
      const row = this.inboxRow(event, cache);
      const reminder = isReminderFireEvent(event) ? this.reminderCard(event) : null;
      if (reminder) {
        blocks.push(leadReminderEventBlock(event, reminder, { placement: options.steered ? "steered" : "dedicated", clock }));
      } else if (event.kind === MESSAGE_EVENT_KIND) {
        // 外部通道的消息事件（统一消息事件 spec D1，工单 03）：结构化的事实，加上外部标签里的原话。
        const contextIn = newestContext.get(queueKeyOf(event) ?? "");
        blocks.push(leadMessageEventBlock(event, contextIn === undefined ? {} : { contextIn }));
      } else if (event.kind === LEAD_WAIT_SATISFIED_KIND || event.kind === LEAD_WAIT_EXPIRED_KIND) {
        // 你在等的事（2026-10-19，store 的 lead-waits.ts）：写明当时的备注和发生了什么。
        blocks.push(leadWaitEventBlock(event, { clock: shortTime }));
      } else if (!row) {
        blocks.push(leadEventBlock(event));
      } else {
        if (!inboxIds.includes(row.id)) {
          inboxIds.push(row.id);
          blocks.push(...leadInboxEvents(row));
        }
        // 并进这一行的一条（合并、熔断折叠进来的）：那一行的文字里没有它的摘要时，单独给。
        const summary = textOf(event.payload.summary);
        if (event.payload.delivery !== "row" && summary && !rowMentions(row, summary)) {
          blocks.push(leadInboxEntryEvent({
            inboxId: row.id, itemId: row.item_id, severity: String(event.payload.severity ?? row.severity), summary,
            payload: isRecord(event.payload.payload) ? event.payload.payload : {},
          }));
        }
      }
      // 按根因合并进这一件的：跟着它交，写明是哪几张工单，Lead 说一次。
      const merged = merges.get(event.seq) ?? [];
      for (const other of merged) {
        run.inFlight.set(other.seq, other);
        delivered.push(other);
        const otherRow = this.inboxRow(other, cache);
        if (otherRow && !inboxIds.includes(otherRow.id)) inboxIds.push(otherRow.id);
      }
      if (merged.length) {
        blocks.push(leadSystemEvent("event", this.mergedNote(event, merged), { topic: "merged_root_cause" }));
      }
      // 合并到的那一件已经交过了：这一件单独交，说明它和哪一件同一个根因。
      const standalone = this.standaloneMergeNote(event);
      if (standalone) blocks.push(leadSystemEvent("event", standalone, { topic: "merged_root_cause" }));
    }
    if (inboxIds.length) markInbox(this.db, inboxIds, "delivered");
    return { events: delivered, text: blocks.join("\n"), inboxIds };
  }

  // 一条到点的提醒现在卡片的状态（工单 07）：推了几次、用户确认了没有、关联的工单。
  private reminderCard(event: EventRecord): LeadReminderCardState {
    const state = reminderFireState(this.db, event);
    const ticket = state.policy.ticketId !== null ? getItem(this.db, state.policy.ticketId) : undefined;
    return {
      reminderId: state.reminderId, title: state.title, remindAt: state.remindAt, level: state.level, state: state.state,
      closedAt: state.closedAt, closedBy: state.closedBy, nextAt: state.nextAt, pushes: state.pushes,
      ticket: ticket ? { id: ticket.id, title: ticket.display_title ?? ticket.title, stage: ticket.stage } : null,
      check: state.policy.check,
    };
  }

  /** 插进正在跑的一轮、却没有送到模型的事件（这次运行结束时还在 pi 的队列里）：不算交给了这一轮。 */
  release(seqs: readonly number[]): void {
    for (const seq of seqs) this.run?.inFlight.delete(seq);
  }

  /** 这一轮交给 Lead 的事件有没有（决定失败时要不要按退避再叫醒 Lead）。 */
  carriesMessages(): boolean {
    return Boolean(this.run?.inFlight.size);
  }

  /** Lead 的上下文压缩过了：它不一定还记得上一份当前局面，下一份整段给。 */
  forgetSentSituation(): void {
    this.lastSentStatic = null;
  }

  /**
   * 当前局面（spec D7）。每一轮开头生成一份，放在这一轮输入的开头（daemon 的 runTurnNow，排队消息的开头）。
   * 列出和计数过的变化记在这一轮上，这一轮成功以后算处理完。「在进行的工单、未解决的问题、等用户决定的事」
   * 和上一份一样时只写一行，不重复放。
   */
  renderSituation(context: SituationContext): string {
    const db = this.db;
    const cache = new Map<number, InboxRow | null>();
    const { events, unread } = this.readAfter();
    const merges = this.carriedMerges(events, cache);
    const carried = flattenSeqs(merges);
    const open = events.filter((event) => !this.done(event, cache) && !carried.has(event.seq));
    // 排队中：要交给 Lead、还没交的事，按类别和来源各一行。不写内容。
    const queuedCounts = new Map<string, number>();
    for (const event of open) {
      if (leadEventRoute(event) !== "message" || this.run?.inFlight.has(event.seq)) continue;
      const label = `系统事件 ${event.kind}，来源 ${event.source}`;
      queuedCounts.set(label, (queuedCounts.get(label) ?? 0) + 1);
    }
    const queued = [...queuedCounts].map(([label, count]) => ({ label, count }));
    if (context.queuedUserMessages > 0) queued.unshift({ label: "用户的排队消息", count: context.queuedUserMessages });
    if (context.queuedNotifications) queued.push({ label: "给用户的即时通知（系统会单独请你播报）", count: context.queuedNotifications });
    // 上一轮以后的变化：digest 级按对象合并，record 级按对象只给数量。
    // 对话通道的道（工单 11）里的事件不逐条列：每条道一行摘要（spec D14），一样算这一轮交给了 Lead。
    const situationEvents = open.filter((event) => leadEventRoute(event) === "situation");
    const lanes = this.options.lanes?.(situationEvents.map((event) => event.entityKey)) ?? new Map<string, string>();
    for (const event of situationEvents) if (lanes.has(event.entityKey)) this.run?.shown.add(event.seq);
    const changes = situationEvents.filter((event) => !lanes.has(event.entityKey));
    // 写进这一轮当前局面的 inbox 行算交给了 Lead（delivered），这一轮成功以后消化掉（endRun）。整理笔记不算。
    if (this.run && this.run.kind !== "internal") {
      const shownRows = [...new Set(changes.flatMap((event) => [event, ...(merges.get(event.seq) ?? [])]).flatMap((event) => {
        const row = this.inboxRow(event, cache);
        // Lead 给自己设的跟进到点之前不算交给了 Lead：到点时它的到点事件再叫醒 Lead（recordDueLeadFollowUps）。
        return row && row.state === "pending" && inboxDue(row, this.now()) ? [row.id] : [];
      }))];
      if (shownRows.length) markInbox(db, shownRows, "delivered");
    }
    const digestGroups = new Map<string, SituationDigestGroup>();
    const recordGroups = new Map<string, SituationRecordGroup & { kindCounts: Map<string, number> }>();
    // 关于 Lead 自己的事（压缩失败、换了模型，工单 14）：单独一节，不按预算截断，但有自己的上限（leadSelfLines）。
    const selfEvents: EventRecord[] = [];
    for (const event of changes) {
      this.run?.shown.add(event.seq);
      if (LEAD_SELF_KINDS.has(event.kind)) {
        selfEvents.push(event);
        continue;
      }
      const merged = merges.get(event.seq) ?? [];
      for (const other of merged) this.run?.shown.add(other.seq);
      const { key, label } = this.objectOf(event);
      if (event.level === "record") {
        const group = recordGroups.get(key)
          ?? { label, count: 0, kinds: [], notes: [] as string[], latestSeq: 0, kindCounts: new Map<string, number>() };
        group.count += 1;
        group.kindCounts.set(event.kind, (group.kindCounts.get(event.kind) ?? 0) + 1);
        const note = recordNote(event);
        if (note && group.notes.length < MAX_RECORD_NOTES) group.notes.push(note);
        group.latestSeq = event.seq;
        recordGroups.set(key, group);
        continue;
      }
      const group = digestGroups.get(key) ?? { label, lines: [], latestSeq: 0 };
      group.lines.push(...digestLines(event));
      // 按根因合并（05）：合并进这一件的写在它下面一行，说明涉及哪几张工单；合并到的那一件已经交过的，说明是同一个根因。
      if (merged.length) group.lines.push(this.mergedLine(event, merged));
      const standalone = this.standaloneMergeNote(event);
      if (standalone) group.lines.push(standalone);
      group.latestSeq = event.seq;
      digestGroups.set(key, group);
    }
    const tickets = this.options.tickets?.() ?? [];
    const open_ = tickets.filter((ticket) => ticket.kind === "task" && !TERMINAL_STAGES.has(ticket.stage));
    const ticketLine = (ticket: TicketSummary) => `#${ticket.id}「${oneLine(ticket.displayTitle ?? ticket.title, 60)}」`;
    const problems = open_.flatMap((ticket) => [
      ...(ticket.attention.leadHandling ? [`${ticketLine(ticket)}：你正在处理它的异常，还没处理完`] : []),
      ...(ticket.attention.blockerCount > 0 ? [`${ticketLine(ticket)}：${ticket.attention.blockerCount} 个要用户处理的 blocker`] : []),
    ]);
    const waiting = [
      ...tickets.flatMap((ticket) => {
        const reason = ticketNeedsUser(ticket);
        return reason ? [`${ticketLine(ticket)}：${ticketNeedsUserLabel(reason)}`] : [];
      }),
      ...pendingApprovals(db).map((approval) =>
        `审批 #${approval.id}：工单 #${approval.item_id ?? "-"} 要执行「${approval.tool}」：${oneLine(approval.action, 80)}`),
      // 结束了的编码工单留下的 worktree 有没合并的改动（engine 的 sweepWorkspaces）：合并或放弃之前一直列在这里。
      ...listWorkspaces(db, { state: "pending_integration" }).map((workspace) =>
        `工单 #${workspace.owner_item_id} 的隔离 worktree #${workspace.id}（分支 ${workspace.branch ?? "-"}）有没合并的改动，等合并决定`),
      // 合并冲突的 worktree（blocked）：用户解决冲突或者同意放弃以前一直列在这里。
      ...listWorkspaces(db, { state: "blocked" }).filter((workspace) => workspace.git_worktree && workspace.kind === "isolated_child")
        .map((workspace) =>
          `工单 #${workspace.owner_item_id} 的隔离 worktree #${workspace.id}（分支 ${workspace.branch ?? "-"}）合并时冲突，等用户处理`),
    ];
    // 长期没有动静的工单折叠成一行，只列编号（2026-10-19）。编号不随时间变，「没有变化」的判断照常成立。
    const now = this.now();
    const idleMs = this.options.idleTicketMs && this.options.idleTicketMs > 0 ? this.options.idleTicketMs : DEFAULT_IDLE_TICKET_MS;
    const idle = open_.filter((ticket) => ticketIsIdle(ticket, now, idleMs));
    const idleIds = new Set(idle.map((ticket) => ticket.id));
    const active = open_.filter((ticket) => !idleIds.has(ticket.id));
    const ticketLines = active.slice(0, MAX_SITUATION_TICKETS).map((ticket) => ({
      line: `${ticketLine(ticket)}：${ticket.stage}，${ticketRunAnnotation(db, ticket.id).trim()}`,
    }));
    const idleTickets = idle.length
      ? `另有 ${idle.length} 张超过 ${formatSpan(idleMs)}没有动静的工单，折叠成这一行：`
        + `${idle.slice(0, MAX_IDLE_TICKET_IDS).map((ticket) => `#${ticket.id}`).join("、")}`
        + `${idle.length > MAX_IDLE_TICKET_IDS ? " 等" : ""}（要看用 query_tickets 或 get_ticket_status 查）`
      : null;
    // 你在等的用户操作（2026-10-19，store 的 lead-waits.ts）。
    const openWaits = listOpenLeadWaits(db, { limit: LEAD_WAIT_LIMITS.situationMax + 1 });
    const waits = openWaits.slice(0, LEAD_WAIT_LIMITS.situationMax).map((wait) =>
      `等待 #${wait.id}：${wait.entityKey}，${oneLine(wait.note, 120)}（${shortTime(wait.createdAt)} 起，${shortTime(wait.expiresAt)} 超时`
      + `${wait.mustTell ? "，结果要告诉用户" : ""}${wait.userAction ? `；user_action=${JSON.stringify(wait.userAction)}` : ""}）`);
    if (openWaits.length > LEAD_WAIT_LIMITS.situationMax) waits.push("（还有更多，没有列出）");
    const staticKey = JSON.stringify([ticketLines.map((ticket) => ticket.line), idleTickets, problems, waiting, waits]);
    const unchanged = staticKey === (this.run?.sentStatic ?? this.lastSentStatic);
    if (this.run) this.run.sentStatic = staticKey;
    const rendered = renderLeadSituation({
      now: localIso(now),
      tickets: ticketLines,
      idleTickets,
      waits,
      problems,
      waiting,
      unchanged,
      queued,
      digest: [...digestGroups.values()],
      records: [...recordGroups.values()].map(({ kindCounts, ...group }) => ({ ...group, kinds: [...kindCounts] })),
      unread,
      leadFailure: this.latestLeadFailure(),
      sinceSeq: this.cursorSeq,
      self: [...(context.contextUsage ? [context.contextUsage] : []), ...leadSelfLines(selfEvents)],
      lanes: [...lanes.values()],
    }, this.options.budgetTokens ?? DEFAULT_SITUATION_BUDGET_TOKENS);
    return rendered.text;
  }

  /**
   * 一次运行结束。成功：这一轮交给 Lead 的事和当前局面里列出的变化都算处理完，游标前进；
   * 当前局面里列出的 digest、auto 级事件记成 digested（05 的 markEventsDigested，摘要编号是 digestId，
   * 没给时用这一次运行的编号）。返回记成 digested 的有几条。
   */
  endRun(outcome: "succeeded" | "failed" | "interrupted", options: { digestId?: string } = {}): { digested: number } {
    const run = this.run;
    this.run = null;
    if (!run) return { digested: 0 };
    const cache = new Map<number, InboxRow | null>();
    const inboxIds = (seqs: Iterable<number>, source: Map<number, EventRecord> | null) => {
      const ids = new Set<number>();
      for (const seq of seqs) {
        const event = source?.get(seq) ?? this.eventBySeq(seq);
        const row = event ? this.inboxRow(event, cache) : null;
        if (row) ids.add(row.id);
      }
      return ids;
    };
    // 这一轮没有成功：不知道 Lead 看到了哪一份当前局面，下一份整段给。
    if (outcome !== "succeeded") this.lastSentStatic = null;
    else if (run.sentStatic !== undefined) this.lastSentStatic = run.sentStatic;
    if (outcome === "interrupted") {
      // 被停机打断：交给这一轮的 inbox 行回到 pending，下一个 daemon 照常交给 Lead。
      returnInboxToPending(this.db, [...inboxIds(run.inFlight.keys(), run.inFlight)]);
      return { digested: 0 };
    }
    if (outcome !== "succeeded") return { digested: 0 };
    // 整理笔记是内部回合：当前局面里的变化不在这一轮里算处理完，等下一轮普通的 Lead 回合。
    const shown = run.kind === "internal" ? [] : [...run.shown];
    const settledNow = [...run.inFlight.keys(), ...shown];
    if (!settledNow.length) {
      this.advance();
      return { digested: 0 };
    }
    const at = this.now().toISOString();
    let digested = 0;
    this.db.transaction(() => {
      for (const seq of settledNow) this.settled.add(seq);
      const touched = new Set([...inboxIds(run.inFlight.keys(), run.inFlight), ...inboxIds(shown, null)]);
      // 当前局面里列出的摘要（digest、auto 级，经不经过 inbox 都一样）：Lead 没有说怎么处置的，记成 digested，
      // 带摘要编号和依据（常设指令 events.digest_batch）。按根因合并进来的已经是 superseded，不改。
      const digestSeqs = shown.filter((seq) => {
        const level = this.eventBySeq(seq)?.level;
        return level === "digest" || level === "auto";
      });
      if (digestSeqs.length) {
        digested = markEventsDigested(this.db, digestSeqs, { digestId: options.digestId ?? run.id, at: new Date(at) });
      }
      // 作为消息交给 Lead、不经过 inbox 的事件：Lead 没有说怎么处置的，记成「看过了」。经过 inbox 的，这一行消化掉时记（下面）。
      const dispose = this.db.prepare(
        "UPDATE events SET disposition = ?, disposition_detail = ?, disposed_at = ? WHERE seq = ? AND disposition IS NULL",
      );
      for (const event of run.inFlight.values()) {
        if (!this.inboxRow(event, cache)) dispose.run("seen", null, at, event.seq);
      }
      // inbox 行：这一行游标后面的事都处理完了，才算消化掉（并记「看过了」）。还没到点的跟进不消化。
      const consumed = [...touched].filter((id) => this.inboxRowSettled(id) && this.inboxRowDue(id));
      if (consumed.length) {
        markInbox(this.db, consumed, "consumed");
        recordSeenDispositions(this.db, consumed, new Date(at));
      }
      this.advance();
    })();
    return { digested };
  }

  private eventBySeq(seq: number): EventRecord | undefined {
    return getEvent(this.db, seq);
  }

  private inboxRowDue(inboxId: number): boolean {
    const row = this.db.prepare("SELECT * FROM inbox WHERE id = ?").get(inboxId) as InboxRow | undefined;
    return row !== undefined && inboxDue(row, this.now());
  }

  private inboxRowSettled(inboxId: number): boolean {
    const rows = this.db.prepare(
      "SELECT seq FROM events WHERE correlation_id = ? AND seq > ?",
    ).all(`inbox:${inboxId}`, this.cursorSeq) as Array<{ seq: number }>;
    const cache = new Map<number, InboxRow | null>();
    return rows.every(({ seq }) => {
      const event = this.eventBySeq(seq);
      return !event || this.done(event, cache);
    });
  }

  // 游标前进：越过已经处理完的和不交给 Lead 的事件，停在第一件还没处理完的事前面。
  // 收紧以后的区间不用一条一条读：挡着的事件之前（没有挡着的就是全部）的区间都处理完了，游标直接越过。
  private advance(): void {
    const cache = new Map<number, InboxRow | null>();
    let blockedAt: number | null = null;
    for (;;) {
      const batch = listEvents(this.db, { sinceSeq: this.cursorSeq, excludeRanges: this.settledRanges, limit: 1000 });
      for (const event of batch) {
        if (!this.done(event, cache)) { blockedAt = event.seq; break; }
        this.cursorSeq = event.seq;
      }
      if (blockedAt !== null || batch.length < 1000) break;
    }
    for (const [, to] of this.settledRanges) {
      if (to > this.cursorSeq && (blockedAt === null || to < blockedAt)) this.cursorSeq = to;
    }
    for (const seq of [...this.settled]) if (seq <= this.cursorSeq) this.settled.delete(seq);
    this.settledRanges = normalizeSeqRanges(this.settledRanges, this.cursorSeq);
    if (blockedAt !== null) this.foldSettled();
    this.afterCache = null;
    this.save();
  }

  /**
   * 收紧（工单 14，04 的风险第 4 条）。一件事长时间挡着游标时（例如它的那一轮一直失败），后面处理完的序号一条一条地记，
   * 没有上限；游标后面一次只读 1000 条，处理完的事件占满这个窗口以后，新来的事就看不到了。
   * 游标后面要看的事件超过 SETTLED_FOLD_THRESHOLD 条时，把处理完的（记着的，以及不交给 Lead、被取代、行已消化的）
   * 连续序号并成区间，单个记着的不再另记。只并处理完的事件：还没处理完的一件都不跳过，所以不丢；
   * 并进区间的都是处理完的，以后也不再交给 Lead，所以不重复。处理完的判断和 advance 越过事件时一样（done）。
   * 区间的条数不超过挡着的事件数加 1。
   */
  private foldSettled(): void {
    if (countEvents(this.db, { sinceSeq: this.cursorSeq, excludeRanges: this.settledRanges }) <= SETTLED_FOLD_THRESHOLD) return;
    const cache = new Map<number, InboxRow | null>();
    const items: Array<{ from: number; to: number; done: boolean }> =
      this.settledRanges.map(([from, to]) => ({ from, to, done: true }));
    let after = this.cursorSeq;
    for (;;) {
      const batch = listEvents(this.db, { sinceSeq: after, excludeRanges: this.settledRanges, limit: 1000 });
      for (const event of batch) items.push({ from: event.seq, to: event.seq, done: this.done(event, cache) });
      if (batch.length < 1000) break;
      after = batch.at(-1)!.seq;
    }
    items.sort((left, right) => left.from - right.from);
    const ranges: SeqRange[] = [];
    let open: SeqRange | null = null;
    for (const item of items) {
      if (!item.done) {
        open = null;
        continue;
      }
      if (open) {
        open[1] = item.to;
      } else {
        open = [item.from, item.to];
        ranges.push(open);
      }
    }
    const blocking = items.filter((item) => !item.done).length;
    this.options.log?.(`lead input: folded ${this.settled.size} settled event(s) into ${ranges.length} range(s); ${blocking} event(s) still open after the cursor at #${this.cursorSeq}`);
    // 记着的单个序号都在游标后面、不在旧区间里，上面读到过，并且处理完了：都在新区间里。
    this.settled.clear();
    this.settledRanges = ranges;
  }

  // 按根因合并进 target 的事件交给 Lead 时的说明（作为消息交的那一种）。
  private mergedNote(target: EventRecord, merged: readonly EventRecord[]): string {
    return [
      `同一个根因（${rootCauseCode(target, merged)}）合并进事件 #${target.seq} 的还有 ${merged.length} 件。系统把它们合成一件事交给你，说一次就够了：`,
      ...merged.map((event) => `- 事件 #${event.seq}：${this.objectOf(event).label}${summarySuffix(event)}`),
    ].join("\n");
  }

  // 当前局面里，合并进 target 的事件写成一行：涉及哪几个对象（工单）。
  private mergedLine(target: EventRecord, merged: readonly EventRecord[]): string {
    const labels = [...new Set(merged.map((event) => this.objectOf(event).label))];
    const shown = labels.slice(0, MAX_MERGED_LABELS).join("、");
    const more = labels.length > MAX_MERGED_LABELS ? ` 等 ${labels.length} 个` : "";
    return `同一个根因（${rootCauseCode(target, merged)}）合并进来 ${merged.length} 件：${shown}${more}`;
  }

  // 合并到的那一件已经交过了（处理完了、在路上、在游标前面），合并进去的这一件单独交时的说明。
  private standaloneMergeNote(event: EventRecord): string | null {
    const target = mergedTargetOf(event);
    if (target === null) return null;
    return `这一件和事件 #${target} 是同一个根因（${rootCauseCode(event, [])}），系统把它合并进了那一件；那一件已经交给过你`;
  }

  // 一个事件属于哪个对象：挂在工单或提醒上的（payload 里有 itemId，或者对象键是 ticket:、reminder:）按那一项合并。
  private objectOf(event: EventRecord): { key: string; label: string } {
    const itemId = idOf(event.payload.itemId) ?? itemIdOfKey(event.entityKey);
    if (itemId !== null) {
      const item = getItem(this.db, itemId);
      const title = item ? `「${oneLine(item.display_title ?? item.title, 40)}」` : "";
      return { key: `item:${itemId}`, label: `#${itemId}${title}${item ? `（现在 ${item.stage}）` : ""}` };
    }
    return { key: event.entityKey, label: event.entityKey };
  }

  // 最近一次 Lead 自己的失败（24 小时以内）。
  private latestLeadFailure(): string | null {
    const [failure] = listEvents(this.db, { kind: "lead.turn_failed", order: "desc", limit: 1 });
    if (!failure || this.now().getTime() - Date.parse(failure.occurredAt) > LEAD_FAILURE_WINDOW_MS) return null;
    const cause = failure.rootCause;
    const retry = failure.payload.willRetry === true ? "，系统会自动再试一次" : "";
    return `${localIso(new Date(failure.occurredAt))}：${cause?.code ?? "unknown"}（${oneLine(cause?.message ?? String(failure.payload.error ?? ""), 160)}）${retry}`;
  }
}

// 「关于你自己」一节最多列几行（工单 14 审查）。压缩反复失败时这一节会越来越长，而压缩失败本来就说明上下文接近上限。
export const MAX_LEAD_SELF_LINES = 5;
const LEAD_SELF_QUERY = "query_events kind=lead.*";
const LEAD_SELF_RUN_LABELS: Record<string, string> = {
  "lead.compaction_failed": "你的上下文压缩连续失败了",
  "lead.model_switched": "你的模型连续换了",
};

/**
 * 「关于你自己」一节的行（按发生的先后）。同一种事件连续出现时合成一行，写次数和最近一次的原话；
 * 合完以后只列最近的 MAX_LEAD_SELF_LINES 行，更早的合成一行，写省略了几条和怎样查。
 */
export function leadSelfLines(events: readonly EventRecord[]): string[] {
  const runs: Array<{ kind: string; events: EventRecord[] }> = [];
  for (const event of events) {
    const last = runs.at(-1);
    if (last && last.kind === event.kind) last.events.push(event);
    else runs.push({ kind: event.kind, events: [event] });
  }
  const lines = runs.map((run) => {
    const latest = run.events.at(-1)!;
    const note = textOf(latest.payload.note) ?? latest.kind;
    if (run.events.length === 1) return { count: 1, text: note };
    const label = LEAD_SELF_RUN_LABELS[run.kind] ?? `${run.kind} 连续出现了`;
    const earlier = run.events.length - 1;
    return {
      count: run.events.length,
      text: `${label} ${run.events.length} 次（更早的 ${earlier} 次没有列出，用 ${LEAD_SELF_QUERY} 查）。最近一次：${note}`,
    };
  });
  if (lines.length <= MAX_LEAD_SELF_LINES) return lines.map((line) => line.text);
  const dropped = lines.slice(0, lines.length - MAX_LEAD_SELF_LINES);
  const omitted = dropped.reduce((sum, line) => sum + line.count, 0);
  return [
    `另有 ${omitted} 条更早的（用 ${LEAD_SELF_QUERY} 查）`,
    ...lines.slice(-MAX_LEAD_SELF_LINES).map((line) => line.text),
  ];
}

export function createLeadInput(options: LeadInputOptions): LeadInput {
  return new LeadInput(options);
}

// ── 排着的外部消息（工单 10，决策边界，纯函数）──────────────────────────────────────────────

export interface LeadQueueUnit<E extends Pick<EventRecord, "seq" | "kind" | "entityKey" | "payload"> = EventRecord> {
  // 对话的对象键；系统事件那一组是 null。
  key: string | null;
  events: E[];
}

/** 一条要交给 Lead 的事属于哪个对话：外部通道的消息事件是它的对话，别的（系统事件）是 null。 */
function queueKeyOf(event: Pick<EventRecord, "kind" | "entityKey" | "payload">): string | null {
  if (event.kind !== MESSAGE_EVENT_KIND) return null;
  const conversation = isRecord(event.payload.conversation) ? event.payload.conversation : null;
  return typeof conversation?.key === "string" && conversation.key ? conversation.key : event.entityKey;
}

/**
 * 排着的事怎么分组、按什么顺序交给 Lead（统一消息事件 spec D6，工单 10）：
 *   · 同一个对话里的外部消息合成一组（一次处理）；所有系统事件合成一组（照旧一起交）；
 *   · 用户排到下一个的对话在最前面，后排的在更前面；其余的按组里最早的一条排。
 * events 是还没处理完、也不在路上的事，按序号排好。promoted 是对象键 → 第几次排的。
 */
export function leadQueueUnits<E extends Pick<EventRecord, "seq" | "kind" | "entityKey" | "payload">>(
  events: readonly E[], promoted: ReadonlyMap<string, number>,
): LeadQueueUnit<E>[] {
  const units = new Map<string | null, LeadQueueUnit<E>>();
  for (const event of events) {
    const key = queueKeyOf(event);
    const unit = units.get(key) ?? { key, events: [] };
    unit.events.push(event);
    units.set(key, unit);
  }
  const rank = (unit: LeadQueueUnit<E>) => (unit.key !== null ? promoted.get(unit.key) ?? 0 : 0);
  return [...units.values()].sort((left, right) => rank(right) - rank(left) || left.events[0]!.seq - right.events[0]!.seq);
}

// 排着的一个对话给状态栏和面板看的样子。原话只给人看，不进 Lead 的输入（describe 不给它）。
function queueEntryOf(key: string, events: readonly EventRecord[], next: boolean): LeadQueueEntry {
  const payloads = events.map((event) => event.payload);
  const last = payloads.at(-1)!;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const conversation = isRecord(last.conversation) ? last.conversation : {};
  const senders = [...new Set(payloads.map((payload) => (isRecord(payload.sender) ? text(payload.sender.name) : "")).filter(Boolean))];
  const cardIds = [...new Set(payloads.map((payload) => idOf(payload.cardId)).filter((id): id is number => id !== null))];
  const excerpt = text(last.text).replace(/\s+/gu, " ").trim();
  return {
    key,
    conversation: text(conversation.label) || key,
    source: text(last.source) || key.split(":")[0]!,
    sourceLabel: text(last.sourceLabel),
    senders,
    count: events.length,
    excerpt: excerpt.length > LEAD_QUEUE_EXCERPT_MAX ? `${excerpt.slice(0, LEAD_QUEUE_EXCERPT_MAX)}…` : excerpt,
    cardIds,
    firstAt: events[0]!.receivedAt,
    lastAt: events.at(-1)!.receivedAt,
    next,
    actions: next ? ["remove"] : ["move_next", "remove"],
  };
}

// 按根因合并进别的事件的（05 的 events.merge_root_cause，处置是 superseded）合并到的那一条的序号。不是这种事件时返回 null。
function mergedTargetOf(event: EventRecord): number | null {
  if (event.disposition !== "superseded") return null;
  return idOf(event.dispositionDetail?.mergedInto) ?? idOf(event.triage?.mergedInto);
}

function flattenSeqs(groups: Map<number, EventRecord[]>): Set<number> {
  return new Set([...groups.values()].flat().map((event) => event.seq));
}

function rootCauseCode(event: EventRecord, merged: readonly EventRecord[]): string {
  const detail = event.dispositionDetail?.rootCauseCode;
  return event.rootCause?.code ?? merged[0]?.rootCause?.code ?? (typeof detail === "string" ? detail : "未知");
}

function summarySuffix(event: EventRecord): string {
  const summary = textOf(event.payload.summary) ?? textOf(event.payload.title) ?? textOf(event.payload.note);
  return summary ? `：${oneLine(summary, 80)}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function itemIdOfKey(entityKey: string): number | null {
  const match = /^(?:ticket|reminder):(\d+)$/u.exec(entityKey);
  return match ? Number(match[1]) : null;
}

// 这一行 inbox 的文字（leadInboxEvents）里有没有这条摘要：行自己的摘要、合并进来的、熔断记下的最近一条。
function rowMentions(row: InboxRow, summary: string): boolean {
  if (row.summary === summary) return true;
  try {
    const payload = JSON.parse(row.payload || "{}") as { merged?: unknown; lastSummary?: unknown };
    if (payload.lastSummary === summary) return true;
    return Array.isArray(payload.merged) && payload.merged.some((entry) => entry === summary
      || (isRecord(entry) && entry.summary === summary));
  } catch {
    return false;
  }
}

// digest 级的一条变化在当前局面里的一行（或几行）。
function digestLines(event: EventRecord): string[] {
  const payload = event.payload;
  if (event.kind.startsWith("inbox.")) {
    const inboxId = idOf(payload.inboxId);
    const head = inboxId !== null ? `通知 #${inboxId}：` : "";
    const lines = [`${head}${oneLine(String(payload.summary ?? ""))}`];
    // 游标第一次建立时转过来的行，合并进来的摘要在那一行的 payload 里。
    const merged = isRecord(payload.payload) && Array.isArray(payload.payload.merged) ? payload.payload.merged : [];
    for (const entry of merged) {
      const text = typeof entry === "string" ? entry : isRecord(entry) ? textOf(entry.summary) : null;
      if (text) lines.push(`${head}${oneLine(text)}`);
    }
    return lines;
  }
  if (event.kind === "notification.created") {
    const body = textOf(payload.body);
    return [`给用户的通知：${oneLine(String(payload.title ?? ""))}${body ? `（${oneLine(body.split("\n")[0]!, 80)}）` : ""}`];
  }
  if (event.kind === "system.event_rejected") {
    return [`一条事件没有写成（${String(payload.rejectedKind ?? "未知类型")}）：${oneLine(String(payload.error ?? ""), 120)}`];
  }
  // 提醒推满了次数还没确认（工单 07）：回来简报里说一句。
  if (event.kind === REMINDER_UNACKNOWLEDGED_KIND) {
    return [`提醒还没确认：${oneLine(String(payload.summary ?? payload.title ?? ""))}（「待你」托盘里也有它）`];
  }
  const summary = textOf(payload.summary) ?? textOf(payload.title) ?? textOf(payload.note);
  return [`${event.kind}${summary ? `：${oneLine(summary)}` : ""}`];
}

// record 级的一条变化的一句很短的说明。没有可说的返回 null（只计数）。
function recordNote(event: EventRecord): string | null {
  const payload = event.payload;
  const runId = idOf(payload.runId);
  const purpose = typeof payload.purpose === "string" ? PURPOSE_LABELS[payload.purpose] ?? payload.purpose : null;
  const run = runId !== null ? `Run #${runId}${purpose ? `（${purpose}）` : ""}` : "Run";
  switch (event.kind) {
    case "run.finished": return `${run} 结束`;
    case "run.failed": return `${run} 失败${event.rootCause ? `（code=${event.rootCause.code}）` : ""}`;
    case "run.stopped": return `${run} 被停止`;
    case "run.paused": return `${run} 暂停`;
    case "stage.changed": return `stage ${String(payload.from)}→${String(payload.to)}`;
    case "checkpoint.recorded": return `checkpoint「${oneLine(String(payload.title ?? ""), 40)}」`;
    case "timer.fired": return payload.timer === "reminder" ? `提醒「${oneLine(String(payload.title ?? ""), 40)}」到点` : "跟进到点";
    case REMINDER_PUSHED_KIND: return payload.occasion === "early" ? "系统提前推送了提醒"
      : payload.occasion === "repeat" ? `系统又推送了一次提醒（第 ${String(payload.attempt)}/${String(payload.planned)} 次）` : "系统准时推送了提醒";
    case "ticket_agent.turn_completed": return "工单对话答完一轮";
    case "ticket_agent.turn_failed": return "工单对话一轮没有答完";
    // 用户点了横幅上的「知道了」（工单 06）：Lead 处理这件事时据此知道用户已经看到了。
    case "event.acknowledged": return `用户确认了事件 #${String(payload.acknowledgedSeq)}（${String(payload.acknowledgedKind)}）`;
    // 2026-10-19：连接的状态、daemon 启动、请求过期，和已经由别的事件交给你的等待了结（lead-waits.ts）。
    case CONNECTION_STATUS_CHANGED_KIND: return oneLine(String(payload.summary ?? `${String(payload.from)}→${String(payload.to)}`), 80);
    case DAEMON_STARTED_KIND: return "daemon 启动了";
    case USER_REQUEST_EXPIRED_KIND: return oneLine(String(payload.summary ?? "请求过期了"), 80);
    case LEAD_WAIT_SATISFIED_KIND: return `你在等的事有了下一步（等待 #${String(payload.waitId)}，详情在同一件事的另一条事件里）`;
    default: return null;
  }
}
