// 子 agent 经连接中心做的写操作记进动作层（landing.md C3）。连接中心每做成一次写操作就调一次 recordAgentWrite：
//   - 每一次都在工单上记一条活动（agent_write）：Lead 派的子 agent 代你做的，凭的是这个 Run 的权限清单（哪一条规则）。
//   - 别人看得到的（例如提交了的 review、发出的评论）另记一条主人操作 connection.agent_write：daemon 的 owner-actions
//     那一步直接推给你（不经过 Lead），卡上有「撤销」。没提交的 pending review 这类别人看不到的只记活动。
// 主人操作没有配对凭证：凭证编号写 0，名字写那张工单；来源是 agent。「撤销」只撤这次操作，不作废任何凭证
// （protocol 的 isOnBehalfOwnerActionSource）。已经发到外部服务的写操作撤不回，撤销时给出链接（网关的 owner-actions.ts）。
import type { AgentConnectionWrite } from "@pi-lead-child/connections";
import { addActivity, getItem, itemLabel, leadDisplayName, recordOwnerAction, type Db } from "@pi-lead-child/store";

export const AGENT_WRITE_DECISION = "agent_write";

export function recordAgentWrite(db: Db, write: AgentConnectionWrite, now: Date = new Date()): { ownerActionEventId: string | null } {
  const item = getItem(db, write.itemId);
  const { description } = write;
  addActivity(db, {
    itemId: write.itemId, runId: write.runId, actor: "lead", kind: "decision",
    payload: {
      decision: AGENT_WRITE_DECISION, by: "sub_agent", onBehalfOf: "user", authority: "grant", ruleId: write.ruleId,
      connection: write.connection, tool: write.tool, summary: description.summary, target: description.target,
      url: description.url, visible: description.visible, callId: write.callId,
    },
  });
  if (!description.visible) return { ownerActionEventId: null };
  const ticket = item ? itemLabel(item) : `工单 #${write.itemId}`;
  const recorded = recordOwnerAction(db, {
    action: "connection.agent_write",
    target: { key: `run:${write.runId}`, label: `Run #${write.runId}（${ticket}）`, ticketId: write.itemId },
    // 称呼 Lead 用你起的名字（设置 → 身份与风格）。
    summary: `${leadDisplayName(db)} 派的子 agent 代你${description.summary}`,
    detail: {
      connection: write.connection, tool: write.tool, target: description.target, url: description.url, ruleId: write.ruleId,
      callId: write.callId,
    },
    undo: {
      kind: "connection_write", runId: write.runId, callId: write.callId, connection: write.connection, tool: write.tool,
      url: description.url,
    },
    alertNote: description.url ? `链接：${description.url}` : null,
    credential: { id: 0, kind: "agent", display_name: ticket, origin: "unknown" },
    source: { client: "agent", deviceName: ticket, loopback: false, fromThisMachine: true },
    now,
  });
  return { ownerActionEventId: recorded.event.eventId };
}
