// 交接和挂起（lead-scheduler spec H1–H10，P2）。daemon 建一个实例，Lead 的工具（hand-off-tool.ts）、调度器的 extension
// 和 daemon 共用它，和调度器的运行层一样不需要进程间通信（D13）。
//
// 它管四件事：
//   1. 这个单元做过的步骤（UnitWorkLog）：extension 在 tool_execution_start、tool_execution_end 里报来。
//   2. 交接包：hand_off 调用时现拼（prepare），交出去以后记账（handedOff）；被迫交的窗口里没交、被抢占、卡死时挂起（suspend）。
//   3. 挂起的单元（H10）：存成文件，当前局面里列出来；Lead 用 resume_unit 接着做或者丢下，或者 hand_off 交出去。
//      系统不替 Lead 派出子 agent（用户 2026-11-09）。
//   4. 归属（H5）：交出去的单元在子 agent 跑的时候「拥有」它碰过的对象，当前局面里列出来。不加守卫：Lead 在被拥有的对象上
//      做内容上的工作时只记一条日志（校准样本，H9）。
//
// 存在哪：数据目录下的 lead-handoffs/<包编号>/，package.json 是包，step-NN.txt 是长结果的全文，state.json 是状态
// （suspended / handed_off / resumed / dropped）。都用同步写：小文件，而且不经过 I/O 线程池（D12）。
// 日志只写编号、数字和种类，不写原文（D12）。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstLine } from "../overflow.js";
import { schedulerLine, type SchedulerRecordKind } from "./core.js";
import {
  buildHandoffPackage, HANDOFF_RESULT_CHARS, packageStats, renderHandoffBrief, stepFileName, suspendedSummary, UnitWorkLog,
  type HandoffEntry, type HandoffGoal, type HandoffPackage, type TouchedObject,
} from "./handoff-package.js";
import { laneName, LANES, type Lane } from "./lanes.js";
import type { LeadSchedulerRuntime } from "./runtime.js";

export type SuspendReason = "handoff_timeout" | "handoff_skipped" | "preempt" | "stage_timeout";
export type HandoffState = "suspended" | "handed_off" | "resumed" | "dropped";

export interface HandoffRecordState {
  state: HandoffState;
  reason?: SuspendReason;
  ticketId?: number;
  // 被叫醒处理过几次（每个挂起的单元，系统只为它叫醒 Lead 一次；过了车道的时限再提一级叫醒一次）。
  wakes: number;
  // 现在的车道（挂起以后过了时限会提级）。
  lane: Lane;
  at: string;
}

interface StoredHandoff {
  pkg: HandoffPackage;
  state: HandoffRecordState;
}

export interface UnitGoalInput {
  unitId: string;
  turnId: string | null;
  goal: HandoffGoal;
}

export interface LeadHandoffsOptions {
  dataDir: string;
  scheduler: Pick<LeadSchedulerRuntime, "unit" | "state">;
  log: (line: string) => void;
  // events 表（scheduler.*）。
  record?: (kind: SchedulerRecordKind, payload: Record<string, string | number | boolean | null> & { unitId: string }) => void;
  now?: () => number;
  // 停下这一轮会不会把这个调用做到一半（red-line.ts 的 interruptibleWrite）。
  isWrite?: (name: string, args: unknown) => boolean;
  // 这个工具的输出算不算外部内容（turn-origin.ts）。
  isExternalTool?: (name: string) => boolean;
  // 这一轮的来历：带没带外部内容、来自哪些来源。
  turnOrigin?: () => { external: boolean; sources: string[] };
  // 一张工单还在跑（没有 done、cancelled）：归属只在它跑的时候有效。
  ticketOpen?: (ticketId: number) => boolean;
  newId?: () => string;
}

let packageCounter = 0;
function defaultPackageId(): string {
  packageCounter += 1;
  return `hof_${Date.now().toString(36)}${packageCounter.toString(36).padStart(3, "0")}`;
}

const ID_PATTERN = /^hof_[a-z0-9]{4,40}$/u;

/** 交接包编号的样子：hof_ 加小写字母和数字。工具的参数先核对，免得拼进路径。 */
export function validHandoffId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** 交接自己的工具：不进交接包。 */
const SELF_TOOLS: ReadonlySet<string> = new Set(["hand_off", "resume_unit"]);

/** 管管理的工具（H5）：加预算、停下、批准、回答它的问题、读它的状态。它们碰被拥有的对象不算冲突。 */
const MANAGEMENT_TOOLS: ReadonlySet<string> = new Set([
  "ticket_action", "continue_ticket_agent", "steer_child", "get_ticket", "get_ticket_status", "get_ticket_tree", "query_tickets",
  "read_run_events", "get_session_entries", "list_ticket_actions", "add_comment", "spawn_child", "hand_off", "resume_unit",
  "record_decision", "list_needs_user", "list_approvals", "render_ui", "notify_user", "follow_up",
]);

export class LeadHandoffs {
  readonly #options: LeadHandoffsOptions;
  readonly #now: () => number;
  readonly #root: string;
  #work: UnitWorkLog | null = null;
  #goal: UnitGoalInput | null = null;
  // 这个单元交出去了（hand_off 成功了）：被迫交的窗口到时不再挂起。
  #handedOff: { unitId: string; packageId: string; ticketId: number } | null = null;
  // 这个单元挂起过（交接窗口到时）：之后 Lead 的 hand_off 还是做成了，挂起的那一份跟着记成交出去了。
  #suspendedHere: { unitId: string; packageId: string } | null = null;
  #stored = new Map<string, StoredHandoff>();
  // 正在跑的子 agent 拥有的对象（H5）：工单号 → 交接包编号和对象。
  #owned = new Map<number, { packageId: string; objects: TouchedObject[] }>();

  constructor(options: LeadHandoffsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#root = join(options.dataDir, "lead-handoffs");
    this.#load();
  }

  // ── 单元 ──────────────────────────────────────────────────────────────────

  /** 一个单元开始：记下它的目标，步骤从空开始。 */
  beginUnit(input: UnitGoalInput): void {
    this.#goal = input;
    this.#work = new UnitWorkLog(input.unitId);
    this.#handedOff = null;
    this.#suspendedHere = null;
  }

  /** 单元结束。 */
  endUnit(unitId: string): void {
    if (this.#goal?.unitId !== unitId) return;
    this.#goal = null;
    this.#work = null;
    this.#handedOff = null;
    this.#suspendedHere = null;
  }

  /** 这个单元已经交出去了。 */
  handedOffThisUnit(unitId: string): boolean {
    return this.#handedOff?.unitId === unitId;
  }

  /** 这个单元交出去的那一次：交接包和工单号。没交时为 null。 */
  handoffOf(unitId: string): { packageId: string; ticketId: number } | null {
    return this.#handedOff?.unitId === unitId ? { packageId: this.#handedOff.packageId, ticketId: this.#handedOff.ticketId } : null;
  }

  toolStart(call: { id: string; tool: string; args: unknown }): void {
    const work = this.#work;
    // 交接自己的调用不进交接包。
    if (!work || SELF_TOOLS.has(call.tool)) return;
    let write = false;
    try { write = this.#options.isWrite?.(call.tool, call.args) ?? false; } catch { /* 按只读记 */ }
    let external = false;
    try { external = this.#options.isExternalTool?.(call.tool) ?? false; } catch { external = true; }
    work.toolStart({ ...call, write, external, at: this.#now() });
    this.#checkOwned(call.tool, call.args);
  }

  toolEnd(call: { id: string; result: unknown; error: boolean }): void {
    const work = this.#work;
    if (!work) return;
    // pi 中断正在跑的 bash 时，结果写「已中断」（aborted）。只有写操作在意这一点（D5）。
    const text = typeof call.result === "object" && call.result ? JSON.stringify(call.result).slice(0, 4_000) : String(call.result ?? "");
    work.toolEnd({ ...call, at: this.#now(), interrupted: call.error && /aborted|interrupted|已中断/iu.test(text) });
  }

  // ── 交接包 ─────────────────────────────────────────────────────────────────

  /**
   * 给 hand_off 拼一个包。suspendedId：交出去的是一个挂起的单元（包现成）。不然拼这个单元的：
   * 被迫交的窗口里是 forced；这个单元还没有调过别的工具是 lead_initial；否则 lead_midway。
   */
  prepare(input: { note?: string | null; suspendedId?: string; forced: boolean }): { pkg: HandoffPackage; files: Map<number, string> } {
    if (input.suspendedId) {
      const stored = this.#stored.get(input.suspendedId);
      if (!stored || stored.state.state !== "suspended") throw new Error(`没有挂起的单元 ${input.suspendedId}。当前局面里列着现在挂起的单元。`);
      const note = input.note?.trim() ? input.note.trim() : stored.pkg.note;
      return { pkg: { ...stored.pkg, note: note ?? null }, files: this.#storedFiles(stored.pkg) };
    }
    const goal = this.#goal;
    const unit = this.#options.scheduler.unit;
    if (!goal || !unit || unit.id !== goal.unitId) throw new Error("现在没有在做的单元，没有东西可交。要交挂起的单元，给 suspended。");
    // 交接自己的调用不算：还没有调过别的工具时，是第一步就交。
    const calls = this.#work?.calls ?? 0;
    const entry: HandoffEntry = input.forced ? "forced" : calls <= 0 ? "lead_initial" : "lead_midway";
    return this.#build(entry, input.note ?? null);
  }

  #build(entry: HandoffEntry, note: string | null): { pkg: HandoffPackage; files: Map<number, string> } {
    const goal = this.#goal!;
    const unit = this.#options.scheduler.unit;
    const now = this.#now();
    const origin = this.#origin();
    const started = unit?.budgetStartedAt ?? unit?.openedAt ?? now;
    return buildHandoffPackage({
      id: (this.#options.newId ?? defaultPackageId)(), unitId: goal.unitId, turnId: unit?.turnId ?? goal.turnId,
      entry, goal: { ...goal.goal, lane: unit?.lane ?? goal.goal.lane },
      external: origin.external, externalSources: origin.sources, work: this.#work, note,
      elapsedMs: now - started, modelSteps: unit?.steps ?? 0, now,
    });
  }

  #origin(): { external: boolean; sources: string[] } {
    try {
      return this.#options.turnOrigin?.() ?? { external: false, sources: [] };
    } catch {
      return { external: true, sources: ["unknown"] };
    }
  }

  /** 给子 agent 的说明，以及要放进它目录里的全文文件（相对路径 → 内容）。 */
  brief(pkg: HandoffPackage, files: Map<number, string>): { brief: string; files: Array<{ path: string; text: string }> } {
    const out = [...files.entries()].map(([index, text]) => ({ path: stepFileName(index), text }));
    const named = new Set(files.keys());
    return { brief: renderHandoffBrief(pkg, (index) => (named.has(index) ? stepFileName(index) : null)), files: out };
  }

  /** hand_off 成功：记账、写日志、归属。ms 是 hand_off 用了多久。 */
  handedOff(pkg: HandoffPackage, files: Map<number, string>, result: { ticketId: number; ms: number }): void {
    const unit = this.#options.scheduler.unit;
    const stored = this.#stored.get(pkg.id);
    const state: HandoffRecordState = {
      state: "handed_off", ticketId: result.ticketId, wakes: stored?.state.wakes ?? 0, lane: pkg.goal.lane, at: new Date(this.#now()).toISOString(),
      ...(stored?.state.reason ? { reason: stored.state.reason } : {}),
    };
    this.#save(pkg, files, state);
    if (unit && unit.id === pkg.unitId && !stored) this.#handedOff = { unitId: unit.id, packageId: pkg.id, ticketId: result.ticketId };
    // 交接窗口到时这个单元已经挂起了，hand_off 却在中止以前做成了：挂起的那一份也算交出去了，不再列成挂起。
    const raced = this.#suspendedHere && this.#suspendedHere.unitId === pkg.unitId && this.#suspendedHere.packageId !== pkg.id
      ? this.#stored.get(this.#suspendedHere.packageId) : undefined;
    if (raced && raced.state.state === "suspended") {
      const settled: HandoffRecordState = { ...raced.state, state: "handed_off", ticketId: result.ticketId, at: new Date(this.#now()).toISOString() };
      this.#writeState(raced.pkg.id, settled);
      raced.state = settled;
      this.#options.log(schedulerLine("suspend.settled", { pkg: raced.pkg.id, by: pkg.id, ticket: result.ticketId }));
    }
    this.#owned.set(result.ticketId, { packageId: pkg.id, objects: pkg.touched });
    const stats = packageStats(pkg);
    // 当前单元（hand_off 是在它里面调的）和被交出去的单元（挂起的单元可能是别的）都记。
    const where = unit ? { unit: unit.id, turn: unit.turnId ?? "-" } : { unit: "-" };
    this.#options.log(schedulerLine("handoff", {
      ...where, pkg: pkg.id, of: pkg.unitId, entry: pkg.entry, ticket: result.ticketId, ms: result.ms,
      lane: laneName(pkg.goal.lane), elapsedMs: pkg.elapsedMs, modelSteps: pkg.modelSteps, ...stats,
    }));
    this.#record("handed_off", {
      unitId: pkg.unitId, turnId: pkg.turnId, packageId: pkg.id, entry: pkg.entry, ticketId: result.ticketId, ms: result.ms,
      lane: laneName(pkg.goal.lane), elapsedMs: pkg.elapsedMs, steps: stats.steps as number, committed: stats.committed as number,
      unknown: stats.unknown as number, note: pkg.note !== null, fromSuspended: Boolean(stored),
      ...(unit && unit.id !== pkg.unitId ? { byUnit: unit.id } : {}),
    });
  }

  // ── 挂起和恢复（H10）──────────────────────────────────────────────────────────

  /** 把现在的单元挂起：交接包存下来，不需要模型调用。这个单元已经交出去了时不挂起，返回 null。 */
  suspend(reason: SuspendReason): HandoffPackage | null {
    const goal = this.#goal;
    const unit = this.#options.scheduler.unit;
    if (!goal || !unit || unit.id !== goal.unitId || this.handedOffThisUnit(unit.id)) return null;
    const started = this.#now();
    const { pkg, files } = this.#build("suspended", null);
    const state: HandoffRecordState = { state: "suspended", reason, wakes: 0, lane: pkg.goal.lane, at: new Date(this.#now()).toISOString() };
    this.#save(pkg, files, state);
    this.#suspendedHere = { unitId: unit.id, packageId: pkg.id };
    const stats = packageStats(pkg);
    this.#options.log(schedulerLine("suspend", {
      unit: unit.id, turn: unit.turnId ?? "-", lane: laneName(unit.lane), reason, pkg: pkg.id, ms: this.#now() - started,
      elapsedMs: pkg.elapsedMs, modelSteps: pkg.modelSteps, ...stats,
    }));
    this.#record("suspended", {
      unitId: unit.id, turnId: unit.turnId, packageId: pkg.id, reason, lane: laneName(unit.lane), elapsedMs: pkg.elapsedMs,
      steps: stats.steps as number, committed: stats.committed as number, unknown: stats.unknown as number,
    });
    return pkg;
  }

  /** Lead 处理一个挂起的单元：接着做（resume），或者丢下（drop）。返回给 Lead 的说明。 */
  resolve(id: string, action: "resume" | "drop", reason: string | null): { pkg: HandoffPackage; text: string } {
    if (!validHandoffId(id)) throw new Error(`${id} 不是交接包的编号（hof_ 开头）。`);
    const stored = this.#stored.get(id);
    if (!stored) throw new Error(`没有交接包 ${id}。`);
    if (stored.state.state !== "suspended") throw new Error(`${id} 不是挂起的单元，它现在是 ${stored.state.state}。`);
    const unit = this.#options.scheduler.unit;
    const state: HandoffRecordState = { ...stored.state, state: action === "resume" ? "resumed" : "dropped", at: new Date(this.#now()).toISOString() };
    this.#writeState(id, state);
    stored.state = state;
    this.#options.log(schedulerLine("resume", {
      unit: unit?.id ?? "-", turn: unit?.turnId ?? "-", pkg: id, of: stored.pkg.unitId, decision: action,
      lane: laneName(stored.pkg.goal.lane), waitedMs: this.#now() - Date.parse(stored.pkg.createdAt), reason: reason ? "given" : "-",
    }));
    this.#record("resumed", {
      unitId: stored.pkg.unitId, turnId: stored.pkg.turnId, packageId: id, decision: action, byUnit: unit?.id ?? null,
      waitedMs: this.#now() - Date.parse(stored.pkg.createdAt),
    });
    if (action === "drop") return { pkg: stored.pkg, text: `丢下了挂起的单元 ${id}。` };
    const { brief } = this.brief(stored.pkg, this.#storedFiles(stored.pkg));
    return {
      pkg: stored.pkg,
      text: [
        `接着做挂起的单元 ${id}。就地预算从现在重新算（2 分 30 秒）；剩下超过 2–3 步时，改用 hand_off(suspended="${id}") 交出去。`,
        "下面是它的交接包。已经提交的写操作不要再做；状态未知的写操作先查再做。",
        "",
        brief,
      ].join("\n"),
    };
  }

  /** 挂起、还没被处理的单元，按挂起的先后。 */
  suspended(): HandoffPackage[] {
    return [...this.#stored.values()].filter((stored) => stored.state.state === "suspended")
      .sort((left, right) => Date.parse(left.pkg.createdAt) - Date.parse(right.pkg.createdAt)).map((stored) => stored.pkg);
  }

  /** 挂起的单元现在的状态（车道、为什么挂起、叫醒过几次）。 */
  suspendedState(id: string): HandoffRecordState | null {
    const stored = this.#stored.get(id);
    return stored?.state.state === "suspended" ? stored.state : null;
  }

  /**
   * 要不要为挂起的单元叫醒 Lead（H10）：没叫醒过的叫一次；叫过的过了它车道的时限还没被处理，提一级再叫一次（D1 防饿死）。
   * 返回要叫醒的那一个和它的车道；没有时为 null。调用方真的叫醒以后调 noteWake。
   */
  nextWake(): { pkg: HandoffPackage; lane: Lane; raised: boolean } | null {
    const now = this.#now();
    for (const stored of [...this.#stored.values()].filter((entry) => entry.state.state === "suspended")) {
      if (stored.state.wakes === 0) return { pkg: stored.pkg, lane: stored.state.lane, raised: false };
      const deadline = LANES[stored.state.lane].firstResponseMs;
      if (stored.state.lane > 0 && deadline !== null && stored.state.wakes === 1 && now - Date.parse(stored.state.at) > deadline) {
        return { pkg: stored.pkg, lane: (stored.state.lane - 1) as Lane, raised: true };
      }
    }
    return null;
  }

  noteWake(id: string, lane: Lane): void {
    const stored = this.#stored.get(id);
    if (!stored || stored.state.state !== "suspended") return;
    const raised = lane !== stored.state.lane;
    const state: HandoffRecordState = { ...stored.state, wakes: stored.state.wakes + 1, lane, at: new Date(this.#now()).toISOString() };
    this.#writeState(id, state);
    stored.state = state;
    this.#options.log(schedulerLine("suspended.wake", { pkg: id, of: stored.pkg.unitId, lane: laneName(lane), raised, wakes: state.wakes }));
  }

  // ── 当前局面和预算状态 ────────────────────────────────────────────────────────────

  /** 当前局面里的几行（H5、H10）：挂起的单元、子 agent 正在处理的对象。没有时为 null。 */
  situationText(): string | null {
    const now = this.#now();
    const lines: string[] = [];
    const suspended = this.suspended();
    if (suspended.length) {
      lines.push("挂起的单元（被打断的工作，交接包已经存好）：");
      for (const pkg of suspended) lines.push(`- ${suspendedSummary(pkg, now, firstLine)}`);
      lines.push("剩下不超过 2–3 步：resume_unit(id, action=\"resume\") 接着做；更多：hand_off(suspended=id) 交给子 agent；"
        + "已经不需要了：resume_unit(id, action=\"drop\")。由你决定，系统不替你派出。");
    }
    const owned = this.#ownedNow();
    if (owned.length) {
      lines.push("子 agent 正在处理的对象（内容上的新要求用 continue_ticket_agent 转给它，不要自己做；加预算、停下、批准这类管理操作你照常做）：");
      for (const [ticketId, entry] of owned) {
        const objects = entry.objects.filter((object) => object.kind !== "path").slice(0, 6).map((object) => object.ref);
        lines.push(`- #${ticketId}（交接包 ${entry.packageId}）${objects.length ? `：${objects.join("、")}` : ""}`);
      }
    }
    return lines.length ? lines.join("\n") : null;
  }

  #ownedNow(): Array<[number, { packageId: string; objects: TouchedObject[] }]> {
    const out: Array<[number, { packageId: string; objects: TouchedObject[] }]> = [];
    for (const [ticketId, entry] of this.#owned) {
      let open = true;
      try { open = this.#options.ticketOpen?.(ticketId) ?? true; } catch { /* 读不到时按还在跑算 */ }
      if (open) out.push([ticketId, entry]);
      else this.#owned.delete(ticketId);
    }
    return out;
  }

  // H5：Lead 在被拥有的对象上做内容上的工作：只记一条日志（校准样本，H9），不拦。
  #checkOwned(tool: string, args: unknown): void {
    if (MANAGEMENT_TOOLS.has(tool) || !this.#owned.size) return;
    const touched = new Set(
      (args && typeof args === "object" ? Object.entries(args as Record<string, unknown>) : [])
        .flatMap(([, value]) => (typeof value === "number" ? [`#${value}`] : typeof value === "string" ? [value] : [])),
    );
    for (const [ticketId, entry] of this.#ownedNow()) {
      const hit = entry.objects.find((object) => object.kind !== "path" && touched.has(object.ref));
      if (!hit && !touched.has(`#${ticketId}`)) continue;
      const unit = this.#options.scheduler.unit;
      this.#options.log(schedulerLine("owned.touch", {
        unit: unit?.id ?? "-", turn: unit?.turnId ?? "-", tool, ticket: ticketId, pkg: entry.packageId, object: hit?.kind ?? "ticket",
      }));
      return;
    }
  }

  /** 挂起的单元（GET /v1/lead/scheduler）。 */
  snapshot(): Array<{ id: string; unitId: string; lane: string; reason: string; sinceMs: number }> {
    const now = this.#now();
    return [...this.#stored.values()].filter((stored) => stored.state.state === "suspended").map((stored) => ({
      id: stored.pkg.id, unitId: stored.pkg.unitId, lane: laneName(stored.state.lane), reason: stored.state.reason ?? "-",
      sinceMs: now - Date.parse(stored.pkg.createdAt),
    }));
  }

  // ── 存储 ───────────────────────────────────────────────────────────────────

  #dir(id: string): string {
    return join(this.#root, id);
  }

  #save(pkg: HandoffPackage, files: Map<number, string>, state: HandoffRecordState): void {
    const dir = this.#dir(pkg.id);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2), { mode: 0o600 });
      for (const [index, text] of files) writeFileSync(join(dir, `step-${String(index).padStart(2, "0")}.txt`), text, { mode: 0o600 });
      writeFileSync(join(dir, "state.json"), JSON.stringify(state), { mode: 0o600 });
    } catch (error) {
      this.#options.log(schedulerLine("handoff.store_failed", { pkg: pkg.id, error: error instanceof Error ? error.message : String(error) }));
    }
    this.#stored.set(pkg.id, { pkg, state });
  }

  #writeState(id: string, state: HandoffRecordState): void {
    try {
      writeFileSync(join(this.#dir(id), "state.json"), JSON.stringify(state), { mode: 0o600 });
    } catch (error) {
      this.#options.log(schedulerLine("handoff.store_failed", { pkg: id, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  #storedFiles(pkg: HandoffPackage): Map<number, string> {
    const files = new Map<number, string>();
    for (const step of pkg.steps) {
      if (step.fullChars <= HANDOFF_RESULT_CHARS) continue;
      try {
        files.set(step.index, readFileSync(join(this.#dir(pkg.id), `step-${String(step.index).padStart(2, "0")}.txt`), "utf8"));
      } catch { /* 文件没了：包里还有截断的结果 */ }
    }
    return files;
  }

  // 重启以后接着管挂起的单元和归属：读回 lead-handoffs/ 下的包。读不了的跳过。
  #load(): void {
    if (!existsSync(this.#root)) return;
    for (const id of readdirSync(this.#root)) {
      if (!validHandoffId(id)) continue;
      try {
        const pkg = JSON.parse(readFileSync(join(this.#dir(id), "package.json"), "utf8")) as HandoffPackage;
        const state = JSON.parse(readFileSync(join(this.#dir(id), "state.json"), "utf8")) as HandoffRecordState;
        this.#stored.set(id, { pkg, state });
        if (state.state === "handed_off" && typeof state.ticketId === "number") this.#owned.set(state.ticketId, { packageId: id, objects: pkg.touched });
      } catch { /* 坏了的包跳过 */ }
    }
  }

  #record(kind: SchedulerRecordKind, payload: Record<string, string | number | boolean | null> & { unitId: string }): void {
    try {
      this.#options.record?.(kind, payload);
    } catch (error) {
      this.#options.log(schedulerLine("record.failed", { kind, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}
