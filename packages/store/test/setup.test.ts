// 首次启动引导的小状态（2026-10-30，.scratch/onboarding/spec.md）：设置状态只在变化时写、准备清单只记第一次、
// 建议卡按清单顺序挑第一项没配好又不在冷却里的（spec R3、R4）。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { SETUP_ITEM_KEYS, type SetupItem, type SetupItemKey } from "@pi-lead-child/protocol";
import {
  loadSetupChecklist, loadSetupHints, loadSetupStatus, openDb, pickSetupHint, recordSetupChecklist, recordSetupHint,
  resolveSetupHint, saveSetupStatus, type Db,
} from "../src/index.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-setup-"), "plc.db")); });

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-10-30T08:00:00.000Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

function items(ready: SetupItemKey[]): SetupItem[] {
  return SETUP_ITEM_KEYS.map((key) => ({ key, ready: ready.includes(key), detail: null }));
}

describe("the setup status", () => {
  it("keeps changedAt when a recompute finds nothing new", () => {
    expect(saveSetupStatus(db, items(["brain"]), t0).changed).toBe(true);
    const again = saveSetupStatus(db, items(["brain"]), at(5_000));
    expect(again.changed).toBe(false);
    expect(loadSetupStatus(db)!.changedAt).toBe(t0.toISOString());
    expect(saveSetupStatus(db, items(["brain", "memory"]), at(10_000)).changed).toBe(true);
    expect(loadSetupStatus(db)!.changedAt).toBe(at(10_000).toISOString());
  });
});

describe("the checklist record", () => {
  it("only records the first time", () => {
    expect(loadSetupChecklist(db)).toBeNull();
    expect(recordSetupChecklist(db, "skipped", t0)).toEqual({ state: "skipped", at: t0.toISOString() });
    expect(recordSetupChecklist(db, "shown", at(DAY)).state).toBe("skipped");
  });
});

describe("picking a hint", () => {
  it("takes the first item in list order that is not ready, never the brain", () => {
    const status = saveSetupStatus(db, items(["memory"]), t0).status;
    expect(pickSetupHint(status, loadSetupHints(db), t0)).toBe("slack");
  });

  it("waits two days after any hint and seven days before the same item again", () => {
    const status = saveSetupStatus(db, items(["brain"]), t0).status;
    recordSetupHint(db, "memory", t0);
    expect(pickSetupHint(status, loadSetupHints(db), at(DAY))).toBeNull();
    // 两天后换下一项：memory 还在 7 天的冷却里。
    expect(pickSetupHint(status, loadSetupHints(db), at(2 * DAY))).toBe("slack");
    recordSetupHint(db, "slack", at(2 * DAY));
    // 第 7 天 memory 又能提了。
    expect(pickSetupHint(status, loadSetupHints(db), at(7 * DAY))).toBe("memory");
  });

  it("never asks again after 不用再提, and waits seven days after 以后再说", () => {
    const status = saveSetupStatus(db, items(["brain"]), t0).status;
    const memory = recordSetupHint(db, "memory", t0);
    resolveSetupHint(db, memory.id, "dismissed", t0);
    const slack = recordSetupHint(db, "slack", at(2 * DAY));
    resolveSetupHint(db, slack.id, "snoozed", at(3 * DAY));
    // 第 9 天：memory 不再提；slack 的「以后再说」到第 10 天；所以轮到 profile。
    expect(pickSetupHint(status, loadSetupHints(db), at(9 * DAY))).toBe("profile");
    expect(pickSetupHint(status, loadSetupHints(db), at(10 * DAY))).toBe("slack");
  });

  it("asks nothing when everything is ready", () => {
    const status = saveSetupStatus(db, items([...SETUP_ITEM_KEYS]), t0).status;
    expect(pickSetupHint(status, loadSetupHints(db), t0)).toBeNull();
  });

  it("keeps the card's own state when it is resolved", () => {
    const hint = recordSetupHint(db, "jira", t0);
    expect(resolveSetupHint(db, hint.id, "snoozed", at(1_000))).toMatchObject({ id: hint.id, state: "snoozed" });
    expect(resolveSetupHint(db, 999, "dismissed", at(1_000))).toBeNull();
    expect(loadSetupHints(db).cards).toEqual([expect.objectContaining({ id: hint.id, item: "jira", state: "snoozed" })]);
  });
});
