// 空闲车道的运行层（lead-scheduler spec D8、D10、D13，P4）：跑 idle-lane.ts 的状态机，执行它给出的事。
//
// daemon 建一个实例；pi extension（idleLaneExtension，登记在 session.ts）和 daemon 共用它，不需要进程间通信。
//   · daemon 告诉它：单元开了、结束了（unitOpened / unitClosed），更高车道的输入到了（inputArrived），看一眼（check）。
//   · 扩展告诉它：pi 想压缩（beforeCompact，pi 的 session_before_compact），压缩结束了（compactionEnded）。
//   · 它让 daemon 做：开整理笔记的 L4 单元、让那个单元在让出点停下、调 session.compact（取对话、接上摘要）。
//   · 它自己做：定时器（Lead 空闲满 graceMs 时看一眼）、写摘要的子进程（idle-compaction.ts）、碰会话时的锁
//     （sessionFree：daemon 发 prompt 之前等它）、没人等的后台重活的闸门（gate）。
//
// 碰会话的两件事（取对话、接上）都只在 Lead 空闲时开始，各几毫秒。它们经 session.compact(说明) 走 pi 自己的压缩流程，
// 说明是两个标记（IDLE_PROBE_INSTRUCTIONS、IDLE_APPLY_INSTRUCTIONS），由这里的 beforeCompact 认出来：
//   · 取对话：拿到 pi 算好的 preparation，交给子进程，然后让 pi 取消这次压缩（cancel）；
//   · 接上：返回写好的摘要（compaction），pi 记成一条压缩。
// pi 的 compact() 开头会 abort() 正在跑的运行，所以 daemon 必须在 Lead 空闲时才调它，并且发 prompt 之前等它做完。
import type { ExtensionContext, ExtensionFactory, SessionBeforeCompactEvent, SessionBeforeCompactResult } from "@earendil-works/pi-coding-agent";
import type { IdleLaneSnapshot } from "@pi-lead-child/protocol";
import { schedulerLine } from "./core.js";
import {
  idleLaneLimitsFromEnv, idleLaneStep, idleLongEnough, initialIdleLaneState, nextIdleCheckAt,
  type IdleLaneEffect, type IdleLaneEvent, type IdleLaneLimits, type IdleLaneState, type IdleRecordPayload,
} from "./idle-lane.js";
import {
  serializablePreparation, summarizeInChild, type IdleCompactRequest, type SummarizeInChildOptions, type SummarizeInChildResult,
} from "./idle-compaction.js";
import type { Lane } from "./lanes.js";

export const IDLE_PROBE_INSTRUCTIONS = "[plc idle lane: prepare]";
export const IDLE_APPLY_INSTRUCTIONS = "[plc idle lane: apply]";

export type PrecipitationOutcome = "done" | "yielded" | "failed" | "skipped";

/** daemon 给运行层的出口。都是同步的小查询，除了 runPrecipitation 和 compact。 */
export interface IdleLaneHost {
  log(line: string): void;
  // 写进 events 表（scheduler.idle_job）。写不进时由调用方记日志。
  record?(payload: IdleRecordPayload): void;
  // 正在跑的单元（编号）；没有时为 null。
  currentUnit(): string | null;
  // 系统回合正在探网络、还没开单元：会话这时不能碰。
  starting(): boolean;
  // 排着更高车道的事（用户的消息、要交给 Lead 的事件、到点的重试）：daemon 马上会开一轮，L4 不开始。
  pendingInput(): boolean;
  // Lead 的上下文占窗口的比例；读不到时为 null。
  contextRatio(): number | null;
  // 开整理笔记的 L4 单元，等它结束。yielded：给更高车道让了路；skipped：没开成（忙、断网）。
  runPrecipitation(): Promise<PrecipitationOutcome>;
  // 正在跑的单元里有没有正在跑的写操作（spec D5：写操作不打断）。返回工具名。
  writeInFlight(): string | null;
  // 让正在跑的 L4 单元停下（调度器的 idle.yield，经控制层中止）。
  yieldUnit(by: Lane): void;
  // pi 的 session.compact(说明)。
  compact(instructions: string): Promise<unknown>;
}

export interface IdleLaneRuntimeOptions {
  host: IdleLaneHost;
  limits?: IdleLaneLimits;
  now?: () => number;
  // 写摘要的子进程最多跑多久（daemon 的压缩时限，PLC_LEAD_COMPACTION_TIMEOUT_MS）。
  compactionTimeoutMs?: number;
  // 让路时最多等正在跑的写操作多久。
  writeGraceMs?: number;
  // 上下文溢出时，最多等正在写的摘要多久（等不到就让 pi 就地压缩）。
  overflowWaitMs?: number;
  // 测试换掉子进程。
  summarize?: (request: IdleCompactRequest, options: SummarizeInChildOptions) => Promise<SummarizeInChildResult>;
}

interface ReadySummary {
  id: string;
  summary: string;
  details: unknown;
  usage: unknown;
  // 取对话时会话里最后一条压缩的编号：接上时还是它，摘要才有效。
  baseCompactionId: string | null;
  firstKeptEntryId: string;
}

type BranchEntry = { id?: unknown; type?: unknown };

function lastCompactionId(entries: readonly BranchEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "compaction" && typeof entry.id === "string") return entry.id;
  }
  return null;
}

type CompactionResult = SessionBeforeCompactResult | undefined;

export class IdleLaneRuntime {
  #state: IdleLaneState;
  readonly #limits: IdleLaneLimits;
  readonly #host: IdleLaneHost;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #writeGraceMs: number;
  readonly #overflowWaitMs: number;
  readonly #summarize: NonNullable<IdleLaneRuntimeOptions["summarize"]>;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerAt: number | null = null;
  // 上一次 tick 的时间：定时器只等这以后的时刻。
  #lastCheckAt = Number.NEGATIVE_INFINITY;
  #child: AbortController | null = null;
  // 正在写的摘要结束（成功、失败或者被叫停）时 resolve。溢出时等它。
  #childSettled: Promise<void> | null = null;
  #childPid: number | null = null;
  #ready: ReadySummary | null = null;
  #session: Promise<void> | null = null;
  #sessionKind: "probe" | "apply" | null = null;
  #probeReached = false;
  #gateWaiters: Array<() => void> = [];
  // beforeCompact 的结果：这次 pi 的压缩由这里接上了（chunks 扩展跳过），或者是这里取消的（日志不报「压缩中止」）。
  #claimed: SessionBeforeCompactEvent | null = null;
  #supplied: string | null = null;
  #cancelled = 0;
  #inlineAction: "allow" | "defer" | "supply" | null = null;
  #pendingPrep: { event: SessionBeforeCompactEvent; ctx: Pick<ExtensionContext, "model" | "modelRegistry"> } | null = null;
  #sweepHeldLogged = false;
  #stopped = false;

  constructor(options: IdleLaneRuntimeOptions) {
    this.#host = options.host;
    this.#limits = options.limits ?? idleLaneLimitsFromEnv();
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.compactionTimeoutMs ?? 10 * 60_000;
    this.#writeGraceMs = options.writeGraceMs ?? 10_000;
    this.#overflowWaitMs = options.overflowWaitMs ?? 60_000;
    this.#summarize = options.summarize ?? summarizeInChild;
    this.#state = initialIdleLaneState(this.#now());
  }

  get state(): IdleLaneState {
    return this.#state;
  }

  get limits(): IdleLaneLimits {
    return this.#limits;
  }

  dispatch(event: IdleLaneEvent): IdleLaneEffect[] {
    if (this.#stopped) return [];
    const step = idleLaneStep(this.#state, event, this.#now(), this.#limits);
    this.#state = step.state;
    for (const effect of step.effects) this.#run(effect);
    this.#reschedule();
    return step.effects;
  }

  // ── daemon 的入口 ──────────────────────────────────────────────────────────

  unitOpened(unitId: string, lane: Lane): void {
    this.dispatch({ type: "busy", unitId, lane });
  }

  /** 单元结束了：会话空着的这一刻看一眼（上下文快满时马上开始写摘要，见 idle-lane.ts 的提级）。 */
  unitClosed(): void {
    this.dispatch({ type: "idle" });
    this.check({ boundary: true });
  }

  /**
   * 看一眼该不该开始什么（单元结束、排着的事处理完以后，daemon 调它；定时器也调它）。
   * ifOlderThanMs：daemon 轮询里的心跳，离上一次看不到这么久时不看（读上下文水位要建一次投影）。
   */
  check(options: { ifOlderThanMs?: number; boundary?: boolean } = {}): void {
    if (this.#stopped) return;
    if (options.ifOlderThanMs !== undefined && this.#now() - this.#lastCheckAt < options.ifOlderThanMs) return;
    let ratio: number | null = null;
    let pendingInput = false;
    let starting = false;
    try {
      ratio = this.#host.contextRatio();
      pendingInput = this.#host.pendingInput();
      starting = this.#host.starting();
    } catch (error) {
      // 例如 daemon 还在启动、会话还没建好。daemon 轮询里的心跳会再看。
      this.#lastCheckAt = this.#now();
      this.#host.log(schedulerLine("idle.check_failed", { error: error instanceof Error ? error.message : String(error) }));
      return;
    }
    this.#lastCheckAt = this.#now();
    this.dispatch({ type: "tick", ratio, pendingInput, starting, ...(options.boundary ? { boundary: true } : {}) });
  }

  /** Lead 忙着 L4 的活时，更高车道的输入到了。 */
  inputArrived(lane: Lane, what: string): void {
    if (lane >= 4) return;
    this.dispatch({ type: "input", lane, what });
  }

  /** 发 prompt 之前等：空闲车道正在碰会话（取对话、接上摘要，各几毫秒）。不会抛错。 */
  sessionFree(): Promise<void> {
    return this.#session ?? Promise.resolve();
  }

  /** 正在碰会话的是哪一件：daemon 的压缩日志据此不把它当成 pi 的压缩。 */
  get sessionOp(): "probe" | "apply" | null {
    return this.#sessionKind;
  }

  /** 没人等的后台重活（回收区的删除）开始以前等 Lead 空闲满 graceMs（core 的 setHostIdleGate）。 */
  gate(job: { kind: string; label: string }): Promise<void> {
    if (this.#stopped || idleLongEnough(this.#state, this.#now(), this.#limits)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#gateWaiters.push(resolve);
      this.dispatch({ type: "gate.wait", kind: job.kind, label: job.label });
    });
  }

  /** 清理扫描现在能不能开始：Lead 空闲满 graceMs，或者已经推迟太久（overdue）。推迟时只记一次日志。 */
  mayStartSweep(overdue: boolean): boolean {
    if (this.#stopped) return false;
    if (idleLongEnough(this.#state, this.#now(), this.#limits)) {
      this.#sweepHeldLogged = false;
      return true;
    }
    if (overdue) {
      this.#host.log(schedulerLine("idle.forced", { job: "sweep", why: "overdue", unit: this.#state.busyUnit ?? "-" }));
      this.#sweepHeldLogged = false;
      return true;
    }
    if (!this.#sweepHeldLogged) {
      this.#sweepHeldLogged = true;
      this.#host.log(schedulerLine("idle.wait", { job: "sweep", why: this.#state.busyUnit ? "lead_busy" : "idle_grace", unit: this.#state.busyUnit ?? "-" }));
    }
    return false;
  }

  snapshot(): IdleLaneSnapshot {
    const now = this.#now();
    const state = this.#state;
    const compact = state.compact;
    return {
      idleMs: state.busyUnit === null && state.idleSince !== null ? now - state.idleSince : null,
      graceMs: this.#limits.graceMs,
      ratio: state.ratio,
      precipitateRatio: this.#limits.precipitateRatio,
      compactRatio: this.#limits.compactRatio,
      compact: {
        phase: compact.phase, id: compact.id, promoted: compact.promoted,
        sinceMs: compact.startedAt === null ? null : now - compact.startedAt,
        deferredMs: compact.deferredSince === null ? null : now - compact.deferredSince,
        deferrals: compact.deferrals, deferMaxMs: this.#limits.deferMaxMs, failures: compact.failures,
        retryInMs: compact.retryAt === null ? null : Math.max(0, compact.retryAt - now),
        pid: this.#childPid,
      },
      precipitate: {
        phase: state.precipitate.phase, id: state.precipitate.id, done: state.precipitate.done,
        yields: state.precipitate.yields, unitId: state.precipitate.unitId,
      },
      gated: state.gated,
    };
  }

  /** 停机：停掉写摘要的子进程、定时器，放行在等的后台重活。 */
  stop(): void {
    if (this.#stopped) return;
    this.#child?.abort();
    this.#child = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    for (const resolve of this.#gateWaiters.splice(0)) resolve();
    this.#stopped = true;
  }

  // ── 扩展的入口（pi 的 session_before_compact 和压缩结束）────────────────────────

  /** pi 想压缩。返回给 pi 的结果：cancel、compaction，或者 undefined（照常）。 */
  async beforeCompact(event: SessionBeforeCompactEvent, ctx: Pick<ExtensionContext, "model" | "modelRegistry">): Promise<CompactionResult> {
    const marker = event.customInstructions;
    if (marker === IDLE_PROBE_INSTRUCTIONS) {
      this.#probeReached = true;
      const compact = this.#state.compact;
      if (compact.phase === "preparing" && compact.id) this.#startChild(compact.id, event, ctx);
      this.#cancelled += 1;
      return { cancel: true };
    }
    // 上下文溢出，子进程正在写摘要：先等它（最多 overflowWaitMs）。它比现在就地重写一份早开始，所以不会更慢。
    if (event.reason === "overflow" && !this.#ready && this.#childSettled
      && (this.#state.compact.phase === "summarizing" || this.#state.compact.phase === "preparing")) {
      const started = this.#now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.#childSettled,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, this.#overflowWaitMs); timer.unref?.(); }),
      ]).finally(() => clearTimeout(timer));
      this.#host.log(schedulerLine("idle.overflow_wait", {
        job: "compact", id: this.#state.compact.id, waitedMs: this.#now() - started, ready: this.#ready !== null,
        unit: this.#state.busyUnit ?? "-",
      }));
    }
    const valid = this.#validReady(event.branchEntries as readonly BranchEntry[]);
    if (this.#ready && !valid) {
      this.#ready = null;
      this.dispatch({ type: "compact.stale", why: "session_compacted_since" });
    }
    if (marker === IDLE_APPLY_INSTRUCTIONS) {
      if (!valid) {
        this.#cancelled += 1;
        return { cancel: true };
      }
      return this.#supply(event);
    }
    if (event.reason === "manual") {
      // 别处发起的手动压缩（daemon 的恢复压缩）：有写好的摘要就用它，没有就照常。
      if (!valid) return undefined;
      this.#inlineAction = null;
      this.dispatch({ type: "inline", reason: "manual", ready: true });
      return this.#supply(event);
    }
    this.#inlineAction = null;
    this.#pendingPrep = { event, ctx };
    try {
      this.dispatch({ type: "inline", reason: event.reason, ready: valid });
    } finally {
      this.#pendingPrep = null;
    }
    const action = this.#inlineAction as "allow" | "defer" | "supply" | null;
    if (action === "supply") return this.#supply(event);
    if (action === "defer") {
      this.#cancelled += 1;
      return { cancel: true };
    }
    return undefined;
  }

  /** chunks 扩展问：这次压缩是不是已经由空闲车道接上了（是的话它不再自己写摘要）。 */
  claims(event: unknown): boolean {
    return this.#claimed !== null && this.#claimed === event;
  }

  /**
   * pi 的一次压缩结束（compaction_end）。ours：是空闲车道取消的（取对话、推迟），daemon 不当成压缩中止来报；
   * applied：接上的是空闲车道写好的摘要。
   */
  compactionEnded(event: { reason?: unknown; aborted?: unknown; result?: unknown; errorMessage?: unknown }): { ours: boolean; applied: boolean } {
    const succeeded = Boolean(event.result) && !event.aborted && !event.errorMessage;
    if (this.#supplied) {
      const id = this.#supplied;
      this.#supplied = null;
      this.#claimed = null;
      if (succeeded) {
        const tokensBefore = (event.result as { tokensBefore?: unknown }).tokensBefore;
        this.dispatch({ type: "compact.applied", tokensBefore: typeof tokensBefore === "number" ? tokensBefore : null });
        return { ours: true, applied: true };
      }
      this.#host.log(schedulerLine("idle.apply_failed", { job: "compact", id, error: String(event.errorMessage ?? (event.aborted ? "aborted" : "unknown")).slice(0, 200) }));
      this.dispatch({ type: "compact.stale", why: "apply_failed" });
      return { ours: true, applied: false };
    }
    if (event.aborted && this.#cancelled > 0) {
      this.#cancelled -= 1;
      return { ours: true, applied: false };
    }
    if (succeeded) this.dispatch({ type: "compacted", how: String(event.reason ?? "unknown") });
    return { ours: false, applied: false };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  #validReady(entries: readonly BranchEntry[]): boolean {
    const ready = this.#ready;
    if (!ready || this.#state.compact.id !== ready.id) return false;
    return lastCompactionId(entries) === ready.baseCompactionId && entries.some((entry) => entry.id === ready.firstKeptEntryId);
  }

  #supply(event: SessionBeforeCompactEvent): CompactionResult {
    const ready = this.#ready!;
    this.#ready = null;
    this.#claimed = event;
    this.#supplied = ready.id;
    const details = ready.details && typeof ready.details === "object" ? { ...(ready.details as object), idleLane: ready.id } : { idleLane: ready.id };
    return {
      compaction: {
        summary: ready.summary, firstKeptEntryId: ready.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore,
        details, ...(ready.usage ? { usage: ready.usage as never } : {}),
      },
    };
  }

  #run(effect: IdleLaneEffect): void {
    switch (effect.type) {
      case "log":
        this.#host.log(effect.line);
        return;
      case "record":
        try {
          this.#host.record?.(effect.payload);
        } catch (error) {
          this.#host.log(schedulerLine("record.failed", { kind: "idle_job", error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      case "inline":
        this.#inlineAction = effect.action;
        return;
      case "compact.start": {
        const prep = this.#pendingPrep;
        if (prep) {
          this.#startChild(effect.id, prep.event, prep.ctx);
          return;
        }
        this.#probe(effect.id);
        return;
      }
      case "compact.apply":
        this.#apply(effect.id);
        return;
      case "compact.cancel":
        this.#child?.abort();
        this.#child = null;
        this.#ready = null;
        return;
      case "precipitate.start":
        // 整理笔记结束以后再看一眼：它的单元结束时（unitClosed）这里还记着「在跑」，接下来的压缩要等这一眼。
        void this.#host.runPrecipitation().then(
          (outcome) => this.dispatch({ type: "precipitate.ended", outcome: outcome === "skipped" ? "yielded" : outcome }),
          () => this.dispatch({ type: "precipitate.ended", outcome: "failed" }),
        ).then(() => this.check());
        return;
      case "yield.unit":
        this.#yieldWhenSafe(effect.by, effect.unitId);
        return;
      case "gate.release":
        for (const resolve of this.#gateWaiters.splice(0)) resolve();
        return;
    }
  }

  // 碰会话的事排成一个：daemon 发 prompt 之前等它（sessionFree）。
  #sessionOp(kind: "probe" | "apply", work: () => Promise<void>): void {
    const op: Promise<void> = (async () => {
      this.#sessionKind = kind;
      try {
        await work();
      } finally {
        this.#sessionKind = null;
      }
    })().catch(() => {}).finally(() => {
      if (this.#session === op) this.#session = null;
    });
    this.#session = op;
  }

  // 取要摘要的对话：session.compact(取对话的标记)，beforeCompact 拿到 preparation，交给子进程，再让 pi 取消。
  #probe(id: string): void {
    this.#probeReached = false;
    this.#sessionOp("probe", async () => {
      try {
        await this.#host.compact(IDLE_PROBE_INSTRUCTIONS);
      } catch (error) {
        if (!this.#probeReached && this.#state.compact.id === id && this.#state.compact.phase === "preparing") {
          // 没走到钩子：pi 不让压缩（刚压缩过、会话太小、没有模型）。
          this.dispatch({ type: "compact.skipped", why: (error instanceof Error ? error.message : String(error)).slice(0, 120) });
        }
      }
    });
  }

  // 接上写好的摘要：session.compact(接上的标记)，beforeCompact 返回它。结果由 compactionEnded 收尾。
  #apply(id: string): void {
    this.#sessionOp("apply", async () => {
      try {
        await this.#host.compact(IDLE_APPLY_INSTRUCTIONS);
      } catch (error) {
        // 摘要失效时 beforeCompact 已经收尾（compact.stale）；pi 在钩子之前就不让压缩时在这里收尾。
        if (this.#state.compact.id === id && this.#state.compact.phase === "applying") {
          this.#ready = null;
          this.dispatch({ type: "compact.stale", why: (error instanceof Error ? error.message : String(error)).slice(0, 120) });
        }
      }
    });
  }

  #startChild(id: string, event: SessionBeforeCompactEvent, ctx: Pick<ExtensionContext, "model" | "modelRegistry">): void {
    const model = ctx.model;
    if (!model) {
      this.dispatch({ type: "compact.failed", error: "no model", ms: 0 });
      return;
    }
    const preparation = serializablePreparation(event.preparation as never);
    const baseCompactionId = lastCompactionId(event.branchEntries as readonly BranchEntry[]);
    const auth = ctx.modelRegistry.getApiKeyAndHeaders(model);
    this.dispatch({
      type: "compact.summarizing", tokens: event.preparation.tokensBefore,
      messages: preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length,
    });
    const controller = new AbortController();
    this.#child = controller;
    this.#childPid = null;
    const settled = (async () => {
      let result: SummarizeInChildResult;
      try {
        const resolved = await auth;
        if (!resolved.ok) throw new Error(`model auth: ${resolved.error}`);
        const request: IdleCompactRequest = {
          version: 1,
          model: model as unknown as IdleCompactRequest["model"],
          auth: {
            ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
            ...(resolved.headers ? { headers: resolved.headers as Record<string, string> } : {}),
            ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
          },
          preparation,
        };
        result = await this.#summarize(request, {
          id, timeoutMs: this.#timeoutMs, signal: controller.signal,
          onStart: (pid) => { if (this.#child === controller) this.#childPid = pid; },
        });
      } catch (error) {
        result = { response: { ok: false, error: error instanceof Error ? error.message : String(error) }, ms: 0 };
      }
      if (this.#child === controller) {
        this.#child = null;
        this.#childPid = null;
      }
      if (controller.signal.aborted || this.#state.compact.id !== id) return;
      const { response, ms } = result;
      if (!response.ok) {
        this.dispatch({ type: "compact.failed", error: response.error, ms });
        return;
      }
      this.#ready = {
        id, summary: response.summary, details: response.details, usage: response.usage,
        baseCompactionId, firstKeptEntryId: preparation.firstKeptEntryId,
      };
      this.dispatch({ type: "compact.ready", ms, chars: response.summary.length, chunks: response.chunks });
    })();
    this.#childSettled = settled;
    void settled.finally(() => { if (this.#childSettled === settled) this.#childSettled = null; });
  }

  // 让路：正在跑的写操作先做完（最多 writeGraceMs，spec D5），然后停下那个 L4 单元。
  #yieldWhenSafe(by: Lane, unitId: string): void {
    const started = this.#now();
    let logged = false;
    const attempt = () => {
      if (this.#stopped || this.#host.currentUnit() !== unitId) return;
      const write = this.#host.writeInFlight();
      if (write && this.#now() - started < this.#writeGraceMs) {
        if (!logged) {
          logged = true;
          this.#host.log(schedulerLine("idle.yield_wait", { unit: unitId, tool: write, graceMs: this.#writeGraceMs }));
        }
        const timer = setTimeout(attempt, 250);
        timer.unref?.();
        return;
      }
      this.#host.yieldUnit(by);
    };
    attempt();
  }

  #reschedule(): void {
    if (this.#stopped) return;
    const at = nextIdleCheckAt(this.#state, this.#limits, this.#lastCheckAt);
    if (at === this.#timerAt && this.#timer) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#timerAt = at;
    if (at === null) return;
    const delay = Math.max(0, at - this.#now()) + 5;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#timerAt = null;
      this.check();
    }, delay);
    this.#timer.unref?.();
  }
}

/** pi 扩展：pi 想压缩时问空闲车道（session_before_compact）。登记在分段压缩（compaction-chunks.ts）之前。 */
export function idleLaneExtension(runtime: IdleLaneRuntime): ExtensionFactory {
  return (pi) => {
    pi.on("session_before_compact", (event, ctx) => runtime.beforeCompact(event, ctx));
  };
}
