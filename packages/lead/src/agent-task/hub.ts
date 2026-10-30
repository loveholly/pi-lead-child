// 子 agent 的工具接到连接中心：搜索和调用都带上 runId，连接中心从库里读这个 Run 现在的清单，按它检查（hub.ts）。
// 角色是 executor：用户在连接的设置里不让执行 agent 用某个连接时，子 agent 也用不了它。
import type { ConnectionHub } from "@pi-lead-child/connections";
import { describeRunGrant } from "@pi-lead-child/protocol";
import { getRunGrant, type Db } from "@pi-lead-child/store";
import type { AgentTaskConnections } from "./tools.js";

export function agentTaskConnections(hub: Pick<ConnectionHub, "searchTools" | "callTool" | "runReads">, db: Db): AgentTaskConnections {
  return {
    search: async (runId, input) => (await hub.searchTools("executor", input, { runId })).map((tool) => ({
      connection: tool.connection, name: tool.name, description: tool.description, readOnly: tool.readOnly,
      inputSchema: tool.inputSchema, ...(tool.allowedBy ? { allowedBy: tool.allowedBy } : {}),
    })),
    call: (runId, input, signal) => hub.callTool(input.connection, input.tool, input.arguments, {
      role: "executor", runId, ...(signal ? { signal } : {}),
    }),
    grant: (runId) => {
      const record = getRunGrant(db, runId);
      return record ? { revision: record.revision, labels: describeRunGrant(record.grant), grant: record.grant } : null;
    },
    reads: (runId) => hub.runReads(runId).content(),
  };
}
