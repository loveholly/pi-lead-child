// 对外提问（2026-11-12）：Lead 的 send_channel_message 带上 ticket_id、decision_id 时，是替这张工单问人：
// 系统在工单上记一笔，在回复会出现的对话上登记等待。到期的等待交给 Lead 时写明下一步是把摘要交给用户。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator, type ChannelMessageService } from "@pi-lead-child/engine";
import { createItem, createRun, listActivities, listOpenLeadWaits, openDb, transition, updateRun, type Db } from "@pi-lead-child/store";
import { leadWaitEventBlock } from "../src/envelope.js";
import type { LeadDeps } from "../src/tools.js";
import { createChannelActionTools } from "../src/ui-action-tools.js";

let db: Db;
let deps: LeadDeps;
let itemId: number;
let decisionId: number;
let sent: string[];
let checked: boolean[];

// send_channel_message 只在接了外部通道时注册（tools.ts 看 deps.channelCards）：这里直接取通道的那一组工具。
function tool(name: string) {
  const found = createChannelActionTools(deps).find((candidate: any) => candidate.name === name) as any;
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

beforeEach(() => {
  const dir = tempDir("plc-question-tool-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  sent = [];
  checked = [];
  const channelMessages: ChannelMessageService = {
    canSend: () => true,
    send: async (conversationId, input) => {
      sent.push(input.text);
      checked.push(input.targetChecked === true);
      return { conversation: conversationId, label: "Nina的私信", objectKey: "slack:D0NINA:main", text: input.text, card: null, outcome: "auto_sent" };
    },
    react: async () => { throw new Error("not used"); },
    openCards: () => [],
  };
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir, uiActionServices: { channelMessages } };
  itemId = createItem(db, { title: "build the export page", brief: "If information is missing, Nina provides it.", createdBy: "lead" });
  transition(db, { itemId, to: "active", actor: "system", reason: "spawn" });
  const runId = createRun(db, { itemId, role: "executor" });
  updateRun(db, runId, { state: "running" });
  decisionId = createCoordinator({ db }).requestDecision({
    itemId, runId, kind: "question", audience: "lead_or_user", blocking: true,
    prompt: "Does the export keep deleted rows?",
    checkpoint: { title: "Deleted rows", summary: "The requirement and the code disagree." },
  }).requestId;
});

describe("send_channel_message for a ticket", () => {
  it("records the question on the ticket and registers the wait, and tells Lead it need not set a follow-up", async () => {
    const result = await tool("send_channel_message").execute("t", {
      conversation: "slack:@U0NINA", text: "Hi Nina, does the export keep deleted rows?", words: "assistant",
      ticket_id: itemId, decision_id: decisionId, reason: "The ticket names Nina for missing information",
    });
    expect(sent).toEqual(["Hi Nina, does the export keep deleted rows?"]);
    expect(listOpenLeadWaits(db)).toMatchObject([{ entityKey: "slack:D0NINA:main", origin: `question:ticket:${itemId}:decision:${decisionId}` }]);
    const marks = listActivities(db, itemId).map((activity) => JSON.parse(activity.payload) as Record<string, unknown>)
      .filter((payload) => payload.decision === "question_sent");
    expect(marks).toMatchObject([{ decisionRequestId: decisionId, round: 1, text: "Hi Nina, does the export keep deleted rows?" }]);
    const text = result.content[0].text as string;
    expect(text).toContain('"round": 1');
    expect(text).toContain("不用另设跟进");
  });

  it("stays an ordinary message without a ticket", async () => {
    await tool("send_channel_message").execute("t", {
      conversation: "slack:@U0NINA", text: "See you at the stand-up.", words: "assistant", reason: "The user asked me to tell her",
    });
    expect(sent).toHaveLength(1);
    expect(listOpenLeadWaits(db)).toEqual([]);
  });

  it("asks for the ticket when only the decision is given", async () => {
    await expect(tool("send_channel_message").execute("t", {
      conversation: "slack:@U0NINA", text: "hello", words: "assistant", decision_id: decisionId, reason: "r",
    })).rejects.toThrow(/ticket_id/);
    expect(sent).toEqual([]);
  });
});

describe("the wait block when an outbound question runs out of time", () => {
  it("tells Lead to hand the summary to the user instead of waiting again", () => {
    const block = leadWaitEventBlock({
      seq: 50, source: "timer", level: "tell", entityKey: "slack:D0NINA:main", kind: "lead.wait_expired",
      payload: {
        waitId: 7, waitedKey: "slack:D0NINA:main", note: "工单 #12 的决定请求 #5：你问了「…」。", origin: "question:ticket:12:decision:5",
        mustTell: false, waitingSince: "2026-11-12T02:00:00.000Z", userAction: null, expiresAt: "2026-11-13T02:00:00.000Z",
      },
    } as never);
    expect(block).toContain("交给用户");
    expect(block).toContain("不要再催");
    expect(block).not.toContain("决定再等");
  });
});

// 工单 #589：回复落点的核对拦下以后，Lead 确认没回错时带 confirm_target=true 重发，系统不再核对。
describe("send_channel_message after the reply-target check", () => {
  it("passes confirm_target on as targetChecked, and only when Lead gives it", async () => {
    await tool("send_channel_message").execute("t", { conversation: "slack:D0NINA:main", text: "收到", words: "assistant", reason: "r" });
    await tool("send_channel_message").execute("t", {
      conversation: "slack:D0NINA:main", text: "收到", words: "assistant", reason: "r", confirm_target: true,
    });
    expect(checked).toEqual([false, true]);
  });
});
