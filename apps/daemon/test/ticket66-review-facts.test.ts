// 工单 #66 复核（2026-10-13）的回归套件：review 阶段的三条事实。
//
// 1. 用户在 review 工单里发一句话，会起一个 purpose=conversation 的 Run。它是回答，不是交付：
//    结束时不能写"成果缺失"、不能升起 blocker、更不能把 review 打回 blocked（旧代码三样都做）。
// 2. 用户点「开始执行 / 重试」直接启动的 Run 不经派发队列。旧代码只在收尾派发认领时请求自动核查，
//    所以这种 Run 进了 review 以后没有任何 reviewer 会来——#66 的 Run #49 就停在这里。
// 3. 早就卡住的旧工单不自动补派（启动修复必须有界），而是投影成"独立核查未派发"，由用户手动派发。
//
// Seam 1：真实 SQLite、真实 child manager（runItem）、lead 的真实启动入口，runtime 是回放。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conversationWorkspaceChecksSettled, createDispatcher, createOrchestrator, recordOutcomeRegistrationMissing,
  setWorkspaceTreeHashForTesting, workspaceTreeHash, type Orchestrator,
} from "@pi-lead-child/engine";
import { createUserActionService } from "@pi-lead-child/gateway";
import {
  routeTicketMessageToAgentRun, runningChildren, spawnClaimedItem, spawnItemChild, type LeadDeps,
} from "@pi-lead-child/lead";
import { ClaudeRuntime, RuntimeRegistry } from "@pi-lead-child/runtime";
import type { AgentRuntime, RuntimeCapabilities, RuntimeHandle, RuntimeStartRequest } from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { getOutcomeSnapshotForRun } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { readGatewayNotifications, readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { ReplayRuntime, type RecordedEvent } from "@pi-lead-child/runtime/testing";
import { tempDir } from "@pi-lead-child/core/testing";

const SESSION = "claude-session-66";

function envelope(summary: string): string {
  return `PLC_OUTCOME_V1 ${JSON.stringify({
    summary,
    changes: [{ kind: "file", ref: "src/pipeline/outcome-recovery.ts", summary: "registry gap closed" }],
    deliverables: [{ kind: "path", ref: "src/pipeline/outcome-recovery.ts", label: "outcome recovery" }],
    validations: [{ command: "vitest run", outcome: "passed", exitCode: 0, summary: "suite green", evidenceRef: null }],
  })}`;
}

// #49 的样子：交接工具调用丢了回执，最后一条消息带着成果信封，runtime 自我恢复把工单推进 review。
function deliveryRecoveredFromOutput(): RecordedEvent[] {
  return [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
    { type: "tool.started", callId: "c-1", name: "mcp__plc__ticket_update", args: { status: "review" } },
    { type: "tool.failed", callId: "c-1", name: "mcp__plc__ticket_update", error: "socket closed" },
    {
      type: "message.completed", messageId: "m-1", role: "assistant", stopReason: "end_turn",
      text: `Closed the outcome-registry gap.\n\n${envelope("Closed the outcome-registry gap")}`,
    },
    { type: "run.completed", exitCode: 0 },
  ];
}

// #50 的样子：用户问"这个工单是在干什么来着"，agent 回答，没有任何成果信封。
function conversationAnswer(text: string): RecordedEvent[] {
  return [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
    { type: "message.completed", messageId: "m-c", role: "assistant", stopReason: "end_turn", text },
    { type: "run.completed", exitCode: 0 },
  ];
}

// 回答之前用了一个工具，例如跑了一条命令或改了一个文件。
function conversationWithTool(name: string, text: string): RecordedEvent[] {
  return [
    { type: "run.started", runtime: "claude", model: null },
    { type: "session.updated", externalSessionId: SESSION, runtimeVersion: "test" },
    { type: "tool.started", callId: "c-tool", name, args: {} },
    { type: "tool.completed", callId: "c-tool", name, result: { content: [{ type: "text", text: "ok" }] } },
    { type: "message.completed", messageId: "m-c", role: "assistant", stopReason: "end_turn", text },
    { type: "run.completed", exitCode: 0 },
  ];
}

class ScriptedRuntime implements AgentRuntime {
  readonly id = "claude" as const;
  readonly capabilities: RuntimeCapabilities;
  readonly requests: RuntimeStartRequest[] = [];

  // 回放之前在 Run 里做的事，例如 agent 改了一个文件。返回 Promise 时，Run 等它结束再回放，例如一个慢的 Run。
  onStart?: (request: RuntimeStartRequest) => void | Promise<void>;

  constructor(private readonly recordings: RecordedEvent[][], capabilities: Partial<RuntimeCapabilities> = {}) {
    this.capabilities = { ...new ClaudeRuntime().capabilities, resume: true, ...capabilities };
  }

  async start(request: RuntimeStartRequest): Promise<RuntimeHandle> {
    this.requests.push(request);
    await this.onStart?.(request);
    const events = this.recordings.shift();
    if (!events) throw new Error(`no recording left for run #${request.runId}`);
    return new ReplayRuntime({ runtime: "claude", events }).start(request);
  }
}

let db: Db;
let dir: string;

beforeEach(() => {
  dir = tempDir("plc-ticket66-facts-");
  process.env.PLC_DATA_DIR = dir;
  process.env.PLC_CHILD_LINGER_MS = "0";
  db = openDb(join(dir, "plc.db"));
});

// 等所有 child 结束：直接等 runningChildren 里登记的 Promise，不轮询。以前用 vi.waitFor 的缺省时限（1 秒），
// 机器忙时 child 跑不完就失败（2026-10-19）。child 真的卡住时，由用例的 testTimeout 报错。
async function childrenFinished(): Promise<void> {
  while (runningChildren().size > 0) await Promise.allSettled([...runningChildren().values()]);
}

// 等一个后台条件（指纹函数被调用、工单释放）时的时限。缺省的 1 秒在机器忙时同样不够。
const BACKGROUND_WAIT = { timeout: 10_000 };

afterEach(async () => {
  // 失败的用例可能留下还在跑的 child。数据库关掉以后它不再结束，一直登记在 runningChildren 里，
  // 后面每个用例的 item #1 都撞上「已有 child 在运行」。所以先等它结束，再关数据库。
  await childrenFinished();
  await conversationWorkspaceChecksSettled();
  setWorkspaceTreeHashForTesting();
  vi.unstubAllEnvs();
  db.close();
});

function harness(recordings: RecordedEvent[][], capabilities: Partial<RuntimeCapabilities> = {}) {
  const runtime = new ScriptedRuntime(recordings, capabilities);
  const deps: LeadDeps = {
    db, dbPath: join(dir, "plc.db"), dataDir: dir,
    runtimeRegistry: new RuntimeRegistry([runtime]),
  };
  // Run 结束、工单释放以后，对话的工作区检查还在后台算指纹（review-currency.ts），也等它。
  const settled = async (): Promise<void> => {
    await childrenFinished();
    await conversationWorkspaceChecksSettled();
  };
  return { runtime, deps, settled };
}

function independentTicket(): number {
  return createItem(db, {
    title: "outcome snapshot and registry mechanism",
    brief: "implement the outcome snapshot protocol",
    createdBy: "user",
    runtime: "claude",
    verificationPolicy: "independent_reviewer",
  });
}

function runsOf(itemId: number) {
  return db.prepare("SELECT id, role, purpose, state FROM runs WHERE item_id=? ORDER BY id")
    .all(itemId) as Array<{ id: number; role: string; purpose: string; state: string }>;
}

function reviewerRequests(itemId: number) {
  return db.prepare(
    `SELECT trigger, idempotency_key AS key, state FROM dispatch_requests
     WHERE item_id=? AND role='reviewer' ORDER BY id`,
  ).all(itemId) as Array<{ trigger: string; key: string; state: string }>;
}

function blockerCodes(itemId: number): string[] {
  return listInbox(db, { severity: "blocker" })
    .filter((row) => row.item_id === itemId)
    .map((row) => JSON.parse(row.payload).blockerCode as string);
}

describe("a directly started delivery that ends in review", () => {
  it("requests the automatic independent review, keyed by the run like the dispatcher path", async () => {
    const { deps, settled } = harness([deliveryRecoveredFromOutput()]);
    const itemId = independentTicket();

    // 用户点「开始执行」：daemon 的 startRun 就是这一行，不经过派发队列。
    spawnItemChild(deps, itemId, {});
    await settled();

    const [delivery] = runsOf(itemId);
    expect(delivery).toMatchObject({ role: "executor", purpose: "execution", state: "finished" });
    expect(getItem(db, itemId)!.stage).toBe("review");
    expect(getOutcomeSnapshotForRun(db, delivery!.id)).toMatchObject({ completeness: "complete" });
    // 旧代码到这里为止：工单进了 review，没有任何 reviewer 请求。
    expect(reviewerRequests(itemId)).toEqual([{
      trigger: "automatic-review",
      key: `automatic-review:${itemId}:executor-run:${delivery!.id}`,
      state: "pending",
    }]);
    const [ticket] = await readGatewayTickets(db);
    // 请求已排队、reviewer 还没开始：说"排队中"，不说"正在进行"。
    expect(ticket!.reviewState).toMatchObject({
      state: "independent_review",
      label: "独立核查排队中",
      reviewProgress: "queued",
      deliveryRunId: delivery!.id,
      canRequestReview: false,
    });
  });

  it("still creates a single request when the dispatcher path asks for the same run", async () => {
    const { deps, settled } = harness([deliveryRecoveredFromOutput()]);
    const orchestrator: Orchestrator = createOrchestrator(db, {
      dataDir: dir,
      onDispatch: (claim) => { spawnClaimedItem(deps, claim); },
    });
    const itemId = independentTicket();
    orchestrator.dispatcher.request({
      itemId, role: "executor", purpose: "execution", runtime: "claude",
      trigger: "test", idempotencyKey: `test-execution:${itemId}`,
    });

    await orchestrator.tick();
    await settled();
    // 第二轮 tick 收尾认领：orchestrator 用同一个键再请求一次。
    await orchestrator.tick();

    const [delivery] = runsOf(itemId).filter((run) => run.role === "executor");
    expect(reviewerRequests(itemId).map((request) => request.key))
      .toEqual([`automatic-review:${itemId}:executor-run:${delivery!.id}`]);
  });
});

describe("a ticket-scoped message on a ticket in review", () => {
  it("answers without writing a missing outcome, raising a blocker or demoting the ticket", async () => {
    const { deps, settled } = harness([
      deliveryRecoveredFromOutput(),
      conversationAnswer("这张工单在落地成果快照和登记机制。"),
    ]);
    const itemId = independentTicket();
    spawnItemChild(deps, itemId, {});
    await settled();
    expect(getItem(db, itemId)!.stage).toBe("review");

    // 用户在工单卡片底部问了一句：没有 live child，于是起一个对话 Run。
    const route = routeTicketMessageToAgentRun(deps, { itemId, message: "这个工单是在干什么来着" });
    expect(route.purpose).toBe("conversation");
    await settled();

    expect(runsOf(itemId).map((run) => run.purpose)).toEqual(["execution", "conversation"]);
    // 旧代码：对话 Run 结束时走成果恢复，写下 outcome-registration-missing，升起 blocker，
    // 并把工单从 review 打回 blocked。
    expect(getItem(db, itemId)!.stage).toBe("review");
    expect(db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE idempotency_key=?")
      .get(`outcome-registration-missing:${route.runId}`)).toEqual({ n: 0 });
    expect(blockerCodes(itemId)).toEqual([]);
    expect(await readGatewayNotifications(db)).toEqual([]);
    // 一次提问也不让核查请求"过期"：仍然只有那一次交付的自动核查。
    const [delivery] = runsOf(itemId);
    expect(reviewerRequests(itemId).map((request) => request.key))
      .toEqual([`automatic-review:${itemId}:executor-run:${delivery!.id}`]);
    const [ticket] = await readGatewayTickets(db);
    expect(ticket!.reviewState).toMatchObject({ state: "independent_review", deliveryRunId: delivery!.id });
  });
});

describe("a delivery that was stranded in review before this fix", () => {
  // #66 的现状：交付 Run 早已结束、成果已登记、工单停在 review，从来没有 reviewer 请求。
  function strandedTicket(): { itemId: number; deliveryRunId: number } {
    const itemId = independentTicket();
    transition(db, { itemId, to: "active", actor: "system", reason: "retry run" });
    const deliveryRunId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, deliveryRunId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, {
      itemId, to: "review", actor: "system", runId: deliveryRunId,
      reason: "recovered outcome snapshot from successful runtime output",
    });
    // 之后用户问了两句（#50/#51）。
    for (const _ of [0, 1]) {
      const conversation = createRun(db, { itemId, role: "executor", purpose: "conversation", runtime: "claude" });
      updateRun(db, conversation, { state: "finished", endedAt: true, exitCode: 0 });
    }
    return { itemId, deliveryRunId };
  }

  it("is not backfilled by the orchestrator, and says plainly that no review is coming", async () => {
    const { itemId, deliveryRunId } = strandedTicket();
    const orchestrator = createOrchestrator(db, { dataDir: dir, onDispatch: () => {} });

    await orchestrator.tick();

    expect(reviewerRequests(itemId)).toEqual([]);
    const [ticket] = await readGatewayTickets(db);
    expect(ticket!.reviewState).toMatchObject({
      state: "independent_review",
      label: "独立核查未派发",
      deliveryRunId,
      canRequestReview: true,
    });
    expect(ticket!.reviewState!.reason).toContain(`Run #${deliveryRunId}`);
  });

  it("lets the user send the latest delivery to an independent reviewer exactly once", async () => {
    const { itemId, deliveryRunId } = strandedTicket();
    const actions = createUserActionService({ db, reviewerRuntime: "codex" });

    const result = actions.requestReview(itemId);

    expect(result.deliveryRunId).toBe(deliveryRunId);
    expect(reviewerRequests(itemId)).toEqual([{
      trigger: "user-review",
      key: `user-review:${itemId}:delivery-run:${deliveryRunId}:1`,
      state: "pending",
    }]);
    const [ticket] = await readGatewayTickets(db);
    expect(ticket!.reviewState).toMatchObject({ label: "独立核查排队中", reviewProgress: "queued", canRequestReview: false });
    // 核查已经在路上：再点一次不会重复派发。
    expect(() => actions.requestReview(itemId)).toThrow(/no unreviewed delivery/);
    expect(reviewerRequests(itemId)).toHaveLength(1);
    expect(db.prepare(
      `SELECT json_extract(payload, '$.deliveryRunId') AS run FROM activities
       WHERE item_id=? AND json_extract(payload, '$.decision')='review_requested_by_user'`,
    ).all(itemId)).toEqual([{ run: deliveryRunId }]);
  });
});

describe("rework and missing-outcome records on a ticket with an expired review", () => {
  // #66 的账：Run #42 交付 → reviewer Run #43 FAIL → 用户返工 → Run #49 交付 → 两次提问。
  function expiredReviewTicket() {
    const itemId = independentTicket();
    db.prepare("UPDATE items SET rework_policy='ask_user' WHERE id=?").run(itemId);
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    const firstDelivery = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "codex" });
    updateRun(db, firstDelivery, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: firstDelivery });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, reviewer, { state: "running" });
    createDispatcher(db).submitReviewVerdict({
      runId: reviewer, verdict: "fail", evidence: "STALE: npm test red at checkpoint-control-plane-e2e:783",
    });
    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    const latestDelivery = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, latestDelivery, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "system", reason: "recovered", runId: latestDelivery });
    const conversation = createRun(db, { itemId, role: "executor", purpose: "conversation", runtime: "claude" });
    updateRun(db, conversation, { state: "finished", endedAt: true, exitCode: 0 });
    return { itemId, latestDelivery };
  }

  it("resumes the latest delivery with the user's reason instead of resending an expired FAIL", () => {
    const { itemId, latestDelivery } = expiredReviewTicket();
    const actions = createUserActionService({ db });

    actions.reworkItem(itemId, "补跑 typecheck 和 build");

    const request = db.prepare(
      "SELECT resume_from_run_id AS resume, instruction FROM dispatch_requests WHERE item_id=? AND trigger='user-rework'",
    ).get(itemId) as { resume: number; instruction: string };
    // 旧代码：从对话 Run 续接，指令是两个月前那次 FAIL 的原文。
    expect(request.resume).toBe(latestDelivery);
    expect(request.instruction).not.toContain("STALE");
    expect(request.instruction).toContain(`Run #${latestDelivery}`);
    expect(request.instruction).toContain("补跑 typecheck 和 build");
    expect(getItem(db, itemId)!.body).not.toContain("STALE");
  });

  it("describes the run's own end when a delivery leaves no outcome", () => {
    const itemId = independentTicket();
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    const runId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId });

    expect(recordOutcomeRegistrationMissing(db, { itemId, runId })).toBe(true);

    const { summary } = db.prepare("SELECT summary FROM checkpoints WHERE idempotency_key=?")
      .get(`outcome-registration-missing:${runId}`) as { summary: string };
    // 旧代码写 "Run #N reached review"：那是写入时工单的 stage，不是这个 Run 的结局。
    expect(summary).toBe(`Run #${runId} ended without a structured outcome snapshot that could be recovered.`);
  });
});

// release review 5：对话 Run 不是交付，但它能改代码。这个对话 Run 自己改了工作区，结论就过期。
// 第二轮 N1/N2：只量对话 Run 自己的影响（启动前、结束后各算一次指纹），不拿 reviewer 的哈希比；
// 只在工单停在 review 时量；git 仓库按 git 的视角算，被忽略的缓存不算。
describe("a chat that changes the reviewed workspace", () => {
  /** 一张停在 review、带着真实核查收尾留下的 PASS 的工单。harness 的第一段录像给 reviewer。 */
  async function passReview(deps: LeadDeps, options: { git?: boolean; userVerifies?: boolean } = {}) {
    // 工作目录必须在 PLC 数据目录之外。
    const workdir = tempDir("plc-ticket66-repo-");
    writeFileSync(join(workdir, "src.txt"), "v1");
    if (options.git) {
      writeFileSync(join(workdir, ".gitignore"), "cache/\n");
      const git = (...args: string[]) => execFileSync("git", ["-C", workdir, ...args], { stdio: "ignore" });
      git("init", "-q");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init");
    }
    const itemId = createItem(db, {
      title: "reviewed ticket", brief: "b", createdBy: "user", runtime: "claude",
      verificationPolicy: "independent_reviewer", workdir,
    });
    db.prepare("UPDATE items SET acceptance_policy='user_only' WHERE id=?").run(itemId);
    // 由用户验收的工单：用户自己派过一次核查，拿到了 PASS。
    if (options.userVerifies) {
      db.prepare("UPDATE items SET verification_policy='user' WHERE id=?").run(itemId);
    }
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    const delivery = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, delivery, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery });

    // 真实的核查收尾：reviewer 在运行中交结论，manager 在它结束时算工作区哈希并落下结论。
    deps.onChildEvent = (_itemId, runId, event) => {
      if (event.type === "run.started" && runsOf(itemId).find((run) => run.id === runId)?.purpose === "review") {
        createDispatcher(db).submitReviewVerdict({ runId, verdict: "pass", evidence: "full suite green" });
      }
    };
    const dispatcher = createDispatcher(db);
    dispatcher.request({
      itemId, role: "reviewer", purpose: "review", runtime: "claude",
      trigger: "automatic-review", idempotencyKey: `automatic-review:${itemId}:executor-run:${delivery}`,
    });
    spawnClaimedItem(deps, dispatcher.claimNext()!);
    await childrenFinished();
    await conversationWorkspaceChecksSettled();
    const [reviewer] = runsOf(itemId).filter((run) => run.purpose === "review");
    expect((await readGatewayTickets(db))[0]!.reviewState).toMatchObject({ state: "review_passed" });
    return { itemId, workdir, delivery, reviewer: reviewer!.id };
  }

  async function passedReview(options: {
    git?: boolean;
    userVerifies?: boolean;
    beforeChat?: (workdir: string, itemId: number) => void;
    duringChat?: (workdir: string) => void;
  } = {}) {
    const { runtime, deps, settled } = harness(
      [conversationAnswer("PASS：全量测试通过。"), conversationAnswer("回答完了。"), conversationAnswer("PASS：v2 也通过。")],
      { executableReadOnlyReview: true },
    );
    const { itemId, workdir, delivery, reviewer } = await passReview(deps, options);

    options.beforeChat?.(workdir, itemId);
    if (options.duringChat) runtime.onStart = () => { options.duringChat!(workdir); };
    const route = routeTicketMessageToAgentRun(deps, { itemId, message: "src.txt 现在是什么？" });
    await settled();
    runtime.onStart = undefined;
    expect(route).toMatchObject({ role: "reviewer", purpose: "conversation" });
    return { runtime, deps, settled, itemId, workdir, delivery, reviewer, chat: route.runId };
  }

  function pendingReviewerRequests(itemId: number) {
    return reviewerRequests(itemId).filter((request) => request.state === "pending");
  }

  function workspaceChanges(itemId: number): number {
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM activities
       WHERE item_id=? AND json_extract(payload, '$.decision')='workspace_changed_after_review'`,
    ).get(itemId) as { n: number }).n;
  }

  // 2026-10-19：机器忙时（Sophos 扫描、别的会话在跑测试），git 仓库里的核查收尾要 1 秒以上。passReview 以前用
  // vi.waitFor 的缺省时限（1 秒）等 child 结束：等不到就失败，child 还登记在 runningChildren 里，
  // 后面用例的 item #1 撞上「已有 child 在运行」。一个慢用例连带后面 6 个一起失败。
  it("waits for a reviewer that runs longer than one second", async () => {
    const { runtime, deps } = harness([conversationAnswer("PASS：全量测试通过。")], { executableReadOnlyReview: true });
    runtime.onStart = () => new Promise((done) => setTimeout(done, 1_200));

    const { itemId } = await passReview(deps);

    expect(runsOf(itemId).filter((run) => run.purpose === "review").map((run) => run.state)).toEqual(["finished"]);
  });

  // 要求独立核查的工单：结论过期以后，系统重新排一次自动核查。旧代码到过期为止，卡片写着
  // "独立核查未派发"，要用户手动派发。
  it("expires the PASS and queues one automatic review of the changed workspace", async () => {
    const { itemId, delivery, reviewer, chat } = await passedReview({
      duringChat: (workdir) => writeFileSync(join(workdir, "src.txt"), "v2"),
    });

    expect(getItem(db, itemId)!.stage).toBe("review");
    expect(pendingReviewerRequests(itemId)).toEqual([{
      trigger: "automatic-review",
      key: `automatic-review:${itemId}:conversation-run:${chat}`,
      state: "pending",
    }]);
    // 请求记下它为哪一次交付而建：还是那一次交付，对话不是交付。
    expect(db.prepare(
      `SELECT json_extract(payload, '$.reviewDeliveryRunId') AS delivery FROM activities
       WHERE item_id=? AND json_extract(payload, '$.decision')='dispatch_requested'
         AND json_extract(payload, '$.idempotencyKey')=?`,
    ).all(itemId, `automatic-review:${itemId}:conversation-run:${chat}`)).toEqual([{ delivery }]);
    const [ticket] = await readGatewayTickets(db);
    expect(ticket!.reviewState).toMatchObject({
      state: "independent_review",
      label: "独立核查排队中",
      reviewProgress: "queued",
      deliveryRunId: delivery,
      canRequestReview: false,
      supersededReview: { reviewerAttemptId: reviewer, verdict: "pass", supersededByRunId: chat },
    });
  });

  // 排上的核查要核查改过的工作区，它的结论要算当前有效：不能一落下就又被那次对话判成过期。
  it("reviews the changed workspace, and the new verdict is current", async () => {
    vi.stubEnv("PLC_REVIEW_RUNTIME", "claude");
    const { runtime, deps, settled, itemId, workdir, chat } = await passedReview({
      duringChat: (dir) => writeFileSync(join(dir, "src.txt"), "v2"),
    });
    let seen: { workdir: string; content: string } | null = null;
    runtime.onStart = (request) => {
      if (request.purpose === "review") {
        seen = { workdir: request.workdir, content: readFileSync(join(request.workdir, "src.txt"), "utf8") };
      }
    };

    const claim = createDispatcher(db).claimNext();
    expect(claim).toMatchObject({ itemId, role: "reviewer", purpose: "review", trigger: "automatic-review" });
    spawnClaimedItem(deps, claim!);
    await settled();

    expect(seen).toEqual({ workdir, content: "v2" });
    const again = runsOf(itemId).filter((run) => run.purpose === "review").at(-1)!;
    expect(again.id).toBe(claim!.runId);
    expect(again.id).toBeGreaterThan(chat);
    const [ticket] = await readGatewayTickets(db);
    expect(ticket!.reviewState).toMatchObject({
      state: "review_passed", reviewerAttemptId: again.id, supersededReview: null, reviewProgress: null,
    });
    expect(pendingReviewerRequests(itemId)).toEqual([]);
  });

  // 由用户验收的工单：结论照样过期，但系统不派核查。手动派发的入口还在。
  it("expires the PASS but queues no review on a ticket the user verifies", async () => {
    const { itemId, reviewer, chat } = await passedReview({
      userVerifies: true,
      duringChat: (workdir) => writeFileSync(join(workdir, "src.txt"), "v2"),
    });

    expect(workspaceChanges(itemId)).toBe(1);
    expect(pendingReviewerRequests(itemId)).toEqual([]);
    const [ticket] = await readGatewayTickets(db);
    expect(ticket!.reviewState).toMatchObject({
      state: "waiting_user",
      reviewProgress: null,
      canRequestReview: true,
      supersededReview: { reviewerAttemptId: reviewer, verdict: "pass", supersededByRunId: chat },
    });
  });

  // 两次对话都改了工作区，第一次的检查还没算完，第二次就结束了：同一次交付也只排一条核查。
  it("queues a single review when two chats both change the workspace", async () => {
    const { runtime, deps } = harness(
      [conversationAnswer("PASS：全量测试通过。"), conversationAnswer("改好了。"), conversationAnswer("又改了一处。")],
      { executableReadOnlyReview: true },
    );
    const { itemId, workdir } = await passReview(deps);
    let release: () => void = () => {};
    let calls = 0;
    setWorkspaceTreeHashForTesting(async (target, options) => {
      calls += 1;
      // 第二次是第一次对话结束后的指纹：卡住它，直到第二次对话也结束、它的检查也算完。
      if (calls === 2) await new Promise<void>((done) => { release = done; });
      return workspaceTreeHash(target, options);
    });
    runtime.onStart = () => { writeFileSync(join(workdir, "src.txt"), `edited at hash call ${calls}`); };

    const first = routeTicketMessageToAgentRun(deps, { itemId, message: "改一下 src.txt" });
    await vi.waitFor(() => expect(calls).toBe(2), BACKGROUND_WAIT);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), BACKGROUND_WAIT);
    const second = routeTicketMessageToAgentRun(deps, { itemId, message: "再改一处" });
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), BACKGROUND_WAIT);
    await vi.waitFor(() => expect(workspaceChanges(itemId)).toBe(1), BACKGROUND_WAIT);
    release();
    await conversationWorkspaceChecksSettled();

    expect(first.runId).toBeLessThan(second.runId);
    expect(pendingReviewerRequests(itemId)).toHaveLength(1);
    expect((await readGatewayTickets(db))[0]!.reviewState).toMatchObject({ reviewProgress: "queued", canRequestReview: false });
  });

  it("keeps the PASS when the chat only read the workspace", async () => {
    await passedReview();

    const [ticket] = await readGatewayTickets(db);
    expect(ticket!.reviewState).toMatchObject({ state: "review_passed", supersededReview: null });
  });

  // N1：核查之后、对话之前，共用工作区的其他工单或用户自己改了文件。那不是这次对话改的。
  it("keeps the PASS when the workspace changed before the chat started", async () => {
    const { itemId } = await passedReview({
      beforeChat: (workdir) => writeFileSync(join(workdir, "src.txt"), "edited by a sibling ticket"),
    });

    expect((await readGatewayTickets(db))[0]!.reviewState).toMatchObject({ state: "review_passed", supersededReview: null });
    expect(workspaceChanges(itemId)).toBe(0);
  });

  // N2：git 仓库只看 git 的视角，被忽略的测试缓存不算改动。
  it("ignores a change to a file that git ignores, such as a test cache", async () => {
    const { itemId } = await passedReview({
      git: true,
      duringChat: (workdir) => {
        mkdirSync(join(workdir, "cache"), { recursive: true });
        writeFileSync(join(workdir, "cache", "result.json"), "{}");
      },
    });

    expect((await readGatewayTickets(db))[0]!.reviewState).toMatchObject({ state: "review_passed" });
    expect(workspaceChanges(itemId)).toBe(0);
  });

  // 第三轮 F1：Run 结束以后先释放工单，再在后台算结束后的指纹。算指纹的时候用户再发一句话不能撞上
  // "已有 child 在运行"。第四轮：这时新的 Run 已经开始，第一次对话的改动照样要记——第二次对话启动前的
  // 指纹已经包含了这次改动，它自己量不出来。第二次对话只读，PASS 也必须过期。
  it("releases the ticket before it hashes the workspace after a chat", async () => {
    const { runtime, deps } = harness(
      [conversationAnswer("PASS：全量测试通过。"), conversationAnswer("回答完了。"), conversationAnswer("第二个回答。")],
      { executableReadOnlyReview: true },
    );
    const { itemId, workdir } = await passReview(deps);
    let release: () => void = () => {};
    let calls = 0;
    setWorkspaceTreeHashForTesting(async (target, options) => {
      calls += 1;
      // 第二次是第一次对话结束后的指纹：卡住它，直到测试放行。
      if (calls === 2) await new Promise<void>((done) => { release = done; });
      return workspaceTreeHash(target, options);
    });
    // 只有第一次对话改文件（它启动时 calls 是 1：只算过启动前的指纹）。第二次对话只读。
    runtime.onStart = () => { if (calls === 1) writeFileSync(join(workdir, "src.txt"), "edited by the first chat"); };

    const first = routeTicketMessageToAgentRun(deps, { itemId, message: "改一下 src.txt" });
    await vi.waitFor(() => expect(calls).toBe(2), BACKGROUND_WAIT);
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), BACKGROUND_WAIT);
    // 以前 runItem 要等指纹算完才返回，这一句会撞上"已有 child 在运行"。
    const second = routeTicketMessageToAgentRun(deps, { itemId, message: "再看一眼" });
    await vi.waitFor(() => expect(runningChildren().has(itemId)).toBe(false), BACKGROUND_WAIT);
    release();
    await conversationWorkspaceChecksSettled();

    const changes = db.prepare(
      `SELECT run_id FROM activities
       WHERE item_id=? AND json_extract(payload, '$.decision')='workspace_changed_after_review' ORDER BY id`,
    ).all(itemId) as Array<{ run_id: number }>;
    expect(changes.map((row) => row.run_id)).toEqual([first.runId]);
    expect(first.runId).toBeLessThan(second.runId);
    // 改动记在更新的 Run 之后，核查照样排，而且只排一条。
    expect(pendingReviewerRequests(itemId)).toEqual([{
      trigger: "automatic-review",
      key: `automatic-review:${itemId}:conversation-run:${first.runId}`,
      state: "pending",
    }]);
    expect((await readGatewayTickets(db))[0]!.reviewState).toMatchObject({
      state: "independent_review", reviewProgress: "queued", canRequestReview: false,
    });
  });

  // N2：工单不在 review 时从不检查。done 的工单上让结论过期，会翻回旧的失败证据。
  it("never checks a ticket that is no longer in review", async () => {
    const { itemId } = await passedReview({
      beforeChat: (_workdir, id) => { transition(db, { itemId: id, to: "done", actor: "user", reason: "accepted" }); },
      duringChat: (workdir) => writeFileSync(join(workdir, "src.txt"), "v2"),
    });

    expect(getItem(db, itemId)!.stage).toBe("done");
    expect(workspaceChanges(itemId)).toBe(0);
  });
});

// 第二轮 release review N5：Lead 排的 reviewer 请求（spawn-suspended）没有写明它要核查哪一次交付。
// 用户返工并直接点"开始执行"时，dispatcher 一次也没看到工单离开 review；新交付回到 review 以后，
// 这条请求看起来就像是为新交付排的。新交付开始时就要作废它。
describe("a reviewer request queued before the next delivery", () => {
  it("expires when the next delivery starts, so it never reviews the new delivery", async () => {
    const { deps, settled } = harness([deliveryRecoveredFromOutput()]);
    const itemId = createItem(db, {
      title: "user-accepted ticket", brief: "implement the outcome snapshot protocol", createdBy: "user", runtime: "claude",
    });
    db.prepare("UPDATE items SET verification_policy='user' WHERE id=?").run(itemId);
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    const first = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, first, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: first });
    const requestId = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "claude",
      trigger: "spawn-suspended", idempotencyKey: `spawn-suspended:${itemId}:reviewer:incident:1`,
    });

    transition(db, { itemId, to: "active", actor: "user", reason: "rework" });
    spawnItemChild(deps, itemId, {});
    await settled();

    expect(getItem(db, itemId)!.stage).toBe("review");
    expect(db.prepare("SELECT state FROM dispatch_requests WHERE id=?").get(requestId)).toEqual({ state: "cancelled" });
    const [ticket] = await readGatewayTickets(db);
    expect(ticket!.reviewState).toMatchObject({ reviewProgress: null, canRequestReview: true });
  });
});

// 第二轮 release review N4：工单没有工作区、算不出哈希时，只按明确改文件的工具判断。
// 跑一条 shell 命令（测试、git status、cat）不算改了工作区；以前 bash 也算，一个只读问题就让 PASS 过期。
describe("a chat on a ticket without a workspace hash", () => {
  async function chatAfterPass(tool: string) {
    const { deps, settled } = harness([conversationWithTool(tool, "看过了。")], { executableReadOnlyReview: true });
    const itemId = createItem(db, {
      title: "no workspace", brief: "b", createdBy: "user", runtime: "claude", verificationPolicy: "independent_reviewer",
    });
    db.prepare("UPDATE items SET acceptance_policy='user_only' WHERE id=?").run(itemId);
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    const delivery = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, delivery, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery });
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "claude" });
    updateRun(db, reviewer, { state: "running" });
    createDispatcher(db).submitReviewVerdict({ runId: reviewer, verdict: "pass", evidence: "green" });
    db.prepare("UPDATE runs SET external_session_id=? WHERE id=?").run(SESSION, reviewer);

    routeTicketMessageToAgentRun(deps, { itemId, message: "这个单子的测试怎么跑？" });
    await settled();
    return (await readGatewayTickets(db))[0]!.reviewState;
  }

  it("keeps the PASS when the chat only ran a shell command", async () => {
    expect(await chatAfterPass("Bash")).toMatchObject({ state: "review_passed", supersededReview: null });
  });

  it("expires the PASS when the chat used a file-edit tool, and queues a new review", async () => {
    expect(await chatAfterPass("Edit")).toMatchObject({
      state: "independent_review", reviewProgress: "queued", canRequestReview: false,
    });
  });
});

describe("a chat with the reviewer agent", () => {
  it("does not lock the workspace or open a review check, because it is not a review", async () => {
    const { deps, settled } = harness(
      [conversationAnswer("核查结论是 FAIL，原因是全量测试红。")],
      { executableReadOnlyReview: true },
    );
    // 工作目录必须在 PLC 数据目录之外。
    const workdir = tempDir("plc-ticket66-repo-");
    const itemId = createItem(db, {
      title: "reviewed ticket", brief: "b", createdBy: "user", runtime: "claude",
      verificationPolicy: "independent_reviewer", workdir,
    });
    transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    const delivery = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    updateRun(db, delivery, { state: "finished", endedAt: true, exitCode: 0 });
    transition(db, { itemId, to: "review", actor: "child", reason: "done", runId: delivery });
    // 最后一个有会话的 Run 是 reviewer：用户的提问会续接它，role 仍是 reviewer，purpose 是 conversation。
    const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "claude" });
    updateRun(db, reviewer, { state: "finished", endedAt: true, exitCode: 0 });
    db.prepare("UPDATE runs SET external_session_id=? WHERE id=?").run(SESSION, reviewer);
    const workspaceStates: string[] = [];
    deps.onChildEvent = (_itemId, _runId, event) => {
      if (event.type !== "run.started") return;
      const row = db.prepare("SELECT state FROM workspaces WHERE owner_item_id=?").get(itemId) as { state: string } | undefined;
      if (row) workspaceStates.push(row.state);
    };

    const route = routeTicketMessageToAgentRun(deps, { itemId, message: "核查为什么没通过？" });
    await settled();

    expect(route).toMatchObject({ role: "reviewer", purpose: "conversation" });
    // 旧代码：对话一开始就把工作区锁成 review_hold，并开一条 review_workspace_checks。
    expect(workspaceStates).not.toContain("review_hold");
    expect(db.prepare("SELECT COUNT(*) AS n FROM review_workspace_checks WHERE run_id=?").get(route.runId))
      .toEqual({ n: 0 });
    expect(getItem(db, itemId)!.stage).toBe("review");
  });
});

