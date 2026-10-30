// Lead 遇到限流时换模型（spec D9）。以前 Lead 只用 lead.models[0]：2026-10-16 16:57 的心跳巡检遇到 429，
// 21 秒里试了 4 次都失败，配好的第二个模型一直没用上；Lead 自己也不知道这次失败。
// 现在：Lead 的一轮遇到 429 后，下一轮开始前 daemon 按 lead.models 的顺序换下一个模型（会话里换，不重启、不改配置），
// 写日志，并在这一轮的输入里告诉 Lead。服务端给了恢复时间时，到时间后用回第一个模型。
// 所有模型都失败时不再换：Lead 的健康状态留在降级，交给现有的停摆流程。
// 2026-10-19：09:06–09:41 Lead 连续失败 35 分钟（先 DNS，后 503 auth_unavailable），只用了第一个模型，用户也不知道。
// 现在授权、额度、模型不可用也换；每次换都要告诉用户：换模型的事件交给 Lead，Lead 不说时系统直接在会话里说。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPairing, listEvents, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { createLeadToolset, type LeadDeps } from "@pi-lead-child/lead";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

const RATE_LIMIT = "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit";

beforeEach(() => {
  dir = tempDir("plc-lead-failover-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_USER_TURN_RETRY_MS", "50");
  vi.stubEnv("PLC_LEAD_DRAIN_MS", "50");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 不调用模型的 Lead，配了 models 里的几个模型。fails(model) 返回错误时，用这个模型的一轮以这个错误失败。
// holdSwitch：换模型挂起，直到 release()。这一轮开始前排进 pi 队列的插话（steer），pi 在这一轮开头和 prompt 一起送给模型
// （pi-agent-core 的 agent-loop.js：runLoop 开头先取插话），所以 Lead 的第一段回答就在插话之后。
function stubLead(
  models: string[],
  fails: (model: string, index: number) => string | null,
  options: { holdSwitch?: boolean; quietOnSwitch?: boolean } = {},
) {
  const listeners: Array<(event: any) => void> = [];
  const turns: Array<{ model: string; prompt: string }> = [];
  const switches: string[] = [];
  const steers: string[] = [];
  // 真的 Lead 工具（clear_lead_model_quota 要 daemon 给的额度封禁）。
  let tools: ReturnType<typeof createLeadToolset> = [];
  let current = models[0]!;
  let releaseSwitch: (() => void) | null = null;
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const say = (text: string) => emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  const factory = async (args: LeadDeps) => {
    tools = createLeadToolset(args);
    return {
    modelName: current,
    models,
    switchModel: async (spec: string) => {
      switches.push(spec);
      if (options.holdSwitch) await new Promise<void>((resolve) => { releaseSwitch = resolve; });
      current = spec;
    },
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        turns.push({ model: current, prompt: message });
        const error = fails(current, turns.length - 1);
        if (error) {
          emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: error, content: [] } });
          return;
        }
        // 只为换模型这件事开的一轮：quietOnSwitch 时 Lead 一言不发（回 NO_REPLY）。
        if (options.quietOnSwitch && message.includes("lead.model_switched") && !message.includes("<user_message")) {
          say("NO_REPLY");
          emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "NO_REPLY" }] } });
          return;
        }
        if (steers.length === 0) {
          say("收到。");
          emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "收到。" }] } });
          return;
        }
        steers.splice(0);
        say("两条都看了：在的；#77 已经 done。");
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "两条都看了：在的；#77 已经 done。" }] } });
      },
      async steer(text: string) { steers.push(text); },
      async followUp() {},
      dispose() {},
    },
    };
  };
  const tool = (name: string) => tools.find((candidate) => candidate.name === name)!;
  return { factory, turns, switches, tool, release: () => releaseSwitch?.() };
}

async function start(lead: ReturnType<typeof stubLead>, options: { networkUp?: () => boolean } = {}) {
  const logs: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, sessionFactory: lead.factory as never, log: (line) => logs.push(line),
    // 网络探测：null 表示通，字符串是不通的说明（network.ts 的 NetworkProbe）。
    ...(options.networkUp ? { networkProbe: async () => (options.networkUp!() ? null : "lookup api.example.com: no such host") } : {}),
  });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const headers = { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" };
  let sent = 0;
  const chat = async (message: string) => {
    sent += 1;
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/chat/send`, {
      method: "POST", headers, body: JSON.stringify({ id: `cmd-${sent}`, message }),
    });
    expect(response.ok).toBe(true);
    return ((await response.json()) as { turnId: string }).turnId;
  };
  const overview = async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/overview?include=lead`, { headers })).json()) as
    { model: string; lead?: Record<string, any> };
  return { logs, chat, overview };
}

const turnState = (id: string) => db.prepare("SELECT state, assistant_text FROM channel_turns WHERE id = ?").get(id) as
  { state: string; assistant_text: string };

describe("a Lead turn that hits a rate limit", () => {
  it("moves Lead to the next configured model, logs why, and tells Lead in the next turn", async () => {
    const lead = stubLead(["p/a", "p/b"], (model) => model === "p/a" ? RATE_LIMIT : null);
    const { logs, chat, overview } = await start(lead);

    const turnId = await chat("在吗");
    // 这一轮在等那一次自动重试；重试时 Lead 已经换到第二个模型，答上了。
    await vi.waitFor(() => expect(turnState(turnId)).toEqual({ state: "completed", assistant_text: "收到。" }));
    expect(lead.switches).toEqual(["p/b"]);
    expect(lead.turns.slice(0, 2).map((turn) => turn.model)).toEqual(["p/a", "p/b"]);
    expect(logs.some((line) => line.includes("lead model switch") && line.includes("p/a") && line.includes("p/b"))).toBe(true);
    expect((await overview()).model).toBe("p/b");
    // 工单 14：换模型是一条事件（以前在 daemon 内存里）。2026-10-19 起它要告诉用户：tell 级，交给 Lead 一件事，写明必须说。
    expect(listEvents(db, { kind: "lead.model_switched" })).toMatchObject([{
      source: "lead", entityKey: "lead:main", level: "tell",
      payload: { from: "p/a", to: "p/b", restored: false, mustTell: true, note: expect.stringContaining("429") },
    }]);
    // 用新模型答完用户这一轮以后，系统单独开一轮把这件事交给 Lead。
    await vi.waitFor(() => expect(lead.turns.some((turn) => turn.prompt.includes("这件事必须告诉用户"))).toBe(true));
    const told = lead.turns.find((turn) => turn.prompt.includes("这件事必须告诉用户"))!;
    expect(told.prompt).toContain("lead.model_switched");
    expect(told.prompt).toContain("p/a");
    expect(told.prompt).toContain("p/b");
    expect(told.prompt).toContain("429");
    expect(told.prompt).toContain("这件事必须告诉用户");
  });

  it("goes back to the first model once the recovery time the service gave has passed", async () => {
    let limited = true;
    const lead = stubLead(["p/a", "p/b"], (model) => model === "p/a" && limited
      ? `Server requested 1s retry delay (max: 0s). ${RATE_LIMIT}`
      : null);
    const { chat } = await start(lead);

    const first = await chat("在吗");
    await vi.waitFor(() => expect(turnState(first).state).toBe("completed"));
    expect(lead.switches).toEqual(["p/b"]);
    limited = false;

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await chat("现在呢");
    await vi.waitFor(() => expect(turnState(second).state).toBe("completed"));
    expect(lead.switches).toEqual(["p/b", "p/a"]);
    expect(lead.turns.at(-1)).toMatchObject({ model: "p/a" });
    await vi.waitFor(() => expect(lead.turns.some((turn) => turn.prompt.includes("换回"))).toBe(true));
    expect(listEvents(db, { kind: "lead.model_switched" }).map((event) => [event.payload.to, event.payload.restored]))
      .toEqual([["p/b", false], ["p/a", true]]);
  });

  // 审查 02 发现：runTurnNow 先标忙，再等换模型（和重新加载扩展），等完才清掉「上一轮遗留的插话锚」。
  // 等的时候用户发来的消息走插话，它的锚是这一轮的，却被当成遗留清掉：插话进了 pi 的队列，回答却挂到别的轮次下面，
  // 插话那一轮一直停在 steered。
  it("keeps a message that arrives while Lead switches models: its turn gets Lead's answer", async () => {
    const lead = stubLead(["p/a", "p/b"], (model) => model === "p/a" ? RATE_LIMIT : null, { holdSwitch: true });
    const { chat } = await start(lead);

    const first = await chat("在吗");
    // 第一条的那一次自动重试开始了，正在换模型。
    await vi.waitFor(() => expect(lead.switches).toEqual(["p/b"]));
    const second = await chat("顺便看一下 #77");
    await vi.waitFor(() => expect(turnState(second).state).toBe("steered"));
    lead.release();

    await vi.waitFor(() => expect(turnState(second)).toEqual({ state: "completed", assistant_text: "两条都看了：在的；#77 已经 done。" }));
    // 回答不挂到第一条的轮次下面。
    expect(turnState(first).assistant_text).toBe("");
  });

  // 工单 04 第 7 项（审查 02 发现）：插话在 Lead 开口之前到达，Lead 的第一段话就在插话之后，两条一起答了。
  // 以前 handOverToSteer 收口第一条时它没有文字，就标成「Lead 未生成回复，请重试」。
  // 现在第一条的结局是 done，标明「和后面的插话一起回答」，界面上它和插话那条是同一次回答。
  it("closes the first message as answered together with the steer, not as failed", async () => {
    const lead = stubLead(["p/a", "p/b"], (model) => model === "p/a" ? RATE_LIMIT : null, { holdSwitch: true });
    const { chat } = await start(lead);

    const first = await chat("在吗");
    await vi.waitFor(() => expect(lead.switches).toEqual(["p/b"]));
    const second = await chat("顺便看一下 #77");
    await vi.waitFor(() => expect(turnState(second).state).toBe("steered"));
    lead.release();

    await vi.waitFor(() => expect(turnState(second).state).toBe("completed"));
    const row = db.prepare("SELECT state, error FROM channel_turns WHERE id = ?").get(first) as { state: string; error: string | null };
    expect(row).toEqual({ state: "steered", error: null });
    const outcome = (db.prepare(
      "SELECT disposition, disposition_detail FROM events WHERE kind = 'user.message' AND json_extract(payload, '$.turnId') = ?",
    ).get(first)) as { disposition: string; disposition_detail: string };
    expect(outcome.disposition).toBe("handled");
    expect(JSON.parse(outcome.disposition_detail)).toMatchObject({ outcome: "done", answeredWith: second, note: "和后面的插话一起回答" });
  });

  it("stops switching when every model is rate limited, and leaves Lead degraded for the outage flow", async () => {
    const lead = stubLead(["p/a", "p/b"], () => RATE_LIMIT);
    const { logs, chat, overview } = await start(lead);

    const turnId = await chat("在吗");
    await vi.waitFor(() => expect(turnState(turnId).state).toBe("failed"));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lead.switches).toEqual(["p/b"]);
    expect((await overview()).lead).toMatchObject({ state: "degraded", reason: "Paimon 的模型服务正忙" });
    expect(logs.some((line) => line.includes("every Lead model failed"))).toBe(true);
  });
});

describe("a Lead turn that fails for a reason other than a rate limit", () => {
  // 2026-10-19 09:2x：代理回 503 auth_unavailable，Lead 一直用 lead.models[0]。
  // 模型服务不可用要连续两次才换（审查：一次抖动不换）。用户这一轮失败一次、自动重试又失败一次，下一轮换到下一个模型。
  it("moves to the next model after 503 auth_unavailable twice, and tells the user itself when Lead stays silent about it", async () => {
    const lead = stubLead(["vibeproxy/gemini", "vibeproxy/claude-sonnet"], (model) => model === "vibeproxy/gemini"
      ? '503: {"message":"auth_unavailable: no auth available"}'
      : null, { quietOnSwitch: true });
    const { chat } = await start(lead);

    const first = await chat("在吗");
    await vi.waitFor(() => expect(turnState(first).state).toBe("failed"));
    expect(lead.turns.map((turn) => turn.model)).toEqual(["vibeproxy/gemini", "vibeproxy/gemini"]);
    const turnId = await chat("现在呢");
    await vi.waitFor(() => expect(turnState(turnId)).toEqual({ state: "completed", assistant_text: "收到。" }));
    expect(lead.switches).toEqual(["vibeproxy/claude-sonnet"]);
    // Lead 只回 NO_REPLY：切换不允许静默，系统直接在会话里说。
    await vi.waitFor(() => expect(db.prepare(
      "SELECT assistant_text FROM channel_turns WHERE origin_kind = 'system:fallback-notice'",
    ).all()).toEqual([{ assistant_text: expect.stringContaining("Paimon 的模型从 vibeproxy/gemini 换成了 vibeproxy/claude-sonnet") }]));
  });

  // 审查：fetch failed、超时、连接断开以前直接算模型服务不可用，一次抖动就换模型。现在先探网络：断网时不换。
  it("does not switch on a fetch failure while the network probe says the network is down", async () => {
    const lead = stubLead(["p/a", "p/b"], (model) => model === "p/a" ? "TypeError: fetch failed" : null);
    const { chat } = await start(lead, { networkUp: () => false });
    await chat("在吗");
    // 断网时这一轮等网络恢复再答，不再马上重试；以前第一次 fetch failed 就换了模型。
    await vi.waitFor(() => expect(lead.turns.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lead.switches).toEqual([]);
    expect(listEvents(db, { kind: "lead.model_switched" })).toEqual([]);
  });

  it("does not switch while the network is down", async () => {
    const lead = stubLead(["p/a", "p/b"], (model) => model === "p/a" ? "getaddrinfo ENOTFOUND api.example.com" : null);
    // daemon 的网络探测也不通：确认是断网（09:06 Mac 刚醒时的 DNS），等网络恢复，不换模型。
    const { chat } = await start(lead, { networkUp: () => false });
    const turnId = await chat("在吗");
    await vi.waitFor(() => expect(lead.turns.length).toBeGreaterThanOrEqual(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(lead.switches).toEqual([]);
    expect(turnState(turnId).state).not.toBe("completed");
  });

  it("remembers across a restart that Claude's quota ran out, and starts on another model until the weekly reset", async () => {
    const models = ["vibeproxy/claude-sonnet-5-5", "vibeproxy/gemini-3.8"];
    const first = stubLead(models, (model) => model.includes("claude") ? "429 You have reached your usage limit for this week" : null);
    const { chat } = await start(first);
    const turnId = await chat("在吗");
    await vi.waitFor(() => expect(turnState(turnId).state).toBe("completed"));
    expect(first.switches).toEqual(["vibeproxy/gemini-3.8"]);
    await daemon!.close();
    daemon = null;

    const second = stubLead(models, () => null);
    const again = await start(second);
    const next = await again.chat("现在呢");
    await vi.waitFor(() => expect(turnState(next).state).toBe("completed"));
    // 新 daemon 的会话从第一个模型建起，第一轮开始前就换到 gemini，不再去撞一次 Claude 的额度。
    expect(second.switches).toEqual(["vibeproxy/gemini-3.8"]);
    expect(second.turns[0]!.model).toBe("vibeproxy/gemini-3.8");
    const [, restarted] = listEvents(db, { kind: "lead.model_switched" });
    expect(restarted?.payload.note).toContain("vibeproxy/claude-sonnet-5-5 的额度用完了");

    // 用户说额度已经恢复：Lead 用 clear_lead_model_quota 清掉封禁，下一轮换回第一个模型，kv 里的封禁也清掉了。
    const toolText = async (name: string) => {
      const result = await second.tool(name).execute(name, {} as never, undefined, undefined, undefined as never);
      return (result.content[0] as { text: string }).text;
    };
    const listed = JSON.parse(await toolText("list_lead_models"));
    expect(listed.quota_blocked).toEqual([{ model: "vibeproxy/claude-sonnet-5-5", until: expect.any(String) }]);
    expect(await toolText("clear_lead_model_quota")).toContain("已清掉 vibeproxy/claude-sonnet-5-5 的额度封禁");
    expect(db.prepare("SELECT value FROM kv WHERE key = 'lead.model_quota_blocked'").get()).toEqual({ value: "{}" });
    const back = await again.chat("额度恢复了");
    await vi.waitFor(() => expect(turnState(back).state).toBe("completed"));
    expect(second.switches).toEqual(["vibeproxy/gemini-3.8", "vibeproxy/claude-sonnet-5-5"]);
  });
});
