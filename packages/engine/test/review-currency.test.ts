// 决策边界（release review 5，第二轮 N1/N2/N4）：工单对话 Run 自己改了工作区，核查结论才过期。
// 只量这个 Run 自己的影响：启动前、结束后各算一次指纹，两次不一样才算改过。
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, transition } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  WORKSPACE_CHANGE_CHECK_FAILED,
  beginConversationWorkspaceCheck,
  createDispatcher,
  effectiveRunPurpose,
  finishConversationWorkspaceCheck,
  loadConversationWorkspaceCheck,
  recordEffectiveRunPurpose,
  reviewerProgress,
  setWorkspaceTreeHashForTesting,
  staleReviewRequestReason,
  verificationState,
  workspaceTreeHash,
} from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-review-currency-"), "plc.db"));
});

afterEach(() => {
  setWorkspaceTreeHashForTesting();
});

/** 一张停在 review、带着当前有效 PASS 的工单。userVerifies：由用户验收，不要求独立核查。 */
function passedItem(options: { userVerifies?: boolean } = {}): { itemId: number; delivery: number; reviewer: number } {
  const itemId = createItem(db, {
    title: "deliver", brief: "b", createdBy: "system", verificationPolicy: "independent_reviewer",
  });
  db.prepare("UPDATE items SET acceptance_policy='user_only' WHERE id=?").run(itemId);
  if (options.userVerifies) {
    db.prepare("UPDATE items SET verification_policy='user' WHERE id=?").run(itemId);
  }
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn_child" });
  const delivery = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
  updateRun(db, delivery, { state: "finished", endedAt: true, exitCode: 0 });
  transition(db, { itemId, to: "review", actor: "system", reason: "delivered", runId: delivery });
  const reviewer = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
  updateRun(db, reviewer, { state: "running" });
  createDispatcher(db).submitReviewVerdict({ runId: reviewer, verdict: "pass", evidence: "green" });
  updateRun(db, reviewer, { state: "finished", endedAt: true, exitCode: 0 });
  return { itemId, delivery, reviewer };
}

/** 排着队的 reviewer 请求。 */
function pendingReviews(itemId: number) {
  return db.prepare(
    `SELECT id, item_id, trigger, idempotency_key, retry_of_run_id FROM dispatch_requests
     WHERE item_id=? AND role='reviewer' AND state='pending' ORDER BY id`,
  ).all(itemId) as Array<{
    id: number; item_id: number; trigger: string; idempotency_key: string; retry_of_run_id: number | null;
  }>;
}

function chatRun(itemId: number, tools: string[] = []): number {
  const chat = createRun(db, { itemId, role: "executor", purpose: "conversation", runtime: "claude" });
  tools.forEach((name, index) => {
    db.prepare(
      "INSERT INTO runtime_events (run_id, seq, event_type, payload, occurred_at) VALUES (?, ?, 'tool.started', ?, ?)",
    ).run(chat, index + 1, JSON.stringify({ type: "tool.started", runId: chat, seq: index + 1, callId: `c-${index}`, name, args: {} }),
      new Date().toISOString());
  });
  return chat;
}

function workdir(): string {
  const dir = tempDir("plc-review-currency-repo-");
  writeFileSync(join(dir, "src.txt"), "v1");
  return dir;
}

function decisions(itemId: number, decision: string): number {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM activities WHERE item_id=? AND json_extract(payload, '$.decision')=?",
  ).get(itemId, decision) as { n: number }).n;
}

describe("verification currency after a ticket conversation", () => {
  it("expires the verdict when the chat run itself changed its workspace", async () => {
    const { itemId, reviewer } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(true);
    expect(verificationState(db, itemId)).toMatchObject({
      status: "unknown", current: null, latest: { run_id: reviewer }, supersededByRunId: chat,
    });
  });

  it("keeps the verdict when the workspace changed before the chat run started", async () => {
    const { itemId } = passedItem();
    const path = workdir();
    // 核查之后、对话之前，别的工单或用户改了文件。
    writeFileSync(join(path, "src.txt"), "edited before the chat");
    const chat = chatRun(itemId, ["Edit"]);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(false);
    expect(verificationState(db, itemId).status).toBe("pass");
  });

  it("does not check a run that is not a conversation, or a ticket that is not in review", async () => {
    const { itemId } = passedItem();
    const path = workdir();
    expect(await beginConversationWorkspaceCheck(db, { itemId, runId: 99, purpose: "execution", path })).toBeNull();

    transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });
    expect(await beginConversationWorkspaceCheck(db, { itemId, runId: chatRun(itemId), purpose: "conversation", path }))
      .toBeNull();
  });

  it("stops checking when the ticket leaves review during the chat", async () => {
    const { itemId } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");
    transition(db, { itemId, to: "done", actor: "user", reason: "accepted" });

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(false);
    expect(decisions(itemId, "workspace_changed_after_review")).toBe(0);
  });

  it("does not expire the verdict when the hash cannot be computed, and records why", async () => {
    const { itemId } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId, ["Edit"]);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    rmSync(path, { recursive: true, force: true });

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(false);
    expect(verificationState(db, itemId).status).toBe("pass");
    expect(decisions(itemId, WORKSPACE_CHANGE_CHECK_FAILED)).toBe(1);
  });

  it("does not expire the verdict when the post-run hash times out", async () => {
    const { itemId } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId, ["Edit"]);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    setWorkspaceTreeHashForTesting(() => Promise.reject(new Error("workspace hash timed out after 30000ms")));

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(false);
    expect(verificationState(db, itemId).status).toBe("pass");
    expect(decisions(itemId, WORKSPACE_CHANGE_CHECK_FAILED)).toBe(1);
  });

  // 第三轮 F4：启动前的指纹会推迟对话开始。它只有几秒的预算；超时就跳过这次检查，每个 Run 最多记一条失败。
  it("skips the check when the pre-run hash exceeds its short budget, and records one failure per run", async () => {
    const { itemId } = passedItem();
    const chat = chatRun(itemId, ["Edit"]);
    setWorkspaceTreeHashForTesting(() => new Promise((done) => setTimeout(() => done("late"), 2_000)));
    const started = Date.now();

    const check = await beginConversationWorkspaceCheck(
      db, { itemId, runId: chat, purpose: "conversation", path: workdir() }, { budgetMs: 50 },
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(check).toBeNull();
    await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path: workdir() }, { budgetMs: 50 });

    expect(decisions(itemId, WORKSPACE_CHANGE_CHECK_FAILED)).toBe(1);
    expect(verificationState(db, itemId).status).toBe("pass");
  });

  // 第三轮 F5：接管的（或停机时分离的）对话 Run 没有启动前的内存记录。启动前的指纹落在活动里，
  // 接管以后照样能比。
  it("checks an adopted chat run against the hash recorded before the daemon restarted", async () => {
    const { itemId } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId);
    await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");

    const adopted = loadConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation" });
    expect(await finishConversationWorkspaceCheck(db, adopted)).toBe(true);
    expect(verificationState(db, itemId)).toMatchObject({ status: "unknown", supersededByRunId: chat });
  });

  it("falls back to file-edit tools for an adopted chat run with no recorded hash", async () => {
    const { itemId } = passedItem();
    const shell = chatRun(itemId, ["Bash"]);
    expect(await finishConversationWorkspaceCheck(db, loadConversationWorkspaceCheck(db, {
      itemId, runId: shell, purpose: "conversation",
    }))).toBe(false);

    const editing = chatRun(itemId, ["Edit"]);
    expect(await finishConversationWorkspaceCheck(db, loadConversationWorkspaceCheck(db, {
      itemId, runId: editing, purpose: "conversation",
    }))).toBe(true);
  });

  // 第三轮 F1：结论在算指纹的这段时间里可能已经变了。写之前再看一次。
  it("records nothing when the user accepted the ticket while the post-run hash was running", async () => {
    const { itemId } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");
    setWorkspaceTreeHashForTesting(async (target, options) => {
      transition(db, { itemId, to: "done", actor: "user", reason: "accepted during the hash" });
      return workspaceTreeHash(target, options);
    });

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(false);
    expect(decisions(itemId, "workspace_changed_after_review")).toBe(0);
    expect(pendingReviews(itemId)).toEqual([]);
  });

  // 第四轮：算指纹期间又开始了一个 Run（用户追问、Lead 转来的消息、reviewer 认领），这次对话的改动
  // 照样要记。新的 Run 启动前的指纹已经包含了这次改动，它自己量不出来；不记的话 PASS 就一直挂着。
  it("records the change even when a newer run started while the post-run hash was running", async () => {
    const { itemId, reviewer } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");
    setWorkspaceTreeHashForTesting(async (target, options) => {
      chatRun(itemId);
      return workspaceTreeHash(target, options);
    });

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(true);
    expect(verificationState(db, itemId)).toMatchObject({ status: "unknown", latest: { run_id: reviewer } });
    // 更新的 Run 不影响排核查：照样排，而且只排一条。
    expect(pendingReviews(itemId).map((request) => request.idempotency_key))
      .toEqual([`automatic-review:${itemId}:conversation-run:${chat}`]);
  });

  // 记改动之前，那条结论已经被一次更新的核查替换了：改动属于新核查之前，新核查看过的就是改过的成果。
  it("records nothing when a newer review replaced the verdict while the post-run hash was running", async () => {
    const { itemId } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");
    let again = 0;
    setWorkspaceTreeHashForTesting(async (target, options) => {
      again = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
      updateRun(db, again, { state: "running" });
      createDispatcher(db).submitReviewVerdict({ runId: again, verdict: "pass", evidence: "reviewed v2" });
      return workspaceTreeHash(target, options);
    });

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(false);
    expect(verificationState(db, itemId)).toMatchObject({ status: "pass", current: { run_id: again } });
    expect(pendingReviews(itemId)).toEqual([]);
  });

  it("falls back to file-edit tools when the run has no workspace path", async () => {
    const { itemId } = passedItem();

    const shell = chatRun(itemId, ["Read", "Bash", "command_execution"]);
    const shellCheck = await beginConversationWorkspaceCheck(db, { itemId, runId: shell, purpose: "conversation", path: null });
    expect(await finishConversationWorkspaceCheck(db, shellCheck)).toBe(false);
    expect(verificationState(db, itemId).status).toBe("pass");

    const editing = chatRun(itemId, ["Read", "Edit"]);
    const editCheck = await beginConversationWorkspaceCheck(db, { itemId, runId: editing, purpose: "conversation", path: null });
    expect(await finishConversationWorkspaceCheck(db, editCheck)).toBe(true);
    expect(verificationState(db, itemId)).toMatchObject({ status: "unknown", supersededByRunId: editing });
  });

  // 要求独立核查的工单：记下改动的同一笔事务里，为同一次交付排一条自动核查。
  it("queues one automatic review of the same delivery when it records the change", async () => {
    const { itemId, delivery } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");

    expect(await finishConversationWorkspaceCheck(db, check, { reviewerRuntime: "claude" })).toBe(true);
    const [request, ...rest] = pendingReviews(itemId);
    expect(rest).toEqual([]);
    expect(request).toMatchObject({
      trigger: "automatic-review", idempotency_key: `automatic-review:${itemId}:conversation-run:${chat}`,
    });
    expect(db.prepare("SELECT runtime FROM dispatch_requests WHERE id=?").get(request!.id)).toEqual({ runtime: "claude" });
    expect(db.prepare(
      `SELECT json_extract(payload, '$.reviewDeliveryRunId') AS delivery FROM activities
       WHERE json_extract(payload, '$.decision')='dispatch_requested' AND json_extract(payload, '$.dispatchRequestId')=?`,
    ).get(request!.id)).toEqual({ delivery });
    // 请求是为当前这次交付排的，不算过期；卡片读到的是"排队中"。
    expect(staleReviewRequestReason(db, request!)).toBeNull();
    expect(reviewerProgress(db, itemId)).toEqual({ state: "queued" });
  });

  it("queues no review on a ticket the user verifies", async () => {
    const { itemId } = passedItem({ userVerifies: true });
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(true);
    expect(verificationState(db, itemId)).toMatchObject({ status: "unknown", supersededByRunId: chat });
    expect(pendingReviews(itemId)).toEqual([]);
  });

  // 同一次交付只排一条核查：已经有一条排着（例如 Lead 在 PASS 还有效时排的），改动让它重新成立，不再排第二条。
  it("does not queue a second review when one is already queued for the delivery", async () => {
    const { itemId } = passedItem();
    const queued = createDispatcher(db).request({
      itemId, role: "reviewer", purpose: "review", runtime: "codex",
      trigger: "lead-review", idempotencyKey: `lead-review:${itemId}:1`,
    });
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");

    expect(await finishConversationWorkspaceCheck(db, check)).toBe(true);
    expect(pendingReviews(itemId).map((request) => request.id)).toEqual([queued]);
  });

  // 排不上核查不能撤销过期的记录：卡片照实写"独立核查未派发"，用户可以手动派发。
  it("keeps the recorded change and notes why when the review cannot be queued", async () => {
    const { itemId, reviewer } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");

    expect(await finishConversationWorkspaceCheck(db, check, { reviewerRuntime: "no-such-runtime" as never })).toBe(true);
    expect(verificationState(db, itemId)).toMatchObject({ status: "unknown", latest: { run_id: reviewer } });
    expect(pendingReviews(itemId)).toEqual([]);
    expect(decisions(itemId, "automatic_review_request_failed")).toBe(1);
  });

  it("lets a later review make the verdict current again", async () => {
    const { itemId } = passedItem();
    const path = workdir();
    const chat = chatRun(itemId);
    const check = await beginConversationWorkspaceCheck(db, { itemId, runId: chat, purpose: "conversation", path });
    writeFileSync(join(path, "src.txt"), "v2");
    await finishConversationWorkspaceCheck(db, check);

    const again = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex" });
    updateRun(db, again, { state: "running" });
    createDispatcher(db).submitReviewVerdict({ runId: again, verdict: "fail", evidence: "v2 broke it" });

    expect(verificationState(db, itemId)).toMatchObject({ status: "fail", current: { run_id: again } });
  });
});

// 第四轮：Run 实际按什么用途跑，可能和库里的 purpose 不同（例如恢复控制按执行跑一个暂停的对话 Run）；
// daemon 重启后接管它时要按实际用途跑（lead 的 adoptRunChild）。
describe("effective run purpose", () => {
  it("remembers a different purpose, and forgets it when the run starts with its own purpose again", () => {
    const itemId = createItem(db, { title: "paused execution", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
    const run = () => ({ id: runId, purpose: "execution" as const });
    const recorded = () => decisions(itemId, "run_started_as");

    recordEffectiveRunPurpose(db, { itemId, runId, purpose: "execution", stored: "execution" });
    expect(recorded()).toBe(0);
    expect(effectiveRunPurpose(db, run())).toBe("execution");

    recordEffectiveRunPurpose(db, { itemId, runId, purpose: "conversation", stored: "execution" });
    expect(effectiveRunPurpose(db, run())).toBe("conversation");

    recordEffectiveRunPurpose(db, { itemId, runId, purpose: "execution", stored: "execution" });
    expect(effectiveRunPurpose(db, run())).toBe("execution");
    expect(recorded()).toBe(2);
  });
});
