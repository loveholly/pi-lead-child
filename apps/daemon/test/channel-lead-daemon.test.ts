// 交给 Lead（落地计划 B，用户 2026-10-22）在 daemon 里走一遍：Slack 私信请用户 review 一个 PR → 请求 A 认出是代码 review →
// 交给 Lead（消息事件，tell 级，Lead 单独一轮；统一消息事件工单 03 以后带原话，包在外部标签里，工单 05 以后它就是请求）→
// Lead 派子 agent 工单（这里由测试代 Lead 调 hub 的 leadDispatch，按消息事件；Lead 的工具 dispatch_agent_task 在 lead 包的 channel-tools.test.ts 测）→ C 的派单器开一个带权限清单的进程内子 agent，经连接中心在 PR 上
// 发 COMMENT review → 结果交回通道的 ⑦：请求 B 加信心模型，代用户回复，改写「正在处理」那一条。
// daemon、网关、store、通道 hub、Slack 来源插件、派单器、子 agent 的 runtime、ConnectionHub 都是真的；Slack、GitHub 的 MCP、
// SmartModel、Lead 的会话、子 agent 的模型（faux）是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { tempDir } from "@pi-lead-child/core/testing";
import { createIsolatedLookupSession, type LookupSession, type LookupSessionFactory } from "@pi-lead-child/lead";
import { withCallObserver } from "@pi-lead-child/engine";
import { cardIdOf, FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { FAKE_GH_TOKEN, FakeGithub } from "@pi-lead-child/connections/testing";
import { createLoopbackBinding, getChannelCard, getItem, listEvents, openDb, recordDecisionModelCall, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead } from "./fake-pi-session.js";

type Step = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const sessions: LookupSession[] = [];

beforeEach(() => {
  dir = tempDir("plc-channel-lead-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  for (const session of sessions.splice(0)) {
    try {
      session.dispose();
    } catch {
      // 已经释放。
    }
  }
  db.close();
  vi.unstubAllEnvs();
});

const PR = { owner: "acme", repo: "widgets", pullNumber: 12 };
const DIFF = [
  "diff --git a/src/retry.ts b/src/retry.ts", "--- a/src/retry.ts", "+++ b/src/retry.ts", "@@ -1,2 +1,3 @@",
  "-export const MAX_DELAY_MS = 600_000;", "+export const MAX_DELAY_MS = 900_000;", "+export const JITTER = 0.2;",
  " export const MIN_DELAY_MS = 1_000;", "",
].join("\n");

function fauxFactory(steps: Step[]): LookupSessionFactory {
  const faux = fauxProvider({ provider: "plc-channel-lead-daemon", api: "plc-channel-lead-daemon-api" });
  faux.setResponses(steps);
  const workDir = tempDir("plc-channel-lead-daemon-session-");
  return async (request) => {
    const session = await createIsolatedLookupSession({
      workDir, systemPrompt: request.systemPrompt, tools: request.tools, model: faux.getModel() as never, thinkingLevel: "off", retry: false,
      extensionFactories: [{ name: "provider", factory: (pi) => pi.registerProvider(faux.provider) }],
    });
    sessions.push(session);
    return { session, model: "plc-channel-lead-daemon/faux" };
  };
}

const github = (tool: string, args: Record<string, unknown>): Step =>
  fauxAssistantMessage([fauxToolCall("call_connection_tool", { connection: "github", tool, arguments: args } as never)], { stopReason: "toolUse" });

// 子 agent：读 PR 和 diff，在 PR 上留一条评论（COMMENT），交结果。
const reviewing = (): Step[] => [
  github("pull_request_read", { ...PR, method: "get" }),
  github("pull_request_read", { ...PR, method: "get_diff" }),
  github("pull_request_review_write", { ...PR, method: "create" }),
  github("add_comment_to_pending_review", { ...PR, path: "src/retry.ts", line: 2, side: "RIGHT", subjectType: "LINE", body: "15 分钟的依据是什么？" }),
  github("pull_request_review_write", { ...PR, method: "submit_pending", event: "COMMENT", body: "看过了，留了一条评论。" }),
  fauxAssistantMessage([fauxToolCall("submit_result", {
    found: "yes", answer: "重试上限从 10 分钟改成 15 分钟；在 PR 上留了一条评论。", checked: ["acme/widgets#12 的 diff"], caveats: [],
    sources: [{ via: "github", repo: "acme/widgets", path: "src/retry.ts", startLine: 1, endLine: 1, quote: "export const MAX_DELAY_MS = 900_000;" }],
    replyDraft: "已在 PR 留了 1 条评论。",
  } as never)], { stopReason: "toolUse" }),
  fauxAssistantMessage("done"),
];

describe("a channel request through Lead in the daemon (landing plan B)", () => {
  it("hands the review request to Lead with the words in an external tag, dispatches within the grant, and replies for the user in place", async () => {
    const slack = new FakeSlack();
    const gh = new FakeGithub();
    gh.addPullRequest({ owner: "acme", repo: "widgets", number: 12, title: "放宽重试上限", body: "把重试上限改成 15 分钟。", headSha: "a".repeat(40), diff: DIFF });
    const model = scriptedSmartModel({
      answers: { ask_kind: (state) => (state.split("\n\n")[0]!.includes("review") ? "code_review" : "other"), handling_verb: "reviewing" },
    });
    const lead = fakePiLead(async () => ({ say: "好的。" }));
    daemon = await startDaemon({
      dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false,
      sessionFactory: (async (args: any) => ({
        ...(await lead.factory(args)),
        smartModel: withCallObserver(model, (call) => recordDecisionModelCall(args.db, call)),
      })) as never,
      channels: {
        sources: { slack: { api: slack.api } },
        credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
        // 抽查（落地计划 D2）是随机的：这里关掉。
        audit: { rate: 0 },
      },
      agentTasks: { sessionFactory: fauxFactory(reviewing()) },
      connections: { fetch: gh.fetch, gh: { token: async () => FAKE_GH_TOKEN }, tickMs: 3_600_000 },
    });
    const owner = createLoopbackBinding(db, { name: "test-web" });
    const started = await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/connections/github/start`, {
      method: "POST", headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" }, body: "{}",
    });
    expect(started.status).toBe(200);

    const delivery = slack.dm("U0ZHANG", "帮忙 review 一下 https://github.com/acme/widgets/pull/12 ，主要看重试的上限");
    const item = (await daemon.channels!.receive("slack", delivery)).items[0]!;
    await vi.waitFor(() => expect(listEvents(db, { kind: "message.received" })).toHaveLength(1), { timeout: 10_000 });
    const cardId = cardIdOf(db, item)!;
    const [request] = listEvents(db, { kind: "message.received" });
    expect(request).toMatchObject({
      level: "tell",
      payload: { cardId, inbound: { intent: "code_review" }, ceiling: { authority: "work" }, objects: [{ owner: "acme", repo: "widgets", number: 12 }] },
    });
    expect(listEvents(db, { kind: "channel.lead.requested" })).toEqual([]);
    // Lead 单独一轮看到这条消息事件：结构化的事实，加上外部标签里的原话（统一消息事件 spec D1、D5）。
    await vi.waitFor(() => expect(lead.calls.flatMap((call) => call.inputs).join("\n")).toContain(`通道卡 #${cardId}`), { timeout: 10_000 });
    expect(lead.calls.flatMap((call) => call.inputs).join("\n")).toMatch(
      /<untrusted_external_text from="external" source="Slack" sender="[^"]+"[^>]*>\n帮忙 review 一下 https:\/\/github\.com\/acme\/widgets\/pull\/12 ，主要看重试的上限\n<\/untrusted_external_text>/u,
    );
    expect(slack.sent()).toEqual([]);

    // Lead 决定派工单（测试代 Lead 调用；Lead 的工具 dispatch_agent_task 调的就是它）。
    const dispatched = await daemon.channels!.leadDispatch(request!.seq, { summary: "review acme/widgets#12 的重试上限改动" });
    expect(dispatched.grant.join("\n")).toContain("acme/widgets#12");
    expect(getItem(db, dispatched.itemId)!.title).not.toContain("主要看重试的上限");

    // 子 agent 在 PR 上留了评论；回复改写「正在处理」那一条。
    await vi.waitFor(() => expect(getChannelCard(db, cardId)!.state).toBe("auto_replied"), { timeout: 20_000 });
    expect(gh.submitted("acme", "widgets", 12)).toMatchObject([{ state: "COMMENTED" }]);
    expect(slack.sent().map((message) => [message.text, message.edits])).toEqual([
      [":robot_face: Paimon (Assistant) · auto-reply for 我\n已在 PR 留了 1 条评论。", 1],
    ]);
    expect(listEvents(db, { kind: "channel.task.finished" })).toMatchObject([{
      payload: { cardId, runId: dispatched.runId, status: "finished", decision: "auto_send", actions: 1 },
    }]);
    expect(listEvents(db, { kind: "channel.lead.decided" })).toMatchObject([{ payload: { decision: "dispatch", by: "lead" } }]);
    // 客户端从会话卡接口读到这份草稿的分数面板（落地计划 D2、D3）。
    const listed = await fetch(`http://127.0.0.1:${daemon.pairedPort}/v1/channels/cards`, { headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(listed.status).toBe(200);
    const shown = ((await listed.json()) as { items: Array<{ id: number; handling: { reply: unknown } | null }> }).items.find((card) => card.id === cardId);
    expect(shown?.handling?.reply).toMatchObject({ draftKind: "task", decision: "auto_send", audit: false, calibration: { samples: 0 } });
  }, 40_000);
});
