// child runtime 可靠性的验收回放（.scratch/runtime-reliability）。
// 脚本把真实库里失败过的 Run 按工单分组。
// 每个 Run 依次经过 orchestrator、dispatcher 和 runItem 回放。
// 脚本记录当前代码对每一次失败的处理。
// 它刻意不用 vitest，因为它要走真实的派发与生命周期代码。断言失败时，脚本抛错退出。
// EXPECTED 是当前行为的基线。后续工单每修好一类失败，就改写对应的行。
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runItem } from "@pi-lead-child/engine";
import { createOrchestrator } from "@pi-lead-child/engine";
import { buildOutcomeRepairPrompt } from "@pi-lead-child/engine";
import { createRuntimePreflight } from "@pi-lead-child/engine";
import { CHILD_RUNTIME_ORDER } from "@pi-lead-child/engine";
import { createDefaultRuntimeRegistry } from "@pi-lead-child/runtime";
import { typedFailure, type FailureCode } from "@pi-lead-child/runtime";
import type { AgentRuntime } from "@pi-lead-child/runtime";
import { TRANSIENT_RETRY_TRIGGER } from "@pi-lead-child/engine";
import { openDb } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { OUTCOME_SENTINEL } from "@pi-lead-child/store";
import { executorRetryBudget } from "@pi-lead-child/store";
import { getRun } from "@pi-lead-child/store";
import type { ItemStage, RunPurpose, RuntimeId } from "@pi-lead-child/core";
import { readGatewayNotifications } from "@pi-lead-child/gateway/testing";
import { ReplayRuntime, RUNTIME_FAILURES_FIXTURE, type RecordedRun } from "@pi-lead-child/runtime/testing";

interface FixtureRun extends RecordedRun {
  historicalRunId: number;
  historicalItemId: number;
  attemptInItem: number;
  itemTitle: string;
  role: "executor" | "reviewer";
  purpose: RunPurpose;
  model: string | null;
}

interface ReplayOutcome {
  created: boolean;
  state: string;
  request: string;
  scope: string;
  code: string;
  leadDecides: boolean | null;
  retryBudgetCharged: number;
  // 用户收到的通知条数，从 gateway 的 HTTP 接口读（工单 03）。
  notifications: number;
  // 健康账本（工单 03）。"opened"：这次失败开启了一次故障。
  // "suspended by N"：历史 run N 开启的故障挂起了这个请求，没有创建 Run。
  health: string;
  stage: ItemStage;
  followUps: string[];
  // 成果修复回合（工单 09）。"repaired"：修复回合补交了成果。"failed:原因"：修复失败。"-"：没有修复回合。
  repair: string;
  // 瞬时失败的自动重试（工单 06）。"resumed"：内核退避后 resume 了原来的外部 session，并且做完了。"-"：没有重试。
  retry: string;
  note: string;
}

const dir = mkdtempSync(join(tmpdir(), "plc-accept-runtime-"));
// sessionDir() 等路径读 PLC_DATA_DIR。回放绝不能写进用户真实的数据目录。
process.env.PLC_DATA_DIR = dir;
const fixture = JSON.parse(
  readFileSync(RUNTIME_FAILURES_FIXTURE, "utf8"),
) as { runs: FixtureRun[] };

const replayKey = (recording: FixtureRun): string => `replay:${recording.historicalRunId}`;
const REPLAY_TRIGGER = "acceptance-replay";

// 修复回合（工单 09）的录制是构造的：它代表一次成功的修复。
// agent resume 原来的 session，只把它最后一条消息里的成果信封再交一次。
// 历史上 runs 53、54 的最后一条消息里都有完整的成果信封，只是没能调用 ticket_update。
function repairRecording(source: FixtureRun): FixtureRun {
  const text = source.events.flatMap((event) => event.type === "message.completed" ? [event.text] : []).at(-1) ?? "";
  const line = text.split(/\r?\n/).find((candidate) => candidate.includes(OUTCOME_SENTINEL));
  if (!line) throw new Error(`run ${source.historicalRunId} has no outcome envelope to resubmit`);
  const session = source.events.flatMap((event) => event.type === "session.updated" ? [event.externalSessionId] : []).at(-1);
  return {
    ...source,
    purpose: "outcome_repair",
    events: [
      { type: "run.started", runtime: source.runtime, model: source.model },
      ...(session ? [{ type: "session.updated" as const, externalSessionId: session }] : []),
      {
        type: "message.completed", messageId: `repair-${source.historicalRunId}`, role: "assistant",
        stopReason: "end_turn", text: line.slice(line.indexOf(OUTCOME_SENTINEL)),
      },
      { type: "run.completed", exitCode: 0 },
    ],
  };
}

// ── preflight 当时会看到什么（工单 05）──────────────────────────────────────────
// 回放用真实的 preflight：tick 先跑安装检查，claim 读结果。只有安装检查的输入换成历史上的环境：
// 每个历史 Run 开始时，preflight 的安装检查会看到什么。证据取自录制，不是推测：
//   - 14：录制的 stderr 是 "Extension path does not exist: …/item-tools.ts"。扩展检查只看文件在不在。
//   - 52：录制的 stderr 是 zstd 的崩溃。child 当时用的 Node 是 22.14（spec Further Notes），
//     pi-coding-agent 1.1.0 要求 22.19 或更高。
// 15、23、59 是同样的问题，39 的版本命令起不来（spawn codex ENOENT）。更早的故障已经挂起了这些请求，
// 它们走不到 preflight，所以这里不列它们。
// 其他 Run 的安装检查都通过。认证、余额、满载这类故障，preflight 不检查，所以也不在这里。
const HISTORICAL_INSTALL_FAILURES: Partial<Record<number, { check: string; code: FailureCode; message: string }>> = {
  14: {
    check: "pi extensions", code: "extension_missing",
    message: "Pi extension path does not exist: /Users/<user>/Workspace/AI/pi-lead-child/src/extension/item-tools.ts",
  },
  52: {
    check: "node --version", code: "interpreter_mismatch",
    message: "node --version：node 是 v22.14.0，不满足要求 >=22.19.0",
  },
};

// 一个只做安装检查的 adapter。它不启动 child：执行由 ReplayRuntime 回放录制。
// 它没有声明 profile，所以 preflight、派发 gate 和 runItem 用的都是同名 runtime 的默认 profile。
function replayInstallAdapter(id: RuntimeId, current: () => FixtureRun | null): AgentRuntime {
  return {
    id,
    capabilities: createDefaultRuntimeRegistry().get(id).capabilities,
    start: () => Promise.reject(new Error("the replay install adapter never starts a child")),
    preflight: async () => {
      const recording = current();
      const failure = recording?.runtime === id ? HISTORICAL_INSTALL_FAILURES[recording.historicalRunId] : undefined;
      return failure
        ? {
            ok: false, checks: [failure.check],
            failure: typedFailure(failure.code, { errorCode: "probe_failed", message: failure.message }),
          }
        : { ok: true, checks: [] };
    },
  };
}

// 瞬时失败之后内核自动重试（工单 06）。这份录制也是构造的：它代表网络或模型恢复以后的那一轮。
// agent resume 原来的 session，接着做完，调用 ticket_update，并留下成果信封。
// 历史上 runs 44、55、64 断在半路，没有成果，所以信封只有一句摘要。
function resumedRecording(source: FixtureRun): FixtureRun {
  const session = historicalSession(source);
  if (!session) throw new Error(`run ${source.historicalRunId} has no external session to resume`);
  return {
    ...source,
    events: [
      { type: "run.started", runtime: source.runtime, model: source.model },
      { type: "session.updated", externalSessionId: session },
      { type: "tool.started", callId: `resume-${source.historicalRunId}`, name: "ticket_update", args: { status: "review" } },
      { type: "tool.completed", callId: `resume-${source.historicalRunId}`, name: "ticket_update", result: {} },
      {
        type: "message.completed", messageId: `resume-${source.historicalRunId}`, role: "assistant",
        stopReason: "end_turn",
        text: `${OUTCOME_SENTINEL} ${JSON.stringify({
          summary: "Resumed the session after the transient failure and finished the work.",
          changes: [], deliverables: [], validations: [],
        })}`,
      },
      { type: "run.completed", exitCode: 0 },
    ],
  };
}

// 录制里这个历史 Run 的外部 session。它是独立的事实来源：回放用它检查重试 resume 的是不是原 session。
function historicalSession(recording: FixtureRun): string | undefined {
  return recording.events.flatMap((event) => event.type === "session.updated" ? [event.externalSessionId] : []).at(-1);
}

// ── 哪些工单在同一个库里回放 ────────────────────────────────────────────────────
// 工单 01 让每个历史工单在自己的库里回放。dispatcher 的队列是全局的。
// 共用一个库时，下一个工单的派发会先 claim 走上一个工单留下的后续请求。
//
// 工单 03 要证明同一次故障跨工单只撞一次，所以健康账本必须看到跨工单的同一次故障。
// 因此，历史上撞了同一次故障的工单共用一个库，按历史 run 的先后回放。run id 就是时间顺序。
// 分组只按证据定：同一个 runtime，同一个失败码，时间上相连，中间没有一次成功。
//
// 整段历史不能放进一个库。历史上故障修好的时间没有记录，本工单也还没有恢复机制（工单 04）。
// 一次故障开启后，它会一直挂起之后同一个 profile 上的派发。
// 但历史上 run 53、54 开始时，Claude 能正常运行。
//
// 账本按 profile 的身份挂起请求，不看失败码。
// 所以 run 39 也挂起：它和 run 34 在同一个 Codex profile 上，虽然它的历史失败是找不到可执行文件。
const SHARED_INCIDENTS: ReadonlyArray<readonly number[]> = [
  [38, 40, 44, 45], // 7-29 到 8-12：Codex 不支持 gpt-5.6-sol（run 12、13、16）；pi 扩展文件缺失（run 14、15、23）
  [49, 51], // 8-14：Codex 账号余额用完（run 34、35、36）
  [66, 77], // 8-21 到 10-08：Claude OAuth 过期（run 46、47、63）
  [72, 76], // 8-25 到 9-04：pi 跑在过旧的 Node 上（run 52、59）
];

// 同一个库里的工单按历史顺序依次回放。
//
// 回放时停用这组历史 Run 没用过的 runtime（2026-10-21）。2026-10-20 起，核查员的 runtime 不能用时，认领时自动换成
// 一个能用的（engine 的 reviewer-choice.ts，回归测试在 reviewer-fallback.test.ts）。回放里另外两个 runtime 的假 adapter
// 都是好的，所以 run 34（Codex 核查员，余额用完）的重试会换成 Claude Code 派出去，而回放没有它的录制。当时只有 Codex
// 能当核查员，所以这里停用其余 runtime，重现当时的情形：同一次故障里之后的请求挂起，不创建 Run（工单 03）。
async function replayGroup(historicalItemIds: number[], runs: FixtureRun[]): Promise<Map<number, ReplayOutcome>> {
  const used = new Set(runs.map((run) => run.runtime));
  const disabledBefore = process.env.PLC_DISABLED_RUNTIMES;
  process.env.PLC_DISABLED_RUNTIMES = CHILD_RUNTIME_ORDER.filter((runtime) => !used.has(runtime)).join(",");
  try {
    return await replayGroupWith(historicalItemIds, runs);
  } finally {
    if (disabledBefore === undefined) delete process.env.PLC_DISABLED_RUNTIMES;
    else process.env.PLC_DISABLED_RUNTIMES = disabledBefore;
  }
}

async function replayGroupWith(historicalItemIds: number[], runs: FixtureRun[]): Promise<Map<number, ReplayOutcome>> {
  const groupDir = join(dir, `items-${historicalItemIds.join("-")}`);
  const dbPath = join(groupDir, "plc.db");
  mkdirSync(groupDir, { recursive: true });
  const db = openDb(dbPath);
  const openRequests = (): Array<{ item_id: number; trigger: string; state: string; suspended: number }> => db.prepare(
    `SELECT item_id, trigger, state, suspended_incident_id IS NOT NULL AS suspended FROM dispatch_requests
     WHERE state IN ('pending','claimed','started') ORDER BY id`,
  ).all() as Array<{ item_id: number; trigger: string; state: string; suspended: number }>;

  // 每次派发恰好消费一份录制。生产代码不等待 runItem 结束，它的异常交给 onChildDone。
  // 回放保持同样的语义：runItem 的异常不进入 tick 的派发失败分支。
  let pendingRecording: FixtureRun | null = null;
  const childErrors = new Map<number, string>();
  const unexpectedClaims: string[] = [];
  const replayedRuns = new Map<number, number>();
  // 修复回合 resume 的外部 session，按修复回合的 run id 记下。
  const repairSessions = new Map<number, string | null>();
  const adapters = new Map(CHILD_RUNTIME_ORDER.map((id) => [id, replayInstallAdapter(id, () => pendingRecording)]));
  const preflight = createRuntimePreflight(db, { runtime: (id) => adapters.get(id)! });
  // 内核的退避重试（工单 06）：重试的 run id → 它 resume 的来源 Run 和外部 session。
  const transientRetries = new Map<number, { sourceRunId: number | null; session: string | null }>();
  // 回放的时钟。平时是真实时间。退避重试那一轮拨到请求的不早于时间，结算之后拨回来。
  // 所以每一次失败的退避都从真实时间算起，不会因为上一次拨过时钟就立刻到期。
  let clock: Date | null = null;
  const now = (): Date => clock ?? new Date();
  const dispatching = createOrchestrator(db, {
    dataDir: groupDir,
    maxDispatchPerTick: 1,
    preflight,
    now,
    onDispatch: async (claim) => {
      // 内核为瞬时失败排的退避重试（工单 06）。它回放构造的恢复录制，不消耗历史录制。
      // resume 哪个 session，和 daemon 的 spawnClaimedItem 一样从派发请求的来源 Run 读。
      if (claim.trigger === TRANSIENT_RETRY_TRIGGER) {
        const source = claim.resumeFromRunId === null ? undefined : getRun(db, claim.resumeFromRunId);
        const sourceRecording = runs.find((run) => run.historicalRunId === (source && replayedRuns.get(source.id)));
        if (!source || !sourceRecording) {
          unexpectedClaims.push(`transient retry run #${claim.runId} from request #${claim.requestId} has no source recording`);
          throw new Error(`no source recording for transient retry run #${claim.runId}`);
        }
        transientRetries.set(claim.runId, { sourceRunId: source.id, session: source.external_session_id });
        await runItem(db, claim.itemId, {
          dbPath, dataDir: groupDir,
          sessionDir: join(groupDir, "sessions", `item-${claim.itemId}`),
          prompt: "historical failure replay: continue after the transient failure",
          role: claim.role, purpose: claim.purpose, runId: claim.runId,
          runtime: new ReplayRuntime(resumedRecording(sourceRecording)),
          runtimeId: claim.runtime,
          model: claim.model ?? undefined,
          resumeSessionId: source.external_session_id ?? undefined,
          lingerMs: 0,
        }).catch((error: unknown) => { childErrors.set(claim.runId, String(error)); });
        return;
      }
      // 内核为交接失败排的修复回合（工单 09）。它回放构造的成功录制，不消耗历史录制。
      if (claim.purpose === "outcome_repair") {
        const source = claim.resumeFromRunId === null ? undefined : getRun(db, claim.resumeFromRunId);
        const historical = source ? replayedRuns.get(source.id) : undefined;
        const sourceRecording = runs.find((run) => run.historicalRunId === historical);
        if (!source || !sourceRecording) {
          unexpectedClaims.push(`repair run #${claim.runId} from request #${claim.requestId} has no source recording`);
          throw new Error(`no source recording for repair run #${claim.runId}`);
        }
        repairSessions.set(claim.runId, source.external_session_id);
        await runItem(db, claim.itemId, {
          dbPath, dataDir: groupDir,
          sessionDir: join(groupDir, "sessions", `item-${claim.itemId}`),
          prompt: buildOutcomeRepairPrompt({
            item: getItem(db, claim.itemId)!, sourceRunId: source.id, diagnosis: claim.instruction,
          }),
          role: claim.role, purpose: claim.purpose, runId: claim.runId,
          runtime: new ReplayRuntime(repairRecording(sourceRecording)),
          runtimeId: claim.runtime,
          model: claim.model ?? undefined,
          resumeSessionId: source.external_session_id ?? undefined,
          lingerMs: 0,
        }).catch((error: unknown) => { childErrors.set(claim.runId, String(error)); });
        return;
      }
      const recording = pendingRecording;
      pendingRecording = null;
      if (!recording) {
        unexpectedClaims.push(`run #${claim.runId} from request #${claim.requestId} (${claim.trigger})`);
        throw new Error(`no recording for claim of run #${claim.runId}`);
      }
      replayedRuns.set(claim.runId, recording.historicalRunId);
      await runItem(db, claim.itemId, {
        dbPath, dataDir: groupDir,
        sessionDir: join(groupDir, "sessions", `item-${claim.itemId}`),
        prompt: "historical failure replay",
        role: claim.role, purpose: claim.purpose, runId: claim.runId,
        runtime: new ReplayRuntime(recording),
        runtimeId: claim.runtime,
        model: claim.model ?? undefined,
        lingerMs: 0,
      }).catch((error: unknown) => { childErrors.set(claim.runId, String(error)); });
    },
  });
  // 结算用的 orchestrator 不派发。系统自动生成的后续请求（例如 reviewer 重试）
  // 因此留在队列里，可以被观察到，而不会拿错录制去跑。
  const settling = createOrchestrator(db, {
    dataDir: groupDir,
    maxDispatchPerTick: 0,
    now,
    onDispatch: () => { throw new Error("the settling orchestrator never dispatches"); },
  });

  // 每次回放后，用派发的 orchestrator 再空跑一轮：派发 gate 给新请求写上挂起原因。
  // 这一轮没有录制，所以任何 claim 都是错误：说明有一条请求本该挂起却被放行了。
  let notificationsSeen = 0;
  async function replay(itemId: number, recording: FixtureRun): Promise<ReplayOutcome> {
    const leftover = openRequests().filter((open) => open.state !== "pending" || !open.suspended);
    if (leftover.length) {
      throw new Error(`items ${historicalItemIds.join(",")} still have claimable requests before run `
        + `${recording.historicalRunId}: ${JSON.stringify(leftover)}`);
    }
    // 每个历史 Run 有自己当时的环境，所以不沿用上一个 Run 的检查结果。
    for (const runtime of CHILD_RUNTIME_ORDER) preflight.forget(runtime);
    const budgetBefore = executorRetryBudget(db, itemId).failures;
    let note = "";
    // 工单 09：53 的修复回合补交了成果，工单进入 review。历史上用户随后让它又跑了一次（54）。
    // 回放用用户返工（review → active）重现这一步，否则 54 的执行请求派不出去。
    // 工单 06：44 的退避重试做完以后，工单 66 也进入 review。历史上之后又跑了 46，所以 46 之前同样先返工。
    if (recording.role === "executor" && recording.purpose === "execution" && getItem(db, itemId)!.stage === "review") {
      transition(db, { itemId, to: "active", actor: "user", reason: "replay: the user asked for another run" });
    }
    pendingRecording = recording;
    try {
      dispatching.dispatcher.request({
        itemId, role: recording.role, purpose: recording.purpose,
        runtime: recording.runtime, model: recording.model ?? undefined,
        trigger: REPLAY_TRIGGER, idempotencyKey: replayKey(recording),
      });
    } catch (error) {
      note = `request rejected: ${String(error).slice(0, 80)}`;
    }
    if (!note) {
      await dispatching.tick();
      await settling.tick();
    }
    pendingRecording = null;
    // 工单 06：瞬时失败之后，内核排了一个退避重试。不早于时间之前，派发不选它。
    const backoff = db.prepare(
      `SELECT id, not_before FROM dispatch_requests
       WHERE item_id=? AND trigger=? AND state='pending' ORDER BY id DESC LIMIT 1`,
    ).get(itemId, TRANSIENT_RETRY_TRIGGER) as { id: number; not_before: string } | undefined;
    if (backoff) {
      await dispatching.tick();
      const waiting = db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(backoff.id) as { state: string };
      if (waiting.state !== "pending" || Date.parse(backoff.not_before) <= Date.now()) {
        throw new Error(`transient retry request #${backoff.id} was not held until its not-before time`);
      }
      // 拨到不早于时间：重试派出去，resume 原来的 session。
      clock = new Date(Date.parse(backoff.not_before));
      await dispatching.tick();
      await settling.tick();
      clock = null;
    }
    // 这一轮没有历史录制。它只会派出内核排的修复回合（工单 09）。
    await dispatching.tick();
    // 结算修复回合的派发请求，让下一次回放开始时队列是干净的。
    await settling.tick();
    if (unexpectedClaims.length) throw new Error(`unexpected claims: ${unexpectedClaims.join("; ")}`);

    // 这次回放派出的 Run。修复回合另算，见 repair 一列。
    const runId = [...replayedRuns].find(([, historical]) => historical === recording.historicalRunId)?.[0];
    const created = runId !== undefined;
    // scope 和 code 读落库的 Run 行，而不是活动日志：类型化失败必须落库（工单 02）。
    const run = created
      ? db.prepare(
        "SELECT id, state, failure_scope, failure_code FROM runs WHERE id=?",
      ).get(runId) as { id: number; state: string; failure_scope: string | null; failure_code: string | null }
      : null;
    const repairs = run
      ? db.prepare(
        "SELECT id, metadata FROM runs WHERE purpose='outcome_repair' AND resumed_from_run_id=? ORDER BY id",
      ).all(run.id) as Array<{ id: number; metadata: string }>
      : [];
    for (const repairRun of repairs) {
      const repairError = childErrors.get(repairRun.id);
      if (repairError) throw new Error(`repair run #${repairRun.id} failed: ${repairError}`);
      // 修复回合 resume 的必须是来源 Run 的外部 session。
      const resumed = repairSessions.get(repairRun.id);
      if (!resumed || resumed !== getRun(db, run!.id)!.external_session_id) {
        throw new Error(`repair run #${repairRun.id} did not resume the session of run #${run!.id}`);
      }
    }
    // 内核的退避重试（工单 06）：它必须 resume 历史上这个 Run 的外部 session，并且做完。
    const retries = run
      ? [...transientRetries].filter(([, retry]) => retry.sourceRunId === run.id).map(([retryRunId, retry]) => {
        const retryError = childErrors.get(retryRunId);
        if (retryError) throw new Error(`transient retry run #${retryRunId} failed: ${retryError}`);
        if (!retry.session || retry.session !== historicalSession(recording)) {
          throw new Error(`transient retry run #${retryRunId} did not resume the session of run ${recording.historicalRunId}`);
        }
        return getRun(db, retryRunId)!.state === "finished" ? "resumed" : `${getRun(db, retryRunId)!.state}`;
      })
      : [];
    const retry = retries.join(",") || "-";
    const repair = repairs.map((repairRun) => {
      const result = (JSON.parse(repairRun.metadata) as { outcomeRepair?: { state: string; reason?: string } }).outcomeRepair;
      return result?.state === "repaired" ? "repaired" : `failed:${result?.reason ?? "?"}`;
    }).join(",") || "-";
    const decision = (name: string): { payload: string } | undefined => run
      ? db.prepare(
        `SELECT payload FROM activities WHERE run_id=? AND kind='decision'
         AND json_extract(payload, '$.decision')=? ORDER BY id DESC LIMIT 1`,
      ).get(run.id, name) as { payload: string } | undefined
      : undefined;
    const classified = decision("runtime_failure_classified");
    const payload = classified ? JSON.parse(classified.payload) as { leadDecides: boolean } : null;
    const request = db.prepare(
      `SELECT r.id, r.state, r.suspended_reason, i.id AS incident_id, i.opened_run_id FROM dispatch_requests r
       LEFT JOIN runtime_incidents i ON i.id = r.suspended_incident_id
       WHERE r.idempotency_key=?`,
    ).get(replayKey(recording)) as {
      id: number; state: string; suspended_reason: string | null; incident_id: number | null; opened_run_id: number | null;
    } | undefined;
    // preflight 开启的故障没有 Run（工单 05）。开启它的是一条派发请求，活动里记着请求的 id。
    const openedByRequest = (incidentId: number): { id: number; key: string } | undefined => db.prepare(
      `SELECT r.id, r.idempotency_key AS key FROM activities a
       JOIN dispatch_requests r ON r.id = json_extract(a.payload, '$.dispatchRequestId')
       WHERE a.kind='decision' AND json_extract(a.payload, '$.decision')='runtime_incident_opened'
         AND json_extract(a.payload, '$.incidentId')=?`,
    ).get(incidentId) as { id: number; key: string } | undefined;
    const opener = request?.incident_id ? openedByRequest(request.incident_id) : undefined;
    const blockedTitle = run
      ? (db.prepare("SELECT title FROM checkpoints WHERE run_id=? AND kind='blocked' ORDER BY id DESC LIMIT 1")
        .get(run.id) as { title: string } | undefined)?.title
      : undefined;
    const childError = run ? childErrors.get(run.id) : undefined;
    if (childError) note = `child error: ${childError.slice(0, 80)}`;
    else if (!note && blockedTitle) note = `${repair === "repaired" ? "repaired" : "blocked"}: ${blockedTitle}`;
    else if (!note && retry !== "-") {
      const failureTitle = (db.prepare("SELECT title FROM checkpoints WHERE idempotency_key=?")
        .get(`run-crash:${run!.id}`) as { title: string } | undefined)?.title;
      note = `${retry}: ${failureTitle ?? "?"}`;
    }
    else if (!note && request?.suspended_reason) note = `suspended: ${request.suspended_reason.split("（故障 #")[0]}`;
    const health = decision("runtime_incident_opened")
      ? "opened"
      : decision("runtime_incident_recurred")
        ? "joined"
        : opener && opener.id === request?.id
          ? "opened by preflight"
          : request?.opened_run_id
            ? `suspended by ${replayedRuns.get(request.opened_run_id) ?? "?"}`
            : opener
              ? `suspended by ${opener.key.replace("replay:", "")}`
              : "-";
    // 通知从用户看到的那一跳读：gateway 的 HTTP 接口（工单 03）。
    const notifications = (await readGatewayNotifications(db)).length;
    const delivered = notifications - notificationsSeen;
    notificationsSeen = notifications;
    return {
      created,
      state: run?.state ?? "-",
      request: request?.state ?? "-",
      scope: run?.failure_scope ?? "-",
      code: run?.failure_code ?? "-",
      leadDecides: payload?.leadDecides ?? null,
      retryBudgetCharged: executorRetryBudget(db, itemId).failures - budgetBefore,
      notifications: delivered,
      health,
      stage: getItem(db, itemId)!.stage,
      // 只列系统自动生成的后续请求。回放自己发的历史请求已经在 request 一列里。
      followUps: openRequests()
        .filter((open) => open.item_id === itemId && open.trigger !== REPLAY_TRIGGER)
        .map((open) => `${open.trigger}:${open.state}`),
      repair,
      retry,
      note,
    };
  }

  try {
    const itemIds = new Map<number, number>();
    for (const historicalItemId of historicalItemIds) {
      const itemRuns = runs.filter((run) => run.historicalItemId === historicalItemId);
      const reviewed = itemRuns.some((run) => run.role === "reviewer");
      const itemId = createItem(db, {
        title: `[replay #${historicalItemId}] ${itemRuns[0]!.itemTitle}`,
        brief: "historical failure replay",
        createdBy: "user",
        ...(reviewed ? { verificationPolicy: "independent_reviewer" as const } : {}),
      });
      if (reviewed) {
        // reviewer 只在 review 阶段可以被派发。按真实的生命周期把工单推进到 review。
        transition(db, { itemId, to: "active", actor: "system", reason: "replay setup" });
        transition(db, { itemId, to: "review", actor: "child", reason: "replay setup" });
      }
      itemIds.set(historicalItemId, itemId);
    }
    const outcomes = new Map<number, ReplayOutcome>();
    for (const recording of [...runs].sort((left, right) => left.historicalRunId - right.historicalRunId)) {
      outcomes.set(recording.historicalRunId, await replay(itemIds.get(recording.historicalItemId)!, recording));
    }
    return outcomes;
  } finally {
    db.close();
  }
}

// ── 期望：每一次历史失败的处理结果 ─────────────────────────────────────────────
// 真实库里有 23 次失败，其中 21 次留有事件日志，这里回放这 21 次。没有一次失败是 agent 没完成任务。
// 工单 01 把当时的行为冻结成基线：11 次被判为 task_failure，共扣重试额度 10 次，
// 另有 2 次因额度耗尽而派不出去。
// 工单 02 改写了所有失败行。每次失败都带着类型化失败落库，scope 按 spec D1 的映射表判定。
// 没有一次失败扣重试额度，也没有一次请 lead 决定重试。
// runs 53、54 不是失败的 Run，而是运行结束后交接失败，所以没有 scope（见工单 05、09）。
// 工单 03 改写了 runtime 和 account 作用域的行（spec D2）：
//   - 一次故障只在第一个 Run 上撞一次。这个 Run 开启故障，用户收到一条通知（kind=runtime_incident）。
//     工单不进 blocked，内核排的重试请求挂起（followUps 里的 runtime-health-retry）。
//   - 同一次故障里之后的请求挂起，不创建 Run，也没有新通知（health 一列是 suspended by N）。
//   - 工单之后跑了别的 Run，内核的重试就作废，所以 run 53、64 之后不再列出那个重试（14 见工单 05）。
//   - 瞬时故障（attempt）和交接失败照旧：每次一条 blocker 通知。退避由工单 06 实现。
// 工单 05 改写了 14 和 52 两行（spec D2 的 preflight）：
//   - 派发 claim 时、创建 Run 之前，preflight 发现扩展文件缺失（14）和 child 的 Node 过旧（52）。
//     不创建 Run，故障由这条请求开启（health 一列是 opened by preflight），用户照样只收到一条通知。
//     （2026-10-15 起配置错误先交给 Lead，用户不收通知。）
//   - 请求挂起，dispatcher 没有 claim 它，所以 52 的工单停在 ready。没有失败的 Run，所以没有内核的重试请求。
//   - 14 没有创建 Run，所以 12 留下的 Codex 重试不再作废，它仍然挂起（14 的 followUps）。
//   - 15、23、39、59、63 原来就挂起，不创建 Run。更早的故障挂起了它们，所以它们走不到 preflight。
// 工单 06 改写了瞬时失败的三行 44、55、64（spec D5），见 resumedAfterBackoff。
// 改写某一行时，要写明是哪张工单、为什么变。
type Expected = ReplayOutcome;
// notifications 是用户收到的通知。2026-10-15 起故障先交给 Lead：只有要用户行动的（重新登录、充值）通知用户，
// 模型被拒和配置错误不通知（.scratch/lead-self-heal/spec.md 的 D5）。
const failed = (scope: string, code: string, title: string, notifications = 1): Expected => ({
  created: true, state: "failed", request: "failed", scope, code, leadDecides: false,
  retryBudgetCharged: 0, notifications, health: "-", stage: "blocked", followUps: [], repair: "-", retry: "-",
  note: `blocked: ${title}`,
});
// 开启一次故障的 Run：工单留在原来的 stage，内核的重试请求挂起。
const opens = (base: Expected, stage: ItemStage = "active"): Expected => ({
  ...base, health: "opened", stage, followUps: ["runtime-health-retry:pending"],
});
// 一次已开启的故障挂起了这个请求：没有 Run，也没有通知。
const suspended = (openedBy: number, title: string, stage: ItemStage, followUps: string[] = []): Expected => ({
  created: false, state: "-", request: "pending", scope: "-", code: "-", leadDecides: null,
  retryBudgetCharged: 0, notifications: 0, health: `suspended by ${openedBy}`, stage, followUps, repair: "-", retry: "-",
  note: `suspended: ${title}`,
});
const modelUnsupported = failed("runtime", "model_unsupported", "Codex 不支持该模型", 0);
const outOfCredits = failed("account", "out_of_credits", "Codex 账号余额不足");
const oauthExpired = failed("account", "auth_required", "Claude Code 认证失败");
// 工单 06 改写了 44、55、64 三行（spec D5）。它们历史上是瞬时失败：模型满载，或者干了 28 分钟后断网。
// 以前每次升起一条 blocker，工单进入 blocked，要等用户重试。现在内核不升起 blocker，工单留在 active。
// 内核按退避排一个重试请求，带不早于时间。回放先确认这个时间之前派发不选它，再拨到这个时间。
// 重试 resume 历史上原来的外部 session（64 也是），回放一份构造的恢复录制：agent 做完并交接成果。
// 所以这三行的通知是 0，stage 是 review，retry 一列是 resumed。重试不扣工单额度。
const resumedAfterBackoff = (code: string, title: string): Expected => ({
  created: true, state: "failed", request: "failed", scope: "attempt", code, leadDecides: false,
  retryBudgetCharged: 0, notifications: 0, health: "-", stage: "review", followUps: [], repair: "-",
  retry: "resumed", note: `resumed: ${title}`,
});
const capacity = resumedAfterBackoff("provider_overloaded", "Codex 模型不可用");
// 工单 09 改写了 53、54 两行。它们历史上是「运行结束，交接失败」：agent 干完了，最后一条消息里有成果信封，
// 但 plc 工具通道不可用，没能调用 ticket_update。现在内核为每个 Run 排一个修复回合（每个 Run 的额度是一次）。
// 修复回合 resume 原来的 session，回放一份构造的成功录制：agent 再交一次那个成果信封。
// 成果登记在来源 Run 上，「交接失败」的 blocker 和通知撤回，工单按现有规则进入 review。
// 所以这两行的通知是 0，stage 是 review。修复回合不扣工单额度。
const handoffRepaired: Expected = {
  created: true, state: "finished", request: "completed", scope: "-", code: "-", leadDecides: null,
  retryBudgetCharged: 0, notifications: 0, health: "-", stage: "review", followUps: [], repair: "repaired",
  retry: "-", note: "repaired: 运行结束，交接失败",
};
// 回放请求的是 openai/gpt-5.6-sol。adapter 去掉 provider 前缀，把 gpt-5.6-sol 交给 Codex，
// 所以账本把这次模型级故障记在 gpt-5.6-sol 上，和录制的证据一致。
// （2026-10-15 以前，代码把它换成写死的别名 gpt-5.5。现在不再写死模型，见 .scratch/lead-self-heal/spec.md。）
const solSuspended = "Codex 不支持该模型（gpt-5.6-sol）";
const retryPending = ["runtime-health-retry:pending"];
// preflight 没通过（工单 05）：没有 Run，这条请求开启故障并挂起。配置错误先交给 Lead，用户不收通知（2026-10-15）。
const refusedByPreflight = (title: string, stage: ItemStage, followUps: string[] = []): Expected => ({
  created: false, state: "-", request: "pending", scope: "-", code: "-", leadDecides: null,
  retryBudgetCharged: 0, notifications: 0, health: "opened by preflight", stage, followUps, repair: "-", retry: "-",
  note: `suspended: ${title}`,
});
const EXPECTED: Record<number, Expected> = {
  // 工单 03：12 开启 Codex 模型级故障，13 和 16 挂起（12/13/16 一组只撞一次）。
  12: opens(modelUnsupported), // ChatGPT 账号不支持该模型
  13: suspended(12, solSuspended, "active", retryPending),
  // 工单 03：14 开启 pi 的 profile 故障，15 和 23 挂起。
  // 工单 05：preflight 发现扩展文件缺失，14 不再创建 Run。12 留下的 Codex 重试因此不再作废。
  14: refusedByPreflight("Pi agent 配置错误", "active", retryPending),
  15: suspended(14, "Pi agent 配置错误", "ready"),
  16: suspended(12, solSuspended, "ready"),
  23: suspended(14, "Pi agent 配置错误", "ready"),
  55: capacity, // stderr 里有 refresh token 报错，但终止原因是满载。工单 06：退避后 resume
  // 工单 03：34 开启 Codex 账号故障。reviewer 不再立即重试，内核的重试挂起。35 和 36 挂起（34/35/36 一组）。
  34: opens(outOfCredits, "review"),
  35: suspended(34, "Codex 账号余额不足", "ready"),
  36: suspended(34, "Codex 账号余额不足", "ready"),
  // 工单 03：历史上是找不到 codex，但同一个 Codex profile 还在余额故障里，所以请求挂起。
  39: suspended(34, "Codex 账号余额不足", "ready"),
  44: capacity, // 工单 06：退避后 resume。之后 46 开始前，回放先用用户返工把工单从 review 拉回 active
  // 工单 03：46 开启 Claude 账号故障，47 和 63 挂起（46/47/63 一组）。
  46: opens(oauthExpired),
  47: suspended(46, "Claude Code 认证失败", "active", retryPending),
  // 工单 03：52 开启 pi 的 Node 版本故障，59 挂起。
  // 工单 05：preflight 发现 child 的 Node 是 22.14，低于 pi 要求的 22.19，52 不再创建 Run。
  52: refusedByPreflight("Pi agent 配置错误", "ready"),
  53: handoffRepaired, // plc 工具通道不可用，agent 干完 27 分钟却无法交接。工单 09：修复回合补交了成果
  54: handoffRepaired, // 回放先用用户返工把工单从 review 拉回 active，再派出 54（见 replay）
  59: suspended(52, "Pi agent 配置错误", "ready"),
  // 工单 03：62 开启 Codex gpt-5.4-mini 的模型级故障。代理不认识该模型，502 不是瞬时故障。
  62: opens(failed("runtime", "model_unsupported", "Codex 不支持该模型", 0)),
  63: suspended(46, "Claude Code 认证失败", "active", retryPending),
  // 工单 03：同一个 Codex profile 的 gpt-5.5 不受 gpt-5.4-mini 故障影响，照常派发。62 留下的重试作废。
  // 断网，干了 28 分钟。工单 06：退避后 resume 原来的 session，进展没有丢。
  64: resumedAfterBackoff("network_error", "Codex 网络中断"),
};

// 工单 03 的验收条件：每组只有首个 Run 被创建，每组最多一条通知。
// 2026-10-15 起：要用户行动的组（余额、认证）恰好一条；模型被拒的组先交给 Lead，没有通知。
const INCIDENT_GROUPS: ReadonlyArray<{ runs: readonly number[]; notifications: number }> = [
  { runs: [34, 35, 36], notifications: 1 }, { runs: [46, 47, 63], notifications: 1 }, { runs: [12, 13, 16], notifications: 0 },
];
// 工单 05 的验收条件：这些历史 Run 都不创建 Run。
const NO_RUN = [14, 15, 23, 39, 52, 59, 63];

try {
  const groupOf = (historicalItemId: number): readonly number[] =>
    SHARED_INCIDENTS.find((items) => items.includes(historicalItemId)) ?? [historicalItemId];
  const groups = new Map<string, { items: readonly number[]; runs: FixtureRun[] }>();
  for (const run of fixture.runs) {
    const items = groupOf(run.historicalItemId);
    const key = items.join(",");
    const group = groups.get(key) ?? { items, runs: [] };
    group.runs.push(run);
    groups.set(key, group);
  }

  const outcomes = new Map<number, ReplayOutcome>();
  for (const { items, runs } of groups.values()) {
    for (const [run, outcome] of await replayGroup([...items], runs)) outcomes.set(run, outcome);
  }
  const ordered = [...outcomes].sort(([left], [right]) => left - right);

  console.log("\nrun  created state     request    scope    code                 lead  budget notif health              stage    repair    retry    follow-ups / note");
  for (const [run, o] of ordered) {
    console.log(
      `${String(run).padEnd(4)} ${String(o.created).padEnd(7)} ${o.state.padEnd(9)} ${o.request.padEnd(10)} `
      + `${o.scope.padEnd(8)} ${o.code.padEnd(20)} ${String(o.leadDecides).padEnd(5)} ${String(o.retryBudgetCharged).padEnd(6)} `
      + `${String(o.notifications).padEnd(5)} ${o.health.padEnd(19)} ${o.stage.padEnd(8)} ${o.repair.padEnd(9)} ${o.retry.padEnd(8)} `
      + `${[...o.followUps, o.note].filter(Boolean).join("; ")}`,
    );
  }

  const mismatches: string[] = [];
  for (const [run, actual] of ordered) {
    const expected = EXPECTED[run];
    if (!expected) mismatches.push(`run ${run}: no expectation`);
    else if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatches.push(`run ${run}: expected ${JSON.stringify(expected)}\n           got      ${JSON.stringify(actual)}`);
    }
  }
  for (const run of Object.keys(EXPECTED).map(Number)) {
    if (!outcomes.has(run)) mismatches.push(`run ${run}: expected but not replayed`);
  }
  if (mismatches.length) throw new Error(`FAIL: runtime reliability replay\n  ${mismatches.join("\n  ")}`);

  // 每组只有首个 Run 被创建，每组最多一条通知（工单 03；2026-10-15 起只有要用户行动的组有通知）。
  for (const { runs: [first, ...rest], notifications: expectedNotifications } of INCIDENT_GROUPS) {
    const group = [first!, ...rest].map((run) => outcomes.get(run)!);
    const createdRuns = [first!, ...rest].filter((run) => outcomes.get(run)!.created);
    const notified = group.reduce((sum, o) => sum + o.notifications, 0);
    if (createdRuns.join() !== String(first) || notified !== expectedNotifications) {
      throw new Error(`FAIL: incident group ${[first, ...rest].join("/")}: created runs ${createdRuns.join(",")}, `
        + `notifications ${notified}`);
    }
  }

  // preflight 让这些请求都不创建 Run（工单 05）。
  const created = NO_RUN.filter((run) => outcomes.get(run)?.created !== false);
  if (created.length) throw new Error(`FAIL: runs ${created.join(",")} created a Run`);

  const all = [...outcomes.values()];
  const typed = all.filter((o) => o.scope !== "-");
  const scopes = new Map<string, number>();
  for (const o of typed) scopes.set(o.scope, (scopes.get(o.scope) ?? 0) + 1);
  const charged = all.reduce((sum, o) => sum + o.retryBudgetCharged, 0);
  const leadInvited = all.filter((o) => o.leadDecides === true).length;
  const notCreated = all.filter((o) => !o.created).length;
  const preflightRefused = all.filter((o) => o.health === "opened by preflight").length;
  const incidents = all.filter((o) => o.health === "opened").length + preflightRefused;
  const notifications = all.reduce((sum, o) => sum + o.notifications, 0);
  // 工单 09：交接失败的两次各有恰好一个修复回合，并且都修好了。
  const repaired = all.filter((o) => o.repair === "repaired").length;
  const repairTurns = all.filter((o) => o.repair !== "-").length;
  // 工单 06：三次瞬时失败都由内核退避后 resume 了原来的 session。它们不再通知用户，所以通知从 9 变成 6。
  // 2026-10-15：模型被拒和配置错误先交给 Lead，不再通知用户（12、14、52、62），通知从 6 变成 2。
  const resumed = ordered.filter(([, o]) => o.retry === "resumed").map(([run]) => run);
  const retried = all.filter((o) => o.retry !== "-").length;
  if (typed.length !== 7 || charged !== 0 || leadInvited !== 0 || notCreated !== 12 || incidents !== 6
      || preflightRefused !== 2 || notifications !== 2 || repaired !== 2 || repairTurns !== 2
      || outcomes.get(53)?.repair !== "repaired" || outcomes.get(54)?.repair !== "repaired"
      || resumed.join(",") !== "44,55,64" || retried !== 3) {
    throw new Error(`FAIL: totals changed: typed=${typed.length} charged=${charged} leadInvited=${leadInvited} `
      + `notCreated=${notCreated} incidents=${incidents} preflightRefused=${preflightRefused} `
      + `notifications=${notifications} repaired=${repaired} repairTurns=${repairTurns} `
      + `resumed=${resumed.join(",")} retried=${retried}`);
  }
  console.log(
    `\n全部通过：${all.length} 个历史 Run 与期望一致。`
    + `${typed.length} 次失败都带着类型化失败落库（${[...scopes].map(([scope, n]) => `${scope} ${n}`).join("，")}）。`
    + `账号和配置故障开启了 ${incidents} 次故障，其中 ${preflightRefused} 次由 preflight 在创建 Run 之前发现。`
    + `${notCreated} 个请求没有创建 Run，${NO_RUN.join("/")} 都在其中。`
    + `34/35/36、46/47/63、12/13/16 每组只创建了首个 Run。经 gateway HTTP，余额和认证两组各收到一条通知；`
    + `模型被拒和配置错误先交给 Lead，没有通知用户。`
    + `重试额度一次都没扣，也没有一次请 lead 决定重试。`
    + `另有 ${repaired} 次运行结束后交接失败（53、54），各触发一个修复回合，成果都已补交。`
    + `${resumed.length} 次瞬时失败（${resumed.join("、")}）由内核退避后自动 resume 了原来的 session，没有通知用户。`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
