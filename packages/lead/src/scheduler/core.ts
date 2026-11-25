// Lead 调度器的决策层（lead-scheduler spec D9）：一个纯函数 (状态, 事件, 现在的时间) → (新状态, 要做的事)。
//
// P1「抽出调度器，行为不变」：以前 daemon 的 server.ts 里有十几个变量在做调度（busy、draining、systemTurnStarting、
// turnStartedAt、budgetStartedAt、runToolCalls、overflowReminded、secondReminded、queueNoticed、redLine 的五个阶段、
// toolsInFlight、userStopRequested、restartAbort），规则分散在 checkLeadBudget、stopForRedLine、continueAfterRedLine、
// noticeQueue、restartLeadBudget、stopLeadTurn、drainLead 里。现在这些状态和规则都在这里，server.ts 只执行这里给出的事：
// 发提醒、中止、送交接消息、写日志和事件。规则和以前一样，只改了一处（优先级反转，见 countedWaiting）。
//
// 两盏灯（lead 的 overflow.ts、red-line.ts，用户 2026-11-03）：
//   · 黄灯（缺省 2 分钟或 10 次工具调用）：提醒一次；
//   · 红灯（就地预算，缺省 2 分 30 秒）：有人在等时停下这一轮，叫 Lead 交接；没有人在等时再提醒一次，之后有人开始等时
//     照样停下。正在跑的调用不等：改东西的转到后台接着跑（tool-abort-guard.ts，.scratch/tool-occupancy/spec.md 第 7 节
//     第 1 条），然后中断；交接最多 handoffMs，到时再中断一次。
// 排队说明（lead-self-routing spec C）：一个对话排队超过阈值时插一条说明，同一个单元只插一次。
//
// 优先级反转（spec「背景」，用户 2026-11-09 的决定 2）：外部的人的消息不能抢占用户本人的 L0 单元。L0 单元里，
// 只有 L0 的等待（用户本人的消息）算数：外部消息只排队，不让这个单元停下、不让 Lead 先去回他们。L0 单元本身就是
// 用户在等，所以过了就地预算一定停下，不看用户的消息有没有文字。
//
// P2「交接」（spec H1、H10，用户 2026-11-09 的决定 10）：
//   · 到了就地预算，没有人在等也交出去（待定 9）：Lead 是常驻的，下一条输入随时会来。以前没有人在等时只再提醒一次。
//   · 让出点（D3、D4）：一步的工具结果回来以后、下一次模型请求之前（yield.check），用掉的时间加上一步的 p90 会超过就地预算时，
//     在这里就停下，不再开一步做不完的。
//   · 交接窗口里 Lead 调了 hand_off（handoff.made）：交出去了。窗口到时或者这一段结束时还没交，单元挂起（unit.suspend）：
//     交接包存下来，下一轮由 Lead 决定，系统不替它派出子 agent。
//
// P3「抢占」（spec D4、D10，用户 2026-11-09 的决定 1）：用户本人的消息到达，正在跑的单元不是 L0（系统事件、外部消息、
// 子 agent 交回的事）时：
//   · Lead 在等模型（没有工具在跑）：中止这一步（abort preempt），单元挂起（H10），马上处理用户的消息；
//   · 有工具在跑（写操作不能打断，D5）：记下「要抢占」，到下一个让出点（工具结果回来以后、下一次模型请求之前）再中止和挂起；
//   · L0 的单元（用户自己的事、交回给用户的结果）不抢占：用户的消息按「忙时的放置方式」排队或插话。
// 外部的人的消息永远不抢占用户的 L0 单元（P1）。
//
// 所有决定都写一条 [sched] 日志（D12）：决定了什么、为什么、依据的数字、单元编号和 turn id。不写消息原文。
import type { WaitingConversation } from "../overflow.js";
import { abortReasonText, type LeadAbortReason } from "./controller.js";
import { LANES, laneName, type Lane, type UnitSource } from "./lanes.js";

export interface SchedulerLimits {
  // 黄灯：工具调用次数和时长（overflow.ts 的 overflowLimits）。
  yellowToolCalls: number;
  yellowMs: number;
  // 红灯：就地预算（red-line.ts）。
  budgetMs: number;
  handoffMs: number;
  // 排队说明的阈值：外部的人、用户本人（overflow.ts 的 queueNoticeMs、userQueueNoticeMs）。
  queueNoticeMs: number;
  userQueueNoticeMs: number;
}

/** 在等的一个对话，带上它的车道（D1：用户本人的是 L0，外部的人是 L1）。 */
export interface WaitingEntry extends WaitingConversation {
  lane: Lane;
}

export type RedLinePhase = "stopping" | "aborting" | "handoff" | "closing" | "done";

export interface RedLineState {
  // stopping：决定停下、还没中断；aborting：已经中断，这一次 prompt 返回后送红线消息；
  // handoff：Lead 在交接，只能用交接的工具；closing：交接超时，又中断了一次；done：交接完了。
  phase: RedLinePhase;
  // 停下时在等的人（送交接消息时都已经送到了，就用这一份）。
  waiting: WaitingEntry[];
  stoppedAt: number;
  // 交接窗口什么时候到（handoff 阶段才有）。机器睡着的时间不算（clock.gap 把它往后推）：窗口的定时器在醒来时到点，
  // 还没到这个时间就重新定时（handoff.rearm）。
  handoffDueAt?: number;
  // 交接窗口里机器睡过（clock.gap）：只有这时窗口的定时器才可能早于 handoffDueAt 到点、需要重新定时。
  slept?: boolean;
}

export interface ToolInFlight {
  name: string;
  // 它改不改东西（red-line.ts 的 writeCall，按工具清单）。红线不再等它：改东西的调用转到后台。
  write: boolean;
}

// yielded：空闲车道的单元给更高车道的输入让了路（P4）。suspended：用户本人的消息抢占了这个单元，单元挂起（P3）。
export type UnitOutcome = "answered" | "failed" | "stopped" | "interrupted" | "offline" | "yielded" | "suspended";

export interface UnitState {
  id: string;
  lane: Lane;
  source: UnitSource;
  // 系统回合的来源（system:digest 等），用户的单元为 null。
  origin: string | null;
  // 现在接文字的那一轮（关联编号）。插话接过出水口时会变。
  turnId: string | null;
  openedAt: number;
  // 单元真正开始跑的时间（换模型、等扩展重载以后，以前的 turnStartedAt）。卡死的粗检查（checkLeadLiveness）用它。
  beganAt: number | null;
  // 预算从什么时候开始算：换模型、等扩展重载以后才开始（以前的 turnStartedAt）。排着的消息在同一次运行里开始答时重新算。
  budgetStartedAt: number | null;
  // 顶层的工具调用次数（codemode 脚本里的嵌套调用不算），只为黄灯：排着的消息开始答时清零。
  toolCalls: number;
  // 这个单元一共调了几次顶层的工具（不清零），单元结束的日志和记录用它。
  totalToolCalls: number;
  // 模型回复的次数（每一步一次），只为日志和统计。
  steps: number;
  yellowReminded: boolean;
  secondReminded: boolean;
  queueNoticed: boolean;
  // L0 单元里只有外部的人等过了阈值、没有插说明（queue_hold）：已经记过一次日志。
  queueHeld: boolean;
  redLine: RedLineState | null;
  // 这个单元里发出过的中止，按先后。以前是 userStopRequested、restartAbort 两个标记和红线的阶段。
  aborts: LeadAbortReason[];
  tools: Record<string, ToolInFlight>;
  // 控制层的段号：每次中止以后在同一个单元里再送一次 prompt（红线的交接）时加一。
  segment: number;
  // 这个单元用 hand_off 交出去了：交接包编号（P2）。
  handedOff: string | null;
  // 用户本人的消息要抢占这个单元，但当时有工具在跑：到下一个让出点再中止（P3）。by 是用户那一轮。
  preemptPending: { by: string; at: number } | null;
  // 机器睡着、进程停住的时间（clock.gap，工单「夜间挂起风暴」）。预算和交接窗口不算这段时间。
  pausedMs: number;
}

export interface SchedulerState {
  unit: UnitState | null;
  // 停机前排空（drainLead）：不再开新的单元。
  draining: boolean;
  // 系统回合正在探网络、还没开始（以前的 systemTurnStarting）：别的唤醒不再同时开一轮。
  starting: boolean;
}

export function initialSchedulerState(): SchedulerState {
  return { unit: null, draining: false, starting: false };
}

/** tick 和工具开始时，daemon 现算的事实。waiting 只在用到时才算（它要读排队）。 */
export interface BudgetFacts {
  limits: SchedulerLimits;
  // 正在压缩上下文（自动压缩或 daemon 发起的恢复压缩）：不停下，中断会把压缩一起打断。
  compacting: boolean;
  // 会话能不能中断（老的会话端口不能）。
  canAbort: boolean;
  // 在等的人：用户本人（正在回答的、插进来的、排着的）和外部的人。answering=false 时不算这一轮正在回答的那一条。
  waiting: (options?: { answering?: boolean }) => WaitingEntry[];
}

export type SchedulerEvent =
  | { type: "unit.open"; id: string; lane: Lane; source: UnitSource; origin: string | null; turnId: string | null }
  | { type: "unit.begin" }
  | { type: "unit.lane"; lane: Lane; why: string }
  | { type: "unit.turn"; turnId: string | null }
  | { type: "unit.close"; outcome: UnitOutcome }
  | { type: "step.end" }
  | { type: "tool.start"; id: string; name: string; write: boolean; top: boolean; facts: BudgetFacts }
  | { type: "tool.end"; id: string }
  | { type: "budget.check"; facts: BudgetFacts }
  | { type: "queue.check"; facts: BudgetFacts }
  | { type: "budget.restart"; why: "follow_up" | "steer_after_handoff" | "resume" }
  | { type: "prompt.returned"; limits: SchedulerLimits }
  | { type: "handoff.timeout" }
  | { type: "handoff.done" }
  | { type: "stop.request"; canAbort: boolean }
  | { type: "drain.start" }
  | { type: "drain.abort" }
  | { type: "drain.expire" }
  | { type: "starting"; on: boolean }
  // 空闲车道（P4，idle-lane.ts）：L4 单元给更高车道的输入让路。调用方已经等正在跑的写操作做完（D5）。
  | { type: "idle.yield"; by: Lane }
  // P2：让出点（一步的工具结果回来以后、下一次模型请求之前）。stepP90Ms：一步的 p90。
  | { type: "yield.check"; facts: BudgetFacts; stepP90Ms: number }
  // P2：Lead 用 hand_off 交出去了（packageId 是交接包）。
  | { type: "handoff.made"; packageId: string; ticketId: number; entry: string }
  // P3：用户本人的消息（by 是那一轮）要抢占正在跑的单元。stage 是这一步现在的阶段（只为日志）。
  | { type: "preempt.request"; by: string; stage: string | null }
  // 排着等抢占的用户消息都被取消了（P3 收尾）：不用再让，撤回等着的抢占。by 是最后取消的那一条。
  | { type: "preempt.withdraw"; by: string }
  // 进程停住了一段时间（机器睡眠、合盖，或者主线程被卡住）：gapMs 是没有醒着的时间。就地预算和交接窗口按醒着的时间算，
  // 不把它算进去（2026-11-24 夜里：合盖以后每次只醒几秒，墙钟把 8–17 分钟的睡眠算成「就地做了」，一醒就停下）。
  | { type: "clock.gap"; gapMs: number };

/** 要写进 events 表和会话文件的调度记录（D12）。payload 里只有编号、数字和种类。 */
export type SchedulerRecordKind = "unit_started" | "unit_ended" | "decided" | "aborted" | "lane_changed" | "stage_slow"
  | "handed_off" | "suspended" | "resumed";

export type SchedulerEffect =
  | { type: "log"; line: string }
  | { type: "record"; kind: SchedulerRecordKind; payload: Record<string, string | number | boolean | null> }
  // 黄灯：插一条提醒。waiting 是算数的那些人（L0 单元里只有用户本人）。
  | { type: "remind.yellow"; reason: "tool_calls" | "duration"; toolCalls: number; startedAt: number; waiting: WaitingEntry[]; budgetMs: number }
  // 红灯，没有人在等：再提醒一次。
  | { type: "remind.second"; elapsedMs: number }
  // 排队说明。
  | { type: "notice.queue"; waiting: WaitingEntry[] }
  // 中止这一段运行（控制层：先记原因，再 session.abort()）。
  | { type: "abort"; reason: LeadAbortReason }
  // 会话不能中断：把红线消息插进这一轮，照样只能交接。
  | { type: "redline.steer"; elapsedMs: number; waiting: WaitingEntry[] }
  // 红线中断以后这一次 prompt 返回了：在同一个单元里送红线消息，并在 timeoutMs 以后发 handoff.timeout。
  | { type: "redline.handoff"; elapsedMs: number; waiting: WaitingEntry[]; timeoutMs: number }
  // P2：把这个单元挂起（H10）：交接包存下来，不需要模型调用。
  | { type: "unit.suspend"; reason: "handoff_timeout" | "handoff_skipped" | "preempt" }
  // 交接窗口的定时器到点了，可是窗口因为机器睡眠往后推了：inMs 以后再定一次时。
  | { type: "handoff.rearm"; inMs: number };

export interface SchedulerStep {
  state: SchedulerState;
  effects: SchedulerEffect[];
}

// ── 查询（都是纯函数）──────────────────────────────────────────────────────────

export function isBusy(state: SchedulerState): boolean {
  return state.unit !== null;
}

export function redLinePhase(state: SchedulerState): RedLinePhase | null {
  return state.unit?.redLine?.phase ?? null;
}

/** 用户用 /stop 停下了这个单元（以前的 userStopRequested）。 */
export function stoppedByUser(state: SchedulerState): boolean {
  return state.unit?.aborts.some((reason) => reason.kind === "user_stop") ?? false;
}

/** 排空中断了这个单元（以前的 restartAbort）。 */
export function abortedForRestart(state: SchedulerState): boolean {
  return state.unit?.aborts.some((reason) => reason.kind === "drain") ?? false;
}

/** 空闲车道的单元给更高车道的输入让了路（P4）：这一步以 aborted 结束不是失败。 */
export function yieldedToInput(state: SchedulerState): boolean {
  return state.unit?.aborts.some((reason) => reason.kind === "idle_yield") ?? false;
}

/** 用户本人的消息抢占了这个单元（P3）：这一步以 aborted 结束不是失败，单元挂起。 */
export function abortedForPreempt(state: SchedulerState): boolean {
  return state.unit?.aborts.some((reason) => reason.kind === "preempt") ?? false;
}

/** 这一步以 aborted 结束，是红线要求的（停下，或者交接超时）。 */
export function abortedByRedLine(state: SchedulerState): boolean {
  const phase = redLinePhase(state);
  return phase === "aborting" || phase === "closing";
}

/**
 * 这个单元一个工具都没调过，却被红线停下了（就地预算到了，或者交接窗口到了）：它没有做任何事，这不是「就地做久了」，
 * 是模型一直没有给出回答（请求挂住、连不上）。daemon 把它记成一次模型调用失败（model-hold.ts 的熔断），
 * 连续几次以后暂停自动调用、告诉用户，不再一轮轮静默地挂起（2026-11-24 夜里的挂起风暴）。
 */
export function emptyRedLineUnit(unit: Pick<UnitState, "totalToolCalls" | "aborts"> | null | undefined): boolean {
  if (!unit || unit.totalToolCalls > 0) return false;
  return unit.aborts.some((reason) => reason.kind === "budget" || reason.kind === "handoff_timeout");
}

/**
 * 一轮结束时，对模型暂停（model-hold.ts）做什么：答上了解除（lift），一个工具都没调就被红线停下的记一次失败（fail）。
 * 没答上的一轮在出错的地方已经记过失败，这里不再记（null）。以前答上了就一律解除，空转的单元把熔断的计数一次次清零。
 */
export function modelHoldAfterUnit(succeeded: boolean, unit: Pick<UnitState, "totalToolCalls" | "aborts"> | null | undefined): "lift" | "fail" | null {
  if (!succeeded) return null;
  return emptyRedLineUnit(unit) ? "fail" : "lift";
}

/** 记进模型熔断的那句失败（不像断网、不像账号问题：model-hold.ts 按普通的失败数）。 */
export const EMPTY_RED_LINE_FAILURE = "Lead's turn reached the in-place budget without one tool call: the model gave no answer";

/** 交接时这一轮只能用的工具；没有限制时为 null。 */
export function handoffGate<T>(state: SchedulerState, tools: T): T | null {
  return redLinePhase(state) === "handoff" ? tools : null;
}

/** 打断式插话现在能不能做（step-interrupt.ts）：/stop、红线的中断、停机时不做。 */
export function canInterruptForSteer(state: SchedulerState): boolean {
  if (!state.unit || state.draining || stoppedByUser(state)) return false;
  return !abortedByRedLine(state);
}

/**
 * 算数的等待（优先级反转的修正）：L0 单元里只有 L0 的等待算数，外部的人只排队。别的车道的单元里，所有在等的人都算数
 * （和以前一样）。
 */
export function countedWaiting(unit: Pick<UnitState, "lane">, waiting: readonly WaitingEntry[]): WaitingEntry[] {
  return unit.lane === 0 ? waiting.filter((entry) => entry.lane === 0) : [...waiting];
}

/** 过了就地预算时有没有人在等：L0 单元本身就是用户在等。只用来写日志：P2 起没有人在等也停下（待定 9）。 */
function someoneWaiting(unit: Pick<UnitState, "lane">, counted: readonly WaitingEntry[]): boolean {
  return unit.lane === 0 || counted.length > 0;
}

// ── 日志 ─────────────────────────────────────────────────────────────────────

/** 日志里的一个等待：L0:user:1:27s。 */
function waitingField(entries: readonly WaitingEntry[]): string {
  if (!entries.length) return "none";
  return entries.map((entry) => `${laneName(entry.lane)}:${entry.user ? "user" : "external"}:${entry.count}:${Math.round(entry.waitedMs / 1_000)}s`).join(",");
}

type Field = string | number | boolean | null | undefined;

function quote(value: string): string {
  return /^[^\s"=]+$/u.test(value) ? value : JSON.stringify(value);
}

/** 一条 [sched] 日志。和 core 的 schedLine 同一个样子，这里不依赖 core。 */
export function schedulerLine(event: string, fields: Record<string, Field>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value === null ? "-" : typeof value === "string" ? quote(value) : String(value)}`);
  return ["[sched]", event, ...parts].join(" ");
}

function unitFields(unit: UnitState): Record<string, Field> {
  return { unit: unit.id, lane: laneName(unit.lane), turn: unit.turnId ?? "-" };
}

// ── 状态机 ───────────────────────────────────────────────────────────────────

function withUnit(state: SchedulerState, unit: UnitState): SchedulerState {
  return { ...state, unit };
}

/** 两盏灯（以前的 checkLeadBudget）。工具开始时和每次轮询时看一次。 */
function checkBudget(state: SchedulerState, facts: BudgetFacts, now: number): SchedulerStep {
  const effects: SchedulerEffect[] = [];
  let unit = state.unit;
  if (state.draining || !unit || unit.budgetStartedAt === null || unit.redLine) return { state, effects };
  // 正在压缩上下文：不停下。压缩做完以后的这一次检查照常。
  if (facts.compacting) return { state, effects };
  const { limits } = facts;
  const startedAt = unit.budgetStartedAt;
  if (!unit.yellowReminded) {
    const reason = unit.toolCalls >= limits.yellowToolCalls ? "tool_calls"
      : now - startedAt >= limits.yellowMs ? "duration" : null;
    if (reason) {
      unit = { ...unit, yellowReminded: true };
      const counted = countedWaiting(unit, facts.waiting());
      effects.push({ type: "log", line: `lead overflow: ${reason} (${unit.toolCalls} tool calls), reminding Lead to hand the rest to a sub-agent` });
      effects.push({ type: "log", line: schedulerLine("decide", {
        ...unitFields(unit), decision: "yellow", reason, toolCalls: unit.toolCalls, elapsedMs: now - startedAt,
        yellowMs: limits.yellowMs, waiting: waitingField(counted),
      }) });
      effects.push({ type: "record", kind: "decided", payload: { unitId: unit.id, turnId: unit.turnId, lane: laneName(unit.lane), decision: "yellow", reason, elapsedMs: now - startedAt, toolCalls: unit.toolCalls } });
      effects.push({ type: "remind.yellow", reason, toolCalls: unit.toolCalls, startedAt, waiting: counted, budgetMs: limits.budgetMs });
    }
  }
  const elapsed = now - startedAt;
  if (elapsed < limits.budgetMs) return { state: withUnit(state, unit), effects };
  const stopped = redLineStop(withUnit(state, unit), facts, now, { decision: "red_line_stop", elapsedMs: elapsed });
  return { state: stopped.state, effects: [...effects, ...stopped.effects] };
}

/**
 * 停下这一轮、请 Lead 交接（红线）。P2 起没有人在等也停下（待定 9）：日志里 waiting=none 照实写。
 * decision 是 red_line_stop（就地预算到了）或 yield_budget（让出点上算出再做一步会超过预算）。
 */
function redLineStop(
  state: SchedulerState, facts: BudgetFacts, now: number, why: { decision: "red_line_stop" | "yield_budget"; elapsedMs: number; stepP90Ms?: number },
): SchedulerStep {
  const effects: SchedulerEffect[] = [];
  const { limits } = facts;
  const elapsed = why.elapsedMs;
  let unit = state.unit!;
  const all = facts.waiting();
  const counted = countedWaiting(unit, all);
  const held = all.filter((entry) => !counted.includes(entry));
  const alone = !someoneWaiting(unit, counted);
  unit = {
    ...unit,
    redLine: { phase: "stopping", waiting: counted, stoppedAt: now },
  };
  effects.push({ type: "log", line: alone
    ? `lead red line: ${Math.round(elapsed / 1_000)}s and nobody is waiting; stopping the turn for a hand-off`
    : `lead red line: ${Math.round(elapsed / 1_000)}s with ${Math.max(counted.length, 1)} conversation(s) waiting; stopping the turn for a hand-off` });
  effects.push({ type: "log", line: schedulerLine("decide", {
    ...unitFields(unit), decision: why.decision, elapsedMs: elapsed, budgetMs: limits.budgetMs,
    ...(why.stepP90Ms !== undefined ? { stepP90Ms: why.stepP90Ms } : {}),
    waiting: alone ? "none" : unit.lane === 0 && !counted.length ? "L0:unit" : waitingField(counted),
    ...(held.length ? { queued: waitingField(held) } : {}),
  }) });
  effects.push({ type: "record", kind: "decided", payload: {
    unitId: unit.id, turnId: unit.turnId, lane: laneName(unit.lane), decision: why.decision, elapsedMs: elapsed,
    budgetMs: limits.budgetMs, waiting: counted.length, queued: held.length,
  } });
  const stopped = stopForRedLine(withUnit(state, unit), facts.canAbort, now);
  return { state: stopped.state, effects: [...effects, ...stopped.effects] };
}

/**
 * 红线停下这一轮：马上中断（以前的 stopForRedLine）。以前先等正在跑的写操作做完（最多 30 秒）；现在中止兜底让改东西的
 * 调用转到后台接着跑，不会做到一半被杀掉（tool-abort-guard.ts，用户 2026-11-11），所以不等。
 */
function stopForRedLine(state: SchedulerState, canAbort: boolean, now: number): SchedulerStep {
  const unit = state.unit;
  const line = unit?.redLine;
  if (!unit || !line || line.phase !== "stopping") return { state, effects: [] };
  const effects: SchedulerEffect[] = [];
  const write = Object.values(unit.tools).find((tool) => tool.write)?.name ?? null;
  if (write) effects.push({ type: "log", line: `lead red line: ${write} is running; it moves to the background and the turn stops now` });
  const elapsed = now - (unit.budgetStartedAt ?? now);
  if (!canAbort) {
    // 会话不能中断（老的会话端口）：把红线消息插进这一轮，照样只能交接。
    return {
      state: withUnit(state, { ...unit, redLine: { ...line, phase: "handoff" } }),
      effects: [...effects, { type: "redline.steer", elapsedMs: elapsed, waiting: line.waiting }],
    };
  }
  const reason: LeadAbortReason = { kind: "budget" };
  return {
    state: withUnit(state, { ...unit, redLine: { ...line, phase: "aborting" }, aborts: [...unit.aborts, reason] }),
    effects: [...effects, ...abortEffects(unit, reason, now, { write, elapsedMs: elapsed })],
  };
}

function abortEffects(
  unit: UnitState, reason: LeadAbortReason, now: number, extra: Record<string, Field> = {},
): SchedulerEffect[] {
  const elapsedMs = unit.budgetStartedAt === null ? now - unit.openedAt : now - unit.budgetStartedAt;
  return [
    { type: "log", line: schedulerLine("abort", { ...unitFields(unit), seg: unit.segment, reason: abortReasonText(reason), elapsedMs, ...extra }) },
    { type: "record", kind: "aborted", payload: { unitId: unit.id, turnId: unit.turnId, lane: laneName(unit.lane), reason: abortReasonText(reason), segment: unit.segment, elapsedMs } },
    { type: "abort", reason },
  ];
}

/** 排队说明（以前的 noticeQueue）。 */
function checkQueue(state: SchedulerState, facts: BudgetFacts, now: number): SchedulerStep {
  const unit = state.unit;
  if (!unit || unit.queueNoticed || state.draining || unit.budgetStartedAt === null || unit.redLine) return { state, effects: [] };
  const { limits } = facts;
  const all = facts.waiting({ answering: false });
  const over = all.filter((entry) => entry.waitedMs >= (entry.user ? limits.userQueueNoticeMs : limits.queueNoticeMs));
  if (!over.length) return { state, effects: [] };
  const counted = countedWaiting(unit, over);
  if (!counted.length) {
    // L0 单元里只有外部的人等过了阈值：他们只排队，不劝 Lead 先去回他们（优先级反转的修正）。只记一次日志；
    // 之后用户本人的消息等过了阈值，照样插说明。
    if (unit.queueHeld) return { state, effects: [] };
    return {
      state: withUnit(state, { ...unit, queueHeld: true }),
      effects: [{ type: "log", line: schedulerLine("decide", {
        ...unitFields(unit), decision: "queue_hold", reason: "user_unit", queued: waitingField(over),
      }) }],
    };
  }
  return {
    state: withUnit(state, { ...unit, queueNoticed: true }),
    effects: [
      { type: "log", line: `lead queue: ${counted.length} conversation(s) waited over ${Math.round(limits.queueNoticeMs / 1_000)}s, telling Lead in the running turn` },
      { type: "log", line: schedulerLine("decide", {
        ...unitFields(unit), decision: "queue_notice", waiting: waitingField(counted),
        ...(counted.length < over.length ? { queued: waitingField(over.filter((entry) => !counted.includes(entry))) } : {}),
      }) },
      { type: "record", kind: "decided", payload: { unitId: unit.id, turnId: unit.turnId, lane: laneName(unit.lane), decision: "queue_notice", waiting: counted.length, elapsedMs: now - (unit.budgetStartedAt ?? now) } },
      { type: "notice.queue", waiting: counted },
    ],
  };
}

/** 一个事件。返回新状态和要做的事；状态不变时返回原来的对象。 */
export function schedulerStep(state: SchedulerState, event: SchedulerEvent, now: number): SchedulerStep {
  const unit = state.unit;
  switch (event.type) {
    case "unit.open": {
      // 已经有一个单元在跑时又开一个（以前两条消息在同一拍里到达时会这样，busy 只是又置了一次）：新的接替旧的，
      // 和以前一样；记一条日志，这种重叠以后要查。
      const overlap: SchedulerEffect[] = unit
        ? [{ type: "log", line: schedulerLine("unit.overlap", { unit: event.id, replaces: unit.id }) }]
        : [];
      const opened: UnitState = {
        id: event.id, lane: event.lane, source: event.source, origin: event.origin, turnId: event.turnId,
        openedAt: now, beganAt: null, budgetStartedAt: null, toolCalls: 0, totalToolCalls: 0, steps: 0,
        yellowReminded: false, secondReminded: false, queueNoticed: false, queueHeld: false, redLine: null, aborts: [],
        tools: {}, segment: 1, handedOff: null, preemptPending: null, pausedMs: 0,
      };
      const deadline = LANES[event.lane].firstResponseMs;
      return {
        state: { ...state, unit: opened, starting: false },
        effects: [
          ...overlap,
          { type: "log", line: schedulerLine("unit.start", {
            ...unitFields(opened), source: event.source, origin: event.origin ?? "-", deadlineMs: deadline,
          }) },
          { type: "record", kind: "unit_started", payload: {
            unitId: opened.id, turnId: opened.turnId, lane: laneName(opened.lane), source: event.source, origin: event.origin,
          } },
        ],
      };
    }
    case "unit.begin": {
      if (!unit) return { state, effects: [] };
      return {
        state: withUnit(state, {
          ...unit, beganAt: now, budgetStartedAt: now, toolCalls: 0, yellowReminded: false, secondReminded: false,
          queueNoticed: false, queueHeld: false, redLine: null, tools: {},
        }),
        effects: now - unit.openedAt >= 1_000
          ? [{ type: "log", line: schedulerLine("unit.begin", { ...unitFields(unit), waitedMs: now - unit.openedAt }) }]
          : [],
      };
    }
    case "unit.lane": {
      if (!unit || unit.lane === event.lane) return { state, effects: [] };
      return {
        state: withUnit(state, { ...unit, lane: event.lane }),
        effects: [
          { type: "log", line: schedulerLine("lane", { unit: unit.id, turn: unit.turnId ?? "-", from: laneName(unit.lane), to: laneName(event.lane), why: event.why }) },
          { type: "record", kind: "lane_changed", payload: { unitId: unit.id, turnId: unit.turnId, from: laneName(unit.lane), to: laneName(event.lane), why: event.why } },
        ],
      };
    }
    case "unit.turn": {
      if (!unit || unit.turnId === event.turnId) return { state, effects: [] };
      return {
        state: withUnit(state, { ...unit, turnId: event.turnId }),
        effects: [{ type: "log", line: schedulerLine("unit.turn", { unit: unit.id, from: unit.turnId ?? "-", turn: event.turnId ?? "-" }) }],
      };
    }
    case "unit.close": {
      if (!unit) return { state, effects: [] };
      const ms = now - unit.openedAt;
      const aborts = unit.aborts.map(abortReasonText).join(",") || "-";
      return {
        state: { ...state, unit: null },
        effects: [
          { type: "log", line: schedulerLine("unit.end", {
            ...unitFields(unit), outcome: event.outcome, ms, steps: unit.steps, toolCalls: unit.totalToolCalls, aborts,
            redLine: unit.redLine?.phase ?? "-", ...(unit.pausedMs ? { pausedMs: unit.pausedMs } : {}),
          }) },
          { type: "record", kind: "unit_ended", payload: {
            unitId: unit.id, turnId: unit.turnId, lane: laneName(unit.lane), source: unit.source, outcome: event.outcome,
            ms, steps: unit.steps, toolCalls: unit.totalToolCalls, aborts, redLine: unit.redLine?.phase ?? null,
            ...(unit.pausedMs ? { pausedMs: unit.pausedMs } : {}),
          } },
        ],
      };
    }
    case "step.end": {
      if (!unit) return { state, effects: [] };
      return { state: withUnit(state, { ...unit, steps: unit.steps + 1 }), effects: [] };
    }
    case "tool.start": {
      if (!unit) return { state, effects: [] };
      const tools = { ...unit.tools, [event.id]: { name: event.name, write: event.write } };
      const top = event.top ? 1 : 0;
      const next = withUnit(state, { ...unit, tools, toolCalls: unit.toolCalls + top, totalToolCalls: unit.totalToolCalls + top });
      return event.top ? checkBudget(next, event.facts, now) : { state: next, effects: [] };
    }
    case "tool.end": {
      if (!unit || !(event.id in unit.tools)) return { state, effects: [] };
      const { [event.id]: _done, ...tools } = unit.tools;
      return { state: withUnit(state, { ...unit, tools }), effects: [] };
    }
    case "budget.check":
      return checkBudget(state, event.facts, now);
    case "queue.check":
      return checkQueue(state, event.facts, now);
    case "budget.restart": {
      // 排着的消息在这一次运行里开始答：那是用户新的一件事，两盏灯重新算。红线没走完时不重算。
      if (!unit || (unit.redLine && unit.redLine.phase !== "done")) return { state, effects: [] };
      return {
        state: withUnit(state, {
          ...unit, budgetStartedAt: now, toolCalls: 0, yellowReminded: false, secondReminded: false, redLine: null,
        }),
        effects: [{ type: "log", line: schedulerLine("decide", { ...unitFields(unit), decision: "budget_restart", why: event.why }) }],
      };
    }
    case "prompt.returned": {
      // 红线中断以后这一次 prompt 返回了：在同一个单元里马上叫 Lead 交接（以前的 continueAfterRedLine）。
      if (!unit?.redLine || unit.redLine.phase !== "aborting" || abortedForRestart(state)) return { state, effects: [] };
      const elapsed = now - (unit.budgetStartedAt ?? now);
      const next: UnitState = {
        ...unit, redLine: { ...unit.redLine, phase: "handoff", handoffDueAt: now + event.limits.handoffMs }, segment: unit.segment + 1,
      };
      return {
        state: withUnit(state, next),
        effects: [
          { type: "log", line: `lead red line: turn stopped after ${Math.round(elapsed / 1_000)}s; asking Lead to hand off` },
          { type: "log", line: schedulerLine("decide", {
            ...unitFields(next), seg: next.segment, decision: "handoff", elapsedMs: elapsed, windowMs: event.limits.handoffMs,
          }) },
          { type: "redline.handoff", elapsedMs: elapsed, waiting: unit.redLine.waiting, timeoutMs: event.limits.handoffMs },
        ],
      };
    }
    case "handoff.timeout": {
      if (!unit?.redLine || unit.redLine.phase !== "handoff") return { state, effects: [] };
      // 定时器在机器醒来时到点，可是醒着的时间还没到窗口：再等剩下的那一段。
      const dueAt = unit.redLine.handoffDueAt;
      if (unit.redLine.slept && dueAt !== undefined && now < dueAt) {
        return {
          state,
          effects: [
            { type: "log", line: schedulerLine("decide", { ...unitFields(unit), decision: "handoff_rearm", inMs: dueAt - now, pausedMs: unit.pausedMs }) },
            { type: "handoff.rearm", inMs: dueAt - now },
          ],
        };
      }
      const reason: LeadAbortReason = { kind: "handoff_timeout" };
      // 交接窗口到了还没交（H1）：中止这一段，单元挂起（H10）。已经交了（Lead 还在写那句话）时只中止。
      const suspend: SchedulerEffect[] = unit.handedOff ? [] : [
        { type: "log", line: schedulerLine("decide", { ...unitFields(unit), decision: "suspend", reason: "handoff_timeout", sinceStopMs: now - unit.redLine.stoppedAt }) },
        { type: "unit.suspend", reason: "handoff_timeout" },
      ];
      return {
        state: withUnit(state, { ...unit, redLine: { ...unit.redLine, phase: "closing" }, aborts: [...unit.aborts, reason] }),
        effects: [...abortEffects(unit, reason, now), ...suspend],
      };
    }
    case "handoff.done": {
      if (!unit?.redLine || unit.redLine.phase === "done") return { state, effects: [] };
      // 交接这一段结束了却没有交（例如只写了一句话，或者用 follow_up 记了一条）：单元挂起（H1、H10）。窗口到时已经挂起过的不再挂。
      const skipped = !unit.handedOff && unit.redLine.phase === "handoff";
      return {
        state: withUnit(state, { ...unit, redLine: { ...unit.redLine, phase: "done" } }),
        effects: [
          { type: "log", line: schedulerLine("decide", {
            ...unitFields(unit), decision: "handoff_done", sinceStopMs: now - unit.redLine.stoppedAt, handedOff: unit.handedOff ?? "-",
          }) },
          ...(skipped ? [
            { type: "log", line: schedulerLine("decide", { ...unitFields(unit), decision: "suspend", reason: "handoff_skipped" }) } as SchedulerEffect,
            { type: "unit.suspend", reason: "handoff_skipped" } as SchedulerEffect,
          ] : []),
        ],
      };
    }
    case "handoff.made": {
      if (!unit || unit.handedOff) return { state, effects: [] };
      return {
        state: withUnit(state, { ...unit, handedOff: event.packageId }),
        effects: [{ type: "log", line: schedulerLine("decide", {
          ...unitFields(unit), decision: "handed_off", pkg: event.packageId, ticket: event.ticketId, entry: event.entry,
          elapsedMs: now - (unit.budgetStartedAt ?? unit.openedAt), redLine: unit.redLine?.phase ?? "-",
        }) }],
      };
    }
    case "yield.check": {
      // 让出点：用户本人的消息在等着抢占（当时有工具在跑），现在中止这一步、挂起单元（P3）。
      if (unit?.preemptPending && !unit.redLine && !state.draining && !unit.aborts.some((reason) => reason.kind === "preempt")) {
        return preemptNow(state, unit.preemptPending.by, now, "yield_point", now - unit.preemptPending.at);
      }
      // 让出点（D3、D4）：用掉的时间加上一步的 p90 会超过就地预算时，这一步不再开始，在这里停下，请 Lead 交接。
      if (!unit || state.draining || unit.budgetStartedAt === null || unit.redLine || event.facts.compacting) return { state, effects: [] };
      const elapsed = now - unit.budgetStartedAt;
      const { budgetMs } = event.facts.limits;
      if (elapsed + event.stepP90Ms < budgetMs) return { state, effects: [] };
      return redLineStop(state, event.facts, now, { decision: "yield_budget", elapsedMs: elapsed, stepP90Ms: event.stepP90Ms });
    }
    case "stop.request": {
      // /stop：Lead 空着（或者会话不能中断）时什么都不做。
      if (!unit || !event.canAbort) return { state, effects: [] };
      const reason: LeadAbortReason = { kind: "user_stop" };
      return { state: withUnit(state, { ...unit, aborts: [...unit.aborts, reason] }), effects: abortEffects(unit, reason, now) };
    }
    case "drain.start":
      return state.draining ? { state, effects: [] } : {
        state: { ...state, draining: true },
        effects: [{ type: "log", line: schedulerLine("drain.start", { unit: unit?.id ?? "-" }) }],
      };
    case "drain.abort": {
      if (!unit || abortedForRestart(state)) return { state, effects: [] };
      const reason: LeadAbortReason = { kind: "drain" };
      return { state: withUnit(state, { ...unit, aborts: [...unit.aborts, reason] }), effects: abortEffects(unit, reason, now) };
    }
    case "drain.expire": {
      // 排空作废（没有等到停机）：daemon 照常工作。中断了的单元不再按「被重启打断」收尾。
      const next: SchedulerState = { ...state, draining: false };
      if (unit) next.unit = { ...unit, aborts: unit.aborts.filter((reason) => reason.kind !== "drain") };
      return { state: next, effects: [{ type: "log", line: schedulerLine("drain.expire", { unit: unit?.id ?? "-" }) }] };
    }
    case "starting":
      return state.starting === event.on ? { state, effects: [] } : { state: { ...state, starting: event.on }, effects: [] };
    case "idle.yield": {
      // 只停 L4 的单元（spec D1：L4 随时让出）；已经停过、/stop 或者排空了的不再停。
      if (!unit || unit.lane !== 4 || yieldedToInput(state) || stoppedByUser(state) || abortedForRestart(state)) return { state, effects: [] };
      const reason: LeadAbortReason = { kind: "idle_yield", by: laneName(event.by) };
      return {
        state: withUnit(state, { ...unit, aborts: [...unit.aborts, reason] }),
        effects: [
          { type: "log", line: schedulerLine("decide", { ...unitFields(unit), decision: "idle_yield", by: laneName(event.by), steps: unit.steps }) },
          { type: "record", kind: "decided", payload: { unitId: unit.id, turnId: unit.turnId, lane: laneName(unit.lane), decision: "idle_yield", by: laneName(event.by), elapsedMs: now - unit.openedAt } },
          ...abortEffects(unit, reason, now),
        ],
      };
    }
    case "preempt.request": {
      if (!unit) return { state, effects: [] };
      const fields = { ...unitFields(unit), by: event.by, stage: event.stage ?? "-" };
      const skip = (reason: string): SchedulerStep => ({
        state, effects: [{ type: "log", line: schedulerLine("decide", { ...fields, decision: "no_preempt", reason }) }],
      });
      // L0 单元是用户自己的事（或者交回给用户的结果）：不抢占，按忙时的放置方式。
      if (unit.lane === 0) return skip("l0_unit");
      if (state.draining) return skip("draining");
      // 红线在停这一轮、请 Lead 交接：这一轮马上结束，用户的消息接着开一轮。
      if (unit.redLine) return skip("red_line");
      if (unit.aborts.some((reason) => reason.kind === "preempt")) return skip("already_preempted");
      const running = Object.values(unit.tools);
      if (running.length) {
        // 工具在跑（写操作不能打断，D5）：到下一个让出点再中止。
        if (unit.preemptPending) return skip("already_pending");
        return {
          state: withUnit(state, { ...unit, preemptPending: { by: event.by, at: now } }),
          effects: [{ type: "log", line: schedulerLine("decide", {
            ...fields, decision: "preempt_wait", reason: "tool", tool: running.map((tool) => tool.name).join(","),
            write: running.some((tool) => tool.write),
          }) }],
        };
      }
      return preemptNow(state, event.by, now, "model");
    }
    case "clock.gap": {
      if (!unit || !(event.gapMs > 0)) return { state, effects: [] };
      const gap = event.gapMs;
      const redLine = unit.redLine
        ? {
          ...unit.redLine, stoppedAt: unit.redLine.stoppedAt + gap,
          ...(unit.redLine.handoffDueAt !== undefined ? { handoffDueAt: unit.redLine.handoffDueAt + gap, slept: true } : {}),
        }
        : null;
      const next: UnitState = {
        ...unit, budgetStartedAt: unit.budgetStartedAt === null ? null : unit.budgetStartedAt + gap, redLine, pausedMs: unit.pausedMs + gap,
        ...(unit.preemptPending ? { preemptPending: { ...unit.preemptPending, at: unit.preemptPending.at + gap } } : {}),
      };
      return {
        state: withUnit(state, next),
        effects: [
          { type: "log", line: schedulerLine("clock.gap", { ...unitFields(unit), gapMs: gap, pausedMs: next.pausedMs, redLine: unit.redLine?.phase ?? "-" }) },
          { type: "record", kind: "decided", payload: {
            unitId: unit.id, turnId: unit.turnId, lane: laneName(unit.lane), decision: "clock_gap", gapMs: gap, pausedMs: next.pausedMs,
          } },
        ],
      };
    }
    case "preempt.withdraw": {
      if (!unit?.preemptPending) return { state, effects: [] };
      return {
        state: withUnit(state, { ...unit, preemptPending: null }),
        effects: [{ type: "log", line: schedulerLine("decide", {
          ...unitFields(unit), decision: "preempt_withdrawn", by: event.by, waitedMs: now - unit.preemptPending.at,
        }) }],
      };
    }
  }
}

/** 抢占（P3）：中止这一步，单元挂起，交接包存下来（H10）。不需要模型调用。 */
function preemptNow(state: SchedulerState, by: string, now: number, at: "model" | "yield_point", waitedMs?: number): SchedulerStep {
  const unit = state.unit!;
  const reason: LeadAbortReason = { kind: "preempt", by };
  const elapsedMs = now - (unit.budgetStartedAt ?? unit.openedAt);
  return {
    state: withUnit(state, { ...unit, aborts: [...unit.aborts, reason], preemptPending: null }),
    effects: [
      { type: "log", line: schedulerLine("decide", {
        ...unitFields(unit), decision: "preempt", by, at, elapsedMs, steps: unit.steps,
        ...(waitedMs !== undefined ? { waitedMs } : {}),
      }) },
      { type: "record", kind: "decided", payload: {
        unitId: unit.id, turnId: unit.turnId, lane: laneName(unit.lane), decision: "preempt", by, at, elapsedMs,
      } },
      ...abortEffects(unit, reason, now),
      { type: "unit.suspend", reason: "preempt" },
    ],
  };
}
