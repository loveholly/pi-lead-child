// 「用户本人发话时免沙箱」开关（docs/ticket-246-user-turn-bypass.md 第 5 节，实施单 A）。store、操作层和事件是真的。核对：
//   - 存储：kv 的 lead.host-bypass；打开以后一直开着，没有到点的时间（用户 2026-11-10）；坏掉的值按关算；
//     旧版本写的行带 until：过了 until 的读出来是关，没过的照旧开到 until（那是用户当时选的时长）；
//   - enable：只有你本人能在设置页打开（user_direct）。不带时长，请求体是 {}。开着时再打开一次什么也不写。
//     Lead 调它在哪一轮都拿到结构化的拒绝，拒绝里写设置页的位置，什么都不改；
//   - disable：你和 Lead 都能关；已经关着时什么也不写；
//   - 开、关各写一条事件（5.5 的字段）、发 snapshot.required（host-bypass）、写一条 inbox。不再写 host_bypass.expired。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  HOST_BYPASS_DISABLED_KIND, HOST_BYPASS_ENABLED_KIND, HOST_BYPASS_EXPIRED_KIND, UI_ACTION_PERFORMED_KIND,
} from "@pi-lead-child/protocol";
import {
  createLoopbackBinding, createTurn, getHostBypass, HOST_BYPASS_KEY, listEvents, openDb, readStoredHostBypass, type Db,
} from "@pi-lead-child/store";
import { HOST_BYPASS_WHERE, runUiAction } from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-host-bypass-"), "plc.db"));
});

const target = { type: "host_bypass", id: "lead" } as const;
const NOW = new Date("2026-11-05T06:00:00.000Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const DAYS = 24 * 60;

function asUser(action: "enable" | "disable", input: unknown, now = NOW) {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  return runUiAction(db, {
    target, action, input,
    caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } } as never,
    now,
  });
}

function events(kind: string) {
  return listEvents(db, { kind, limit: 50 }).map((event) => ({ entityKey: event.entityKey, payload: event.payload }));
}

function reloads() {
  return db.prepare("SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required'").all()
    .map((row: any) => JSON.parse(row.payload))
    .filter((payload: any) => payload.resource === "host-bypass");
}

function inbox() {
  return db.prepare("SELECT summary, payload FROM inbox WHERE dedup_scope = 'host_bypass:lead' ORDER BY id").all()
    .map((row: any) => ({ summary: row.summary as string, payload: JSON.parse(row.payload) }));
}

function liveUserTurn(id: string) {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  createTurn(db, { id, originBindingId: binding.id, originKind: "paired:companion", userText: "帮我把免沙箱打开", state: "streaming" });
}

const writeRaw = (value: unknown) => db.prepare(
  `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
).run(HOST_BYPASS_KEY, typeof value === "string" ? value : JSON.stringify(value));

describe("the host bypass switch in storage", () => {
  it("is off when nothing is stored, and off when the stored value is broken", () => {
    expect(getHostBypass(db, NOW)).toEqual({ enabled: false, enabledAt: null, bindingId: null, reason: null });
    writeRaw("{ not json");
    expect(getHostBypass(db, NOW).enabled).toBe(false);
    writeRaw({ enabled: "yes" });
    expect(getHostBypass(db, NOW).enabled).toBe(false);
  });

  it("stays on with no end time: a row without until reads as on days later", () => {
    writeRaw({ enabled: true, bindingId: 1, enabledAt: NOW.toISOString(), reason: "在设置页打开了免沙箱" });
    expect(getHostBypass(db, later(30 * DAYS))).toEqual({
      enabled: true, enabledAt: NOW.toISOString(), bindingId: 1, reason: "在设置页打开了免沙箱",
    });
  });

  // 旧版本（2026-11-05 到 11-10）写的行带 until。启动和读都不报错；过了 until 的按关算，没过的开到 until 为止，
  // 不因为这次改动变成一直开着（用户当时只同意了那么久）。
  it("reads a row from the old version with until: off once until has passed, on before it", () => {
    writeRaw({ enabled: true, until: later(30).toISOString(), bindingId: 1, enabledAt: NOW.toISOString(), reason: "在设置页打开了免沙箱" });
    expect(getHostBypass(db, later(29))).toEqual({ enabled: true, enabledAt: NOW.toISOString(), bindingId: 1, reason: "在设置页打开了免沙箱" });
    expect(getHostBypass(db, later(30))).toEqual({ enabled: false, enabledAt: null, bindingId: null, reason: "在设置页打开了免沙箱" });
    writeRaw({ enabled: true, until: "not a date", bindingId: 1, enabledAt: NOW.toISOString(), reason: "x" });
    expect(getHostBypass(db, NOW).enabled).toBe(false);
  });
});

describe("host_bypass.enable", () => {
  it("turns the switch on from the settings page with no duration, and records the event, a reload and an inbox row", async () => {
    const outcome = await asUser("enable", {}, NOW);
    expect(outcome.result).toMatchObject({ changed: true, hostBypass: { enabled: true } });
    const state = getHostBypass(db, NOW);
    expect(state).toEqual({ enabled: true, enabledAt: NOW.toISOString(), bindingId: expect.any(Number), reason: "在设置页打开了免沙箱" });
    // 新写的行不带 until。
    expect(JSON.parse((db.prepare("SELECT value FROM kv WHERE key = ?").get(HOST_BYPASS_KEY) as { value: string }).value))
      .not.toHaveProperty("until");
    // 5.5：host_bypass.enabled 的 bindingId、resolvedBy。没有时长。
    expect(events(HOST_BYPASS_ENABLED_KIND)).toEqual([{
      entityKey: "host_bypass:lead",
      payload: { bindingId: state.bindingId, resolvedBy: `user via Mac 网页（binding ${state.bindingId}）` },
    }]);
    expect(reloads()).toHaveLength(1);
    expect(inbox()).toEqual([{
      summary: "用户在设置页打开了「用户本人发话时免沙箱」。它一直开着，直到用户或你关掉。",
      payload: expect.objectContaining({ kind: "host_bypass", state: "enabled", wakeLead: true }),
    }]);
    const ledger = listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 }).map((event) => event.payload);
    expect(ledger).toEqual([expect.objectContaining({ target, action: "enable", actor: "user", detail: { changed: true } })]);
  });

  it("stays on long after it was turned on, and never writes host_bypass.expired", async () => {
    await asUser("enable", {});
    for (const at of [later(30), later(240), later(241), later(365 * DAYS)]) expect(getHostBypass(db, at).enabled).toBe(true);
    expect(readStoredHostBypass(db).enabled).toBe(true);
    expect(events(HOST_BYPASS_EXPIRED_KIND)).toEqual([]);
  });

  it("takes no duration", async () => {
    for (const input of [{ minutes: 30 }, { minutes: 15 }, { until: later(30).toISOString() }]) {
      await expect(asUser("enable", input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(getHostBypass(db, NOW).enabled).toBe(false);
  });

  it("writes nothing when it is already on", async () => {
    await asUser("enable", {});
    const outcome = await asUser("enable", {}, later(10));
    expect(outcome.result).toMatchObject({ changed: false, hostBypass: { enabled: true, enabledAt: NOW.toISOString() } });
    expect(events(HOST_BYPASS_ENABLED_KIND)).toHaveLength(1);
    expect(reloads()).toHaveLength(1);
  });

  // 旧版本写的、还没到 until 的行：用户在设置页再打开一次，就按新的规则一直开着。
  it("replaces a row from the old version with one that has no end time", async () => {
    writeRaw({ enabled: true, until: later(30).toISOString(), bindingId: 1, enabledAt: NOW.toISOString(), reason: "旧的" });
    const outcome = await asUser("enable", {}, later(10));
    expect(outcome.result).toMatchObject({ changed: true });
    expect(readStoredHostBypass(db).until).toBeNull();
    expect(getHostBypass(db, later(365 * DAYS)).enabled).toBe(true);
  });

  // 验收第 2 条：Fairy 调 enable 得到 user_direct 的结构化拒绝，拒绝里写设置页的位置。
  it("refuses Lead in every turn with a user_direct refusal that says where to turn it on", async () => {
    liveUserTurn("turn-user");
    for (const caller of [
      { kind: "lead", turnId: null },
      { kind: "lead", turnId: "turn-user" },
      { kind: "lead", turnId: null, externalContent: [{ via: "message", source: "slack" }] },
    ] as const) {
      const refused = await runUiAction(db, {
        target, action: "enable", input: {}, reason: "用户让我打开", caller, now: NOW,
      }).catch((error: unknown) => error);
      expect(refused).toMatchObject({
        code: "user_direct",
        refusal: { code: "user_direct", permission: "user_direct", where: HOST_BYPASS_WHERE, target, action: "enable" },
      });
      expect((refused as Error).message).toContain(HOST_BYPASS_WHERE);
      expect((refused as Error).message).not.toMatch(/分钟|minutes/);
    }
    expect(getHostBypass(db, NOW).enabled).toBe(false);
    expect(events(HOST_BYPASS_ENABLED_KIND)).toEqual([]);
  });
});

describe("host_bypass.disable", () => {
  it("lets Lead turn it off in any turn, records who did it and in which turn, and does not wake Lead for its own change", async () => {
    await asUser("enable", {});
    const outcome = await runUiAction(db, {
      target, action: "disable", input: {}, reason: "这件事做完了，不用再开着", caller: { kind: "lead", turnId: "turn-7" },
      now: later(5 * DAYS),
    });
    expect(outcome.forLead).toEqual({ result: "disabled" });
    expect(getHostBypass(db, later(5 * DAYS))).toEqual({ enabled: false, enabledAt: null, bindingId: null, reason: "这件事做完了，不用再开着" });
    expect(events(HOST_BYPASS_DISABLED_KIND)).toEqual([{
      entityKey: "host_bypass:lead", payload: { by: "lead", turnId: "turn-7", reason: "这件事做完了，不用再开着" },
    }]);
    expect(reloads()).toHaveLength(2);
    expect(inbox().at(-1)!.payload).toMatchObject({ state: "disabled", wakeLead: false });
  });

  it("lets you turn it off from the page, and wakes Lead", async () => {
    await asUser("enable", {});
    await asUser("disable", {}, later(1));
    expect(events(HOST_BYPASS_DISABLED_KIND)).toEqual([
      { entityKey: "host_bypass:lead", payload: { by: "user", turnId: null, reason: "关掉了免沙箱" } },
    ]);
    expect(inbox().at(-1)!.payload).toMatchObject({ state: "disabled", wakeLead: true });
  });

  it("writes nothing when the switch is already off", async () => {
    const outcome = await runUiAction(db, {
      target, action: "disable", input: {}, reason: "确认是关着的", caller: { kind: "lead", turnId: null }, now: NOW,
    });
    expect(outcome.forLead).toEqual({ result: "unchanged", note: "免沙箱本来就是关着的" });
    expect(events(HOST_BYPASS_DISABLED_KIND)).toEqual([]);
    expect(reloads()).toEqual([]);
  });

  // 旧版本写的行已经过了 until：读出来本来就是关，关一次什么也不写，也不补 host_bypass.expired。
  it("writes nothing for a row from the old version whose until has passed", async () => {
    writeRaw({ enabled: true, until: later(15).toISOString(), bindingId: 1, enabledAt: NOW.toISOString(), reason: "旧的" });
    const outcome = await asUser("disable", {}, later(20));
    expect(outcome.result).toMatchObject({ changed: false, hostBypass: { enabled: false } });
    expect(events(HOST_BYPASS_DISABLED_KIND)).toEqual([]);
    expect(events(HOST_BYPASS_EXPIRED_KIND)).toEqual([]);
    expect(reloads()).toEqual([]);
  });
});
