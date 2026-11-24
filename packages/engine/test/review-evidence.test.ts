// 工单 #503：核查员把核查工作区里的截图挂到工单详情的「核查证据」里。
// 以前截图只落在工作区的磁盘上，工单详情看不到。这里核对：
//   - 读文件只读核查的工作区：越界路径、指向区外的符号链接、敏感文件、不是图片的文件都拒绝；
//   - 核查员在核查时用 attach_review_evidence 挂，标明对应的验收标准；执行者和已经结束的核查不能用这个工具；
//   - 已经结束的核查经操作层 review_attempt.attach_evidence 补挂（页面和 Lead 同一个函数），不改工单阶段和核查结论。
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  addAcceptanceCriteria, createItem, createLoopbackBinding, createRun, createWorkspace, getItem, listReviewEvidence, openDb,
  readReviewEvidence, updateRun, type Db,
} from "@pi-lead-child/store";

import { createAgentToolHandlers, AGENT_TOOL_DEFINITIONS } from "../src/agent-tools/definitions.js";
import { readWorkspaceImage, ReviewEvidenceError } from "../src/agent-tools/review-evidence.js";
import { listUiActions, runUiAction, UI_ACTIONS } from "../src/index.js";

// 一个 1×1 的 PNG。
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PNG2 = Buffer.concat([PNG, Buffer.from([0])]);

let base: string;
let dataDir: string;
let workdir: string;
let outside: string;
let db: Db;
let itemId: number;
let criteria: number[];

beforeEach(() => {
  base = tempDir("plc-review-evidence-");
  dataDir = join(base, "data");
  workdir = join(base, "ws");
  outside = join(base, "outside");
  for (const dir of [dataDir, workdir, outside, join(workdir, ".scratch", "review"), join(workdir, ".git")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(workdir, ".scratch", "review", "desktop.png"), PNG);
  writeFileSync(join(workdir, ".scratch", "review", "mobile.png"), PNG2);
  writeFileSync(join(outside, "secret.png"), PNG);
  writeFileSync(join(workdir, "notes.txt"), "hello");
  writeFileSync(join(workdir, "fake.png"), "not an image");
  writeFileSync(join(workdir, "secrets.png"), PNG);
  writeFileSync(join(workdir, ".git", "shot.png"), PNG);
  symlinkSync(join(outside, "secret.png"), join(workdir, "escape.png"));
  symlinkSync(join(workdir, ".scratch", "review", "desktop.png"), join(workdir, "inside-link.png"));
  db = openDb(join(dataDir, "plc.db"));
  itemId = createItem(db, { title: "截图附到工单", brief: "b", createdBy: "lead", workdir });
  criteria = addAcceptanceCriteria(db, { itemId, texts: ["桌面能打开大图", "手机能翻页"], by: "lead" }).map((criterion) => criterion.id);
});

// 核查只在等验收（review）的工单上开（run-gate）。
function toReview(id: number) {
  db.prepare("UPDATE items SET stage = 'review' WHERE id = ?").run(id);
}

function reviewRun(state: "running" | "finished" = "running") {
  toReview(itemId);
  const runId = createRun(db, { itemId, role: "reviewer" });
  updateRun(db, runId, { state });
  return runId;
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReviewEvidenceError);
  return error as ReviewEvidenceError;
}

describe("reading an image from the review workspace", () => {
  it("reads an image by a relative path and by an absolute path inside the workspace", async () => {
    const relative = await readWorkspaceImage(workdir, ".scratch/review/desktop.png");
    expect(relative).toMatchObject({ path: ".scratch/review/desktop.png", name: "desktop.png", mimeType: "image/png" });
    const absolute = await readWorkspaceImage(workdir, join(workdir, ".scratch/review/mobile.png"));
    expect(absolute.path).toBe(".scratch/review/mobile.png");
  });

  it("follows a symlink that stays inside the workspace", async () => {
    expect((await readWorkspaceImage(workdir, "inside-link.png")).path).toBe(".scratch/review/desktop.png");
  });

  it("refuses paths that leave the workspace, also through ..", async () => {
    expect((await refusal(readWorkspaceImage(workdir, "../outside/secret.png"))).code).toBe("not_allowed");
    expect((await refusal(readWorkspaceImage(workdir, join(outside, "secret.png")))).code).toBe("not_allowed");
    expect((await refusal(readWorkspaceImage(workdir, ".scratch/../../outside/secret.png"))).code).toBe("not_allowed");
  });

  it("refuses a symlink that points outside the workspace", async () => {
    const error = await refusal(readWorkspaceImage(workdir, "escape.png"));
    expect(error.code).toBe("not_allowed");
    expect(error.message).toContain("符号链接");
  });

  it("refuses secret-looking files and files inside .git", async () => {
    expect((await refusal(readWorkspaceImage(workdir, "secrets.png"))).code).toBe("not_allowed");
    expect((await refusal(readWorkspaceImage(workdir, ".git/shot.png"))).code).toBe("not_allowed");
    expect((await refusal(readWorkspaceImage(workdir, ".env"))).code).toBe("not_allowed");
  });

  it("refuses files that are not supported images, by name and by content", async () => {
    expect((await refusal(readWorkspaceImage(workdir, "notes.txt"))).code).toBe("invalid_input");
    expect((await refusal(readWorkspaceImage(workdir, "fake.png"))).code).toBe("invalid_input");
    expect((await refusal(readWorkspaceImage(workdir, ".scratch/review"))).code).toBe("invalid_input");
    expect((await refusal(readWorkspaceImage(workdir, "missing.png"))).code).toBe("not_found");
  });
});

describe("attach_review_evidence (the reviewer's tool)", () => {
  it("is in the shared tool list, so Pi, Codex and Claude reviewers all get it", () => {
    expect(AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toContain("attach_review_evidence");
  });

  it("attaches screenshots with the criteria they prove, and attaches the same image only once", async () => {
    const runId = reviewRun();
    const handlers = createAgentToolHandlers({ db, itemId, runId, dataDir });
    const result = await handlers.call("attach_review_evidence", { files: [
      { path: ".scratch/review/desktop.png", criteria: [criteria[0]], caption: "桌面打开大图" },
      { path: ".scratch/review/mobile.png", criteria: [criteria[1], criteria[0]] },
    ] }) as { attached: unknown[]; already_attached: unknown[] };
    expect(result.attached).toHaveLength(2);
    const listed = listReviewEvidence(db, itemId);
    expect(listed).toEqual([
      expect.objectContaining({ attemptId: runId, path: ".scratch/review/desktop.png", criterionIds: [criteria[0]], caption: "桌面打开大图", addedBy: "reviewer" }),
      // 标准按工单里的顺序排。
      expect.objectContaining({ path: ".scratch/review/mobile.png", criterionIds: [criteria[0], criteria[1]], caption: null }),
    ]);
    const { data } = await readReviewEvidence(db, dataDir, itemId, listed[0]!.id);
    expect(data.equals(PNG)).toBe(true);

    const again = await handlers.call("attach_review_evidence", { files: [{ path: "inside-link.png", criteria: [criteria[0]] }] }) as { attached: unknown[]; already_attached: unknown[] };
    expect(again.attached).toHaveLength(0);
    expect(again.already_attached).toHaveLength(1);
    expect(listReviewEvidence(db, itemId)).toHaveLength(2);
  });

  it("attaches nothing when one file of the call is refused", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId: reviewRun(), dataDir });
    await expect(handlers.call("attach_review_evidence", { files: [
      { path: ".scratch/review/desktop.png", criteria: [criteria[0]] },
      { path: "escape.png", criteria: [criteria[0]] },
    ] })).rejects.toThrow(/符号链接/);
    expect(listReviewEvidence(db, itemId)).toEqual([]);
  });

  it("asks for the criteria an image proves, and refuses ids from another ticket", async () => {
    const handlers = createAgentToolHandlers({ db, itemId, runId: reviewRun(), dataDir });
    await expect(handlers.call("attach_review_evidence", { files: [{ path: ".scratch/review/desktop.png", criteria: [] }] }))
      .rejects.toThrow(/至少写一条/);
    await expect(handlers.call("attach_review_evidence", { files: [{ path: ".scratch/review/desktop.png", criteria: [999_999] }] }))
      .rejects.toThrow(/不是这张工单的验收标准/);
  });

  it("refuses an executor and a review that has ended", async () => {
    const executorRun = createRun(db, { itemId });
    updateRun(db, executorRun, { state: "running" });
    await expect(createAgentToolHandlers({ db, itemId, runId: executorRun, dataDir })
      .call("attach_review_evidence", { files: [{ path: ".scratch/review/desktop.png", criteria: [criteria[0]] }] }))
      .rejects.toThrow(/only the reviewer/);
    await expect(createAgentToolHandlers({ db, itemId, runId: reviewRun("finished"), dataDir })
      .call("attach_review_evidence", { files: [{ path: ".scratch/review/desktop.png", criteria: [criteria[0]] }] }))
      .rejects.toThrow(/has ended/);
  });

  it("reads from the review's own workspace when it has one", async () => {
    const shared = join(base, "review-ws");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "only-here.png"), PNG);
    const workspace = createWorkspace(db, { ownerItemId: itemId, mode: "shared", kind: "primary", path: shared, state: "active" });
    toReview(itemId);
    const runId = createRun(db, { itemId, role: "reviewer", workspaceId: workspace.id });
    updateRun(db, runId, { state: "running" });
    const handlers = createAgentToolHandlers({ db, itemId, runId, dataDir });
    await handlers.call("attach_review_evidence", { files: [{ path: "only-here.png", criteria: [criteria[0]] }] });
    // 工单的工作目录不是这次核查的工作区：那里的文件不读。
    await expect(handlers.call("attach_review_evidence", { files: [{ path: join(workdir, ".scratch/review/mobile.png"), criteria: [criteria[0]] }] }))
      .rejects.toThrow(/不在这次核查的工作区里/);
  });
});

describe("review_attempt.attach_evidence (backfill for an ended review)", () => {
  const services = () => ({ dataDir });

  function finishedReviewWithVerdict() {
    const runId = reviewRun("finished");
    db.prepare("INSERT INTO review_verdicts (run_id, item_id, verdict, evidence, pre_hash, post_hash) VALUES (?, ?, 'pass', '两条都通过', 'a', 'b')")
      .run(runId, itemId);
    return runId;
  }

  it("is one lead_allowed operation that does not change rules and is not irreversible", () => {
    expect(UI_ACTIONS.review_attempt.attach_evidence).toMatchObject({
      permission: "lead_allowed", changesRules: false, external: false, irreversible: false,
    });
  });

  it("lets the user attach screenshots of an ended review without changing the stage or the verdict", async () => {
    const runId = finishedReviewWithVerdict();
    const verdictBefore = db.prepare("SELECT * FROM review_verdicts WHERE run_id = ?").get(runId);
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    const outcome = await runUiAction(db, {
      target: { type: "review_attempt", id: String(runId) }, action: "attach_evidence", services: services(),
      input: { files: [{ path: ".scratch/review/desktop.png", criteria: [criteria[0]], caption: "补挂的桌面截图" }] },
      caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } } as never,
    });
    expect(outcome.result).toMatchObject({ ticketId: itemId, attemptId: runId });
    expect(listReviewEvidence(db, itemId)).toEqual([expect.objectContaining({ attemptId: runId, addedBy: "user", caption: "补挂的桌面截图" })]);
    expect(getItem(db, itemId)?.stage).toBe("review");
    expect(db.prepare("SELECT * FROM review_verdicts WHERE run_id = ?").get(runId)).toEqual(verdictBefore);
    expect((db.prepare("SELECT COUNT(*) AS n FROM runs WHERE item_id = ?").get(itemId) as { n: number }).n).toBe(1);
  });

  it("lets Lead attach them too, and refuses a path outside the workspace", async () => {
    const runId = finishedReviewWithVerdict();
    const target = { type: "review_attempt", id: String(runId) } as const;
    const outcome = await runUiAction(db, {
      target, action: "attach_evidence", services: services(), reason: "用户要看 #1 的核查截图", caller: { kind: "lead", turnId: null },
      input: { files: [{ path: ".scratch/review/mobile.png", criteria: [criteria[1]] }] },
    });
    expect(outcome.forLead).toMatchObject({ attached: [expect.objectContaining({ path: ".scratch/review/mobile.png" })] });
    expect(listReviewEvidence(db, itemId)[0]).toMatchObject({ addedBy: "lead" });
    await expect(runUiAction(db, {
      target, action: "attach_evidence", services: services(), reason: "再补一张", caller: { kind: "lead", turnId: null },
      input: { files: [{ path: "../outside/secret.png", criteria: [criteria[1]] }] },
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("is not available while the review runs, or when its workspace is gone", async () => {
    const running = reviewRun("running");
    const [view] = await listUiActions(db, { type: "review_attempt", id: String(running) }, { services: services() });
    expect(view).toMatchObject({ available: false, reason: expect.stringContaining("attach_review_evidence") });

    const goneItem = createItem(db, { title: "旧工单", brief: "b", createdBy: "lead", workdir: join(base, "gone") });
    toReview(goneItem);
    const goneRun = createRun(db, { itemId: goneItem, role: "reviewer" });
    updateRun(db, goneRun, { state: "finished" });
    const [gone] = await listUiActions(db, { type: "review_attempt", id: String(goneRun) }, { services: services() });
    expect(gone).toMatchObject({ available: false, reason: expect.stringContaining("清掉") });
  });

  it("does not treat an executor's run as a review", async () => {
    const executorRun = createRun(db, { itemId });
    await expect(listUiActions(db, { type: "review_attempt", id: String(executorRun) }, { services: services() }))
      .rejects.toMatchObject({ code: "not_found" });
  });
});
