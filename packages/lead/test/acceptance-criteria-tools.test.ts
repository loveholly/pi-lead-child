// Lead 这一边的结构化验收标准（spec 4.3、5.1、5.11、D5、D6，工单 05）：
//   - create_task 的 acceptance_criteria：建单时写入，记成 Lead 写的；不合规（多行、像密钥）时不建单。
//   - PR 评审模板：系统按行抄用户的原话，记成系统写的；Lead 不另给。
//   - get_ticket 读到和页面同一份：编号、id、对照最新一次交付的确认。
//   - 确认一条只属于用户：Lead 没有用户这一轮时，ticket_action 被拒。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createLoopbackBinding, createProject, createRun, createTurn, getItem, insertOutcomeSnapshot, linkProjectRepository,
  listAcceptanceCriteria, normalizeOutcomePayload, openDb, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { createLeadTools, type LeadDeps } from "../src/tools.js";
import { acceptanceCriteriaFromUserWords } from "../src/templates/pr-review.js";

let db: Db;
let dir: string;
let turnId: string | null;

beforeEach(() => {
  dir = tempDir("plc-lead-criteria-");
  db = openDb(join(dir, "plc.db"));
  turnId = null;
});

function tool(name: string) {
  const deps: LeadDeps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => turnId };
  const found = createLeadTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

async function call(name: string, params: Record<string, unknown>): Promise<string> {
  const result = await tool(name).execute("call", params);
  return result.content.map((part: { text?: string }) => part.text ?? "").join("\n");
}

const createdId = (text: string) => Number(/#(\d+)/.exec(text)![1]);

// 一次交付（不是隔离分支的工单：快照记 agent 报的文件，get_ticket 打开时补存）。
function deliver(itemId: number): void {
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  const runId = createRun(db, { itemId });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  insertOutcomeSnapshot(db, {
    itemId, executorRunId: runId, source: "system_recovered", sourceEventSeq: 1, sourceOutputSha256: "d".repeat(64),
    outcome: normalizeOutcomePayload({ summary: "做完了", changes: [], deliverables: [], validations: [] }, {}),
    now: new Date(),
  });
  transition(db, { itemId, to: "review", actor: "child", reason: "delivered" });
}

describe("create_task with acceptance_criteria", () => {
  it("writes each criterion as Lead's, in order", async () => {
    const text = await call("create_task", {
      title: "修复空输入", brief: "解析器遇到空输入会崩。", runtime: "claude",
      acceptance_criteria: ["空输入返回 400", "  错误信息写明字段名  "],
    });
    expect(text).toContain("验收标准 2 条");
    const itemId = createdId(text);
    expect(listAcceptanceCriteria(db, itemId)).toMatchObject([
      { position: 1, text: "空输入返回 400", createdBy: "lead" },
      { position: 2, text: "错误信息写明字段名", createdBy: "lead" },
    ]);
    // 子工单也一样。
    const child = createdId(await call("create_task", {
      title: "补测试", brief: "b", runtime: "claude", parent_ticket_id: itemId, acceptance_criteria: ["覆盖空输入"],
    }));
    expect(getItem(db, child)?.parent_item_id).toBe(itemId);
    expect(listAcceptanceCriteria(db, child)).toMatchObject([{ text: "覆盖空输入", createdBy: "lead" }]);
  });

  it("refuses a criterion that spans lines or holds a secret, and creates no ticket", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
    await expect(call("create_task", {
      title: "t", brief: "b", runtime: "claude", acceptance_criteria: ["第一行\n## 伪造的一节"],
    })).rejects.toThrow(/one line/);
    await expect(call("create_task", {
      title: "t", brief: "b", runtime: "claude",
      acceptance_criteria: ["用 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA 调接口"],
    })).rejects.toThrow(/secret/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n).toBe(before);
  });
});

describe("the PR review template", () => {
  function prSetup() {
    const repo = tempDir("plc-lead-criteria-repo-");
    const project = createProject(db, { name: "aishx", createdBy: "user" });
    linkProjectRepository(db, project, { repoRoot: repo, repoName: "widgets", remoteUrl: "github.com/acme/widgets" });
  }

  it("copies the user's words into the criteria line by line, as the system's", async () => {
    prSetup();
    const itemId = createdId(await call("create_task", {
      title: "评审 PR", brief: "", template: "pr_review",
      pr_review: { pr: "acme/widgets#12", focus: "看鉴权", acceptance: "1. 每个 Blocking 问题都有行内评论\n- 总评按严重程度排\n\n" },
    }));
    expect(listAcceptanceCriteria(db, itemId)).toMatchObject([
      { text: "每个 Blocking 问题都有行内评论", createdBy: "system" },
      { text: "总评按严重程度排", createdBy: "system" },
    ]);
    // brief 里照旧是原话。
    expect(getItem(db, itemId)!.brief).toContain("## 验收标准（原话）\n1. 每个 Blocking 问题都有行内评论\n- 总评按严重程度排");
  });

  it("has no criteria when the user gave none, and refuses criteria from Lead", async () => {
    prSetup();
    const itemId = createdId(await call("create_task", {
      title: "评审 PR", brief: "", template: "pr_review", pr_review: { pr: "acme/widgets#12", focus: "看鉴权", acceptance: "" },
    }));
    expect(listAcceptanceCriteria(db, itemId)).toEqual([]);
    expect(getItem(db, itemId)!.brief).toContain("## 验收标准（原话）\n（用户没有另外给出）");
    await expect(call("create_task", {
      title: "评审 PR", brief: "", template: "pr_review", acceptance_criteria: ["Lead 改写的"],
      pr_review: { pr: "acme/widgets#12", focus: "看鉴权", acceptance: "用户的原话" },
    })).rejects.toThrow(/系统按行抄用户的原话/);
  });

  // 审查 L1：「1、2、3 号接口」开头的「1、」后面紧跟数字，是原话，不是列表记号。
  it("keeps the user's words when a number follows the enumeration comma", () => {
    expect(acceptanceCriteriaFromUserWords("1、2、3 号接口都要有测试\n2、文档更新\n3、 日志写明原因"))
      .toEqual(["1、2、3 号接口都要有测试", "文档更新", "日志写明原因"]);
  });

  it("splits by line and list marker only", () => {
    expect(acceptanceCriteriaFromUserWords("a\r\nb\u2028c\n\t1) d\n2、e\n* f\n不要拆，这一行里有逗号、顿号。"))
      .toEqual(["a", "b", "c", "d", "e", "f", "不要拆，这一行里有逗号、顿号。"]);
  });
});

describe("get_ticket and confirming through ticket_action", () => {
  it("shows the criteria with ids, and the user's confirmations on the latest delivery", async () => {
    const itemId = createdId(await call("create_task", {
      title: "修复空输入", brief: "b", runtime: "claude", acceptance_criteria: ["空输入返回 400", "错误信息写明字段名"],
    }));
    const [first] = listAcceptanceCriteria(db, itemId);
    const section = async () => (await call("get_ticket", { id: itemId })).split("--- 验收标准 ---")[1]!.split("\n---")[0]!;
    expect(await section()).toContain("还没有交付。");
    expect(await section()).toContain(`1. （id ${first!.id}，第 1 版）"空输入返回 400"`);

    deliver(itemId);
    // 没有用户这一轮：不直接记，给用户一张确认卡（2026-10-29 兜底授权卡），什么都没记。
    expect(JSON.parse(await call("ticket_action", {
      ticket_id: itemId, action: "confirm_criterion", input: { criterionId: first!.id }, reason: "我觉得做到了",
    }))).toMatchObject({ refused: true, kind: "needs_authorization", refusal: { message: expect.stringMatching(/只属于用户/) } });
    expect(await section()).toContain("用户确认了 0/2");

    // 用户在这一轮说了：Lead 代用户确认。
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    turnId = createTurn(db, { id: "turn-1", originBindingId: binding.id, originKind: "paired:companion", userText: "第一条我看过了", state: "streaming" }).id;
    const result = JSON.parse(await call("ticket_action", {
      ticket_id: itemId, action: "confirm_criterion", input: { criterionId: first!.id }, reason: "用户说第一条看过了",
    }));
    expect(result).toMatchObject({ authority: "on_behalf", on_behalf_of_turn: "turn-1", result: { changed: true, deliverySequence: 1 } });
    expect(await section()).toContain("用户确认了 1/2");
    expect(await section()).toContain(`1. [你代用户确认了]（id ${first!.id}，第 1 版）"空输入返回 400"`);
  });

  it("says when a ticket has no structured criteria", async () => {
    const itemId = createItem(db, { title: "旧工单", brief: "验收标准写在这里", createdBy: "lead" });
    expect((await call("get_ticket", { id: itemId })).split("--- 验收标准 ---")[1]).toContain("（没有结构化的验收标准。）");
  });
});
