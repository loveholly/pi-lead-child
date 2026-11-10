// 控制层（lead-scheduler spec D10）：用浏览器 TaskController 的形状，不用它的实现。
//
// 三层：决策层（core.ts 的纯函数状态机）决定做什么；控制层把决定传给执行层，传的是中止和车道；执行层（pi 的
// agent loop、工具、模型请求）听从 signal。Node 24 没有 TaskController，就算有，它调度的也是毫秒级的 JS 回调，
// 决定不了 Lead 下一件处理哪个输入。
//
// 一个 controller 管单元的一段运行：单元的第一次 prompt 是一段；红线以后在同一个单元里送交接消息，是第二段。
// AbortSignal 只能触发一次，所以第二段用一个新的 controller，单元编号相同、段号加一。
//
// 中止的原因要先记下来：pi 的 session.abort() 不带原因。所以 abort(reason) 先把原因写进 signal.reason（状态机里
// 也记一份），再由监听者调用 session.abort()。session.abort() 会等 pi 空闲（waitForIdle）；有东西不听 signal 时，
// 中止本身也会挂住，所以 abortExecution 不无限期地等：过了宽限时间照样返回，并写日志（D10 局限 3）。
import { laneName, type Lane } from "./lanes.js";

export type LeadAbortReason =
  // 用户本人的消息抢占（D4，P3 才用）。
  | { kind: "preempt"; by: string }
  // 就地预算到了，有人在等（红线，D4、H1）。
  | { kind: "budget" }
  // 红线以后的交接窗口用完了。
  | { kind: "handoff_timeout" }
  // 阶段超时（D7，P3 才用）。
  | { kind: "stage_timeout"; stage: "A" | "B2" | "C" }
  // 用户的 /stop。
  | { kind: "user_stop" }
  // 停机前排空到时。
  | { kind: "drain" }
  // 空闲车道的活（L4 单元，例如整理笔记）给更高车道的输入让路（spec D8，P4）。by 是那条输入的车道。
  | { kind: "idle_yield"; by: string };

export type LeadAbortKind = LeadAbortReason["kind"];

/** 日志里的原因：budget、stage_timeout:A、preempt。不写原文。 */
export function abortReasonText(reason: LeadAbortReason): string {
  if (reason.kind === "stage_timeout") return `stage_timeout:${reason.stage}`;
  if (reason.kind === "idle_yield") return `idle_yield:${reason.by}`;
  return reason.kind;
}

/** 车道变了（对应 TaskSignal 的 prioritychange）。 */
export class LaneChangeEvent extends Event {
  constructor(readonly previous: Lane, readonly lane: Lane) {
    super("lanechange");
  }
}

export class LeadTaskController extends AbortController {
  readonly unitId: string;
  readonly segment: number;
  // 首次可见回应的时限（绝对时间，毫秒）。L4 没有时限，是 null。
  readonly deadline: number | null;
  #lane: Lane;

  constructor(init: { unitId: string; segment?: number; lane: Lane; deadline: number | null }) {
    super();
    this.unitId = init.unitId;
    this.segment = init.segment ?? 1;
    this.deadline = init.deadline;
    this.#lane = init.lane;
  }

  get lane(): Lane {
    return this.#lane;
  }

  /** 提级时调用（setPriority）。在 signal 上发 lanechange。 */
  setLane(lane: Lane): void {
    if (lane === this.#lane) return;
    const previous = this.#lane;
    this.#lane = lane;
    this.signal.dispatchEvent(new LaneChangeEvent(previous, lane));
  }

  /** 中止这一段，原因放进 signal.reason。已经中止过的不再中止（第一次的原因留着）。 */
  override abort(reason: LeadAbortReason): void {
    if (this.signal.aborted) return;
    super.abort(reason);
  }

  /** 这一段被中止的原因；没有中止时为 null。 */
  get abortReason(): LeadAbortReason | null {
    return this.signal.aborted ? (this.signal.reason as LeadAbortReason) : null;
  }

  /** 日志里的样子：unit=… seg=… lane=L0。 */
  describe(): string {
    return `unit=${this.unitId} seg=${this.segment} lane=${laneName(this.#lane)}`;
  }
}

export interface AbortExecutionResult {
  // 执行层在宽限时间内停下了（session.abort() 返回了）。
  settled: boolean;
  // 从发出中止到停下（或者到宽限用完）的毫秒数：用来发现中止本身挂住（D12 第 5 条）。
  ms: number;
  error?: string;
}

/**
 * 让执行层停下（调用 stop，通常是 session.abort()），最多等 graceMs。stop 挂住时照样返回 settled=false，
 * 不让调用方跟着挂住。stop 抛错时 settled=true，带上错误。
 */
export async function abortExecution(
  stop: () => unknown, options: { graceMs: number; now?: () => number },
): Promise<AbortExecutionResult> {
  const now = options.now ?? Date.now;
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // stop 同步调用（和以前 daemon 直接调 session.abort() 一样），它返回的 Promise 再和宽限时间赛跑。
  let stopped: Promise<unknown>;
  try {
    stopped = Promise.resolve(stop());
  } catch (error) {
    stopped = Promise.reject(error);
  }
  const outcome = await Promise.race([
    stopped.then(
      () => ({ settled: true as const }),
      (error: unknown) => ({ settled: true as const, error: error instanceof Error ? error.message : String(error) }),
    ),
    new Promise<{ settled: false }>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), options.graceMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  return { ...outcome, ms: now() - started };
}
