// 改界面的外观偏好（2026-10-22）。设置页和 Lead 的 update_design_preferences 调同一个函数（updateDesignPreferences）：
//   - 页面以你本人的名义改，记一次主人操作（ui.design）；
//   - Lead 只能在你这一轮明确要求时代你改；
//   - 没有变化时什么也不写；「不是我」恢复成改之前的样子，之后又改过的不动；
//   - 主色太浅（白底上不到 4.5:1）时拒绝：可读性底线。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { DEFAULT_DESIGN_PREFERENCES } from "@pi-lead-child/protocol";
import {
  completeTurn, createLoopbackBinding, createTurn, getDesignPreferences, listEvents, openDb, type Db,
} from "@pi-lead-child/store";
import { DesignPreferencesError, revertDesignPreferences, updateDesignPreferences } from "../src/design-preferences.js";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-design-prefs-"), "plc.db"));
});
afterEach(() => db.close());

function web() {
  return createLoopbackBinding(db, { name: "本机网页" }).binding;
}

const SOURCE = { client: "web" as const, deviceName: "本机网页", loopback: true, fromThisMachine: true };

function performed() {
  return listEvents(db, { kind: "owner_action.performed", limit: 100 });
}

describe("updateDesignPreferences", () => {
  it("starts with the zoned defaults", () => {
    expect(getDesignPreferences(db)).toEqual(DEFAULT_DESIGN_PREFERENCES);
    expect(getDesignPreferences(db).density).toEqual({ workspace: "compact", ticket: "compact", conversation: "standard", settings: "standard" });
  });

  it("saves the user's change, records an owner action and asks clients to reload", () => {
    const binding = web();
    const published: string[] = [];
    const outcome = updateDesignPreferences(db, {
      request: { density: { ticket: "standard" }, radius: "round", colors: { accent: "#1e51d6" }, notes: " 喜欢大圆角 " },
      caller: { kind: "user", credential: binding, source: SOURCE },
      now: new Date("2026-10-22T07:00:00.000Z"),
      publish: (resource) => published.push(resource),
    });
    expect(outcome).toMatchObject({ changed: true, by: { actor: "user" } });
    expect(getDesignPreferences(db)).toMatchObject({
      density: { workspace: "compact", ticket: "standard", conversation: "standard", settings: "standard" },
      radius: "round", lineHeight: "normal", textScale: "medium",
      colors: { ...DEFAULT_DESIGN_PREFERENCES.colors, accent: "#1E51D6" },
      notes: "喜欢大圆角", updatedAt: "2026-10-22T07:00:00.000Z", updatedBy: "user",
    });
    expect(published).toEqual(["design-preferences"]);
    expect(performed()).toHaveLength(1);
    expect(performed()[0]!.payload).toMatchObject({
      action: "ui.design",
      summary: "工单详情的密度改成标准，圆角改成大圆角，主色改成 #1E51D6，改了设计说明",
      undo: { kind: "design_preferences", before: { radius: "soft" }, after: { radius: "round", notes: "喜欢大圆角" } },
    });
  });

  it("writes nothing when nothing changed", () => {
    const binding = web();
    const published: string[] = [];
    const outcome = updateDesignPreferences(db, {
      request: { radius: "soft", colors: { accent: "#2f6aff" } }, caller: { kind: "user", credential: binding, source: SOURCE },
      publish: (resource) => published.push(resource),
    });
    expect(outcome.changed).toBe(false);
    expect(getDesignPreferences(db).updatedAt).toBeNull();
    expect(performed()).toHaveLength(0);
    expect(published).toEqual([]);
  });

  it("refuses bad input and colors below the readability floor", () => {
    const attempt = (request: unknown) => {
      try {
        updateDesignPreferences(db, { request: request as never, caller: { kind: "user" } });
      } catch (error) {
        return error;
      }
      return null;
    };
    expect(attempt({})).toMatchObject({ code: "invalid_input", message: "没有要改的内容" });
    expect(attempt({ radius: "huge" })).toBeInstanceOf(DesignPreferencesError);
    expect(attempt({ density: { sidebar: "compact" } })).toBeInstanceOf(DesignPreferencesError);
    expect(attempt({ colors: { accent: "blue" } })).toBeInstanceOf(DesignPreferencesError);
    // 浅蓝当链接文字读不清：主色至少 4.5:1。
    expect(attempt({ colors: { accent: "#9DB8FF" } })).toMatchObject({ code: "invalid_input", message: expect.stringContaining("主色太浅") });
    // 警告色只当图标和底色，门槛是 3:1；缺省的橙色本身就过不了 4.5:1，不能把它挡在门外。
    expect(attempt({ colors: { warning: "#FFE8B0" } })).toMatchObject({ code: "invalid_input", message: expect.stringContaining("警告色太浅") });
    expect(getDesignPreferences(db).updatedAt).toBeNull();
  });

  it("lets Lead change it only inside the user's own active turn", () => {
    const binding = web();
    const refused = (turnId: string | null) => {
      try {
        updateDesignPreferences(db, { request: { radius: "round" }, caller: { kind: "lead", turnId } });
      } catch (error) {
        return error as DesignPreferencesError;
      }
      throw new Error("expected a refusal");
    };
    expect(refused(null).code).toBe("needs_user_turn");
    createTurn(db, { id: "turn-done", originBindingId: binding.id, originKind: "paired:companion", userText: "…", state: "streaming" });
    completeTurn(db, "turn-done");
    expect(refused("turn-done").message).toContain("设置 → 外观");
    expect(getDesignPreferences(db).radius).toBe("soft");

    createTurn(db, { id: "turn-user", originBindingId: binding.id, originKind: "paired:companion", userText: "圆角大一点", state: "streaming" });
    const outcome = updateDesignPreferences(db, { request: { radius: "round" }, caller: { kind: "lead", turnId: "turn-user" } });
    expect(outcome.by).toEqual({ actor: "lead", onBehalfOf: { actor: "user", sourceTurnId: "turn-user", bindingId: binding.id } });
    expect(getDesignPreferences(db)).toMatchObject({ radius: "round", updatedBy: "lead" });
    expect(performed()[0]).toMatchObject({
      payload: { action: "ui.design", summary: "助手代你圆角改成大圆角", detail: { sourceTurnId: "turn-user" }, source: { client: "lead" } },
    });
  });
});

describe("revertDesignPreferences", () => {
  it("restores the previous values only while the change is still the latest", () => {
    const binding = web();
    const before = { ...DEFAULT_DESIGN_PREFERENCES, density: { ...DEFAULT_DESIGN_PREFERENCES.density }, colors: { ...DEFAULT_DESIGN_PREFERENCES.colors } };
    const { updatedAt: _a, updatedBy: _b, ...beforeFields } = before;
    updateDesignPreferences(db, { request: { textScale: "large" }, caller: { kind: "user", credential: binding, source: SOURCE } });
    const afterFields = { ...beforeFields, textScale: "large" as const };
    expect(revertDesignPreferences(db, { before: beforeFields, after: afterFields })).toBe("reverted");
    expect(getDesignPreferences(db).textScale).toBe("medium");
    expect(revertDesignPreferences(db, { before: beforeFields, after: afterFields })).toBe("unchanged");
    updateDesignPreferences(db, { request: { textScale: "small" }, caller: { kind: "user", credential: binding, source: SOURCE } });
    expect(revertDesignPreferences(db, { before: beforeFields, after: afterFields })).toBe("changed_since");
    expect(getDesignPreferences(db).textScale).toBe("small");
  });
});
