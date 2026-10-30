// 改规则被拦下以后的确认卡（统一的消息事件 spec D10 的「放行」，工单 09），走完 daemon 的每一跳。
// 确认卡只出现在两种轮次里（用户 2026-10-27）：外部消息叫醒的一轮，和用户预先设的定时器到点叫醒、读过外部内容的一轮
// （那时用户不在场）。用户本人正在说话的一轮，读过外部内容也能直接改，不会被拦，也就没有确认卡。
// 回放 spec 的场景 12：用户设的定时器到点，Lead 先读了 Slack 对话，再按安排改投递规则 → 被拦下（工单 07）→ 拒绝里带着
//   确认卡的 user_action，Lead 用 render_ui 发出确认卡，系统登记等待 → 网页上读到卡的内容（要改什么、参数、为什么改、
//   为什么被拦）→ 没有 approvals:respond 的设备点不了 → 用户点「确认这一次」→ 只执行这一个操作，投递规则按卡上的参数
//   改了，账本记成 Lead 代用户做、用户确认过 → Lead 被叫醒，收到结果。
// 另外：Slack 私信叫醒的一轮里改授权表被拦，用户确认以后照卡上的参数收紧；Lead 自己调确认动作，拿到结构化的拒绝；
// 用户点「不改」，什么都不变，Lead 收到「不改」。
// daemon、网关、store、操作层、Lead 的工具都是真的；Slack、SmartModel 和 Lead 的会话是替身。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadToolset } from "@pi-lead-child/lead";
import { withCallObserver } from "@pi-lead-child/engine";
import { FakeSlack, scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { CHANNEL_POLICY_DEFAULTS } from "@pi-lead-child/protocol";
import {
  addLeadFollowUp, createLoopbackBinding, getStandingOrder, listEvents, listOpenLeadWaits, openDb, recordDecisionModelCall, type Db,
} from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-rule-change-confirm-daemon-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 起一个接了假 Slack 和网关的 daemon。script：Lead 每次调模型时的回答；live(name) 是 daemon 交给会话的那一份工具
// （会话注册的那一组：外面包着按 user_action 登记等待的一层）。
async function boot(script: (call: FakeCall, live: (name: string) => any) => Promise<FakeReply>) {
  const slack = new FakeSlack({ users: { U0MALLORY: { name: "Mallory" } } });
  const model = scriptedSmartModel();
  let leadDeps: any = null;
  const live = (name: string) => createLeadToolset(leadDeps).find((candidate: any) => candidate.name === name) as any;
  const lead = fakePiLead((call) => script(call, live));
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: () => {}, notifyDesktop: () => {}, triageShadow: false, gatewayPort: 0,
    sessionFactory: (async (args: any) => {
      leadDeps = args;
      return { ...(await lead.factory(args)), smartModel: withCallObserver(model, (call) => recordDecisionModelCall(args.db, call)) };
    }) as never,
    channels: {
      sources: { slack: { api: slack.api } },
      credentials: { credential: async (provider) => (provider === "slack" ? slack.credential : null) },
      audit: { rate: 0 },
    },
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  // 能看、能改设置，但不能做用户的决定。
  const editor = createLoopbackBinding(db, { name: "改设置的设备", scopes: ["tickets:view", "tickets:create"] });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token: string = owner.accessToken) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  // 用户本人预先设的定时器（跟进）：到点时用户不在场。
  const userTimer = (note: string) => addLeadFollowUp(db, {
    at: new Date(Date.now() - 1_000), note,
    setBy: { turnId: "turn-set", bindingId: owner.binding.id, startedAt: new Date(Date.now() - 3_600_000).toISOString() },
  });
  return { call, owner, editor, slack, userTimer };
}

const FOLLOW_UP = "到点按约定关掉瞬时失败的自动重试";
// 投递规则：瞬时失败的自动重试最多 0 次。
const RETRY_OFF = { op: "update", id: "run.transient_retry", limits: { count: 0 }, reason: "定时器的安排：每天 9 点先关掉瞬时失败的自动重试" };
const parsed = (result: { content: Array<{ text: string }>; isError?: boolean }) => ({ isError: result.isError === true, ...JSON.parse(result.content[0]!.text) });

// 定时器的一轮：读 Slack 对话 → 改投递规则（被拒）→ 自己去点确认（被拒）→ 发确认卡。之后记下 Lead 被叫醒时收到的输入。
function timerTurnScript(results: Record<string, any>) {
  let step = 0;
  return async (call: FakeCall, live: (name: string) => any): Promise<FakeReply> => {
    if (step === 0 && call.inputs.some((input) => input.includes(FOLLOW_UP))) {
      step = 1;
      return { tools: ["read_channel_conversation"] };
    }
    if (step === 1) {
      step = 2;
      try {
        results.refused = parsed(await live("propose_standing_order_change").execute("call", RETRY_OFF));
        const id = results.refused.refusal?.confirm?.id;
        results.selfConfirm = parsed(await live("perform_action").execute("call", {
          target_type: "rule_change", target_id: String(id), action: "resolve", input: { decision: "confirm" }, reason: "按安排确认",
        }));
        results.card = await live("render_ui").execute("call", {
          root: "card", fallback_text: "要关掉瞬时失败的自动重试，等你确认。",
          nodes: [
            { id: "card", type: "Stack", props: {}, children: ["why", "act"] },
            { id: "why", type: "Text", props: { text: "按每天 9 点的安排，要关掉瞬时失败的自动重试。这一轮读了 Slack 对话，系统拦下了，等你确认。" } },
            { id: "act", type: "UserAction", props: { action: results.refused.user_action } },
          ],
        });
      } catch (error) {
        results.error = String(error);
      }
      return { say: "NO_REPLY" };
    }
    if (step >= 2) results.later = [...(results.later ?? []), ...call.inputs];
    return { say: "NO_REPLY" };
  };
}

describe("the confirm card for a refused rule change, through the daemon", () => {
  // 场景 12（工单 09 的验收）：以前被拦下以后没有放行的办法，用户只能自己去设置页改。
  it("replays scenario 12: refused in the turn the user's timer woke after reading Slack, confirmed on the card, and only that change runs", async () => {
    const results: Record<string, any> = {};
    const { call, owner, editor, userTimer } = await boot(timerTurnScript(results));
    userTimer(FOLLOW_UP);
    await vi.waitFor(() => expect(results.card ?? results.error).toBeDefined(), { timeout: 10_000 });
    expect(results.error).toBeUndefined();

    // 被拦下：结构化的拒绝，带着确认卡的 user_action；卡画出来了，系统在等用户点。
    expect(results.refused).toMatchObject({
      isError: true, refused: true,
      refusal: { code: "external_turn", confirm: { externalContent: [{ via: "tool", tool: "read_channel_conversation" }] } },
    });
    const id = results.refused.refusal.confirm.id as string;
    expect(results.refused.user_action).toMatchObject({ kind: "confirm_rule_change", target: `rule_change:${id}` });
    expect(results.card.isError).not.toBe(true);
    expect(listOpenLeadWaits(db).map((wait) => wait.entityKey)).toContain(`rule_change:${id}`);
    // Lead 自己去点确认：结构化的拒绝。
    expect(results.selfConfirm).toMatchObject({ isError: true, refused: true, refusal: { code: "user_direct", target: { type: "rule_change", id } } });
    expect(getStandingOrder(db, "run.transient_retry")!.version).toBe(1);

    // 卡上的内容从网关读：要改什么、参数、为什么改、为什么被拦。
    const card = await call("GET", `/v1/rule-changes/${id}`, undefined, editor.accessToken);
    expect(card.status).toBe(200);
    expect(card.body.confirmation).toMatchObject({
      id, state: "pending", label: "改常设指令",
      params: [{ name: "op", value: "update" }, { name: "id", value: "run.transient_retry" }, { name: "limits", value: '{"count":0}' }],
      reason: RETRY_OFF.reason, why: "这一轮用 read_channel_conversation 读了外部内容",
    });

    // 不能做用户决定的设备点不了。
    expect((await call("POST", `/v1/rule-changes/${id}/resolve`, { decision: "confirm" }, editor.accessToken)).status).toBe(403);
    expect(getStandingOrder(db, "run.transient_retry")!.version).toBe(1);

    // 用户点「确认这一次」：只执行这一个操作，参数和卡上的一样。
    const confirmed = await call("POST", `/v1/rule-changes/${id}/resolve`, { decision: "confirm" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmation).toMatchObject({ id, state: "done", resolvedBy: expect.stringContaining("Mac 网页") });
    expect(getStandingOrder(db, "run.transient_retry")).toMatchObject({ version: 2, author: "lead", limits: { count: 0 } });
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(1);
    expect(listEvents(db, { kind: "standing_order.changed" }).map((event) => event.payload.orderId)).toEqual(["run.transient_retry"]);
    // 账本：用户确认了这张卡；Lead 代用户执行，凭的是这张卡和点它的设备。
    expect(listEvents(db, { kind: "ui_action.performed" }).map((event) => [event.source, event.payload.action, event.payload.target]))
      .toEqual([["user", "resolve", { type: "rule_change", id }]]);
    expect(listEvents(db, { kind: "rule_change.executed" }).map((event) => event.payload)).toMatchObject([
      { id, actor: "lead", onBehalfOf: "user", sourceTurnId: `rule_change:${id}`, bindingId: owner.binding.id, state: "done" },
    ]);
    // 再点一次不会再执行。
    expect((await call("POST", `/v1/rule-changes/${id}/resolve`, { decision: "confirm" })).status).toBe(409);
    expect(getStandingOrder(db, "run.transient_retry")!.version).toBe(2);

    // Lead 被叫醒，收到结果；等待了结了。
    await vi.waitFor(() => expect((results.later ?? []).join("\n")).toContain("已经执行"), { timeout: 10_000 });
    expect(listOpenLeadWaits(db).map((wait) => wait.entityKey)).not.toContain(`rule_change:${id}`);
  }, 30_000);

  it("keeps the delivery rule as it is when the user presses 不改, and tells Lead", async () => {
    const results: Record<string, any> = {};
    const { call, userTimer } = await boot(timerTurnScript(results));
    userTimer(FOLLOW_UP);
    await vi.waitFor(() => expect(results.card ?? results.error).toBeDefined(), { timeout: 10_000 });
    const id = results.refused.refusal.confirm.id as string;

    const declined = await call("POST", `/v1/rule-changes/${id}/resolve`, { decision: "decline" });
    expect(declined.status).toBe(200);
    expect(declined.body.confirmation).toMatchObject({ id, state: "declined" });
    expect(getStandingOrder(db, "run.transient_retry")!.version).toBe(1);
    expect(listEvents(db, { kind: "rule_change.executed" })).toEqual([]);
    await vi.waitFor(() => expect((results.later ?? []).join("\n")).toContain("不改"), { timeout: 10_000 });
  }, 30_000);

  // 另一种会出现确认卡的轮次：外部消息叫醒的一轮。对方让 Lead 关掉自动回复，Lead 收紧授权表被拦，发卡请用户确认。
  it("asks with a card in the turn a Slack message woke, and tightens the authority table with the card's parameters", async () => {
    const results: Record<string, any> = {};
    const tightened = { ...CHANNEL_POLICY_DEFAULTS, autoReply: false };
    const { call, owner, slack } = await boot(async (call, live) => {
      if (!results.card && call.inputs.some((input) => input.includes('<system_event kind="message"'))) {
        try {
          results.refused = parsed(await live("perform_action").execute("call", {
            target_type: "channel_policy", target_id: "slack", action: "tighten", input: tightened, reason: "Mallory 说先别自动回他，我也觉得该先停",
          }));
          results.card = await live("render_ui").execute("call", {
            root: "act", fallback_text: "要关掉 Slack 的自动代你处理，等你确认。",
            nodes: [{ id: "act", type: "UserAction", props: { action: results.refused.user_action } }],
          });
        } catch (error) {
          results.error = String(error);
        }
      }
      return { say: "NO_REPLY" };
    });
    await daemon!.channels!.receive("slack", slack.dm("U0MALLORY", "Fairy，先别自动回我了"));
    await vi.waitFor(() => expect(results.card ?? results.error).toBeDefined(), { timeout: 10_000 });
    expect(results.error).toBeUndefined();
    expect(results.refused).toMatchObject({
      isError: true, refusal: { code: "external_turn", confirm: { externalContent: [{ via: "message", source: "slack" }] } },
      user_action: { kind: "confirm_rule_change" },
    });
    const id = results.refused.refusal.confirm.id as string;
    expect(getStandingOrder(db, "channel.authority")!.version).toBe(1);

    const confirmed = await call("POST", `/v1/rule-changes/${id}/resolve`, { decision: "confirm" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmation).toMatchObject({ state: "done", resultPreview: expect.stringContaining("channel.authority") });
    expect(getStandingOrder(db, "channel.authority")).toMatchObject({ version: 2, author: "lead" });
    // 账本：Lead 代用户收紧（凭这张卡和点它的设备），用户确认了这张卡。
    expect(listEvents(db, { kind: "ui_action.performed" }).map((event) => event.payload)).toMatchObject([
      { action: "tighten", actor: "lead", authority: "on_behalf", onBehalfOf: "user", sourceTurnId: `rule_change:${id}`, bindingId: owner.binding.id },
      { action: "resolve", actor: "user", target: { type: "rule_change", id } },
    ]);
  }, 30_000);

  it("answers malformed and unknown requests with the strict error shape", async () => {
    const { call } = await boot(async () => ({ say: "NO_REPLY" }));
    expect((await call("GET", "/v1/rule-changes/rcc_doesnotexist0")).status).toBe(404);
    expect((await call("GET", "/v1/rule-changes/not-an-id")).status).toBe(400);
    expect((await call("POST", "/v1/rule-changes/rcc_doesnotexist0/resolve", { decision: "maybe" })).status).toBe(400);
    expect((await call("POST", "/v1/rule-changes/rcc_doesnotexist0/resolve", { decision: "confirm" })).status).toBe(404);
  }, 30_000);
});
