// Lead 的上下文满了，压缩写不下摘要（2026-10-28 09:44–10:23 的停摆）。那天：
//   - Lead 的上下文约 48 万 token，每一轮的回答都被截成空的（stopReason length），pi 的溢出压缩以
//     "generation hit the token cap" 失败，一共 10 次。空回答被算成一次成功的模型调用：顶栏回到绿点，这一轮算成功，
//     交给它的事件（用户本人设的跟进 #329）算处理完，游标前进，事件再也没有交回来。
//   - 跟进 #329 的内容只留在 Lead 的上下文里。之后一条 Slack 消息叫醒的一轮压缩成功了，Lead 接着做 #329 的事，设下一次跟进：
//     系统按那一轮的来历算成外部的一轮，确认卡写成「Aurum 要求设一个定时器」。
//   - Slack 卡一直写「排队中」，用户不知道 Lead 卡住了。
// 现在：
//   - 溢出压缩失败的一轮是失败的一轮：游标不动，交给它的事件下一轮再交；Lead 的健康状态是降级，过了宽限期按停摆处理；
//   - 自动压缩失败以后，下一轮开始前 daemon 自己压缩一次，给摘要定一个长度；写到上限时用更严的长度再试一次；
//     两次都失败时这一轮不调模型，按失败处理（模型切换按连续溢出算）；
//   - 用户本人设的跟进到点，单独一轮，那一轮算用户的一轮。
// daemon、store、Lead 的工具是真的；Lead 的会话是替身（fake-pi-session.ts）。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools } from "@pi-lead-child/lead";
import {
  addInbox, completeTurn, createItem, createLoopbackBinding, createPairing, createTurn, listEvents, listNotifications, openDb,
  redeemPairing, type Db,
} from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

const TOKEN_CAP = "Summarization failed: generation hit the token cap and the summary is incomplete";
const OVERFLOW_FAILED = `Context overflow recovery failed: ${TOKEN_CAP}`;

beforeEach(() => {
  dir = tempDir("plc-lead-context-full-");
  dbPath = join(dir, "plc.db");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(dbPath);
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  vi.stubEnv("PLC_LEAD_WAKE_RETRY_MS", "50");
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  db.close();
  vi.unstubAllEnvs();
});

// 时间线：模型调用（call:<这一次新送进来的输入里有没有跟进>）和手动压缩（compact:normal / compact:strict）。
type Step = string;

async function boot(
  script: (call: FakeCall, live: (name: string) => any) => Promise<FakeReply>,
  compact: (instructions: string | undefined) => void | Promise<void>,
) {
  let leadDeps: any = null;
  const live = (name: string) => createLeadTools(leadDeps).find((candidate: any) => candidate.name === name) as any;
  const lead = fakePiLead((call) => script(call, live), { compact });
  const logs: string[] = [];
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line) => logs.push(line), notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: (async (args: any) => {
      leadDeps = args;
      return lead.factory(args);
    }) as never,
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const tool = (name: string, turnId: string | null) =>
    createLeadTools({ ...leadDeps, currentTurnId: () => turnId }).find((candidate: any) => candidate.name === name) as any;
  const issued = redeemPairing(db, createPairing(db, { name: "app", kind: "companion", scopes: ["chat", "tickets:view"] }).code);
  const headers = { authorization: `Bearer ${issued.accessToken}` };
  const overview = async () => (await (await fetch(`http://127.0.0.1:${daemon!.pairedPort}/v1/overview?include=lead`, { headers })).json()) as
    { lead?: Record<string, any> };
  return { lead, logs, owner, tool, overview };
}

// 用户本人在自己的一轮里设一个已经到点的跟进（和 timer-provenance-daemon.test.ts 一样）。
async function userFollowUp(tool: (name: string, turnId: string | null) => any, ownerId: number, note: string) {
  createTurn(db, { id: "turn-set", originBindingId: ownerId, originKind: "paired:companion", userText: note, state: "streaming" });
  const set = await tool("follow_up", "turn-set").execute("call", { at: new Date(Date.now() - 1_000).toISOString(), note });
  expect(set.content[0].text).toContain("到点那一轮算用户的一轮");
  completeTurn(db, "turn-set");
}

const NOTE = "盯 #proj-os-bfs-design-check 两个 thread，读之前先设下一次跟进";
const mentions = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));

describe("Lead's context is full and the summary does not fit", () => {
  // 回归（2026-10-28 的跟进 #329 和那张确认卡）。
  it("fails the turn, gives its follow-up back, compacts with a length budget first, and keeps the follow-up the user's", async () => {
    const steps: Step[] = [];
    const results: string[] = [];
    let compactions = 0;
    const { owner, tool } = await boot(async (call, live) => {
      steps.push(`call:${mentions(call, NOTE)}`);
      if (!mentions(call, NOTE)) return { say: "NO_REPLY" };
      if (steps.filter((step) => step === "call:true").length === 1) return { cutOff: OVERFLOW_FAILED };
      // 交回来的那一轮：Lead 照跟进说的，先设下一次跟进。
      const next = await live("follow_up").execute("call", { at: new Date(Date.now() + 86_400_000).toISOString(), note: NOTE });
      results.push(next.content[0].text);
      return { say: "两个 thread 都没有新消息。" };
    }, (instructions) => {
      compactions += 1;
      steps.push(`compact:${instructions?.includes("更严") ? "strict" : "normal"}`);
      // 第一次按普通的长度写，还是写到上限；更严的那一次写下了。
      if (compactions === 1) throw new Error(TOKEN_CAP);
    });
    await userFollowUp(tool, owner.binding.id, NOTE);

    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 10_000 });
    // 被截断的那一轮算失败：跟进交回来了，而且是单独的一轮，算用户的一轮（不要确认，不写别人要求的）。
    expect(results[0]).toContain("这是用户让你设的");
    expect(listEvents(db, { kind: "timer.request.requested" })).toEqual([]);
    // 下一轮开始以前先压缩：普通的长度写到上限，换更严的长度再写一次，写下了才调模型。
    const retried = steps.indexOf("call:true", steps.indexOf("call:true") + 1);
    expect(steps.slice(steps.indexOf("call:true"), retried + 1)).toEqual(["call:true", "compact:normal", "compact:strict", "call:true"]);
  }, 30_000);

  it("keeps Lead degraded and tells the user once it counts as down, without a failure card for every retry", async () => {
    vi.stubEnv("PLC_LEAD_DOWN_GRACE_MS", "50");
    const calls: FakeCall[] = [];
    let compactions = 0;
    const { owner, tool, overview, logs } = await boot(async (call) => {
      calls.push(call);
      return mentions(call, NOTE) ? { cutOff: OVERFLOW_FAILED } : { say: "NO_REPLY" };
    }, () => {
      compactions += 1;
      throw new Error(TOKEN_CAP);
    });
    await userFollowUp(tool, owner.binding.id, NOTE);

    // 空回答不算一次成功的模型调用：顶栏一直是降级，原因是上下文满了。
    await vi.waitFor(async () => expect((await overview()).lead).toMatchObject({ state: "degraded" }), { timeout: 10_000 });
    expect((await overview()).lead!.detail).toMatch(/Context overflow/);
    // 下一轮：两次压缩都失败，这一轮不调模型。
    await vi.waitFor(() => expect(compactions).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
    expect(calls.filter((call) => mentions(call, NOTE))).toHaveLength(1);
    expect(logs.some((line) => line.includes("turn error") && line.includes("Context overflow"))).toBe(true);
    // 过了宽限期按停摆处理：积压的事汇总给用户，原因写上下文满了。
    await vi.waitFor(() => expect(listNotifications(db).filter((row) => row.kind === "lead_unavailable")).toMatchObject([
      { title: expect.stringContaining("上下文满了") },
    ]), { timeout: 10_000 });
    // 失败的系统回合不在会话里留一张张失败卡片：顶栏和停摆通知已经说了。
    expect(db.prepare("SELECT count(*) AS n FROM channel_turns WHERE state = 'failed'").get()).toEqual({ n: 0 });
  }, 30_000);
});

describe("a follow-up the user set", () => {
  // 回归：用户的跟进和别的系统事件一起交给一轮时，那一轮不再算用户的一轮（userTimerOf 要求全是用户的跟进）。
  it("gets a turn of its own even when other events wait, so it stays the user's turn", async () => {
    const results: string[] = [];
    const inputs: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { owner, tool } = await boot(async (call, live) => {
      inputs.push(call.inputs);
      // 第一件事的那一轮先停住：跟进到点和第二件事在这期间一起排上。
      if (inputs.length === 1) return { say: ["在看。", gate] };
      if (mentions(call, NOTE)) {
        const next = await live("follow_up").execute("call", { at: new Date(Date.now() + 86_400_000).toISOString(), note: NOTE });
        results.push(next.content[0].text);
      }
      return { say: "NO_REPLY" };
    }, () => {});
    const blocker = (summary: string) => addInbox(db, {
      itemId: createItem(db, { title: summary, brief: "b", createdBy: "system" }), severity: "blocker", source: "structural", summary, lossless: true,
    });
    blocker("Run #7 crashed");
    await vi.waitFor(() => expect(inputs.some((batch) => batch.some((input) => input.includes("Run #7 crashed")))).toBe(true), { timeout: 10_000 });
    await userFollowUp(tool, owner.binding.id, NOTE);
    blocker("Run #8 crashed");
    await vi.waitFor(() => expect(listEvents(db, { kind: "timer.fired" })).toHaveLength(1), { timeout: 10_000 });
    release();

    await vi.waitFor(() => expect(results).toHaveLength(1), { timeout: 10_000 });
    expect(results[0]).toContain("这是用户让你设的");
    // 交给那一轮的事件只有跟进（当前局面里照常列着积压的事，那不是交给它的事件）。
    const withNote = inputs.find((batch) => batch.some((input) => input.includes(NOTE)))!.join("\n");
    const delivered = [...withNote.matchAll(/<system_event kind="inbox"[^>]*>\n([^\n]*)/gu)].map((match) => match[1]);
    expect(delivered).toEqual([expect.stringContaining(NOTE)]);
  }, 30_000);
});
