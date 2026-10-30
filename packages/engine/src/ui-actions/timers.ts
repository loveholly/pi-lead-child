// 定时器带着来源，由决策模型判断（统一的消息事件 spec D16，工单 12；契约和事件在 protocol 的 timer-origins.ts）。
//
//   - setTimer：设一个定时器（跟进、提醒、规则、改提醒时间），记下来源。Lead 的工具和确认卡用同一个函数。
//   - requestExternalTimer：外部的一轮里 Lead 要设定时器。决策模型（channels/timer-decision.ts）判断：
//       设了 → 记下决策，告诉用户一声（不推送的通知）；
//       要确认 → 存下这一个定时器（参数原样），返回确认卡的 user_action，Lead 原样放进 UserAction；
//       拒绝 → 记下决策，通知上写明原因。
//   - 确认卡（timer_request.resolve，权限 user_direct，Lead 调它总是被拒绝）：用户点「设定时器」，系统照存下的参数设，
//     来源仍然是要求设它的人，记下是哪台设备确认的；点「不设」记下来。两种结果都写一条 inbox 叫醒 Lead，都记成校准样本。
//   - 提醒列表（listExternalTimers）：外部的人要求设、还没到点的定时器，写明是谁要求的。
//   - 取消（timer.cancel）：页面和 Lead 走同一个操作。用户取消没问就设的定时器，记成校准样本。
// 状态都在事件日志里，不另建表。
import { randomBytes } from "node:crypto";
import {
  MESSAGE_EVENT_KIND, TIMER_KINDS, TIMER_OUTWARD_AUDIENCE_LABELS, TIMER_REQUEST_DECIDED_KIND, TIMER_REQUEST_EXECUTED_KIND, TIMER_REQUEST_ID,
  TIMER_REQUEST_REQUESTED_KIND, TIMER_REQUEST_RESOLVED_KIND, TIMER_REQUEST_TTL_MS, isSenderTrust, parseTimerRef, timerOriginOf,
  timerAskedBy, timerRef, timerRequesterLabel, userActionRequest,
  type ExternalTimerDto, type ExternalTimerOrigin, type MessageCeiling, type MessageInbound, type ReminderPolicy, type TimerKind,
  type TimerCost, type TimerOrigin, type TimerOutward, type TimerRequestDecision, type TimerRequestDto, type TimerRequestState, type TimerTool,
  type UiActionInputOf, type UserActionRequest, type WatchTimerDto,
} from "@pi-lead-child/protocol";
import { localIso, type Item } from "@pi-lead-child/core";
import {
  addInbox, addLeadFollowUp, addNotification, appendBody, appendEvent, bindingScopes, cancelLeadFollowUp, channelPolicy, createCronTrigger,
  createItem, createOnceTrigger, getBinding, getEvent, getItem, getTrigger, itemUpdatedEvent, labelTimer, labelTimerRequest, listEvents,
  listTriggers, publishGatewayEvent, recordReminderTimeSetter, reminderTimeOrigin, setItemTime, setTriggerEnabled, transition,
  cancelWatch, createWatch, getWatch, listWatches, watchMaxActive, watchOrigin,
  type Binding, type Db, type EventRecord, type FollowUpSetBy, type Trigger, type Watch, type WatchAgentChoice, type WatchMode,
} from "@pi-lead-child/store";
import { describeWatchSchedule } from "../pipeline/watch-runner.js";
import { decideTimerRequest, type TimerDecision } from "../channels/timer-decision.js";
import { CONFIDENCE_MODEL_DEFAULTS, type CostTopic } from "../channels/confidence-model.js";
import { channelCalibration, confidenceParamsFrom } from "../channels/policy.js";
import { AVAILABLE, unavailable } from "../ticket-actions/types.js";
import type { ExternalContentSource } from "./external-content.js";
import { UiActionError, type UiActionDefinition, type UiActionRun, type UiActionServices, type UiActionTargetKind } from "./types.js";

// ── 定时器的参数 ─────────────────────────────────────────────────────────────────

/** Lead 要设的一个定时器（Lead 的工具校验过的参数）。确认卡存下它，确认以后原样设。 */
export type TimerSpec =
  | { tool: "follow_up"; at: string; note: string; ticketId?: number; outward?: TimerOutward | null }
  | { tool: "create_reminder"; title: string; body?: string; remindAt: string; dueAt?: string; policy: ReminderPolicy }
  | { tool: "create_once_trigger"; label: string; fireAt: string; kind: "reminder" | "task"; title: string; brief?: string }
  | { tool: "create_cron_trigger"; label: string; cron: string; tz?: string; kind: "reminder" | "task"; title: string; brief?: string }
  | { tool: "reschedule_reminder"; reminderId: number; remindAt: string; reason: string }
  // 后台检查（.scratch/lead-watch/spec.md）：到点系统自己检查，有结果才叫醒 Lead。
  | {
    tool: "watch"; label: string; check: { kind: "command"; command: string } | { kind: "agent"; brief: string; agent?: WatchAgentChoice };
    mode: WatchMode; everySeconds?: number; cron?: string; tz?: string; untilAt?: string; note: string; ticketId?: number;
  };

/** 规则到点产出的事项的模板（store 的 trigger-actions.ts 的 action_payload 契约）。 */
export function triggerItemTemplate(params: { kind: "reminder" | "task"; title: string; brief?: string }): Record<string, unknown> {
  return params.kind === "reminder"
    ? { kind: "reminder", title: params.title, body: params.brief ?? "" }
    : { kind: "task", title: params.title, brief: params.brief ?? params.title, initial_stage: "draft" };
}

// 规则（trigger）变了：日程要重取，但没有对应的工单。
const SCHEDULE_CHANGED = { type: "ticket.updated", requiredScope: "tickets:view", payload: { snapshotRequired: true } } as const;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// 记进事件和卡上的代价：几档、叫什么、每一档为什么。
function costRecord(cost: TimerDecision["cost"]): TimerCost {
  return { level: cost.level, name: cost.name, steps: cost.steps.map((step) => ({ id: step.id, label: step.label, levels: step.levels, detail: step.detail })) };
}

function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return localIso(at).slice(5, 16).replace("T", " ");
}

/** 一句话说这个定时器：什么时候、做什么（卡上、通知上、给 Lead 的结果里都用它）。 */
export function describeTimer(db: Db, spec: TimerSpec): string {
  if (spec.tool === "follow_up") {
    const outward = spec.outward ? `（到点要在${TIMER_OUTWARD_AUDIENCE_LABELS[spec.outward.audience]}里替你对外做事）` : "";
    return `${when(spec.at)} 叫醒 Lead：${clip(spec.note, 200)}${outward}`;
  }
  if (spec.tool === "create_reminder") return `${when(spec.remindAt)} 提醒你：${clip(spec.title, 200)}`;
  if (spec.tool === "watch") {
    const schedule = describeWatchSchedule({
      mode: spec.mode, every_seconds: spec.everySeconds ?? null, cron_expr: spec.cron ?? null, until_at: spec.untilAt ?? null,
    });
    const how = spec.check.kind === "command" ? `跑命令 \`${clip(spec.check.command, 120)}\`` : "开子 agent";
    return `后台检查「${clip(spec.label, 100)}」：${schedule}，${how}${spec.check.kind === "agent" ? "（到点会自己开子 agent 去查）" : ""}`;
  }
  const makes = (kind: "reminder" | "task") => (kind === "reminder" ? "提醒你" : "建一张等你确认的工单");
  if (spec.tool === "create_once_trigger") return `${when(spec.fireAt)} ${makes(spec.kind)}：${clip(spec.title, 200)}`;
  if (spec.tool === "create_cron_trigger") return `按「${spec.cron}」${makes(spec.kind)}：${clip(spec.title, 200)}`;
  const reminder = getItem(db, spec.reminderId);
  return `把提醒 #${spec.reminderId}${reminder ? `「${clip(reminder.display_title ?? reminder.title, 100)}」` : ""}改到 ${when(spec.remindAt)}`;
}

function firstAt(spec: TimerSpec): string | null {
  if (spec.tool === "follow_up") return spec.at;
  if (spec.tool === "create_reminder" || spec.tool === "reschedule_reminder") return spec.remindAt;
  if (spec.tool === "watch") return null;
  return spec.tool === "create_once_trigger" ? spec.fireAt : null;
}

export interface SetTimerContext {
  origin: TimerOrigin;
  // 跟进：用户本人那一轮设的（到点那一轮算用户的一轮，store 的 user-turn-authority.ts）。
  setBy?: FollowUpSetBy | null;
  // 提醒：时间算谁定的（reminders.ts 的 REMINDER_TIME_SET），和在哪一轮里让 Lead 定的。
  reminderSetBy?: "user" | "lead";
  sourceTurnId?: string | null;
  // 改提醒时间走操作层（和页面上的「改时间」同一个操作）：Lead 当前的一轮、这一轮带着的外部内容、服务。
  turnId?: string | null;
  externalContent?: readonly ExternalContentSource[] | null;
  services?: UiActionServices;
  now?: Date;
}

export interface SetTimerResult {
  kind: TimerKind;
  id: number;
  // 给 Lead 的一句话。
  text: string;
}

// index.ts 也 import 这个文件（经过清单），所以 runUiAction 按需取，不在模块顶层互相引用。
const operationLayer = () => import("./index.js");

/** 设一个定时器，记下来源。Lead 的工具和确认卡都用它。参数由调用方校验过。 */
export async function setTimer(db: Db, spec: TimerSpec, context: SetTimerContext): Promise<SetTimerResult> {
  const origin = context.origin;
  if (spec.tool === "follow_up") {
    const id = addLeadFollowUp(db, {
      at: new Date(spec.at), note: spec.note, ...(spec.ticketId !== undefined ? { itemId: spec.ticketId } : {}),
      ...(context.setBy ? { setBy: context.setBy } : {}), origin,
    });
    // 外部的人要求设的跟进进提醒列表：让客户端重取（和规则一样）。
    if (origin.kind === "external") publishGatewayEvent(db, SCHEDULE_CHANGED);
    return { kind: "follow_up", id, text: `已设跟进 #${id}，${localIso(new Date(spec.at))} 叫醒你。` };
  }
  if (spec.tool === "create_reminder") {
    const id = db.transaction((): number => {
      const created = createItem(db, {
        kind: "reminder", title: spec.title, brief: "", createdBy: "lead", remindAt: new Date(spec.remindAt).toISOString(), reminderPolicy: spec.policy,
      });
      if (spec.body) appendBody(db, created, spec.body);
      if (spec.dueAt) setItemTime(db, created, { dueAt: new Date(spec.dueAt).toISOString() });
      recordReminderTimeSetter(db, created, {
        remindAt: new Date(spec.remindAt).toISOString(), setBy: context.reminderSetBy ?? "lead", actor: "lead",
        sourceTurnId: context.sourceTurnId ?? null, origin,
      });
      return created;
    })();
    publishGatewayEvent(db, itemUpdatedEvent(id));
    return { kind: "reminder", id, text: `created reminder #${id}，将于 ${new Date(spec.remindAt).toISOString()} 提醒` };
  }
  if (spec.tool === "watch") {
    const id = createWatch(db, {
      label: spec.label, check: spec.check, mode: spec.mode, note: spec.note, origin, setBy: context.setBy ?? null,
      ...(spec.everySeconds !== undefined ? { everySeconds: spec.everySeconds } : {}),
      ...(spec.cron !== undefined ? { cron: spec.cron } : {}), ...(spec.tz !== undefined ? { tz: spec.tz } : {}),
      ...(spec.untilAt !== undefined ? { untilAt: spec.untilAt } : {}), ...(spec.ticketId !== undefined ? { itemId: spec.ticketId } : {}),
      maxActive: watchMaxActive(),
    }, context.now ?? new Date());
    publishGatewayEvent(db, SCHEDULE_CHANGED);
    const watch = getWatch(db, id)!;
    return {
      kind: "watch", id,
      text: `已设后台检查 #${id}「${watch.label}」：${describeWatchSchedule(watch)}，第一次 ${watch.next_check_at ? localIso(new Date(watch.next_check_at)) : "—"}。`
        + "检查过程中不叫醒你，有结果才叫醒你。",
    };
  }
  if (spec.tool === "create_once_trigger" || spec.tool === "create_cron_trigger") {
    const action = { type: "create_item" as const, payload: { ...triggerItemTemplate(spec), origin } };
    const id = spec.tool === "create_once_trigger"
      ? createOnceTrigger(db, { label: spec.label, fireAt: new Date(spec.fireAt).toISOString(), createdBy: "lead", action })
      : createCronTrigger(db, { label: spec.label, cronExpr: spec.cron, tz: spec.tz, createdBy: "lead", action }, context.now ?? new Date());
    publishGatewayEvent(db, SCHEDULE_CHANGED);
    const next = getTrigger(db, id)?.next_fire_at ?? null;
    return {
      kind: "trigger", id,
      text: spec.tool === "create_once_trigger"
        ? `created once trigger #${id}「${spec.label}」，将于 ${next} 触发`
        : `created cron trigger #${id}「${spec.label}」，下次触发 ${next}`,
    };
  }
  // 改提醒时间：和页面上的「改时间」是同一个操作（ui-actions 的 reminder.reschedule），来源跟着记下。
  const { runUiAction } = await operationLayer();
  const outcome = await runUiAction(db, {
    target: { type: "reminder", id: spec.reminderId }, action: "reschedule", input: { remindAt: spec.remindAt }, reason: spec.reason,
    caller: { kind: "lead", turnId: context.turnId ?? null, externalContent: context.externalContent ?? null, timerOrigin: origin },
    services: context.services ?? {}, ...(context.now ? { now: context.now } : {}),
  });
  return { kind: "reminder", id: spec.reminderId, text: JSON.stringify(outcome.forLead) };
}

// ── 外部的一轮里要设的定时器：谁要求的，决策模型的输入 ───────────────────────────────────────

/**
 * 这一轮是谁要求设定时器的。events：交给这一轮的外部事件（daemon 记的消息事件、外部来源的定时器到点）；event：Lead 指明的
 * 那一条（要在 events 里）；fallback：这一轮带着的外部内容（说不出是哪条消息时用它的来源）。
 */
export function externalTimerOriginOf(
  db: Db, args: { events: readonly number[]; event?: number; fallback: readonly ExternalContentSource[] },
): ExternalTimerOrigin {
  if (args.event !== undefined && !args.events.includes(args.event)) {
    throw new UiActionError("invalid_input", `#${args.event} 不是交给这一轮的外部消息事件（这一轮的是 ${args.events.map((seq) => `#${seq}`).join("、") || "没有"}）`);
  }
  for (const seq of args.event !== undefined ? [args.event] : args.events) {
    const event = getEvent(db, seq);
    const origin = event ? originOfEvent(event) : null;
    if (!origin) continue;
    // Lead 没指明是哪条消息要的：记下这一轮读了哪条消息（决策模型照旧按它看风险：发信人的信任级别、授权表的上限），
    // 但不写成发信人要求的（2026-10-28 那张「Aurum 要求设一个定时器」的卡）。外部来源的定时器到点：照旧是原来那个来源。
    return args.event === undefined && event!.kind === MESSAGE_EVENT_KIND ? { ...origin, sender: null } : origin;
  }
  const first = args.fallback[0];
  const source = !first ? "external" : first.via === "message" ? first.source : first.tool;
  return { kind: "external", via: first?.via ?? "tool", source, sourceLabel: source, sender: null, messageEvent: null, conversation: null };
}

function originOfEvent(event: EventRecord): ExternalTimerOrigin | null {
  const payload = event.payload;
  if (event.kind === MESSAGE_EVENT_KIND && payload.external === true && typeof payload.source === "string") {
    const sender = payload.sender as { id?: unknown; name?: unknown } | undefined;
    const conversation = payload.conversation as { key?: unknown; label?: unknown } | undefined;
    return {
      kind: "external", via: "message", source: payload.source,
      sourceLabel: typeof payload.sourceLabel === "string" ? payload.sourceLabel : payload.source,
      sender: sender && typeof sender.id === "string" && typeof sender.name === "string" ? { id: sender.id, name: sender.name } : null,
      messageEvent: event.seq,
      conversation: conversation && typeof conversation.key === "string"
        ? { key: conversation.key, label: typeof conversation.label === "string" ? conversation.label : conversation.key } : null,
    };
  }
  // 外部来源的定时器到点叫醒的一轮：还是原来那个人要求的（确认过的不算：那是那一个定时器的确认）。
  const origin = event.kind === "timer.fired" ? timerOriginOf(payload.origin) : null;
  if (origin?.kind !== "external") return null;
  const { confirmedBy: _confirmed, ...rest } = origin;
  return rest;
}

function decisionInputOf(db: Db, origin: ExternalTimerOrigin, spec: TimerSpec) {
  const event = origin.messageEvent !== null ? getEvent(db, origin.messageEvent) : undefined;
  const payload = event?.kind === MESSAGE_EVENT_KIND ? event.payload : null;
  const sender = payload?.sender as { trust?: unknown } | undefined;
  const messages = Array.isArray(payload?.messages) ? payload.messages as unknown[] : [];
  // 请求 A 对来源那条消息的判断（hub 记的 channel.intake.decided，幂等键是 channel-intake:<来源>:<编号>）。
  const intake = typeof messages[0] === "number" ? db.prepare(
    "SELECT payload FROM events WHERE source = 'system' AND source_ref = ?",
  ).get(`channel-intake:${origin.source}:${messages[0]}`) as { payload: string } | undefined : undefined;
  let scores: { topics: Partial<Record<CostTopic, number>>; askConfidence: number | null } | null = null;
  if (intake) {
    try {
      const judged = JSON.parse(intake.payload) as { topics?: Record<string, number>; askConfidence?: number | null; status?: string };
      if (judged.status !== "unavailable" && judged.topics) {
        scores = { topics: judged.topics as Partial<Record<CostTopic, number>>, askConfidence: judged.askConfidence ?? null };
      }
    } catch {
      scores = null;
    }
  }
  return {
    inbound: (payload?.inbound ?? null) as MessageInbound | null,
    ceiling: (payload?.ceiling ?? null) as MessageCeiling | null,
    sender: { trust: isSenderTrust(sender?.trust) ? sender.trust : "unknown" as const },
    scores,
    outward: spec.tool === "follow_up" && spec.outward ? { audience: spec.outward.audience, members: null } : null,
    calibration: { samples: channelCalibration(db, origin.source).samples },
  };
}

// 外部的一轮里要设的子代理检查（.scratch/lead-watch/spec.md D5）：到点会照外部内容写的说明开一个子 agent 去做事，
// 代价高于「到点叫醒 Lead」，按「代价更高 → 确认卡」不直接设。决策模型说不设的照旧不设。
function agentWatchNeedsConfirm(spec: TimerSpec, decided: TimerDecision): TimerDecision {
  if (spec.tool !== "watch" || spec.check.kind !== "agent" || decided.decision !== "set") return decided;
  return { ...decided, decision: "confirm", reasons: [...decided.reasons, "到点会照这一轮读到的外部内容开子 agent 去查，要你确认"] };
}

// requester：这个定时器是怎么来的（protocol 的 timerAskedBy），后面接「定时器」：「Ethan（Slack）要求的」或者
// 「读了「…」里的消息以后设的」。
export type ExternalTimerOutcome =
  | { decision: "set"; timer: SetTimerResult; decided: TimerDecision; requester: string }
  | { decision: "confirm"; request: { id: string; userAction: UserActionRequest }; decided: TimerDecision; requester: string }
  | { decision: "refuse"; decided: TimerDecision; requester: string; message: string };

/**
 * 外部的一轮里 Lead 要设一个定时器（spec D16）：决策模型判断设、问用户、还是拒绝，并照结论做。note：Lead 写的为什么设。
 * context 和 setTimer 一样，origin 由这里给（外部的来源）。
 */
export async function requestExternalTimer(
  db: Db, request: { spec: TimerSpec; origin: ExternalTimerOrigin; note?: string; context?: Omit<SetTimerContext, "origin"> },
): Promise<ExternalTimerOutcome> {
  const now = request.context?.now ?? new Date();
  const policy = channelPolicy(db, request.origin.source);
  const decided = agentWatchNeedsConfirm(request.spec, decideTimerRequest(
    decisionInputOf(db, request.origin, request.spec), policy ? confidenceParamsFrom(policy.params) : CONFIDENCE_MODEL_DEFAULTS,
  ));
  // 「Ethan（Slack）要求的」或者「读了「…」里的消息以后设的」，后面接「定时器」。
  const requester = timerAskedBy(request.origin);
  const what = describeTimer(db, request.spec);
  const record = (timer: { kind: TimerKind; id: number } | null, requestId: string | null) => db.transaction(() => appendEvent(db, {
    source: "system", kind: TIMER_REQUEST_DECIDED_KIND,
    entityKey: timer ? `timer:${timerRef(timer.kind, timer.id)}` : requestId ? timerRequestEntityKey(requestId) : `timer-decision:${request.origin.source}`,
    level: "record", occurredAt: now.toISOString(),
    ...(request.origin.messageEvent !== null ? { causationId: String(request.origin.messageEvent) } : {}),
    payload: {
      decision: decided.decision, tool: request.spec.tool, origin: request.origin, cost: costRecord(decided.cost), reasons: decided.reasons,
      timer, request: requestId,
      summary: `${requester}定时器（${clip(what, 120)}）：${decided.decision === "set" ? "设了" : decided.decision === "confirm" ? "问你" : "不设"}`,
    },
  }))();
  if (decided.decision === "set") {
    const timer = await setTimer(db, request.spec, { ...request.context, origin: request.origin });
    record({ kind: timer.kind, id: timer.id }, null);
    tellUser(db, `${requester}定时器已设`, `${what}。可以在「等待中的提醒」里取消。`, now);
    return { decision: "set", timer, decided, requester };
  }
  if (decided.decision === "confirm") {
    const card = storeTimerRequest(db, { spec: request.spec, origin: request.origin, decided, note: request.note ?? "", now });
    record(null, card.id);
    return { decision: "confirm", request: card, decided, requester };
  }
  record(null, null);
  const message = `没有设：${decided.reasons.join("；")}`;
  tellUser(db, `${requester}定时器没有设`, `${what}。${message}`, now);
  return { decision: "refuse", decided, requester, message };
}

// 告诉用户一声：一条不推送的通知（收件箱里的一张卡）。
function tellUser(db: Db, title: string, body: string, now: Date): void {
  addNotification(db, { kind: "timer_request", urgency: "batchable", title: clip(title, 120), body: clip(body, 1_000), createdAt: now.toISOString() });
}

// ── 确认卡 ───────────────────────────────────────────────────────────────────────

export const timerRequestEntityKey = (id: string) => `timer_request:${id}`;
const CONFIRM_TITLE = "设定时器";

interface StoredTimerRequest {
  id: string;
  tool: TimerTool;
  spec: TimerSpec;
  origin: ExternalTimerOrigin;
  cost: TimerCost;
  reasons: string[];
  note: string;
  expiresAt: string;
}

interface TimerRequestRecord {
  request: StoredTimerRequest;
  createdAt: string;
  resolution: { decision: TimerRequestDecision; resolvedBy: string; bindingId: number | null; at: string } | null;
  execution: { state: "done" | "failed"; timer: string | null; result: string; at: string } | null;
}

function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : item)) ?? "null";
}

function recordOf(db: Db, id: string): TimerRequestRecord | null {
  if (!TIMER_REQUEST_ID.test(id)) return null;
  const events = listEvents(db, {
    entityKey: timerRequestEntityKey(id), kind: [TIMER_REQUEST_REQUESTED_KIND, TIMER_REQUEST_RESOLVED_KIND, TIMER_REQUEST_EXECUTED_KIND], limit: 10,
  });
  const first = (kind: string) => events.find((event) => event.kind === kind);
  const requested = first(TIMER_REQUEST_REQUESTED_KIND);
  if (!requested) return null;
  const resolved = first(TIMER_REQUEST_RESOLVED_KIND);
  const executed = first(TIMER_REQUEST_EXECUTED_KIND);
  return {
    request: requested.payload as unknown as StoredTimerRequest,
    createdAt: requested.occurredAt,
    resolution: resolved ? { ...(resolved.payload as unknown as Omit<NonNullable<TimerRequestRecord["resolution"]>, "at">), at: resolved.occurredAt } : null,
    execution: executed ? { ...(executed.payload as unknown as Omit<NonNullable<TimerRequestRecord["execution"]>, "at">), at: executed.occurredAt } : null,
  };
}

function stateOf(record: TimerRequestRecord, now: Date): TimerRequestState {
  if (record.execution) return record.execution.state;
  if (record.resolution) return record.resolution.decision === "decline" ? "declined" : "running";
  return now.getTime() >= Date.parse(record.request.expiresAt) ? "expired" : "pending";
}

function dtoOf(db: Db, record: TimerRequestRecord, now: Date): TimerRequestDto {
  const { request } = record;
  return {
    id: request.id,
    state: stateOf(record, now),
    tool: request.tool,
    what: describeTimer(db, request.spec),
    at: firstAt(request.spec),
    repeat: request.spec.tool === "create_cron_trigger" ? request.spec.cron : null,
    outward: request.spec.tool === "follow_up" ? request.spec.outward ?? null : null,
    origin: request.origin,
    requester: timerRequesterLabel(request.origin),
    reasons: request.reasons,
    cost: request.cost,
    note: request.note,
    createdAt: record.createdAt,
    expiresAt: request.expiresAt,
    resolvedAt: record.resolution?.at ?? null,
    resolvedBy: record.resolution?.resolvedBy ?? null,
    timer: record.execution?.timer ?? null,
    resultPreview: record.execution ? clip(record.execution.result, 500) : null,
  };
}

/** 一张确认卡现在的样子（卡和网关读它）。没有这张卡时为 null。 */
export function getTimerRequest(db: Db, id: string, now: Date = new Date()): TimerRequestDto | null {
  const record = recordOf(db, id);
  return record ? dtoOf(db, record, now) : null;
}

/** 存下一个要确认的定时器。同一个人要求的同一个定时器已经有一张没决定的卡时，用那一张。 */
function storeTimerRequest(
  db: Db, args: { spec: TimerSpec; origin: ExternalTimerOrigin; decided: TimerDecision; note: string; now: Date },
): { id: string; userAction: UserActionRequest } {
  const key = sortedJson({ spec: args.spec, origin: args.origin });
  const id = db.transaction((): string => {
    const known = listEvents(db, { kind: TIMER_REQUEST_REQUESTED_KIND, order: "desc", limit: 50 })
      .map((event) => recordOf(db, String(event.payload.id)))
      .find((record) => record && stateOf(record, args.now) === "pending"
        && sortedJson({ spec: record.request.spec, origin: record.request.origin }) === key);
    if (known) return known.request.id;
    const fresh = `tmr_${randomBytes(12).toString("base64url")}`;
    const payload: StoredTimerRequest = {
      id: fresh, tool: args.spec.tool, spec: args.spec, origin: args.origin, cost: costRecord(args.decided.cost), reasons: args.decided.reasons,
      note: args.note, expiresAt: new Date(args.now.getTime() + TIMER_REQUEST_TTL_MS).toISOString(),
    };
    appendEvent(db, {
      source: "system", kind: TIMER_REQUEST_REQUESTED_KIND, entityKey: timerRequestEntityKey(fresh), level: "record",
      payload: payload as unknown as Record<string, unknown>, occurredAt: args.now.toISOString(),
    });
    return fresh;
  })();
  return {
    id,
    userAction: userActionRequest({
      kind: "confirm_timer", target: timerRequestEntityKey(id), title: CONFIRM_TITLE,
      reason: clip(`${timerAskedBy(args.origin)}定时器：${describeTimer(db, args.spec)}`, 300),
    }),
  };
}

export interface TimerRequestTarget {
  request: TimerRequestDto;
  spec: TimerSpec;
}

export const TIMER_REQUEST_TARGET: UiActionTargetKind<TimerRequestTarget> = {
  type: "timer_request",
  label: "定时器的确认卡",
  idHint: "确认号，tmr_ 开头",
  load(env, id) {
    const record = recordOf(env.db, id);
    return record ? { request: dtoOf(env.db, record, env.now), spec: record.request.spec } : null;
  },
  name: (target) => `定时器的确认卡（${target.request.requester}）`,
  describe: (target) => ({
    id: target.request.id, state: target.request.state, what: target.request.what, requester: target.request.requester,
    reasons: target.request.reasons, expiresAt: target.request.expiresAt, timer: target.request.timer,
  }),
};

const STATE_WORDS: Record<Exclude<TimerRequestState, "pending">, string> = {
  running: "这张确认卡已经点了「设定时器」，正在设",
  done: "这张确认卡已经确认，定时器设好了",
  failed: "这张确认卡已经确认过了，没设成",
  declined: "这张确认卡已经点了「不设」",
  expired: "这张确认卡已经过期作废了",
};

// 确认卡上的定时器是怎么来的（timerAskedBy）。读不懂来源时退回要求人的名字。
function askedBy(request: TimerRequestDto): string {
  return request.origin.kind === "external" ? timerAskedBy(request.origin) : `${request.requester} 要求的`;
}

function tellLead(db: Db, request: TimerRequestDto): void {
  const summary = request.state === "declined"
    ? `用户在定时器的确认卡上点了「不设」：${askedBy(request)}「${request.what}」。不要再设，也不要换别的办法去设。`
    : request.state === "done"
    ? `用户确认了，定时器设好了（${request.timer}）：${askedBy(request)}「${request.what}」。来源仍然是 ${request.requester}，到点那一轮按外部的一轮算。`
    : `用户确认了，但没设成：${request.what}。原因：${request.resultPreview ?? "未知"}`;
  addInbox(db, {
    // 对象键和确认卡一样（timer_request:<编号>）：Lead 在等这张卡时，等待按它认出这一条已经叫醒了 Lead（lead-waits.ts）。
    dedupScope: timerRequestEntityKey(request.id), severity: "attention", source: "structural", lossless: true, summary,
    payload: { kind: "timer_request", request: request.id, state: request.state, wakeLead: true, needsUser: false },
  });
}

async function resolveTimerRequest(
  run: UiActionRun<TimerRequestTarget, UiActionInputOf<"timer_request", "resolve">>,
): Promise<{ request: TimerRequestDto }> {
  const { db, env } = run;
  const id = run.target.request.id;
  const decision = run.input.decision;
  const binding: Binding | null = run.bindingId === null ? null : getBinding(db, run.bindingId) ?? null;
  // 账本要记下是哪台设备确认的；设定时器要 tickets:create（和 Lead 设它时一样）。
  if (decision === "confirm") {
    if (!binding) throw new UiActionError("forbidden", "要在配对过的设备上确认：账本要记下是哪台设备点的");
    if (!bindingScopes(binding).includes("tickets:create")) throw new UiActionError("forbidden", "设定时器要 tickets:create 权限，这台设备的凭证没有");
  }
  const resolvedBy = binding ? `user via ${binding.display_name}（binding ${binding.id}）` : "user via page";
  // 先记下决定，再设：同一张卡只设一次。
  db.transaction(() => {
    const record = recordOf(db, id);
    const state = record ? stateOf(record, env.now) : "expired";
    if (state !== "pending") throw new UiActionError("unavailable", `${STATE_WORDS[state]}。`);
    appendEvent(db, {
      source: "system", kind: TIMER_REQUEST_RESOLVED_KIND, entityKey: timerRequestEntityKey(id), level: "record",
      payload: { id, decision, actor: "user", resolvedBy, bindingId: binding?.id ?? null }, occurredAt: env.now.toISOString(),
    });
    if (decision === "decline") labelTimerRequest(db, id, "declined", null, env.now);
  })();
  if (decision === "decline") {
    const declined = getTimerRequest(db, id, env.now)!;
    tellLead(db, declined);
    return { request: declined };
  }
  const stored = recordOf(db, id)!.request;
  let execution: { state: "done" | "failed"; timer: string | null; result: string };
  try {
    const origin: ExternalTimerOrigin = { ...stored.origin, confirmedBy: { bindingId: binding!.id, request: id, at: env.now.toISOString() } };
    const set = await setTimer(db, stored.spec, { origin, services: env.services, now: env.now });
    execution = { state: "done", timer: timerRef(set.kind, set.id), result: set.text };
  } catch (error) {
    execution = { state: "failed", timer: null, result: error instanceof Error ? error.message : String(error) };
  }
  db.transaction(() => {
    appendEvent(db, {
      source: "system", kind: TIMER_REQUEST_EXECUTED_KIND, entityKey: timerRequestEntityKey(id), level: "record",
      payload: { id, state: execution.state, timer: execution.timer, result: clip(execution.result, 2_000) }, occurredAt: env.now.toISOString(),
    });
    if (execution.state === "done") labelTimerRequest(db, id, "confirmed", execution.timer, env.now);
  })();
  const request = getTimerRequest(db, id, env.now)!;
  tellLead(db, request);
  return { request };
}

export const TIMER_REQUEST_ACTIONS = {
  resolve: {
    target: "timer_request", id: "resolve", label: "在确认卡上决定设不设定时器", scope: "approvals:respond",
    // 放行外部的人要求、代价不够低的定时器，是批准 Lead 自己的请求：只有用户本人能决定（AGENTS.md UI Actions）。
    permission: "user_direct", changesRules: false, external: false, irreversible: false,
    where: "会话里的定时器确认卡",
    hint: "外部的人要求设的定时器代价不够低时（refusal.code=timer_needs_confirmation），用户在确认卡上点「设定时器」或「不设」。"
      + "你不能替用户点：调用总是被拒绝。",
    defaultReason: "在确认卡上决定",
    available: (target) => (target.request.state === "pending"
      ? AVAILABLE : unavailable(`${STATE_WORDS[target.request.state as Exclude<TimerRequestState, "pending">]}。`)),
    run: (run) => resolveTimerRequest(run as UiActionRun<TimerRequestTarget, UiActionInputOf<"timer_request", "resolve">>),
    forLead: (_run, result) => {
      const { request } = result as { request: TimerRequestDto };
      return { request: { id: request.id, state: request.state, timer: request.timer, resultPreview: request.resultPreview } };
    },
    detail: (run, result) => ({
      decision: (run.input as { decision: TimerRequestDecision }).decision,
      state: (result as { request: TimerRequestDto }).request.state,
      tool: run.target.request.tool,
    }),
  },
} satisfies Record<string, UiActionDefinition<TimerRequestTarget, UiActionInputOf<"timer_request", "resolve">>>;

// ── 定时器本身：提醒列表和取消 ─────────────────────────────────────────────────────────

export interface TimerTarget {
  ref: string;
  kind: TimerKind;
  id: number;
  title: string;
  at: string | null;
  repeat: string | null;
  // waiting 还没到点、在等；done 跟进已经到点了、提醒已经确认了、规则停用了；cancelled 取消了。
  state: "waiting" | "done" | "cancelled";
  origin: TimerOrigin;
}

function followUpTarget(db: Db, id: number): TimerTarget | null {
  const row = db.prepare("SELECT id, state, payload FROM inbox WHERE id = ?").get(id) as { id: number; state: string; payload: string } | undefined;
  if (!row) return null;
  let payload: { kind?: unknown; note?: unknown; notBefore?: unknown; origin?: unknown; setBy?: unknown; disposition?: { kind?: unknown } } = {};
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  if (payload.kind !== "lead_followup") return null;
  const fired = db.prepare("SELECT 1 FROM events WHERE source = 'timer' AND source_ref = ?").get(`followup:${id}`) !== undefined;
  return {
    ref: timerRef("follow_up", id), kind: "follow_up", id, title: typeof payload.note === "string" ? payload.note : "",
    at: typeof payload.notBefore === "string" ? payload.notBefore : null, repeat: null,
    state: payload.disposition?.kind === "cancelled" ? "cancelled" : fired || row.state === "consumed" ? "done" : "waiting",
    origin: timerOriginOf(payload.origin) ?? (payload.setBy ? { kind: "user", turnId: null } : { kind: "system" }),
  };
}

function reminderTarget(db: Db, item: Item): TimerTarget {
  return {
    ref: timerRef("reminder", item.id), kind: "reminder", id: item.id, title: item.display_title ?? item.title, at: item.remind_at,
    repeat: null, state: item.stage === "cancelled" ? "cancelled" : item.stage === "scheduled" || item.stage === "fired" ? "waiting" : "done",
    origin: reminderTimeOrigin(db, item.id),
  };
}

function triggerTarget(trigger: Trigger): TimerTarget {
  let origin: TimerOrigin = trigger.created_by === "user" ? { kind: "user", turnId: null } : { kind: "system" };
  try {
    origin = timerOriginOf((JSON.parse(trigger.action_payload || "{}") as { origin?: unknown }).origin) ?? origin;
  } catch {
    // 读不懂的 action_payload：按谁建的算。
  }
  return {
    ref: timerRef("trigger", trigger.id), kind: "trigger", id: trigger.id, title: trigger.label, at: trigger.next_fire_at,
    repeat: trigger.cron_expr, state: trigger.enabled ? "waiting" : "done", origin,
  };
}

function watchTarget(watch: Watch): TimerTarget {
  return {
    ref: timerRef("watch", watch.id), kind: "watch", id: watch.id, title: watch.label, at: watch.next_check_at,
    repeat: watch.mode === "repeat" ? watch.cron_expr ?? `every ${watch.every_seconds}s` : null,
    state: watch.state, origin: watchOrigin(watch),
  };
}

/** 按编号（follow_up:12、reminder:5、trigger:3、watch:2）找一个定时器。不是定时器时为 null。 */
export function loadTimer(db: Db, ref: string): TimerTarget | null {
  const parsed = parseTimerRef(ref);
  if (!parsed) return null;
  if (parsed.kind === "follow_up") return followUpTarget(db, parsed.id);
  if (parsed.kind === "reminder") {
    const item = getItem(db, parsed.id);
    return item?.kind === "reminder" ? reminderTarget(db, item) : null;
  }
  if (parsed.kind === "watch") {
    const watch = getWatch(db, parsed.id);
    return watch ? watchTarget(watch) : null;
  }
  const trigger = getTrigger(db, parsed.id);
  return trigger ? triggerTarget(trigger) : null;
}

/** 提醒列表里外部的人要求设、还在等的定时器（spec D16）：写明谁要求的，先到的在前。 */
export function listExternalTimers(db: Db): ExternalTimerDto[] {
  const followUps = (db.prepare(
    `SELECT id FROM inbox WHERE state IN ('pending', 'delivered') AND json_valid(payload)
       AND json_extract(payload, '$.kind') = 'lead_followup' AND json_extract(payload, '$.origin.kind') = 'external'`,
  ).all() as Array<{ id: number }>).map((row) => followUpTarget(db, row.id));
  // 提醒只列还没到点的（到点的在会话里有到点卡）。
  const reminders = (db.prepare("SELECT * FROM items WHERE kind = 'reminder' AND stage = 'scheduled'").all() as Item[])
    .map((item) => reminderTarget(db, item));
  const triggers = listTriggers(db, { enabledOnly: true }).map(triggerTarget);
  return [...followUps, ...reminders, ...triggers]
    .filter((timer): timer is TimerTarget & { origin: ExternalTimerOrigin } => timer !== null && timer.state === "waiting" && timer.origin.kind === "external")
    .sort((a, b) => (a.at ?? "9").localeCompare(b.at ?? "9") || TIMER_KINDS.indexOf(a.kind) - TIMER_KINDS.indexOf(b.kind) || a.id - b.id)
    .map((timer) => ({
      ref: timer.ref, kind: timer.kind, title: timer.title, at: timer.at, repeat: timer.repeat,
      // 说不出是谁要求的（Lead 没指明是哪条消息，或者这一轮读了外部对话）时 name 是空的：列表写「来自 Slack」，不写「Slack 要求」。
      requester: { name: timer.origin.sender?.name ?? "", source: timer.origin.source, sourceLabel: timer.origin.sourceLabel },
      messageEvent: timer.origin.messageEvent, confirmed: timer.origin.confirmedBy !== undefined,
    }));
}

/** 提醒列表里还在等的后台检查（.scratch/lead-watch/spec.md D5）：所有来源的，写明谁设的，先到的在前。 */
export function listWatchTimers(db: Db): WatchTimerDto[] {
  return listWatches(db, { waitingOnly: true }).map((watch) => {
    const origin = watchOrigin(watch);
    return {
      ref: timerRef("watch", watch.id), title: watch.label, check: watch.check_kind, schedule: describeWatchSchedule(watch),
      nextAt: watch.next_check_at, running: watch.running_since !== null, lastStatus: watch.last_status, lastCheckedAt: watch.last_checked_at,
      setBy: origin.kind === "external" ? "external" : origin.kind === "user" ? "user" : "lead",
      requester: origin.kind === "external" ? { name: origin.sender?.name ?? "", sourceLabel: origin.sourceLabel } : null,
    };
  });
}

export const TIMER_TARGET: UiActionTargetKind<TimerTarget> = {
  type: "timer",
  label: "定时器",
  idHint: "follow_up:<跟进的编号>、reminder:<提醒的编号>、trigger:<规则的编号>、watch:<后台检查的编号>",
  load: (env, id) => loadTimer(env.db, id),
  name: (timer) => `定时器 ${timer.ref}「${clip(timer.title, 40)}」`,
  describe: (timer) => ({
    ref: timer.ref, kind: timer.kind, title: timer.title, at: timer.at, repeat: timer.repeat, state: timer.state,
    requester: timer.origin.kind === "external" ? timerRequesterLabel(timer.origin) : timer.origin.kind,
  }),
};

export const TIMER_ACTIONS = {
  cancel: {
    target: "timer", id: "cancel", label: "取消定时器", scope: "tickets:create",
    // 取消只会少做事：Lead 可以自己判断（和取消自己的跟进一样）。
    permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    where: "收件箱的「等待中的提醒」",
    hint: "取消一个还在等的定时器：跟进不再叫醒你，提醒取消，规则停用，后台检查不再检查。用户说不要别人让你设的那个定时器、"
      + "或者后台检查盯的事已经办完时用。"
      + "target_id 是 follow_up:<编号>、reminder:<编号>、trigger:<编号> 或 watch:<编号>（提醒列表、read_inbox、list_triggers、list_watches 里有）。",
    defaultReason: "在提醒列表里取消了",
    available: (timer) => (timer.state === "waiting" ? AVAILABLE : unavailable(`${timer.ref} 已经${timer.state === "cancelled" ? "取消了" : "到点或者停用了"}。`)),
    run: (run) => {
      const { db, target } = run;
      db.transaction(() => {
        if (target.kind === "follow_up") cancelLeadFollowUp(db, target.id, { reason: run.reason, at: run.env.now });
        else if (target.kind === "reminder") transition(db, { itemId: target.id, to: "cancelled", actor: run.by.actor, reason: run.reason, now: run.env.now });
        else if (target.kind === "watch") cancelWatch(db, target.id, { reason: run.reason, at: run.env.now });
        else setTriggerEnabled(db, target.id, false);
        // 用户（或者 Lead 在用户这一轮里代他）取消了没问就设的外部来源定时器：校准样本。
        if (run.by.actor === "user" || run.by.onBehalfOf) labelTimer(db, target.kind, target.id, "cancelled", "user", run.env.now);
      })();
      publishGatewayEvent(db, target.kind === "reminder" ? itemUpdatedEvent(target.id, run.env.now) : SCHEDULE_CHANGED);
      return { ref: target.ref, state: "cancelled" as const };
    },
    forLead: (_run, result) => result,
    detail: (run) => ({ ref: run.target.ref, origin: run.target.origin.kind }),
  },
} satisfies Record<string, UiActionDefinition<TimerTarget, Record<string, never>>>;
