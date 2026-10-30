// 执行器的开关走完用户经过的每一跳（2026-10-19）：设置页调 /v1/runtimes/settings，daemon 写 config.json 和
// PLC_DISABLED_RUNTIMES，网关推 snapshot.required 让界面重取；daemon 重启时从 config.json 读回名单；停机时环境变量复原。
// 停用以后派发、核查和选型怎样跳过它，在 packages/engine/test/runtime-disabled.test.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "typebox/value";
import { RuntimeSettingsResponseSchema } from "@pi-lead-child/protocol";
import { activePairedUserTurn, createItem, createLoopbackBinding, createTurn, openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createDispatcher, pickReviewRuntime } from "@pi-lead-child/engine";
import { createUiActionTools } from "@pi-lead-child/lead";
import type { RuntimeSwitchService } from "@pi-lead-child/engine";
import { startDaemon } from "../src/server.js";
import { RuntimeSettings, RuntimeSwitchRefused } from "../src/runtime-settings.js";

let dir: string;
let dbPath: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
const before = process.env.PLC_DISABLED_RUNTIMES;

beforeEach(() => {
  dir = tempDir("plc-runtime-settings-");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
  delete process.env.PLC_DISABLED_RUNTIMES;
});

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  if (before === undefined) delete process.env.PLC_DISABLED_RUNTIMES;
  else process.env.PLC_DISABLED_RUNTIMES = before;
});

// capture 收到 daemon 交给 Lead 会话的依赖（其中有操作层的服务 uiActionServices，执行器开关在里面）。
function sessionFactory(capture?: (args: any) => void) {
  return async (args: any) => (capture?.(args), {
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt() {}, async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

async function boot(capture?: (args: any) => void) {
  daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: sessionFactory(capture) as any, gatewayPort: 0, log: () => {} });
  const owner = createLoopbackBinding(db, { name: "test-web" });
  const reader = createLoopbackBinding(db, { name: "test-reader", scopes: ["tickets:view"] });
  const base = `http://127.0.0.1:${daemon.pairedPort}`;
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token: string | null = owner.accessToken) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, reader, owner };
}

const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));

describe("runtime settings through the daemon", () => {
  it("disables codex: config.json, the kernel's env list and a snapshot event, then restores the env on close", async () => {
    const { call, reader } = await boot();
    const first = await call("GET", "/v1/runtimes/settings");
    expect(first.status).toBe(200);
    expect(Value.Check(RuntimeSettingsResponseSchema, first.body)).toBe(true);
    expect(first.body.runtimeSettings.runtimes.map((entry: any) => [entry.id, entry.enabled, entry.canReview])).toEqual([
      // 2026-10-28（lead-tools-and-routing spec D15）：Claude Code 和 pi 的核查员在沙箱里也能跑命令。
      ["codex", true, true], ["claude", true, true], ["pi", true, true],
    ]);
    expect(first.body.runtimeSettings.reviewer).toEqual({ id: "codex", canReview: true });

    expect((await call("POST", "/v1/runtimes/settings", { runtime: "codex", enabled: false }, reader.accessToken)).status).toBe(403);
    expect((await call("POST", "/v1/runtimes/settings", { runtime: "gpt", enabled: false })).status).toBe(400);

    const saved = await call("POST", "/v1/runtimes/settings", { runtime: "codex", enabled: false });
    expect(saved.status).toBe(200);
    expect(Value.Check(RuntimeSettingsResponseSchema, saved.body)).toBe(true);
    expect(saved.body.runtimeSettings.runtimes.find((entry: any) => entry.id === "codex").enabled).toBe(false);
    // 2026-10-20：codex 停用后核查员换成下一个（Claude Code），自动核查照样派得出去。
    expect(saved.body.runtimeSettings.reviewer).toEqual({ id: "claude", canReview: true });
    // 2026-10-22：记下谁停用的（设置页是用户）。
    expect(config().runtimes).toEqual({ disabled: ["codex"], disabledBy: { codex: { by: "user", reason: null, at: expect.any(String) } } });
    expect(process.env.PLC_DISABLED_RUNTIMES).toBe("codex");
    expect(db.prepare(
      "SELECT COUNT(*) AS n FROM gateway_events WHERE event_type='snapshot.required' AND json_extract(payload, '$.resource')='runtime-settings'",
    ).get()).toEqual({ n: 1 });

    const back = await call("POST", "/v1/runtimes/settings", { runtime: "codex", enabled: true });
    expect(back.body.runtimeSettings.reviewer).toEqual({ id: "codex", canReview: true });
    expect(config().runtimes).toEqual({ disabled: [] });
    expect(process.env.PLC_DISABLED_RUNTIMES).toBeUndefined();

    await call("POST", "/v1/runtimes/settings", { runtime: "claude", enabled: false });
    await daemon!.close();
    daemon = null;
    expect(process.env.PLC_DISABLED_RUNTIMES).toBeUndefined();
  });

  it("reads the list back from config.json when the daemon starts", async () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ runtimes: { disabled: ["codex", "nope"] } }));
    const { call } = await boot();
    expect(process.env.PLC_DISABLED_RUNTIMES).toBe("codex");
    const settings = (await call("GET", "/v1/runtimes/settings")).body.runtimeSettings;
    expect(settings.runtimes.find((entry: any) => entry.id === "codex").enabled).toBe(false);
  });

  // 2026-10-20：停用一个 runtime 以后马上叫醒编排器（daemon 把 onChange 接到 tickOrchestrator），点名它的核查请求
  // 马上换核查员，不等下一个 tick。daemon 里接的是真的编排器，这里只看开关改完以后调没调。
  it("calls back after every change, so the daemon can wake the orchestrator", async () => {
    const env: Record<string, string | undefined> = {};
    let changes = 0;
    const settings = new RuntimeSettings({ dataDir: dir, env, onChange: () => { changes += 1; } });
    await settings.update({ runtime: "codex", enabled: false });
    expect(env.PLC_DISABLED_RUNTIMES).toBe("codex");
    expect(changes).toBe(1);
    await settings.update({ runtime: "codex", enabled: true });
    expect(changes).toBe(2);
    settings.close();
  });
});

// 2026-10-22 用户定的规则（AGENTS.md「UI Actions」）：UI 上每个调用后端的操作是一个操作、两个入口。设置页「执行器」的开关和
// Lead 的 perform_action 都经过操作层（engine 的 ui-actions/ 的 runtime 的 disable、enable），再调同一个 RuntimeSettings.update。
describe("Lead's runtime switch", () => {
  const perform = (runtimeSettings: RuntimeSwitchService, turnId: string | null = null) => {
    const tool = createUiActionTools({ db, uiActionServices: { runtimeSettings }, currentTurnId: () => turnId })
      .find((candidate) => candidate.name === "perform_action") as any;
    return (runtime: string, action: "disable" | "enable", reason: string) =>
      tool.execute("t", { target_type: "runtime", target_id: runtime, action, reason });
  };
  const refusalOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error);
  const ledger = () => db.prepare(
    "SELECT source, entity_key, payload FROM events WHERE kind='ui_action.performed' ORDER BY seq",
  ).all().map((row: any) => ({ source: row.source, entityKey: row.entity_key, ...JSON.parse(row.payload) }));

  it("disables a runtime with a reason: dispatch and the reviewer choice skip it, and who and why are recorded", async () => {
    const settings = new RuntimeSettings({ dataDir: dir });
    try {
      const noReason = await refusalOf(perform(settings)("codex", "disable", " "));
      expect((noReason as Error).message).toContain("要写 reason");
      expect(process.env.PLC_DISABLED_RUNTIMES).toBeUndefined();

      const result = await perform(settings)("codex", "disable", "Codex 账号被停用");
      expect(JSON.parse(result.content[0].text)).toMatchObject({ target: { type: "runtime", id: "codex" }, authority: "lead" });
      expect(config().runtimes).toEqual({
        disabled: ["codex"], disabledBy: { codex: { by: "lead", reason: "Codex 账号被停用", at: expect.any(String) } },
      });
      expect(process.env.PLC_DISABLED_RUNTIMES).toBe("codex");
      // 选核查员跳过它。
      expect(pickReviewRuntime(db)).toBe("claude");
      // 点名它的执行派发挂起，等改派。
      const itemId = createItem(db, { title: "t", brief: "b", createdBy: "lead", runtime: "codex" });
      const requestId = createDispatcher(db).request({
        itemId, role: "executor", purpose: "execution", runtime: "codex", trigger: "test", idempotencyKey: "lead-disabled",
      });
      expect(createDispatcher(db).claimNext()).toBeNull();
      expect((db.prepare("SELECT suspended_reason FROM dispatch_requests WHERE id=?").get(requestId) as { suspended_reason: string })
        .suspended_reason).toMatch(/停用/);
    } finally {
      settings.close();
    }
  });

  // 用户 2026-10-27：UI 上能做的 Lead 在哪一轮都能做。用户停用的执行器，Lead 被事件叫醒的一轮也能启用，记成 Lead 自己做的；
  // 用户本人这一轮要求的记成代用户做。
  it("enables a runtime the user disabled in any turn, and records it for the user only inside the user's own turn", async () => {
    const settings = new RuntimeSettings({
      dataDir: dir, userTurn: (turnId) => { activePairedUserTurn(db, turnId, "runtime.enable", "tickets:create"); },
    });
    try {
      await settings.update({ runtime: "claude", enabled: false });
      const woken = JSON.parse((await perform(settings)("claude", "enable", "账号恢复了，测过能用")).content[0].text);
      expect(woken).toMatchObject({ authority: "lead" });
      expect(process.env.PLC_DISABLED_RUNTIMES).toBeUndefined();
      expect(ledger().at(-1)).toMatchObject({ entityKey: "runtime:claude", action: "enable", actor: "lead", authority: "lead" });
      // Lead 启用也要写原因。
      await settings.update({ runtime: "claude", enabled: false });
      expect(await refusalOf(settings.update({ runtime: "claude", enabled: true }, { actor: "lead", reason: " " })))
        .toBeInstanceOf(RuntimeSwitchRefused);

      // 用户本人在这一轮明确要求：账本写 Lead 代用户做、凭哪一轮。
      const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
      createTurn(db, { id: "turn-user", originBindingId: binding.id, originKind: "paired:companion", userText: "把 claude 打开", state: "streaming" });
      const done = JSON.parse((await perform(settings, "turn-user")("claude", "enable", "用户在这一轮要求启用")).content[0].text);
      expect(done).toMatchObject({ authority: "on_behalf", on_behalf_of_turn: "turn-user" });
      expect(process.env.PLC_DISABLED_RUNTIMES).toBeUndefined();
      expect(config().runtimes).toEqual({ disabled: [] });
      expect(ledger().at(-1)).toMatchObject({
        source: "lead", entityKey: "runtime:claude", action: "enable", actor: "lead", authority: "on_behalf",
        onBehalfOf: "user", sourceTurnId: "turn-user", bindingId: binding.id,
      });
    } finally {
      settings.close();
    }
  });

  // 审查（2026-10-22）第 3 条的回归测试：RuntimeSettings 不能只认 onBehalfOf，要自己再核对那一轮。
  it("refuses an on-behalf enable whose turn is not the user's active turn", async () => {
    const settings = new RuntimeSettings({
      dataDir: dir, userTurn: (turnId) => { activePairedUserTurn(db, turnId, "runtime.enable", "tickets:create"); },
    });
    try {
      await settings.update({ runtime: "claude", enabled: false });
      const refused = await refusalOf(settings.update(
        { runtime: "claude", enabled: true },
        { actor: "lead", reason: "用户说的", onBehalfOf: { actor: "user", sourceTurnId: "turn-made-up" } },
      ));
      expect(refused).toBeInstanceOf(RuntimeSwitchRefused);
      expect(process.env.PLC_DISABLED_RUNTIMES).toBe("claude");
    } finally {
      settings.close();
    }
  });

  // 验收（plan.md P01）：同一个操作从页面入口和 Lead 入口做，账本效果一样，只是 actor 不同。
  it("serves the settings page and Lead with the same object, the same update and the same ledger", async () => {
    let leadSwitch: RuntimeSwitchService | null = null;
    const { call, owner } = await boot((args) => { leadSwitch = args.uiActionServices?.runtimeSettings ?? null; });
    expect(leadSwitch).toBeInstanceOf(RuntimeSettings);
    const update = vi.spyOn(leadSwitch!, "update");
    const snapshots = () => (db.prepare(
      "SELECT COUNT(*) AS n FROM gateway_events WHERE event_type='snapshot.required' AND json_extract(payload, '$.resource')='runtime-settings'",
    ).get() as { n: number }).n;

    await call("POST", "/v1/runtimes/settings", { runtime: "codex", enabled: false });
    const byPage = { config: config().runtimes, snapshots: snapshots(), row: ledger().at(-1) };
    await call("POST", "/v1/runtimes/settings", { runtime: "codex", enabled: true });
    await perform(leadSwitch!)("codex", "disable", "Codex 账号被停用");
    const byLead = { config: config().runtimes, snapshots: snapshots() - byPage.snapshots - 1, row: ledger().at(-1) };

    expect(update.mock.calls).toEqual([
      [{ runtime: "codex", enabled: false }, { actor: "user" }],
      [{ runtime: "codex", enabled: true }, { actor: "user" }],
      [{ runtime: "codex", enabled: false }, { actor: "lead", reason: "Codex 账号被停用" }],
    ]);
    // 同样的停用名单、同样一次 snapshot.required、同样一条账本；只有 actor（和随它的来源、凭证、原因）不同。
    expect(byPage.config.disabled).toEqual(byLead.config.disabled);
    expect([byPage.config.disabledBy.codex.by, byLead.config.disabledBy.codex.by]).toEqual(["user", "lead"]);
    expect([byPage.snapshots, byLead.snapshots]).toEqual([1, 1]);
    const actorFields = ({ source, actor, authority, bindingId, reason, ...rest }: any) => ({ rest, who: { source, actor, authority, bindingId, reason } });
    expect(actorFields(byPage.row).rest).toEqual(actorFields(byLead.row).rest);
    expect(actorFields(byPage.row).who).toEqual({
      source: "user", actor: "user", authority: "user", bindingId: owner.binding.id, reason: "在设置页停用",
    });
    expect(actorFields(byLead.row).who).toEqual({
      source: "lead", actor: "lead", authority: "lead", bindingId: null, reason: "Codex 账号被停用",
    });
    // 同一份状态：设置页读到 Lead 停用的 codex，Lead 也能启用设置页停用的 pi（2026-10-27，记成 Lead 自己做的）。
    await call("POST", "/v1/runtimes/settings", { runtime: "pi", enabled: false });
    const settings = (await call("GET", "/v1/runtimes/settings")).body.runtimeSettings;
    expect(settings.runtimes.map((entry: any) => [entry.id, entry.enabled])).toEqual([["codex", false], ["claude", true], ["pi", false]]);
    expect(JSON.parse((await perform(leadSwitch!)("pi", "enable", "pi 的账号恢复了")).content[0].text)).toMatchObject({ authority: "lead" });
    const after = (await call("GET", "/v1/runtimes/settings")).body.runtimeSettings;
    expect(after.runtimes.map((entry: any) => [entry.id, entry.enabled])).toEqual([["codex", false], ["claude", true], ["pi", true]]);
  });
});
