// 调度器的运行层：把决策层（core.ts 的纯函数）、控制层（controller.ts）和执行的出口接在一起（lead-scheduler spec D9、D10）。
//
// daemon 建一个实例，pi extension（extension.ts）和 daemon 共用它，不需要进程间通信（D13）。
//   · dispatch(event)：跑一次状态机，再执行它给出的事。通用的事（日志、记录、中止）在这里做；
//     daemon 才做得了的事（插提醒、送交接消息）交给 execute。返回这次给出的全部事，调用方据此决定接下来做什么。
//   · 中止：先把原因写进状态和 controller，再调用执行层的 stop（session.abort()），最多等 abortGraceMs，
//     不等到也照样往下走，并写日志（D10 局限 3）。中止花了多久也写日志（D12 第 5 条）。
//   · 记录：每个单元的开始和结束、值得记的决定、中止，写进 events 表（record）和会话文件（extension 绑定的 recorder）。
import { abortExecution, abortReasonText, LeadTaskController, type AbortExecutionResult, type LeadAbortReason } from "./controller.js";
import {
  initialSchedulerState, isBusy, schedulerLine, schedulerStep,
  type SchedulerEffect, type SchedulerEvent, type SchedulerRecordKind, type SchedulerState, type UnitOutcome, type UnitState,
  type WaitingEntry,
} from "./core.js";
import type { SchedulerSnapshot } from "@pi-lead-child/protocol";
import { LANES, laneName, type Lane, type UnitSource } from "./lanes.js";

export type { SchedulerSnapshot };

export const DEFAULT_ABORT_GRACE_MS = 5_000;

/** 一步现在在哪个阶段（extension 报来的，D7）。 */
export interface LeadStageInfo {
  run: number;
  step: number;
  // A 请求前准备；B1 上传和排队；B2 等第一段输出；C 流式输出；tool 在跑工具；idle 一步结束了。
  stage: "A" | "B1" | "B2" | "C" | "tool" | "idle";
  since: number;
  tool?: string;
}

export interface LeadSchedulerRuntimeOptions {
  now?: () => number;
  // daemon 的日志（同步写）。
  log: (line: string) => void;
  // 写进 events 表（scheduler.*）。写不进时由调用方记日志，不影响调度。
  record?: (kind: SchedulerRecordKind, payload: Record<string, string | number | boolean | null>) => void;
  // daemon 才做得了的事。
  execute?: (effect: SchedulerEffect) => void;
  // 让执行层停下（session.abort()）。不给时中止只记原因。
  stopExecution?: () => unknown;
  abortGraceMs?: number;
  newUnitId?: () => string;
}

let unitCounter = 0;
function defaultUnitId(): string {
  unitCounter += 1;
  return `unit_${Date.now().toString(36)}${unitCounter.toString(36).padStart(3, "0")}`;
}

export class LeadSchedulerRuntime {
  #state: SchedulerState = initialSchedulerState();
  #controller: LeadTaskController | null = null;
  #aborting: Promise<AbortExecutionResult> | null = null;
  #sessionRecorder: ((data: Record<string, unknown>) => void) | null = null;
  #stage: LeadStageInfo | null = null;
  readonly #options: LeadSchedulerRuntimeOptions;
  readonly #now: () => number;

  constructor(options: LeadSchedulerRuntimeOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get state(): SchedulerState {
    return this.#state;
  }

  get busy(): boolean {
    return isBusy(this.#state);
  }

  get draining(): boolean {
    return this.#state.draining;
  }

  get starting(): boolean {
    return this.#state.starting;
  }

  get unit(): UnitState | null {
    return this.#state.unit;
  }

  /** 这一段运行的 controller；没有单元时为 null。 */
  get controller(): LeadTaskController | null {
    return this.#controller;
  }

  /** 最近一次中止的执行（drain 据此等它）。 */
  get aborting(): Promise<AbortExecutionResult> | null {
    return this.#aborting;
  }

  /** extension 绑定会话文件的写入口（pi 的 appendEntry，同步写）。重新加载扩展时新的一份替换旧的。 */
  bindSessionRecorder(recorder: (data: Record<string, unknown>) => void): void {
    this.#sessionRecorder = recorder;
  }

  /** 会话关了：解开它绑定的写入口（已经被新的一份替换时不动）。 */
  unbindSessionRecorder(recorder: (data: Record<string, unknown>) => void): void {
    if (this.#sessionRecorder === recorder) this.#sessionRecorder = null;
  }

  /** extension 发现一步在某个阶段等过了阈值（D7）：写进 events 表。日志和会话文件由 extension 自己写。 */
  noteStageSlow(payload: Record<string, string | number | boolean | null> & { unitId: string }): void {
    try {
      this.#options.record?.("stage_slow", payload);
    } catch (error) {
      this.#options.log(schedulerLine("record.failed", { kind: "stage_slow", error: error instanceof Error ? error.message : String(error) }));
    }
  }

  /** extension 报告一步现在在哪个阶段。 */
  noteStage(stage: LeadStageInfo | null): void {
    this.#stage = stage;
  }

  get stage(): LeadStageInfo | null {
    return this.#stage;
  }

  dispatch(event: SchedulerEvent): SchedulerEffect[] {
    const before = this.#state;
    const step = schedulerStep(before, event, this.#now());
    this.#state = step.state;
    const unit = step.state.unit;
    if (this.#controller && unit && this.#controller.unitId === unit.id && this.#controller.lane !== unit.lane) {
      this.#controller.setLane(unit.lane);
    }
    for (const effect of step.effects) this.#run(effect);
    return step.effects;
  }

  /** 开一个单元：编号、controller、状态机的 unit.open。返回单元编号。 */
  openUnit(input: { source: UnitSource; lane: Lane; origin: string | null; turnId: string | null }): string {
    const id = (this.#options.newUnitId ?? defaultUnitId)();
    this.#controller = this.#newController(id, 1, input.lane);
    this.dispatch({ type: "unit.open", id, ...input });
    return id;
  }

  /** 单元的下一段运行（红线以后的交接）：新的 controller，同一个单元编号。 */
  nextSegment(): LeadTaskController | null {
    const unit = this.#state.unit;
    if (!unit) return null;
    this.#controller = this.#newController(unit.id, unit.segment, unit.lane);
    return this.#controller;
  }

  closeUnit(outcome: UnitOutcome): void {
    this.dispatch({ type: "unit.close", outcome });
    this.#controller = null;
    this.#stage = null;
  }

  /** 现在的样子（GET /v1/lead/scheduler）。waiting 是在等的人（带车道），host 是宿主的负载。 */
  snapshot(facts: { waiting?: readonly WaitingEntry[]; host?: string | null; budgetMs: number }): SchedulerSnapshot {
    const now = this.#now();
    const unit = this.#state.unit;
    const stage = this.#stage;
    const lanes = ([0, 1, 2, 3, 4] as Lane[]).map((lane) => {
      const deadline = LANES[lane].firstResponseMs;
      return {
        lane: laneName(lane), deadlineMs: deadline,
        waiting: (facts.waiting ?? []).filter((entry) => entry.lane === lane).map((entry) => ({
          who: entry.who, conversation: entry.conversation, count: entry.count, waitedMs: entry.waitedMs,
          overdue: deadline !== null && entry.waitedMs > deadline,
        })),
      };
    });
    return {
      at: new Date(now).toISOString(),
      draining: this.#state.draining,
      starting: this.#state.starting,
      unit: unit ? {
        id: unit.id, lane: laneName(unit.lane), source: unit.source, origin: unit.origin, turnId: unit.turnId,
        openedAt: new Date(unit.openedAt).toISOString(), elapsedMs: now - unit.openedAt,
        deadlineMs: LANES[unit.lane].firstResponseMs,
        budget: {
          usedMs: unit.budgetStartedAt === null ? null : now - unit.budgetStartedAt, budgetMs: facts.budgetMs,
          yellowReminded: unit.yellowReminded, secondReminded: unit.secondReminded,
        },
        toolCalls: unit.toolCalls, steps: unit.steps, segment: unit.segment, redLine: unit.redLine?.phase ?? null,
        aborts: unit.aborts.map(abortReasonText),
        tools: Object.values(unit.tools).map((tool) => ({ name: tool.name, write: tool.write })),
        stage: stage ? { stage: stage.stage, step: stage.step, sinceMs: now - stage.since, ...(stage.tool ? { tool: stage.tool } : {}) } : null,
      } : null,
      lanes,
      host: facts.host ?? null,
    };
  }

  #newController(unitId: string, segment: number, lane: Lane): LeadTaskController {
    const deadlineMs = LANES[lane].firstResponseMs;
    const controller = new LeadTaskController({
      unitId, segment, lane, deadline: deadlineMs === null ? null : this.#now() + deadlineMs,
    });
    controller.signal.addEventListener("abort", () => {
      this.#stopExecution(controller, controller.abortReason ?? { kind: "user_stop" });
    }, { once: true });
    return controller;
  }

  #run(effect: SchedulerEffect): void {
    switch (effect.type) {
      case "log":
        this.#options.log(effect.line);
        return;
      case "record":
        this.#record(effect.kind, effect.payload);
        return;
      case "abort":
        this.#abort(effect.reason);
        return;
      default:
        this.#options.execute?.(effect);
    }
  }

  #record(kind: SchedulerRecordKind, payload: Record<string, string | number | boolean | null>): void {
    try {
      this.#options.record?.(kind, payload);
    } catch (error) {
      this.#options.log(schedulerLine("record.failed", { kind, error: error instanceof Error ? error.message : String(error) }));
    }
    try {
      this.#sessionRecorder?.({ kind, ...payload, at: new Date(this.#now()).toISOString() });
    } catch { /* 会话已经关了 */ }
  }

  // 先把原因写进 controller（状态机里已经记了），监听者再让执行层停下。这一段已经中止过时（例如红线中断以后用户又 /stop），
  // 直接再叫一次执行层：和以前一样，pi 的 abort 可以叫多次。
  #abort(reason: LeadAbortReason): void {
    const controller = this.#controller;
    if (controller && !controller.signal.aborted) {
      controller.abort(reason);
      return;
    }
    this.#stopExecution(controller, reason);
  }

  #stopExecution(controller: LeadTaskController | null, reason: LeadAbortReason): void {
    const stop = this.#options.stopExecution;
    if (!stop) return;
    const graceMs = this.#options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    const where = controller ? { unit: controller.unitId, seg: controller.segment } : { unit: "-" };
    const running = this.#stage;
    this.#aborting = abortExecution(stop, { graceMs, now: this.#now }).then((result) => {
      const fields = {
        ...where, reason: abortReasonText(reason), settled: result.settled, ms: result.ms,
        ...(running ? { stage: running.stage, step: running.step } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
      // 过了宽限时间还没停下：中止本身挂住了（有东西不听 signal）。照样往下走，留一条日志。
      this.#options.log(schedulerLine(result.settled ? "abort.done" : "abort.stuck", { ...fields, graceMs }));
      return result;
    });
  }
}
