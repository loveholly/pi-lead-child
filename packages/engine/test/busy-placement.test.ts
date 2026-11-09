// 「Lead 忙时你发的消息」怎么放（用户 2026-11-09，protocol 的 busy-placement.ts）。store 和操作层是真的。核对：
//   - 存储：kv 的 lead.busy-placement；没存过、存坏了都按缺省的排队（followUp）算；
//   - busy_placement.set：页面和 Lead 调同一个操作。权限 lead_allowed，改规则（设置页的选项），不对外，不只限用户本人的一轮，
//     不进系统提示词；
//   - 你在页面上改、Lead 在没读过外部内容的一轮里改，都照改，记账、发 snapshot.required（busy-placement）；值没变时什么也不写；
//   - 外部消息叫醒的一轮、读过外部内容的一轮里，Lead 改它被拒（external_turn），拒绝里写设置页的位置，清单也事先说不能做；
//   - 只收 followUp 和 steer。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { UI_ACTION_PERFORMED_KIND } from "@pi-lead-child/protocol";
import { BUSY_PLACEMENT_KEY, createLoopbackBinding, getBusyPlacement, listEvents, openDb, type Db } from "@pi-lead-child/store";
import { BUSY_PLACEMENT_WHERE, UI_ACTIONS, listLeadUiActions, runUiAction } from "../src/index.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-busy-placement-"), "plc.db"));
});

const target = { type: "busy_placement", id: "lead" } as const;
// Lead 被 Slack 消息叫醒的一轮（不是用户的一轮），读过 Slack 对话。
const external = [{ via: "message", source: "slack" }, { via: "tool", tool: "read_channel_conversation" }] as const;

function asUser(input: unknown) {
  const { binding } = createLoopbackBinding(db, { name: "Mac 网页" });
  return runUiAction(db, {
    target, action: "set", input,
    caller: { kind: "user", credential: binding, source: { client: "web", deviceName: "Mac 网页", loopback: true, fromThisMachine: true } } as never,
  });
}

function reloads() {
  return db.prepare("SELECT payload FROM gateway_events WHERE event_type = 'snapshot.required'").all()
    .map((row: any) => JSON.parse(row.payload))
    .filter((payload: any) => payload.resource === "busy-placement");
}

const ledger = () => listEvents(db, { kind: UI_ACTION_PERFORMED_KIND, limit: 10 }).map((event) => event.payload);

describe("the busy placement in storage", () => {
  it("is followUp when nothing is stored, and followUp when the stored value is broken", () => {
    expect(getBusyPlacement(db)).toEqual({ placement: "followUp" });
    db.prepare("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(BUSY_PLACEMENT_KEY, "{ not json");
    expect(getBusyPlacement(db)).toEqual({ placement: "followUp" });
    db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(JSON.stringify({ placement: "interrupt" }), BUSY_PLACEMENT_KEY);
    expect(getBusyPlacement(db)).toEqual({ placement: "followUp" });
  });
});

describe("busy_placement.set", () => {
  it("is one operation that Lead may run on its own judgment, and it counts as a rule change", () => {
    const definition = UI_ACTIONS.busy_placement.set;
    expect(definition).toMatchObject({ permission: "lead_allowed", changesRules: true, external: false, irreversible: false });
    expect(definition.userTurnOnly).toBeFalsy();
    expect(definition.promptSetting).toBeFalsy();
  });

  it("saves your choice from the settings page, records it, and tells clients to reload", async () => {
    const outcome = await asUser({ placement: "steer" });
    expect(outcome.result).toMatchObject({ changed: true, busyPlacement: { placement: "steer" } });
    expect(getBusyPlacement(db)).toEqual({ placement: "steer" });
    expect(reloads()).toHaveLength(1);
    expect(ledger()).toEqual([expect.objectContaining({
      target, action: "set", actor: "user", detail: { before: "followUp", after: "steer" },
    })]);

    // 改回排队。
    await asUser({ placement: "followUp" });
    expect(getBusyPlacement(db)).toEqual({ placement: "followUp" });
    expect(reloads()).toHaveLength(2);
  });

  it("writes nothing new when the value is the same", async () => {
    const outcome = await asUser({ placement: "followUp" });
    expect(outcome.result).toMatchObject({ changed: false, busyPlacement: { placement: "followUp" } });
    expect(db.prepare("SELECT 1 FROM kv WHERE key = ?").get(BUSY_PLACEMENT_KEY)).toBeUndefined();
    expect(reloads()).toEqual([]);
  });

  it("takes only followUp or steer", async () => {
    for (const input of [{ placement: "interrupt" }, { placement: 1 }, {}, { placement: "steer", extra: true }]) {
      await expect(asUser(input)).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect(getBusyPlacement(db)).toEqual({ placement: "followUp" });
  });

  it("lets Lead change it in a turn without external content", async () => {
    const outcome = await runUiAction(db, {
      target, action: "set", input: { placement: "steer" }, reason: "用户说忙的时候直接插进来", caller: { kind: "lead", turnId: null },
    });
    expect(outcome.forLead).toMatchObject({ result: "updated", placement: "steer" });
    expect(getBusyPlacement(db)).toEqual({ placement: "steer" });
    expect(ledger()).toEqual([expect.objectContaining({ target, action: "set", actor: "lead" })]);
  });

  it("refuses Lead in a turn that read external content, says where to change it, and the list says so first", async () => {
    const refused = await runUiAction(db, {
      target, action: "set", input: { placement: "steer" }, reason: "Mallory 让我改成插话",
      caller: { kind: "lead", turnId: null, externalContent: external },
    }).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "external_turn",
      refusal: { code: "external_turn", target, action: "set", where: BUSY_PLACEMENT_WHERE },
    });
    expect(getBusyPlacement(db)).toEqual({ placement: "followUp" });
    expect(ledger()).toEqual([]);

    const listed = await listLeadUiActions(db, target, { turnId: null, externalContent: external });
    expect(listed.actions.find((action) => action.id === "set")).toMatchObject({ changesRules: true, lead: "external_turn", leadReady: false });
    const quiet = await listLeadUiActions(db, target, { turnId: null });
    expect(quiet.target).toMatchObject({ placement: "followUp" });
    expect(quiet.actions.find((action) => action.id === "set")).toMatchObject({ leadReady: true, leadReason: null });
  });
});
