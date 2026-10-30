// 会话里的「Lead 动态」和 interrupt 横幅（Lead 事件主干 spec D10、D16，工单 06）。
//
// 这是方案 A「Lead 动态」（control-plane.ts 的 listLeadActivity）的扩展：以前只列 Lead 在 inbox 行上记下的处置，
// 现在从事件日志算，一个对象一张卡。三种来源：
//   1. 事件卡：digest、auto 级的事件和常设指令的修改（store 的 listLeadActivityEvents）。同一个对象的事件合成一张卡；
//      对象安静了 EPISODE_GAP_MS 以后再来的事件开一张新卡（不然更新落在用户早就翻过去的地方，和派活卡片按一次派活分段一样）。
//      卡的位置是第一条事件的时间，后来的事件和处置原地更新它；Lead 记下的处置（理由）挂在同一张卡下面。
//   2. Lead 的处置：Lead 在 inbox 行上记了处理好了、延后、不处理，而这一行的事件不在事件卡里（tell 级的事，
//      或者工单 04 之前、没有事件的旧行）。一行一张卡，和以前一样；依据取这一行最新一条事件的分诊依据。
//   3. 横幅：interrupt 级的事件，用户点「知道了」（store 的 acknowledgeInterruptEvent）之前一直在；别处已处理的不再提醒。
// record 级的事件只进时间轴和工单详情，不在这里。
//
// 版本（spec D16）：每张卡、每条横幅带 entityKey 和 entityVersion。事件卡的版本 = 卡里最新事件的 seq + 已经有处置的条数：
// 卡里的事件只增不减（级别写入时就定了），处置只会从没有变成有，所以来一条事件、记一条处置，版本都变大。
// Lead 改口（覆盖原来的处置）时版本不变、内容变了：客户端接受不比手上旧的版本，照样换上。
// 推送：LeadActivityPublisher 比较前后两份投影，变了的卡和横幅用 snapshot.required（resource=lead-activity）推出去，
// payload 带 entityKey、entityVersion 和变化后的卡片。只发给声明了 include=lead_activity 的连接（protocol 的 gatewayEventOptIn）。
import {
  DEFAULT_LEAD_NAME, EVENT_ACKNOWLEDGED_KIND, OWNER_ACTION_PERFORMED_KIND, ownerActionDefinition, LEAD_ACTIVITY_DISPOSITIONS, LEAD_ACTIVITY_LIMITS, LEAD_ACTIVITY_RESOURCE, LEAD_TURN_RESPONDING_KIND,
  leadInterruptOpen, REMINDER_PUSHED_KIND, REMINDER_UNACKNOWLEDGED_KIND,
  type LeadActivityBasis, type LeadActivityCard, type LeadActivityNote, type LeadActivityOwnerAction, type LeadActivityView, type LeadInterrupt,
  type ReminderCard, type TriageBasis,
  SETUP_CHECKLIST_KEY, type SetupChecklistCard, type SetupHintCard,
} from "@pi-lead-child/protocol";
import {
  findInterruptAck, getEvent, latestCorrelatedEvent, latestEntityEvent, leadDisplayName, listInterruptEvents, listLeadActivityEvents, listReminderFires,
  maxEventSeq, reminderFireState, loadSetupChecklist, loadSetupHints, loadSetupStatus,
  type Db, type EventRecord, type PublishGatewayEventInput,
} from "@pi-lead-child/store";
import { leadActivityCardAction } from "@pi-lead-child/engine";

// 同一个对象的事件隔多久算新的一段。
export const EPISODE_GAP_MS = 2 * 3_600_000;
// 只看最近这么多条事件（日志会一直长，扫描要有界）。
const SCAN_WINDOW = 20_000;
// 事件卡最多从这么多条事件里算。
const DISPLAY_EVENT_LIMIT = 600;
const INTERRUPT_LIMIT = 50;
const SUMMARY_CHARS = 300;
const DEFAULT_CARD_LIMIT = 100;

const LEAD_NOTE_DISPOSITIONS: ReadonlySet<string> = new Set(LEAD_ACTIVITY_DISPOSITIONS);
const INBOX_CORRELATION = /^inbox:(\d+)$/u;

function clip(text: string, max = SUMMARY_CHARS): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const idOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);

const REMINDER_CARD_KINDS: ReadonlySet<string> = new Set([
  "timer.fired", REMINDER_PUSHED_KIND, REMINDER_UNACKNOWLEDGED_KIND, LEAD_TURN_RESPONDING_KIND, "stage.changed",
]);

/** 这条事件会不会改变「Lead 动态」、横幅或会话里的提醒卡（daemon 据此决定要不要马上 sync）。 */
export function isLeadActivityEvent(event: Pick<EventRecord, "kind" | "level"> & { entityKey?: string }): boolean {
  if (event.level === "digest" || event.level === "auto" || event.level === "interrupt"
    || event.kind === "standing_order.changed" || event.kind === EVENT_ACKNOWLEDGED_KIND) return true;
  // 提醒卡（工单 07）：到点、推送、确认或改期、Lead 回应它的那一轮。
  return typeof event.entityKey === "string" && event.entityKey.startsWith("reminder:") && REMINDER_CARD_KINDS.has(event.kind);
}

/** 卡属于哪个对象。Run 的事件归到它的工单：用户看的是工单，不是某一次 Run。 */
export function leadActivityObjectKey(event: Pick<EventRecord, "entityKey" | "payload">): string {
  const itemId = idOf(event.payload.itemId);
  if (/^run:\d+$/u.test(event.entityKey) && itemId !== null) return `ticket:${itemId}`;
  return event.entityKey;
}

function ticketIdOfKey(key: string): number | null {
  const match = /^(?:ticket|reminder):(\d+)$/u.exec(key);
  return match ? Number(match[1]) : null;
}

const OP_LABELS: Record<string, string> = {
  create: "新增", update: "修改", disable: "停用", enable: "启用", rollback: "回滚",
};
const TIER_LABELS: Record<string, (leadName: string) => string> = {
  conservative: (leadName) => `${leadName} 改得更保守，直接生效`,
  permissive: (leadName) => `你批准了 ${leadName} 的修改`,
  user: () => "你改的",
};

/** 一条事件对用户说的那一句话。leadName 是 Lead 的名字（设置 → 身份与风格）。 */
export function leadActivityEventSummary(
  event: Pick<EventRecord, "kind" | "payload" | "rootCause">, leadName: string = DEFAULT_LEAD_NAME,
): string {
  const payload = event.payload;
  if (event.kind === "standing_order.changed") {
    const title = textOf(payload.title) ?? String(payload.orderId ?? "");
    const previous = idOf(payload.previousVersion);
    const version = idOf(payload.version);
    const versions = version === null ? "" : previous === null ? `v${version}` : `v${previous}→v${version}`;
    const op = OP_LABELS[String(payload.change)] ?? "修改";
    const tier = TIER_LABELS[String(payload.tier)]?.(leadName);
    // 10 写的说明以「修改常设指令 <编号>「<标题>」」开头，和前面重复，去掉这一段，只留改了什么。
    const parts = (textOf(payload.summary) ?? "").split("；");
    const details = (parts[0]?.includes(`「${title}」`) ? parts.slice(1) : parts).join("；").trim();
    const reason = textOf(payload.reason);
    // 两行里先放最要紧的：哪条指令、哪一版、谁改的、为什么；改了什么放在后面。
    return clip(`常设指令「${title}」${op}${versions ? ` ${versions}` : ""}${tier ? `（${tier}）` : ""}`
      + `${reason ? `。原因：${reason}` : ""}${details ? `。${details}` : ""}`);
  }
  if (event.kind === "notification.created") {
    const body = textOf(payload.body);
    return clip(`${String(payload.title ?? "")}${body ? `：${body.split("\n")[0]}` : ""}`);
  }
  if (event.kind === "timer.fired") {
    return payload.timer === "reminder"
      ? clip(`提醒「${String(payload.title ?? "")}」到点`)
      : clip(`跟进到点${textOf(payload.note) ? `：${textOf(payload.note)}` : ""}`);
  }
  if (event.kind === "system.event_rejected") {
    return clip(`一条事件没有写成（${String(payload.rejectedKind ?? "未知类型")}）：${String(payload.error ?? "")}`);
  }
  const summary = textOf(payload.summary) ?? textOf(payload.title) ?? textOf(payload.note);
  if (summary) return clip(summary);
  if (event.rootCause) return clip(`${event.kind}：${event.rootCause.message ?? event.rootCause.code}`);
  return event.kind;
}

/** 分诊依据（事件的 triage 字段）：定级别的常设指令、起作用的常设指令、起作用的硬性规则。 */
export function leadActivityBasis(triage: TriageBasis | null): LeadActivityBasis[] {
  if (!triage) return [];
  const basis: LeadActivityBasis[] = [];
  const seen = new Set<string>();
  const add = (entry: LeadActivityBasis) => {
    const key = JSON.stringify(entry);
    if (seen.has(key)) return;
    seen.add(key);
    basis.push(entry);
  };
  if (triage.order) add({ kind: "order", id: triage.order.id, version: triage.order.version });
  for (const applied of triage.applied ?? []) {
    add({ kind: "order", id: applied.id, version: applied.version, ...(applied.effect ? { effect: applied.effect } : {}) });
  }
  for (const name of triage.hardRules ?? []) add({ kind: "rule", name });
  return basis.slice(0, LEAD_ACTIVITY_LIMITS.basis);
}

function leadNoteOf(events: readonly EventRecord[]): LeadActivityNote | null {
  const noted = [...events].reverse().find((event) => event.disposition !== null && LEAD_NOTE_DISPOSITIONS.has(event.disposition));
  if (!noted) return null;
  return {
    disposition: noted.disposition as LeadActivityNote["disposition"],
    reason: clip(textOf(noted.dispositionDetail?.reason) ?? ""),
    at: noted.disposedAt ?? noted.receivedAt,
  };
}

function laterOf(left: string, right: string | null): string {
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function eventCard(events: readonly EventRecord[], leadName: string): LeadActivityCard {
  const first = events[0]!;
  const latest = events.at(-1)!;
  const entityKey = leadActivityObjectKey(first);
  const disposed = events.filter((event) => event.disposition !== null).length;
  const lead = leadNoteOf(events);
  const resolved = events.some((event) => event.disposition === "resolved_elsewhere") && disposed === events.length;
  const state: LeadActivityCard["state"] = resolved ? "resolved_elsewhere"
    : latest.disposition === null ? "open"
      : lead ? "handled" : "seen";
  const kind: LeadActivityCard["kind"] = latest.kind === "standing_order.changed" ? "standing_order"
    : latest.level === "auto" ? "auto" : "digest";
  const updatedAt = events.reduce((at, event) => laterOf(laterOf(at, event.occurredAt), event.disposedAt), first.occurredAt);
  return {
    key: `${entityKey}@${first.seq}`,
    entityKey,
    entityVersion: latest.seq + disposed,
    lastSeq: latest.seq,
    at: first.occurredAt,
    updatedAt,
    ticketId: ticketIdOfKey(entityKey),
    kind,
    state,
    summary: leadActivityEventSummary(latest, leadName),
    count: events.length,
    basis: leadActivityBasis(latest.triage),
    lead,
    entries: events.slice(-LEAD_ACTIVITY_LIMITS.entries).map((event) => ({
      seq: event.seq, at: event.occurredAt, kind: event.kind, level: event.level, summary: leadActivityEventSummary(event, leadName),
    })),
  };
}

/** 按对象分段：同一个对象的事件，和上一条隔不到 EPISODE_GAP_MS 的，合进同一张卡。事件按 seq 从旧到新给。 */
export function groupLeadActivityCards(events: readonly EventRecord[], leadName: string = DEFAULT_LEAD_NAME): LeadActivityCard[] {
  const open = new Map<string, EventRecord[]>();
  const episodes: EventRecord[][] = [];
  for (const event of events) {
    const key = leadActivityObjectKey(event);
    const current = open.get(key);
    const last = current?.at(-1);
    if (current && last && Date.parse(event.occurredAt) - Date.parse(last.occurredAt) <= EPISODE_GAP_MS) {
      current.push(event);
      continue;
    }
    const episode = [event];
    open.set(key, episode);
    episodes.push(episode);
  }
  return episodes.map((episode) => eventCard(episode, leadName));
}

// Lead 在 inbox 行上记的处置（方案 A 的「Lead 动态」）：这一行的事件不在事件卡里时，一行一张卡。
function leadDispositionCards(db: Db, covered: ReadonlySet<number>, limit: number): LeadActivityCard[] {
  const kinds = LEAD_ACTIVITY_DISPOSITIONS.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT id, item_id, summary, payload FROM inbox
     WHERE json_valid(payload) AND json_extract(payload, '$.disposition.kind') IN (${kinds})
     ORDER BY json_extract(payload, '$.disposition.at') DESC, id DESC
     LIMIT ?`,
  ).all(...LEAD_ACTIVITY_DISPOSITIONS, limit + covered.size) as Array<{ id: number; item_id: number | null; summary: string; payload: string }>;
  const cards: LeadActivityCard[] = [];
  for (const row of rows) {
    if (covered.has(row.id) || cards.length >= limit) continue;
    const disposition = (JSON.parse(row.payload) as { disposition: { kind: LeadActivityNote["disposition"]; reason?: unknown; at?: unknown } }).disposition;
    const at = typeof disposition.at === "string" ? disposition.at : "";
    const latest = latestCorrelatedEvent(db, `inbox:${row.id}`);
    const entityKey = latest ? leadActivityObjectKey(latest) : row.item_id !== null ? `ticket:${row.item_id}` : `inbox:${row.id}`;
    cards.push({
      key: `inbox:${row.id}`,
      entityKey,
      // 内容只在 Lead 改口时变（版本不变）；最新的事件 seq 只增不减。
      entityVersion: Math.max(1, latest?.seq ?? 0),
      lastSeq: latest?.seq ?? 0,
      at,
      updatedAt: at,
      ticketId: row.item_id,
      kind: "lead",
      state: "handled",
      summary: clip(row.summary),
      count: 1,
      basis: leadActivityBasis(latest?.triage ?? null),
      lead: { disposition: disposition.kind, reason: clip(typeof disposition.reason === "string" ? disposition.reason : ""), at },
      entries: [],
    });
  }
  return cards;
}

/** 一条 interrupt 级事件在横幅上的样子（确认过、别处已处理的也能算，推送「它结束了」时用）。 */
export function leadInterruptOf(db: Db, event: EventRecord): LeadInterrupt {
  const ack = findInterruptAck(db, event.eventId);
  const lastSeq = Math.max(event.seq, ack?.seq ?? 0);
  const message = textOf(event.rootCause?.message);
  return {
    key: `interrupt:${event.seq}`,
    seq: event.seq,
    entityKey: event.entityKey,
    // 确认会追加一条事件（seq 变大），记处置加 1。
    entityVersion: lastSeq + (event.disposition !== null ? 1 : 0),
    lastSeq,
    at: event.occurredAt,
    ticketId: ticketIdOfKey(leadActivityObjectKey(event)),
    kind: event.kind,
    summary: leadActivityEventSummary(event, leadDisplayName(db)),
    rootCause: event.rootCause ? { code: event.rootCause.code, ...(message ? { message: clip(message) } : {}) } : null,
    basis: leadActivityBasis(event.triage),
    acknowledgedAt: ack ? ack.occurredAt : null,
    resolvedElsewhere: event.disposition === "resolved_elsewhere",
  };
}

export function leadInterruptBySeq(db: Db, seq: number): LeadInterrupt | null {
  const event = getEvent(db, seq);
  return event && event.level === "interrupt" ? leadInterruptOf(db, event) : null;
}

// ── 会话里的提醒卡（工单 07）───────────────────────────────────────────────────────
// 一次到点一张卡，状态从事件日志算（store 的 reminderFireState）。卡的位置是到点的时间，之后原地更新：
// 推送、确认、改期、取消，Lead 回应它的那一轮（它说的话挂在卡下面），Lead 写到卡上的话。

const REMINDER_CARD_LIMIT = 50;

/** 一次到点的提醒卡。 */
export function reminderCardOf(db: Db, fire: EventRecord): ReminderCard {
  const state = reminderFireState(db, fire);
  return {
    key: `${fire.entityKey}@${fire.seq}`,
    entityKey: fire.entityKey,
    // 来一条事件（推送、确认、改期）seq 变大；Lead 写了话再加 1（它改口时版本不变、内容变了，客户端照样换上）。
    entityVersion: state.lastSeq + (state.lead ? 1 : 0),
    lastSeq: state.lastSeq,
    seq: fire.seq,
    at: fire.occurredAt,
    updatedAt: state.updatedAt,
    reminderId: state.reminderId,
    title: clip(state.title, 120),
    remindAt: state.remindAt,
    level: state.level,
    state: state.state,
    closedAt: state.closedAt,
    closedBy: state.closedBy,
    nextAt: state.nextAt,
    pushes: state.pushes,
    ticketId: state.policy.ticketId,
    check: state.policy.check,
    leadTurnId: state.leadTurnId,
    lead: state.lead ? { ...state.lead, reason: clip(state.lead.reason) } : null,
  };
}

export function reminderCardsOf(db: Db, afterSeq: number, limit = REMINDER_CARD_LIMIT): ReminderCard[] {
  return listReminderFires(db, { afterSeq, limit }).map((fire) => reminderCardOf(db, fire));
}

export interface LeadActivityViewOptions {
  // 卡片最多几张（最新的）。缺省 100，最多 500。
  limit?: number;
  // false：不算 Lead 在 inbox 行上的处置（推送比较时用：那一类由会话刷新带回来，见 LeadActivityPublisher）。
  leadDispositions?: boolean;
  // true：带上会话里的提醒卡（include=reminders，工单 07）。
  reminders?: boolean;
  // true：带上首次启动引导的准备清单卡和建议卡（include=setup，.scratch/onboarding）。
  setup?: boolean;
}

/** 「Lead 动态」的快照：卡片、横幅、水位。在一个读事务里算，水位和卡片对得上。 */
export function buildLeadActivityView(db: Db, options: LeadActivityViewOptions = {}): LeadActivityView {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_CARD_LIMIT), 1), 500);
  return db.transaction((): LeadActivityView => {
    const watermark = maxEventSeq(db);
    const afterSeq = Math.max(0, watermark - SCAN_WINDOW);
    const events = listLeadActivityEvents(db, { afterSeq, limit: DISPLAY_EVENT_LIMIT });
    const eventCards = groupLeadActivityCards(events, leadDisplayName(db));
    const covered = new Set(events.flatMap((event) => {
      const match = INBOX_CORRELATION.exec(event.correlationId ?? "");
      return match ? [Number(match[1])] : [];
    }));
    const dispositionCards = options.leadDispositions === false ? [] : leadDispositionCards(db, covered, limit);
    const cards = [...eventCards, ...dispositionCards]
      .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.key.localeCompare(right.key))
      .slice(-limit)
      .map((card) => withCardAction(db, withCausingOwnerAction(db, card)));
    const interrupts = listInterruptEvents(db, { afterSeq, limit: INTERRUPT_LIMIT })
      .filter((event) => event.disposition !== "superseded")
      .map((event) => leadInterruptOf(db, event))
      .filter(leadInterruptOpen);
    return {
      cards, interrupts, watermark,
      ...(options.reminders ? { reminders: reminderCardsOf(db, afterSeq) } : {}),
      ...(options.setup ? { setup: setupChecklistCardOf(db), setupHints: setupHintCardsOf(db) } : {}),
    };
  })();
}

// ── 首次启动引导的卡（2026-10-30，.scratch/onboarding）──────────────────────────────
// 状态都在 kv 里（store 的 setup.ts，daemon 算设置状态）。卡的位置固定，内容随设置状态原地更新。

/** 准备清单卡：首次上线时建的那一张。没建过（或者是功能上线前的老用户）时为 null。 */
export function setupChecklistCardOf(db: Db): SetupChecklistCard | null {
  const record = loadSetupChecklist(db);
  const status = loadSetupStatus(db);
  if (record?.state !== "shown" || !status) return null;
  const updatedAt = Date.parse(status.changedAt) > Date.parse(record.at) ? status.changedAt : record.at;
  return {
    key: SETUP_CHECKLIST_KEY, entityKey: SETUP_CHECKLIST_KEY, entityVersion: Math.max(1, Date.parse(updatedAt)),
    at: record.at, updatedAt, items: status.items,
  };
}

/** 建议卡，旧的在前。还没处理、这一项后来配好了的，状态是 ready；只有 open 的卡带「以后再说」「不用再提」。 */
export function setupHintCardsOf(db: Db): SetupHintCard[] {
  const status = loadSetupStatus(db);
  return loadSetupHints(db).cards.map((hint) => {
    const ready = hint.state === "open" && status?.items.find((item) => item.key === hint.item)?.ready === true;
    const updatedAt = ready && status && Date.parse(status.changedAt) > Date.parse(hint.updatedAt) ? status.changedAt : hint.updatedAt;
    const target = { type: "setup_hint", id: String(hint.id) };
    return {
      key: `setup_hint:${hint.id}`, entityKey: `setup_hint:${hint.id}`, entityVersion: Math.max(1, Date.parse(updatedAt)),
      at: hint.at, updatedAt, hintId: hint.id, item: hint.item,
      state: ready ? "ready" : hint.state,
      actions: hint.state === "open" && !ready
        ? [{ target, action: "snooze", label: "以后再说" }, { target, action: "dismiss", label: "不用再提" }]
        : [],
    };
  });
}

// 卡上的按钮（2026-10-29）：卡里最新一条事件是 Lead 自己做的、现在还能撤销的事（例如改了常驻偏好）时，带上撤销它的操作。
// 能不能撤销由操作层判断（engine 的 leadActivityCardAction）：撤销了、之后又改过，按钮就没了。
function withCardAction(db: Db, card: LeadActivityCard): LeadActivityCard {
  const latest = card.lastSeq ? getEvent(db, card.lastSeq) : undefined;
  const action = latest ? leadActivityCardAction(db, latest) : null;
  return action ? { ...card, action } : card;
}

// 这一行是你做的一次主人操作引出的（例如你允许了这次写入，2026-10-28 改版稿第 2 组）：带在卡上，会话里那一行并进来。
// 认法：同一个对象上你本人做的最近一次，是在回答一个请求（权限是 approvals:respond：允许写入、批准审批、回答决定……），
// 并且和这一行隔不到 OWNER_ACTION_WINDOW_MS（前后都算：写入确认的结果行在执行时就写下了，比网关记主人操作早几毫秒）。
// 请求这个对象就是为这一次回答存在的，它后面的记录是这次回答的结果。工单不是：你验收了 #89，几分钟后它的 Run 崩溃，
// 那一行说的是崩溃，不能写成「你允许了」（2026-10-28 用线上数据核对时发现）。
// Lead 代你做的不算：它在会话里有自己的注脚。隔得久的不算：工单这种对象一直在，它上面最近一次主人操作
// 和后来的记录没有因果（2026-10-28 线上：#117 的记录挂上了 10-25 那次 Lead 代你验收）。
const OWNER_ACTION_WINDOW_MS = 10 * 60_000;

// 和这张卡最新的一条事件比（没有事件的旧处置和 Lead 记处置的时间比）。
function withCausingOwnerAction(db: Db, card: LeadActivityCard): LeadActivityCard {
  const ownerAction = causingOwnerAction(db, card.entityKey, (card.lastSeq ? getEvent(db, card.lastSeq)?.occurredAt : null) ?? card.at);
  return ownerAction ? { ...card, ownerAction } : card;
}

function causingOwnerAction(db: Db, entityKey: string, at: string): LeadActivityOwnerAction | undefined {
  const event = latestEntityEvent(db, entityKey, OWNER_ACTION_PERFORMED_KIND);
  if (!event) return undefined;
  const source = event.payload.source as { client?: unknown } | undefined;
  if (source?.client === "lead") return undefined;
  if (ownerActionDefinition(String(event.payload.action ?? ""))?.scope !== "approvals:respond") return undefined;
  if (!(Math.abs(Date.parse(at) - Date.parse(event.occurredAt)) <= OWNER_ACTION_WINDOW_MS)) return undefined;
  const payload = event.payload;
  const target = payload.target as { label?: unknown } | undefined;
  const detail = payload.detail as { state?: unknown } | undefined;
  return {
    eventId: event.eventId,
    action: String(payload.action ?? ""),
    summary: clip(textOf(payload.summary) ?? ""),
    target: textOf(target?.label) ?? "",
    failed: detail?.state === "failed",
  };
}

type LeadActivityPushItem =
  | { card: LeadActivityCard } | { interrupt: LeadInterrupt } | { reminder: ReminderCard }
  | { setup: SetupChecklistCard } | { setupHint: SetupHintCard };

/** 一张卡、一条横幅或一张提醒卡变了时推出去的事件。 */
export function leadActivityPushEvent(item: LeadActivityPushItem): PublishGatewayEventInput {
  const projection = "card" in item ? item.card : "interrupt" in item ? item.interrupt : "reminder" in item ? item.reminder
    : "setup" in item ? item.setup : item.setupHint;
  // 提醒卡和首次启动引导的卡不带 itemId：带了的话，客户端把它当成「这一张工单变了」（提醒有 ticket.updated 另说）。
  const itemId = "card" in item || "interrupt" in item ? (projection as LeadActivityCard | LeadInterrupt).ticketId : null;
  return {
    type: "snapshot.required",
    requiredScope: "chat",
    ...(itemId !== null ? { itemId } : {}),
    payload: {
      resource: LEAD_ACTIVITY_RESOURCE,
      entityKey: projection.entityKey,
      entityVersion: projection.entityVersion,
      ...item,
    },
  };
}

function firstSeqOf(card: LeadActivityCard): number {
  const match = /@(\d+)$/u.exec(card.key);
  return match ? Number(match[1]) : 0;
}

/**
 * 比较前后两份投影，把变了的卡和横幅推出去（spec D16：服务端推送投影的变化，带 entityKey 和 entityVersion）。
 * 第一次 sync 只记下现在的样子，不推（daemon 重启不该把所有卡再推一遍，推送会写进 gateway_events）。
 * 事件写进日志时 daemon 马上 sync 一次；处置的变化（Lead 记处置、看过、别处已处理）没有新事件，由 daemon 的轮询带上。
 * 不推的：Lead 在 inbox 行上的处置（会话刷新时一起带回来）；因为扫描窗口截掉了前几条事件而换了键的旧卡。
 */
export interface LeadActivityPublisher {
  sync(publish: (event: PublishGatewayEventInput) => unknown): number;
}

export function createLeadActivityPublisher(db: Db): LeadActivityPublisher {
  let primed = false;
  let watermark = 0;
  const cards = new Map<string, string>();
  const interrupts = new Map<number, string>();
  const reminders = new Map<string, string>();
  const setupCards = new Map<string, string>();
  return {
    sync(publish) {
      const view = buildLeadActivityView(db, { leadDispositions: false, reminders: true, setup: true });
      let pushed = 0;
      const push = (item: LeadActivityPushItem) => {
        if (!primed) return;
        publish(leadActivityPushEvent(item));
        pushed++;
      };
      // 提醒卡（工单 07）：到点那一刻的新卡（seq 比上一次的水位大）马上推；之后的变化原地更新。
      const currentReminders = new Set<string>();
      for (const reminder of view.reminders ?? []) {
        currentReminders.add(reminder.key);
        const hash = JSON.stringify(reminder);
        const previous = reminders.get(reminder.key);
        if (previous === hash) continue;
        reminders.set(reminder.key, hash);
        if (previous === undefined && reminder.seq <= watermark) continue;
        push({ reminder });
      }
      for (const key of [...reminders.keys()]) if (!currentReminders.has(key)) reminders.delete(key);
      // 首次启动引导的卡（.scratch/onboarding）：新卡和变化都推（卡不多，状态都在 kv 里，没有事件的水位可比）。
      const setupItems: LeadActivityPushItem[] = [
        ...(view.setup ? [{ setup: view.setup }] : []),
        ...(view.setupHints ?? []).map((setupHint) => ({ setupHint })),
      ];
      for (const item of setupItems) {
        const card = "setup" in item ? item.setup : (item as { setupHint: SetupHintCard }).setupHint;
        const hash = JSON.stringify(card);
        if (setupCards.get(card.key) === hash) continue;
        setupCards.set(card.key, hash);
        push(item);
      }
      const currentCards = new Set<string>();
      for (const card of view.cards) {
        currentCards.add(card.key);
        const hash = JSON.stringify(card);
        const previous = cards.get(card.key);
        if (previous === hash) continue;
        cards.set(card.key, hash);
        if (previous === undefined && firstSeqOf(card) <= watermark) continue;
        push({ card });
      }
      for (const key of [...cards.keys()]) if (!currentCards.has(key)) cards.delete(key);
      const open = new Set<number>();
      for (const interrupt of view.interrupts) {
        open.add(interrupt.seq);
        const hash = JSON.stringify(interrupt);
        if (interrupts.get(interrupt.seq) === hash) continue;
        interrupts.set(interrupt.seq, hash);
        push({ interrupt });
      }
      // 不在横幅上了（确认了、别处已处理了）：推它结束以后的样子，客户端据此收起横幅。
      for (const seq of [...interrupts.keys()]) {
        if (open.has(seq)) continue;
        interrupts.delete(seq);
        const closed = leadInterruptBySeq(db, seq);
        if (closed) push({ interrupt: closed });
      }
      watermark = view.watermark;
      primed = true;
      return pushed;
    },
  };
}
