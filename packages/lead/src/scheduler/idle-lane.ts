// Lead 调度器的空闲车道 L4（lead-scheduler spec D1、D8，P4）：决策层，纯函数 (状态, 事件, 现在的时间) → (新状态, 要做的事)。
//
// L4 放不急的维护工作。它们以前在什么时候做、现在改成什么时候做：
//   · 上下文压缩（compact）：以前是 pi 在一个单元中间到了压缩线就地压缩（「内联压缩」），用户这一轮多等 43–103 秒。
//     现在 Lead 空闲时、在子进程里写摘要；写好以后在 Lead 空闲的那一刻接上（几毫秒）。
//   · 整理笔记（precipitate）：以前一轮结束马上开（上下文过了 70%）。现在 Lead 空闲满 graceMs 才开，有新输入时让路。
//   · 回收区的删除（P0 已经在子进程里删）、清理扫描：Lead 空闲时才开始下一块。闸门在运行层（idle-runtime.ts）。
//
// 被打断以后怎么办（每种活都不同，用户 2026-11-09 要求说清楚）：
//   · 压缩的摘要：做完这一小块再让。摘要在子进程里写，不占 Lead 的会话、主线程和线程池，所以新输入到达时它照常写完；
//     让路的是「接上」这一步：它要碰 Lead 的会话，只在 Lead 空闲时做。摘要写好时会话已经又压缩过（基础变了），就丢弃，
//     下一次空闲重来。
//   · 整理笔记：断点续做。它是 Lead 自己的一个 L4 单元。新输入到达时在下一个让出点中止它（正在跑的写操作先做完，
//     spec D5），这一周期重新武装；下一次空闲再开。已经存下的笔记留在 Lead 的上下文里，Lead 接着存没存的。
//   · 回收区的删除、清理扫描：做完这一小块再让。正在跑的那一个子进程照常跑完（后台优先级），下一个等 Lead 空闲。
//
// 压缩不能在 Lead 正在回应时抢走它，但上下文快满时也不能因为一直不空闲就永远不压缩：
//   · 上下文过了 promoteRatio（缺省 85%）、Lead 又一直忙：在两个单元之间（会话空着的那几毫秒）就开始写摘要（提级，
//     不等空闲满 graceMs）。摘要在子进程里写，不占 Lead；pi 到了压缩线时多半已经写好，直接用它。
//   · pi 在单元中间到了压缩线（threshold）：推迟（让 pi 这一次不压缩），同时马上在子进程里写摘要（提级，不等空闲）；
//     摘要写好以后，pi 下一次检查时直接用它（几毫秒），不再就地写 43–103 秒。
//     推迟有代价：压缩线只留了 reserveTokens（2 万）的余量，下一步的大工具结果可能让上下文溢出（开发模式下 2/2 次）。
//     所以溢出时如果子进程已经在写，先等它（运行层，最多 overflowWaitMs），比重写一份快。
//   · 兜底时限：从第一次推迟算起超过 deferMaxMs 还没压缩成，就让 pi 照常就地压缩，写一条 idle.compact.forced。
//   · 上下文溢出（overflow）不推迟：不压缩这一轮就答不了。有写好的摘要时用它。
//
// 每个决定写一条 [sched] idle.* 日志（D12）：决定了什么、为什么、依据的数字、作业编号（idle_…）和单元编号。不写原文。
import { schedulerLine } from "./core.js";
import { laneName, type Lane } from "./lanes.js";

export type IdleJobKind = "compact" | "precipitate" | "trash" | "sweep";

export interface IdleLaneLimits {
  // Lead 空闲满这么久才开始 L4 的活（PLC_LEAD_IDLE_GRACE_MS）：用户常常连着发几句，刚答完就开始整理容易被打断。
  graceMs: number;
  // 上下文过了这个比例，这个周期还没整理笔记时整理一次（PRECIPITATE_RATIO）。
  precipitateRatio: number;
  // 上下文过了这个比例，空闲时压缩（PLC_LEAD_IDLE_COMPACT_RATIO）。比 pi 的压缩线低，留出一段给忙的时候。
  compactRatio: number;
  // 上下文过了这个比例，Lead 忙着也在两个单元之间开始写摘要（PLC_LEAD_IDLE_PROMOTE_RATIO）。
  promoteRatio: number;
  // pi 的就地压缩最多推迟多久（PLC_LEAD_COMPACT_DEFER_MAX_MS），从这个周期第一次推迟算。
  deferMaxMs: number;
  // 摘要失败以后多久再试；每多失败一次翻倍，最多 retryMaxMs。
  retryMs: number;
  retryMaxMs: number;
}

export const DEFAULT_IDLE_LANE_LIMITS: IdleLaneLimits = {
  graceMs: 15_000,
  precipitateRatio: 0.7,
  compactRatio: 0.8,
  promoteRatio: 0.85,
  deferMaxMs: 5 * 60_000,
  retryMs: 2 * 60_000,
  retryMaxMs: 30 * 60_000,
};

/** 环境变量里的数字；没设或不合法时用缺省值。 */
export function idleLaneLimitsFromEnv(env: Record<string, string | undefined> = process.env, base: Partial<IdleLaneLimits> = {}): IdleLaneLimits {
  const read = (name: string, fallback: number, ok: (value: number) => boolean) => {
    const value = Number(env[name]);
    return env[name] !== undefined && env[name] !== "" && Number.isFinite(value) && ok(value) ? value : fallback;
  };
  const limits = { ...DEFAULT_IDLE_LANE_LIMITS, ...base };
  return {
    ...limits,
    graceMs: read("PLC_LEAD_IDLE_GRACE_MS", limits.graceMs, (value) => value >= 0),
    compactRatio: read("PLC_LEAD_IDLE_COMPACT_RATIO", limits.compactRatio, (value) => value > 0 && value < 1),
    promoteRatio: read("PLC_LEAD_IDLE_PROMOTE_RATIO", limits.promoteRatio, (value) => value > 0 && value < 1),
    deferMaxMs: read("PLC_LEAD_COMPACT_DEFER_MAX_MS", limits.deferMaxMs, (value) => value >= 0),
    retryMs: read("PLC_LEAD_IDLE_RETRY_MS", limits.retryMs, (value) => value > 0),
  };
}

// 压缩作业的阶段：
//   idle 没有作业；preparing 在取要摘要的对话（碰会话，几毫秒）；summarizing 子进程在写摘要；
//   ready 摘要写好了，等 Lead 空闲接上；applying 正在接上（碰会话，几毫秒）。
export type CompactPhase = "idle" | "preparing" | "summarizing" | "ready" | "applying";

export interface CompactJobState {
  phase: CompactPhase;
  id: string | null;
  // 提级：pi 在单元中间到了压缩线，不等空闲就开始写摘要。
  promoted: boolean;
  startedAt: number | null;
  readyAt: number | null;
  // 这个周期 pi 的就地压缩第一次被推迟的时间和推迟的次数（兜底时限从这里算）。
  deferredSince: number | null;
  deferrals: number;
  // 这个作业在跑时有更高车道的输入到了（只记一次日志）。
  yieldLogged: boolean;
  failures: number;
  retryAt: number | null;
}

export interface PrecipitateJobState {
  phase: "idle" | "running";
  id: string | null;
  // 这个压缩周期整理过了（压缩成功以后重新武装）。
  done: boolean;
  // 这个周期被打断了几次。
  yields: number;
  // 正在跑的那个 L4 单元。
  unitId: string | null;
  startedAt: number | null;
  // 已经要它让路了（只要一次）。
  yieldRequested: boolean;
}

export interface IdleLaneState {
  // Lead 正在忙：哪个单元、哪条车道、从什么时候起。空闲时 busyUnit 为 null。
  busyUnit: string | null;
  busyLane: Lane | null;
  busySince: number | null;
  // Lead 从什么时候起空闲（单元结束的时刻）。忙时为 null。
  idleSince: number | null;
  // 最近一次读到的上下文水位（占窗口的比例）。
  ratio: number | null;
  compact: CompactJobState;
  precipitate: PrecipitateJobState;
  // 在等 Lead 空闲的没人等的后台重活（回收区的删除）。
  gated: number;
  // 作业编号的计数。
  seq: number;
}

export function initialIdleLaneState(now: number): IdleLaneState {
  return {
    busyUnit: null, busyLane: null, busySince: null, idleSince: now, ratio: null,
    compact: idleCompactJob(0),
    precipitate: { phase: "idle", id: null, done: false, yields: 0, unitId: null, startedAt: null, yieldRequested: false },
    gated: 0, seq: 0,
  };
}

function idleCompactJob(failures: number, retryAt: number | null = null, deferral?: Pick<CompactJobState, "deferredSince" | "deferrals">): CompactJobState {
  return {
    phase: "idle", id: null, promoted: false, startedAt: null, readyAt: null,
    deferredSince: deferral?.deferredSince ?? null, deferrals: deferral?.deferrals ?? 0, yieldLogged: false, failures, retryAt,
  };
}

// pi 想压缩的原因：threshold 到了压缩线（单元中间或者开始前）；overflow 上下文溢出；manual 是 session.compact()。
export type InlineCompactionReason = "threshold" | "overflow" | "manual";

export type IdleLaneEvent =
  // 一个单元开了（Lead 开始忙）。
  | { type: "busy"; unitId: string; lane: Lane }
  // 单元结束了（Lead 空闲了）。
  | { type: "idle" }
  // 看一次该不该开始什么：上下文水位、有没有排着的更高车道的事、会话现在能不能碰。boundary：一个单元刚结束（会话空着）。
  | { type: "tick"; ratio: number | null; pendingInput: boolean; starting: boolean; boundary?: boolean }
  // pi 想压缩（扩展的 session_before_compact）。ready：写好的摘要对现在的会话还有效。
  | { type: "inline"; reason: InlineCompactionReason; ready: boolean }
  // 取到了要摘要的对话（tokens 是估算），子进程开始写。
  | { type: "compact.summarizing"; tokens: number; messages: number }
  // 摘要写好了。
  | { type: "compact.ready"; ms: number; chars: number; chunks: number }
  // 写摘要失败（模型出错、超时、子进程异常退出）。
  | { type: "compact.failed"; error: string; ms: number }
  // 取对话失败（会话不让压缩，例如刚压缩过）。
  | { type: "compact.skipped"; why: string }
  // 写好的摘要接上了。
  | { type: "compact.applied"; tokensBefore: number | null }
  // 写好的摘要用不上了（会话在这期间压缩过，或者保留的起点不在了）。
  | { type: "compact.stale"; why: string }
  // 会话压缩成了（不管是谁压缩的）：新的周期。how 是 pi 的原因或者 idle。
  | { type: "compacted"; how: string }
  // 整理笔记的单元开了 / 结束了。
  | { type: "precipitate.started"; unitId: string }
  | { type: "precipitate.ended"; outcome: "done" | "yielded" | "failed" }
  // Lead 忙着 L4 的活时，更高车道的输入到了（what：user、event、retry）。
  | { type: "input"; lane: Lane; what: string }
  // 一件没人等的后台重活在等空闲 / 放行了。
  | { type: "gate.wait"; kind: string; label: string }
  | { type: "gate.release"; count: number };

/** 写进 events 表的空闲车道记录（scheduler.idle_job）。payload 的 unitId 是作业编号。 */
export interface IdleRecordPayload extends Record<string, string | number | boolean | null> {
  unitId: string;
  job: IdleJobKind;
  event: string;
}

export type IdleLaneEffect =
  | { type: "log"; line: string }
  | { type: "record"; payload: IdleRecordPayload }
  // 取要摘要的对话，在子进程里写摘要。
  | { type: "compact.start"; id: string; promoted: boolean }
  // 把写好的摘要接上（只在 Lead 空闲时）。
  | { type: "compact.apply"; id: string }
  // 写摘要的子进程不用再写了（会话已经压缩过）。
  | { type: "compact.cancel"; id: string; why: string }
  // pi 这一次想压缩：allow 照常就地压缩；defer 这次不压缩；supply 用写好的摘要。
  | { type: "inline"; action: "allow" | "defer" | "supply" }
  // 开整理笔记的 L4 单元。
  | { type: "precipitate.start"; id: string }
  // 让正在跑的 L4 单元在下一个让出点停下。
  | { type: "yield.unit"; by: Lane; unitId: string }
  // 放行在等空闲的后台重活。
  | { type: "gate.release" };

export interface IdleLaneStep {
  state: IdleLaneState;
  effects: IdleLaneEffect[];
}

// ── 查询 ─────────────────────────────────────────────────────────────────────

/** Lead 空闲满 graceMs 了（L4 的活可以开始）。 */
export function idleLongEnough(state: IdleLaneState, now: number, limits: IdleLaneLimits): boolean {
  return state.busyUnit === null && state.idleSince !== null && now - state.idleSince >= limits.graceMs;
}

/**
 * 下一次该看一眼的时间（运行层据此排定时器）：空闲满 graceMs 的那一刻、摘要重试的时间。只算上一次看过（lastCheckAt）以后的：
 * 看过的那一刻不再看，免得定时器空转；没有要等的时为 null（之后由 daemon 在单元结束时叫 check）。
 */
export function nextIdleCheckAt(state: IdleLaneState, limits: IdleLaneLimits, lastCheckAt: number): number | null {
  if (state.busyUnit !== null || state.idleSince === null) return null;
  const grace = state.idleSince + limits.graceMs;
  const times = [grace];
  if (state.compact.retryAt !== null) times.push(Math.max(state.compact.retryAt, grace));
  const pending = times.filter((at) => at > lastCheckAt);
  return pending.length ? Math.min(...pending) : null;
}

/** 压缩作业在 pi 想压缩时该怎么办（不改状态，给测试和快照看）。 */
export function inlineDecision(
  state: IdleLaneState, reason: InlineCompactionReason, ready: boolean, now: number, limits: IdleLaneLimits,
): "allow" | "defer" | "supply" {
  if (ready) return "supply";
  if (reason !== "threshold") return "allow";
  if (state.busyUnit === null) return "allow";
  const since = state.compact.deferredSince;
  return since !== null && now - since >= limits.deferMaxMs ? "allow" : "defer";
}

// ── 日志和记录 ────────────────────────────────────────────────────────────────

type Field = string | number | boolean | null | undefined;

function line(event: string, fields: Record<string, Field>): IdleLaneEffect {
  return { type: "log", line: schedulerLine(event, fields) };
}

function record(id: string, job: IdleJobKind, event: string, extra: Record<string, string | number | boolean | null> = {}): IdleLaneEffect {
  return { type: "record", payload: { unitId: id, job, event, ...extra } };
}

function ratioText(ratio: number | null): string {
  return ratio === null ? "-" : ratio.toFixed(2);
}

function busyFields(state: IdleLaneState): Record<string, Field> {
  return state.busyUnit ? { unit: state.busyUnit, lane: state.busyLane === null ? "-" : laneName(state.busyLane) } : { unit: "-" };
}

function nextId(state: IdleLaneState, job: IdleJobKind, now: number): { state: IdleLaneState; id: string } {
  const seq = state.seq + 1;
  return { state: { ...state, seq }, id: `idle_${job}_${now.toString(36)}${seq.toString(36).padStart(2, "0")}` };
}

function retryDelay(failures: number, limits: IdleLaneLimits): number {
  return Math.min(limits.retryMaxMs, limits.retryMs * 2 ** Math.max(0, failures - 1));
}

// ── 状态机 ───────────────────────────────────────────────────────────────────

/** 空闲时开始该开始的活。按先后：接上写好的摘要（几毫秒，不等 graceMs）、放行后台重活、整理笔记、开始写摘要。 */
function startIdleWork(state: IdleLaneState, event: Extract<IdleLaneEvent, { type: "tick" }>, now: number, limits: IdleLaneLimits): IdleLaneStep {
  const effects: IdleLaneEffect[] = [];
  let next: IdleLaneState = { ...state, ratio: event.ratio ?? state.ratio };
  if (next.busyUnit !== null || event.starting) return { state: next, effects };
  // 写好的摘要：Lead 一空闲就接上。碰会话的时间只有几毫秒；接上以后下一轮的上下文就小了。
  if (next.compact.phase === "ready" && next.compact.id) {
    const id = next.compact.id;
    next = { ...next, compact: { ...next.compact, phase: "applying" } };
    effects.push(line("idle.apply", { job: "compact", id, readyForMs: next.compact.readyAt === null ? null : now - next.compact.readyAt }));
    effects.push({ type: "compact.apply", id });
    return { state: next, effects };
  }
  const ratio0 = next.ratio;
  const notesPending = ratio0 !== null && ratio0 >= limits.precipitateRatio && !next.precipitate.done;
  const idleEnough = !event.pendingInput && idleLongEnough(next, now, limits);
  // 上下文快满了：不等空闲满 graceMs，也不管有没有排着的输入，会话一空着就开始写摘要（提级）。取对话只碰会话几毫秒，
  // 子进程不占 Lead。Lead 空闲够久、笔记还没整理时，先整理笔记（下面）。
  if (
    ratio0 !== null && ratio0 >= limits.promoteRatio && next.compact.phase === "idle" && next.precipitate.phase === "idle"
    && (next.compact.retryAt === null || now >= next.compact.retryAt) && !(idleEnough && notesPending)
  ) {
    const made = nextId(next, "compact", now);
    const compact = next.compact;
    next = { ...made.state, compact: { ...compact, phase: "preparing", id: made.id, promoted: true, startedAt: now, readyAt: null, yieldLogged: false } };
    const why = idleEnough ? "idle" : event.boundary ? "boundary" : "busy";
    effects.push(line("idle.start", {
      job: "compact", id: made.id, ratio: ratioText(ratio0), line: limits.promoteRatio, promoted: true, why,
      idleMs: now - next.idleSince!, failures: compact.failures,
    }));
    effects.push(record(made.id, "compact", "started", { ratio: ratio0, promoted: true, why, failures: compact.failures }));
    effects.push({ type: "compact.start", id: made.id, promoted: true });
    return { state: next, effects };
  }
  if (event.pendingInput) return { state: next, effects };
  if (!idleLongEnough(next, now, limits)) return { state: next, effects };
  const idleMs = now - next.idleSince!;
  if (next.gated > 0) {
    effects.push(line("idle.release", { job: "trash", count: next.gated, idleMs }));
    effects.push({ type: "gate.release" });
    next = { ...next, gated: 0 };
  }
  const ratio = next.ratio;
  // 整理笔记先于压缩：压缩以后，没存下的细节只剩摘要（precipitate.ts）。
  if (ratio !== null && ratio >= limits.precipitateRatio && !next.precipitate.done && next.precipitate.phase === "idle") {
    const made = nextId(next, "precipitate", now);
    next = { ...made.state, precipitate: { ...made.state.precipitate, phase: "running", id: made.id, unitId: null, startedAt: now, yieldRequested: false } };
    effects.push(line("idle.start", { job: "precipitate", id: made.id, ratio: ratioText(ratio), line: limits.precipitateRatio, idleMs, yields: next.precipitate.yields }));
    effects.push(record(made.id, "precipitate", "started", { ratio, idleMs, yields: next.precipitate.yields }));
    effects.push({ type: "precipitate.start", id: made.id });
    return { state: next, effects };
  }
  const compact = next.compact;
  const precipitatePending = ratio !== null && ratio >= limits.precipitateRatio && !next.precipitate.done;
  if (
    ratio !== null && ratio >= limits.compactRatio && compact.phase === "idle" && !precipitatePending
    && next.precipitate.phase === "idle" && (compact.retryAt === null || now >= compact.retryAt)
  ) {
    const made = nextId(next, "compact", now);
    next = { ...made.state, compact: { ...compact, phase: "preparing", id: made.id, promoted: false, startedAt: now, readyAt: null, yieldLogged: false } };
    effects.push(line("idle.start", { job: "compact", id: made.id, ratio: ratioText(ratio), line: limits.compactRatio, idleMs, failures: compact.failures }));
    effects.push(record(made.id, "compact", "started", { ratio, idleMs, promoted: false, failures: compact.failures }));
    effects.push({ type: "compact.start", id: made.id, promoted: false });
  }
  return { state: next, effects };
}

/** pi 想压缩：用写好的摘要、推迟、或者照常就地压缩（见文件开头）。 */
function onInline(state: IdleLaneState, event: Extract<IdleLaneEvent, { type: "inline" }>, now: number, limits: IdleLaneLimits): IdleLaneStep {
  const action = inlineDecision(state, event.reason, event.ready, now, limits);
  const compact = state.compact;
  const effects: IdleLaneEffect[] = [];
  if (action === "supply") {
    // 接上写好的摘要：由 compact.applied 收尾。
    effects.push(line("idle.inline", { job: "compact", id: compact.id, reason: event.reason, action, ...busyFields(state) }));
    effects.push({ type: "inline", action });
    return { state: { ...state, compact: { ...compact, phase: "applying" } }, effects };
  }
  if (action === "allow") {
    if (event.reason === "threshold" && state.busyUnit !== null) {
      // 兜底时限到了：照常就地压缩（D7「压缩自己的时限」）。
      const dueMs = compact.deferredSince === null ? 0 : now - compact.deferredSince;
      effects.push(line("idle.compact.forced", {
        ...busyFields(state), reason: event.reason, dueMs, deferMaxMs: limits.deferMaxMs, deferrals: compact.deferrals,
        job: compact.phase === "idle" ? "-" : compact.id, phase: compact.phase,
      }));
      effects.push(record(compact.id ?? `idle_compact_forced_${now.toString(36)}`, "compact", "forced", {
        dueMs, deferrals: compact.deferrals, phase: compact.phase, unit: state.busyUnit,
      }));
    } else if (event.reason !== "manual") {
      // 溢出，或者 Lead 空闲时 pi 自己要压缩：照常。
      effects.push(line("idle.inline", { job: "compact", reason: event.reason, action, ...busyFields(state), phase: compact.phase }));
    }
    effects.push({ type: "inline", action });
    return { state, effects };
  }
  // 推迟。还没有作业时马上在子进程里写摘要（提级，不等空闲）。
  let next: IdleLaneState = {
    ...state,
    compact: { ...compact, deferredSince: compact.deferredSince ?? now, deferrals: compact.deferrals + 1 },
  };
  const first = compact.deferrals === 0;
  const canStart = compact.phase === "idle" && (compact.retryAt === null || now >= compact.retryAt);
  if (canStart) {
    const made = nextId(next, "compact", now);
    next = { ...made.state, compact: { ...next.compact, phase: "preparing", id: made.id, promoted: true, startedAt: now, readyAt: null, yieldLogged: false } };
    effects.push(line("idle.defer", {
      job: "compact", id: made.id, reason: event.reason, ...busyFields(state), deferrals: next.compact.deferrals,
      dueMs: now - next.compact.deferredSince!, deferMaxMs: limits.deferMaxMs, promoted: true,
    }));
    effects.push(record(made.id, "compact", "started", { promoted: true, unit: state.busyUnit, failures: compact.failures }));
    effects.push({ type: "inline", action: "defer" });
    effects.push({ type: "compact.start", id: made.id, promoted: true });
    return { state: next, effects };
  }
  // 已经在写，或者在等重试：只推迟。日志只记第一次和之后每第 10 次，免得每一步一行。
  if (first || next.compact.deferrals % 10 === 0) {
    effects.push(line("idle.defer", {
      job: "compact", id: compact.id ?? "-", reason: event.reason, ...busyFields(state), deferrals: next.compact.deferrals,
      dueMs: now - next.compact.deferredSince!, deferMaxMs: limits.deferMaxMs, phase: compact.phase,
      ...(compact.retryAt !== null && compact.phase === "idle" ? { retryInMs: compact.retryAt - now } : {}),
    }));
  }
  effects.push({ type: "inline", action: "defer" });
  return { state: next, effects };
}

export function idleLaneStep(state: IdleLaneState, event: IdleLaneEvent, now: number, limits: IdleLaneLimits): IdleLaneStep {
  const compact = state.compact;
  switch (event.type) {
    case "busy": {
      const next: IdleLaneState = { ...state, busyUnit: event.unitId, busyLane: event.lane, busySince: now, idleSince: null };
      // 整理笔记的那一轮自己就是这个单元。
      if (state.precipitate.phase === "running" && state.precipitate.unitId === null && event.lane === 4) {
        next.precipitate = { ...state.precipitate, unitId: event.unitId };
      }
      return { state: next, effects: [] };
    }
    case "idle":
      return { state: { ...state, busyUnit: null, busyLane: null, busySince: null, idleSince: now }, effects: [] };
    case "tick":
      return startIdleWork(state, event, now, limits);
    case "inline":
      return onInline(state, event, now, limits);
    case "compact.summarizing": {
      if (compact.phase !== "preparing" || !compact.id) return { state, effects: [] };
      return {
        state: { ...state, compact: { ...compact, phase: "summarizing" } },
        effects: [line("idle.compact.summarizing", { id: compact.id, tokens: event.tokens, messages: event.messages, promoted: compact.promoted })],
      };
    }
    case "compact.ready": {
      if (compact.phase !== "summarizing" || !compact.id) return { state, effects: [] };
      const effects: IdleLaneEffect[] = [
        line("idle.done", { job: "compact", id: compact.id, ms: event.ms, chars: event.chars, chunks: event.chunks, promoted: compact.promoted, ...busyFields(state) }),
        record(compact.id, "compact", "summarized", { ms: event.ms, chars: event.chars, chunks: event.chunks, promoted: compact.promoted }),
      ];
      let next: IdleLaneState = { ...state, compact: { ...compact, phase: "ready", readyAt: now } };
      // Lead 空闲：马上接上。忙着时等单元结束（tick），或者 pi 下一次想压缩时用它（inline supply）。
      if (state.busyUnit === null) {
        next = { ...next, compact: { ...next.compact, phase: "applying" } };
        effects.push(line("idle.apply", { job: "compact", id: compact.id, readyForMs: 0 }));
        effects.push({ type: "compact.apply", id: compact.id });
      } else {
        effects.push(line("idle.wait", { job: "compact", id: compact.id, why: "lead_busy", ...busyFields(state) }));
      }
      return { state: next, effects };
    }
    case "compact.failed": {
      if (!compact.id || (compact.phase !== "summarizing" && compact.phase !== "preparing")) return { state, effects: [] };
      const failures = compact.failures + 1;
      const retryAt = now + retryDelay(failures, limits);
      return {
        state: { ...state, compact: idleCompactJob(failures, retryAt, compact) },
        effects: [
          line("idle.fail", { job: "compact", id: compact.id, ms: event.ms, failures, retryInMs: retryAt - now, error: event.error.slice(0, 200) }),
          record(compact.id, "compact", "failed", { ms: event.ms, failures, error: event.error.slice(0, 200) }),
        ],
      };
    }
    case "compact.skipped": {
      if (!compact.id || compact.phase !== "preparing") return { state, effects: [] };
      // 没有要压缩的（刚压缩过、会话太小）：这个周期不再空闲压缩，等下一次压缩成功或者水位再变。
      return {
        state: { ...state, compact: idleCompactJob(compact.failures, now + limits.retryMs, compact) },
        effects: [line("idle.skip", { job: "compact", id: compact.id, why: event.why })],
      };
    }
    case "compact.applied": {
      if (!compact.id) return { state, effects: [] };
      const ms = compact.startedAt === null ? null : now - compact.startedAt;
      return {
        // 新的周期：推迟的计数清零，整理笔记重新武装。水位要等下一次回答才知道。
        state: {
          ...state,
          ratio: null,
          compact: idleCompactJob(0),
          precipitate: { ...state.precipitate, done: false, yields: 0 },
        },
        effects: [
          line("idle.applied", { job: "compact", id: compact.id, totalMs: ms, tokensBefore: event.tokensBefore, deferrals: compact.deferrals, ...busyFields(state) }),
          record(compact.id, "compact", "applied", { totalMs: ms, tokensBefore: event.tokensBefore, deferrals: compact.deferrals, promoted: compact.promoted }),
        ],
      };
    }
    case "compact.stale": {
      if (!compact.id) return { state, effects: [] };
      return {
        state: { ...state, compact: idleCompactJob(compact.failures, null, compact) },
        effects: [
          line("idle.discard", { job: "compact", id: compact.id, why: event.why }),
          record(compact.id, "compact", "discarded", { why: event.why }),
        ],
      };
    }
    case "compacted": {
      // 别处压缩成了（pi 就地、溢出恢复、daemon 的恢复压缩）：新的周期。还在写的摘要用不上了。
      const effects: IdleLaneEffect[] = [];
      if (compact.id && (compact.phase === "summarizing" || compact.phase === "preparing" || compact.phase === "ready")) {
        effects.push(line("idle.discard", { job: "compact", id: compact.id, why: `compacted_by_${event.how}`, phase: compact.phase }));
        effects.push(record(compact.id, "compact", "discarded", { why: `compacted_by_${event.how}` }));
        if (compact.phase !== "ready") effects.push({ type: "compact.cancel", id: compact.id, why: `compacted_by_${event.how}` });
      }
      return {
        state: { ...state, ratio: null, compact: idleCompactJob(0), precipitate: { ...state.precipitate, done: false, yields: 0 } },
        effects,
      };
    }
    case "precipitate.started": {
      const job = state.precipitate;
      if (job.phase !== "running") return { state, effects: [] };
      return { state: { ...state, precipitate: { ...job, unitId: event.unitId } }, effects: [] };
    }
    case "precipitate.ended": {
      const job = state.precipitate;
      if (job.phase !== "running" || !job.id) return { state, effects: [] };
      const ms = job.startedAt === null ? null : now - job.startedAt;
      // 被打断：断点续做，这个周期重新武装；做完或者失败：这个周期不再做（失败了不一直重试，和以前一样）。
      const yielded = event.outcome === "yielded";
      return {
        state: {
          ...state,
          precipitate: {
            ...job, phase: "idle", unitId: null, startedAt: null, yieldRequested: false,
            done: !yielded, yields: job.yields + (yielded ? 1 : 0),
          },
        },
        effects: [
          line(yielded ? "idle.yielded" : "idle.done", { job: "precipitate", id: job.id, unit: job.unitId ?? "-", outcome: event.outcome, ms, yields: job.yields + (yielded ? 1 : 0) }),
          record(job.id, "precipitate", event.outcome, { ms, unit: job.unitId, yields: job.yields + (yielded ? 1 : 0) }),
        ],
      };
    }
    case "input": {
      const effects: IdleLaneEffect[] = [];
      let next = state;
      const job = state.precipitate;
      // Lead 正在跑整理笔记的 L4 单元：在下一个让出点停下它（只要一次）。
      if (job.phase === "running" && state.busyLane === 4 && state.busyUnit !== null && !job.yieldRequested && event.lane < 4) {
        next = { ...next, precipitate: { ...job, yieldRequested: true } };
        effects.push(line("idle.yield", {
          job: "precipitate", id: job.id, unit: state.busyUnit, by: laneName(event.lane), what: event.what,
          action: "abort_at_yield_point", runMs: job.startedAt === null ? null : now - job.startedAt,
        }));
        effects.push(record(job.id ?? state.busyUnit, "precipitate", "yield_requested", { by: laneName(event.lane), what: event.what, unit: state.busyUnit }));
        effects.push({ type: "yield.unit", by: event.lane, unitId: state.busyUnit });
      }
      // 摘要在子进程里写：不占 Lead，照常写完；接上等空闲（只记一次）。
      if ((compact.phase === "summarizing" || compact.phase === "preparing") && !compact.yieldLogged && event.lane < 4) {
        next = { ...next, compact: { ...next.compact, yieldLogged: true } };
        effects.push(line("idle.yield", {
          job: "compact", id: compact.id, by: laneName(event.lane), what: event.what, action: "continue_in_child", apply: "when_idle",
        }));
      }
      return { state: next, effects };
    }
    case "gate.wait":
      return {
        state: { ...state, gated: state.gated + 1 },
        effects: [line("idle.wait", { job: "trash", kind: event.kind, label: event.label, why: state.busyUnit ? "lead_busy" : "idle_grace", ...busyFields(state) })],
      };
    case "gate.release":
      return { state: { ...state, gated: Math.max(0, state.gated - event.count) }, effects: [] };
  }
}
