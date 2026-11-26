// The limits on automatic model calls (ticket #553, protocol's auto-budget.ts). Before: the three limits came only from
// config.json (lead.autoBudget), read once at startup; to change them the user edited the file and restarted, and Lead
// could not change them. Now auto_budget.set (one operation for the settings page and Lead) writes config.json and
// applies the limits to the running budget at once.
//
// The full persisted flow: the daemon, the gateway, the store, the scheduler and the budget are real; Lead's session is
// the stand-in (fake-pi-session.ts).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runUiAction, UI_ACTIONS } from "@pi-lead-child/engine";
import { scriptedSmartModel } from "@pi-lead-child/engine/testing";
import { AutoCallBudget, autoCallBudgetLimits, autoCallUsageLine, DEFAULT_AUTO_CALL_BUDGET, ModelHold } from "@pi-lead-child/lead";
import { addInbox, createItem, createLoopbackBinding, createTurn, openDb, type Db } from "@pi-lead-child/store";
import { createAutoBudgetService } from "../src/auto-budget-settings.js";
import { startDaemon } from "../src/server.js";
import { fakePiLead, type FakeCall, type FakeReply } from "./fake-pi-session.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

beforeEach(() => {
  dir = tempDir("plc-auto-budget-settings-");
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

const has = (call: FakeCall, text: string) => call.inputs.some((input) => input.includes(text));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as { lead?: { autoBudget?: unknown; models?: unknown } };

async function boot(script: (call: FakeCall) => FakeReply | Promise<FakeReply>) {
  const logs: string[] = [];
  const lead = fakePiLead(script, { smartModel: scriptedSmartModel({ answers: { ask_kind: "other" } }) });
  daemon = await startDaemon({
    dataDir: dir, dbPath, log: (line: string) => { logs.push(line); }, notifyDesktop: () => {}, triageShadow: false,
    sessionFactory: lead.factory as never,
  });
  const owner = createLoopbackBinding(db, { name: "Mac 网页" });
  const http = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${daemon!.pairedPort}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${owner.accessToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { lead, logs, http };
}

function blocker(title: string): void {
  addInbox(db, {
    itemId: createItem(db, { title, brief: "b", createdBy: "system" }),
    severity: "blocker", source: "structural", summary: title, lossless: true,
  });
}

describe("changing the limits on automatic calls from the settings page", () => {
  it("applies at once without a restart: a raised limit ends the budget pause, and Lead's situation shows the new limit", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lead: { models: ["acme/m1"], autoBudget: { callsPerHour: 4 } } }));
    blocker("提示 1");
    const { lead, logs, http } = await boot(() => ({ say: "记下了。" }));
    for (let i = 2; i <= 12; i += 1) {
      await sleep(150);
      blocker(`提示 ${i}`);
    }
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] model.hold action=paused kind=budget"))).toBe(true), { timeout: 10_000 });
    const read = await http("/v1/lead/auto-budget");
    expect(read.status).toBe(200);
    expect(read.body.autoBudget).toMatchObject({ limits: { ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 4 }, defaults: DEFAULT_AUTO_CALL_BUDGET, usage: { callsLastHour: 4 } });
    await sleep(300);
    const paused = lead.calls.length;

    const saved = await http("/v1/actions/auto_budget/lead/set", { input: { callsPerHour: 100 } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.result).toMatchObject({ changed: true, autoBudget: { limits: { callsPerHour: 100 } } });
    // Written back to config.json; the other settings there stay.
    expect(config().lead).toEqual({ models: ["acme/m1"], autoBudget: { ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 100 } });
    // In force at once: the pause ends and the waiting events reach Lead, whose situation shows the new limit.
    await vi.waitFor(() => expect(logs.some((line) => line.startsWith("[sched] model.hold action=resumed kind=budget by=limits_changed"))).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(lead.calls.length).toBeGreaterThan(paused), { timeout: 5_000 });
    await vi.waitFor(() => expect(lead.calls.slice(paused).some((call) => has(call, "/100 次"))).toBe(true), { timeout: 5_000 });
    expect((await http("/v1/lead/auto-budget")).body.autoBudget.limits.callsPerHour).toBe(100);
    // The settings page reads it again.
    const reload = db.prepare("SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required'").all()
      .map((row: any) => JSON.parse(row.payload));
    expect(reload).toContainEqual({ resource: "auto-budget" });

    // After a restart the new limits stay.
    await daemon!.close();
    daemon = null;
    const second = await boot(() => ({ say: "记下了。" }));
    expect((await second.http("/v1/lead/auto-budget")).body.autoBudget.limits).toEqual({ ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 100 });
  }, 60_000);

  it("refuses a value that is not a whole number from 0 up, and changes nothing", async () => {
    const { http } = await boot(() => ({ say: "记下了。" }));
    for (const input of [{ callsPerHour: -1 }, { callsPerDay: 1.5 }, { uncachedTokensPerDay: "5" }, {}, { callsPerHour: 10, extra: 1 }]) {
      const refused = await http("/v1/actions/auto_budget/lead/set", { input });
      expect(refused.status, JSON.stringify(input)).toBe(400);
    }
    expect((await http("/v1/lead/auto-budget")).body.autoBudget.limits).toEqual(DEFAULT_AUTO_CALL_BUDGET);
  }, 30_000);
});

// The same flow without the daemon's sockets (a sandbox that cannot listen on plc.sock still runs these): the service
// the daemon builds, the real budget and the real model hold.
describe("the service behind auto_budget.set", () => {
  it("writes config.json, applies the limits at once, ends a budget pause it no longer needs, and survives a restart", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ lead: { models: ["acme/m1"], autoBudget: { callsPerHour: 4 } } }));
    const lines: string[] = [];
    const budget = new AutoCallBudget({ limits: autoCallBudgetLimits(config().lead?.autoBudget) });
    const hold = new ModelHold({ log: (line) => lines.push(line) });
    let over = null;
    for (let i = 0; i < 4; i += 1) over = budget.record(1_000);
    expect(over).toMatchObject({ limit: "callsPerHour" });
    hold.pause(over!.until, over!.detail);
    expect(hold.held).toBe(true);
    // What Lead's situation shows (the daemon's server.ts builds the line from budget.limits each turn).
    const situation = () => autoCallUsageLine({ ...budget.usage(), limits: budget.limits, coldBatchMinutes: 0 });
    expect(situation()).toContain("最近一小时 4/4 次");

    const service = createAutoBudgetService({ dataDir: dir, budget, hold, log: (line) => lines.push(line) });
    const outcome = await runUiAction(db, {
      target: { type: "auto_budget", id: "lead" }, action: "set", input: { callsPerHour: 100 },
      caller: { kind: "user", credential: createLoopbackBinding(db, { name: "Mac 网页" }).binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } } as never,
      services: { autoBudget: service },
    });
    expect(outcome.result).toMatchObject({ changed: true, autoBudget: { limits: { callsPerHour: 100 }, usage: { callsLastHour: 4, callsLastDay: 4, uncachedTokensLastDay: 4_000 } } });
    expect(budget.limits).toEqual({ ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 100 });
    expect(hold.held).toBe(false);
    expect(lines.some((line) => line.includes("model.hold action=resumed kind=budget by=limits_changed"))).toBe(true);
    expect(situation()).toContain("最近一小时 4/100 次");
    expect(config().lead).toEqual({ models: ["acme/m1"], autoBudget: { ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 100 } });
    // The settings page reads it again.
    const reload = db.prepare("SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required'").all()
      .map((row: any) => JSON.parse(row.payload));
    expect(reload).toContainEqual({ resource: "auto-budget" });
    // A restart reads the new limits (the daemon's startup reads lead.autoBudget the same way).
    expect(autoCallBudgetLimits(config().lead?.autoBudget)).toEqual({ ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 100 });
  });

  it("keeps the pause when the new limits are still exceeded", () => {
    const budget = new AutoCallBudget({ limits: { ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 4 } });
    const hold = new ModelHold({ log: () => {} });
    let over = null;
    for (let i = 0; i < 4; i += 1) over = budget.record(0);
    hold.pause(over!.until, over!.detail);
    createAutoBudgetService({ dataDir: dir, budget, hold }).set({ ...DEFAULT_AUTO_CALL_BUDGET, callsPerHour: 3 });
    expect(hold.held).toBe(true);
  });
});

describe("auto_budget.set from Lead", () => {
  function services() {
    const budget = new AutoCallBudget({ limits: autoCallBudgetLimits(undefined) });
    return { budget, services: { autoBudget: createAutoBudgetService({ dataDir: dir, budget }) } };
  }

  it("belongs to the user: Lead makes it only in the user's own turn, and it is a rule change", () => {
    expect(UI_ACTIONS.auto_budget.set).toMatchObject({ permission: "user_only", userTurnOnly: true, changesRules: true, external: false, irreversible: false });
  });

  it("is refused in a turn that an event or a timer woke: a runaway cannot raise its own limit", async () => {
    const { budget, services: given } = services();
    await expect(runUiAction(db, {
      target: { type: "auto_budget", id: "lead" }, action: "set", input: { callsPerHour: 10_000 }, reason: "事件太多",
      caller: { kind: "lead", turnId: null }, services: given,
    })).rejects.toMatchObject({ code: "needs_user_turn" });
    expect(budget.limits).toEqual(DEFAULT_AUTO_CALL_BUDGET);
  });

  it("changes in the user's own turn, on the user's behalf, and applies at once", async () => {
    const { budget, services: given } = services();
    const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id: "turn-user", originBindingId: binding.id, originKind: "paired:companion", userText: "把每天的上限改成 3000 次", state: "streaming" });
    const outcome = await runUiAction(db, {
      target: { type: "auto_budget", id: "lead" }, action: "set", input: { callsPerDay: 3_000 }, reason: "用户要求",
      caller: { kind: "lead", turnId: "turn-user" }, services: given,
    });
    expect(outcome.forLead).toMatchObject({ result: "updated", limits: { callsPerDay: 3_000 } });
    expect(budget.limits).toEqual({ ...DEFAULT_AUTO_CALL_BUDGET, callsPerDay: 3_000 });
    expect(autoCallBudgetLimits(config().lead?.autoBudget)).toEqual({ ...DEFAULT_AUTO_CALL_BUDGET, callsPerDay: 3_000 });
  });
});
