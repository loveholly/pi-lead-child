// child 的两个连接工具：经工具桥在 daemon 进程里调 host，角色按 Run 的 role 定（评审只拿只读工具）。
// child 自己的进程里没有 host（直接打开账本的模式），这时工具回答要经过 daemon，不悄悄做别的事。
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, createRun, openDb } from "@pi-lead-child/store";
import { AGENT_TOOL_DEFINITIONS, createAgentToolHandlers } from "../src/agent-tools/definitions.js";
import { setAgentConnectionHost, type AgentConnectionRole } from "../src/agent-tools/connection-host.js";

afterEach(() => setAgentConnectionHost(null));

function setup(role: "executor" | "reviewer") {
  const db = openDb(join(tempDir("plc-agent-conn-"), "plc.db"));
  const itemId = createItem(db, { title: "查 Jira", brief: "b", createdBy: "user" });
  // 评审 Run 只能开在 review 阶段的工单上。
  if (role === "reviewer") db.prepare("UPDATE items SET stage = 'review' WHERE id = ?").run(itemId);
  const runId = createRun(db, { itemId, role });
  return createAgentToolHandlers({ db, itemId, runId });
}

describe("connection tools for children", () => {
  it("are listed for every child", () => {
    const names = AGENT_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toContain("search_connection_tools");
    expect(names).toContain("call_connection_tool");
  });

  it("pass the run's role to the daemon's host", async () => {
    const seen: Array<{ role: AgentConnectionRole; what: string }> = [];
    setAgentConnectionHost({
      search: async (role, input) => { seen.push({ role, what: `search ${input.query}` }); return { ok: true, tools: [] }; },
      call: async (role, input) => { seen.push({ role, what: `call ${input.tool}` }); return { ok: true, text: "done" }; },
    });
    await setup("reviewer").call("search_connection_tools", { query: "issue" });
    await setup("executor").call("call_connection_tool", { connection: "atlassian", tool: "getJiraIssue", arguments: { issueIdOrKey: "PROJ-1" } });
    expect(seen).toEqual([{ role: "reviewer", what: "search issue" }, { role: "executor", what: "call getJiraIssue" }]);
  });

  it("say they need the daemon when the child has no bridge", async () => {
    await expect(setup("executor").call("search_connection_tools", {})).rejects.toThrow(/daemon tool bridge/);
  });

  it("reject unknown arguments and a non-object arguments field", async () => {
    setAgentConnectionHost({ search: async () => ({}), call: async () => ({}) });
    await expect(setup("executor").call("call_connection_tool", { connection: "a", tool: "b", extra: 1 })).rejects.toThrow();
    await expect(setup("executor").call("call_connection_tool", { connection: "a", tool: "b", arguments: [1] })).rejects.toThrow(/object/);
  });
});
