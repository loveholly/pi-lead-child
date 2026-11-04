// Lead 的模型没有 key（一次真实的首次运行改写）：缺省模型的服务商没有 key，pi 在发 prompt 前就报
// "No API key found for openai."，不调模型，也没有 message_end。以前：
//   - 这句错误分成 unknown，也没记进 Lead 的健康状态：顶栏一直是绿点，用户看不出来；
//   - 交给 Lead 的事每一轮都失败，按退避（最长 5 分钟）一直叫醒 Lead，三天失败了几百轮。
// 现在这类失败（又没有别的模型可换、没有等着换回的模型）退避最长 30 分钟；改了模型设置、或者有一轮成功，马上再叫。
// daemon、store 是真的；Lead 的会话是替身（fake-pi-session.ts），broken 时 prompt 直接抛出 pi 的那句错误。
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { addInbox, createItem, createPairing, openDb, redeemPairing, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

const NO_KEY = "No API key found for openai.\n\nUse /login to log into a provider via OAuth or API key.";
const EVENT = "Run #7 crashed";

beforeEach(() => {
  dir = tempDir("plc-lead-model-credentials-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  vi.stubEnv("PLC_DATA_DIR", dir);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  // 退避的第一步就比平常的上限（5 分钟）长：认证失败的长退避看日志里的说法，测试里不会自己再叫醒。
  vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "400000");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

interface BootOptions {
  // 模型的分工（第一个是正在用的）。不给时只有一个模型，没有模型切换。
  models?: string[];
  // 这一次调用（正在用的模型）怎样结束：抛出 pi 的预检错误，或者给 fake 会话的回答。
  reply?: (model: string) => "no-key" | FakeReply;
  // 每次 prompt 开始以后先等它（测试在这时改设置）。
  gate?: () => Promise<void> | undefined;
}

async function boot(options: BootOptions = {}) {
  const models = options.models ?? ["openai/gpt-test"];
  let current = models[0]!;
  const reply = options.reply ?? (() => "no-key" as const);
  const lead = fakePiLead(() => {
    const answer = reply(current);
    return answer === "no-key" ? { say: "不该到这里" } : answer;
  });
  const prompts: Array<{ model: string; text: string }> = [];
  const logs: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line) => logs.push(line), notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: (async (args: any) => {
      const made = await lead.factory(args);
      const prompt = made.session.prompt.bind(made.session);
      made.session.prompt = (async (text: string, extra?: any) => {
        prompts.push({ model: current, text });
        await options.gate?.();
        if (reply(current) === "no-key") throw new Error(NO_KEY);
        return prompt(text, extra);
      }) as never;
      return {
        ...made,
        modelName: current,
        refreshProviders: async () => [],
        ...(models.length > 1 ? { models, switchModel: async (spec: string) => { current = spec; } } : {}),
      };
    }) as never,
  });
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view", "tickets:create"] }).code);
  const headers = { authorization: `Bearer ${issued.accessToken}`, "content-type": "application/json" };
  const base = `http://127.0.0.1:${daemon!.pairedPort}`;
  const overview = async () => (await (await fetch(`${base}/v1/overview?include=lead`, { headers })).json()) as
    { lead?: Record<string, any> };
  // 设置 → 模型：用户填上服务商的 key（和网页走同一个操作入口）。
  const saveProvider = async () => (await fetch(`${base}/v1/actions/model_settings/models/save_provider`, {
    method: "POST", headers,
    body: JSON.stringify({ input: { name: "openai", baseUrl: "https://api.example.com/v1", api: "openai-completions", apiKey: "sk-test-new-0123" } }),
  })).status;
  const send = async (message: string) => (await fetch(`${base}/v1/chat/send`, {
    method: "POST", headers, body: JSON.stringify({ id: `cmd-${message.length}`, message }),
  })).status;
  const withEvent = () => prompts.filter((entry) => entry.text.includes(EVENT));
  return { prompts, logs, overview, saveProvider, send, withEvent };
}

function blocker(summary = EVENT) {
  addInbox(db, {
    itemId: createItem(db, { title: summary, brief: "b", createdBy: "system" }), severity: "blocker", source: "structural", summary, lossless: true,
  });
}

const backoffs = (logs: string[]) => logs.filter((line) => line.startsWith("lead wake backoff ("));

describe("Lead's model has no API key", () => {
  it("shows Lead degraded with an account problem, not a green dot", async () => {
    const { prompts, overview } = await boot();
    blocker();
    await vi.waitFor(() => expect(prompts.length).toBeGreaterThanOrEqual(1), { timeout: 10_000 });
    await vi.waitFor(async () => expect((await overview()).lead).toMatchObject({ state: "degraded" }), { timeout: 10_000 });
    const lead = (await overview()).lead!;
    expect(lead.detail).toContain("No API key found for openai");
    expect(lead.reason).toMatch(/account|账号/);
  }, 30_000);

  // 回归：以前退避最长 5 分钟，一直叫醒 Lead。现在最长 30 分钟；用户在设置 → 模型填了 key，马上再交一次。
  it("backs off longer than usual, and wakes Lead again as soon as the user changes the model settings", async () => {
    const { logs, saveProvider, withEvent } = await boot();
    blocker();
    await vi.waitFor(() => expect(withEvent()).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(backoffs(logs)).toEqual(["lead wake backoff (setup): next try in 400 s"]), { timeout: 10_000 });
    await delay(300);
    expect(withEvent()).toHaveLength(1);
    expect(await saveProvider()).toBe(200);
    await vi.waitFor(() => expect(withEvent()).toHaveLength(2), { timeout: 10_000 });
  }, 30_000);

  // 用户自己的消息不受退避影响；它答上了（模型能用了），交给 Lead 的事不再等长退避。
  it("still answers the user while backed off, and a successful turn ends the long backoff", async () => {
    let broken = true;
    const { prompts, send, withEvent } = await boot({ reply: () => (broken ? "no-key" : { say: "好的。" }) });
    blocker();
    await vi.waitFor(() => expect(withEvent()).toHaveLength(1), { timeout: 10_000 });
    await delay(100);
    broken = false;
    expect(await send("你好")).toBe(200);
    await vi.waitFor(() => expect(prompts.some((entry) => entry.text.includes("你好"))).toBe(true), { timeout: 10_000 });
    // 用户那一轮的当前局面里也列着积压的事：只数为交给 Lead 的事开的那几轮。
    await vi.waitFor(() => expect(withEvent().filter((entry) => !entry.text.includes("你好"))).toHaveLength(2), { timeout: 10_000 });
  }, 30_000);

  // 设置是在这一轮开始以后改的：这一轮用的还是旧的 key，它的失败不退避，按新设置马上再叫。
  it("does not back off for a turn that started before the user saved new settings", async () => {
    let release!: () => void;
    let first = true;
    const gate = () => {
      if (!first) return undefined;
      first = false;
      return new Promise<void>((resolve) => { release = resolve; });
    };
    const { logs, saveProvider, withEvent } = await boot({ gate });
    blocker();
    await vi.waitFor(() => expect(withEvent()).toHaveLength(1), { timeout: 10_000 });
    expect(await saveProvider()).toBe(200);
    release();
    await vi.waitFor(() => expect(withEvent()).toHaveLength(2), { timeout: 10_000 });
    // 第二轮是按新设置跑的：它的失败照常长退避。
    await vi.waitFor(() => expect(backoffs(logs)).toEqual(["lead wake backoff (setup): next try in 400 s"]), { timeout: 10_000 });
  }, 30_000);
});

describe("a credential failure while another model can still be used", () => {
  beforeEach(() => vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "50"));

  // 有备用模型：换过去接着做，不按长退避。
  it("fails over to the fallback model instead of backing off long", async () => {
    const { logs, withEvent } = await boot({
      models: ["openai/gpt-test", "spare/model"],
      reply: (model) => (model === "openai/gpt-test" ? "no-key" : { say: "处理了。" }),
    });
    blocker();
    await vi.waitFor(() => expect(withEvent().map((entry) => entry.model)).toEqual(["openai/gpt-test", "spare/model"]), { timeout: 10_000 });
    expect(backoffs(logs)).toEqual([expect.stringContaining("(normal)")]);
  }, 30_000);

  // 第二轮审阅 4：分工里的模型都没有 key 时，以前主用、备用来回换，每次都按 5 分钟的上限退避，失败一直不停。
  // 现在下一轮没有要换的模型时，按长退避。
  it("backs off long once no model in the chain has a key", async () => {
    const { logs, withEvent } = await boot({ models: ["openai/gpt-test", "spare/model"], reply: () => "no-key" });
    blocker();
    await vi.waitFor(() => expect(withEvent().map((entry) => entry.model)).toEqual(["openai/gpt-test", "spare/model"]), { timeout: 10_000 });
    await vi.waitFor(() => expect(backoffs(logs).map((line) => line.slice(0, 26))).toEqual([
      "lead wake backoff (normal)", "lead wake backoff (setup):",
    ]), { timeout: 10_000 });
  }, 30_000);
});

describe("a fallback without a key while the first model waits to come back", () => {
  // 审查 1a：主用的额度封着、Lead 在备用上，备用没有 key。长退避不等过主用的封禁到期（换回只在一轮开始时做），
  // 到期那一轮换回主用，事情交给它。
  it("wakes Lead when the first model's block ends, and the first model takes the events", async () => {
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run("lead.model_quota_blocked", JSON.stringify({ "openai/gpt-test": Date.now() + 1_500 }));
    const { logs, withEvent } = await boot({
      models: ["openai/gpt-test", "spare/model"],
      reply: (model) => (model === "spare/model" ? "no-key" : { say: "处理了。" }),
    });
    blocker();
    await vi.waitFor(() => expect(withEvent().map((entry) => entry.model)).toEqual(["spare/model", "openai/gpt-test"]), { timeout: 10_000 });
    expect(backoffs(logs)).toEqual([expect.stringMatching(/^lead wake backoff \(setup\): next try in [0-2] s$/)]);
  }, 30_000);
});
