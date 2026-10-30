// 首次启动引导的 daemon 部分（2026-10-30，.scratch/onboarding/spec.md）：7 项怎么算、准备清单卡什么时候建、
// 建议卡只在用户自己的、成功的一轮结束时发。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { loadSetupChecklist, loadSetupHints, loadSetupStatus, openDb, writeLeadProfile, type Db } from "@pi-lead-child/store";
import { computeSetupItems, createSetupTracker, type SetupSources } from "../src/setup-status.js";

let db: Db;
beforeEach(() => { db = openDb(join(tempDir("plc-setup-status-"), "plc.db")); });

const DAY = 24 * 60 * 60 * 1000;
const t0 = new Date("2026-10-30T08:00:00.000Z");

function sources(state: { brain: boolean; memory?: string; slack?: { configured: boolean; autoReply: boolean } | null; connected?: string[] }): SetupSources {
  return {
    brain: async () => ({ ready: state.brain, model: state.brain ? "anthropic/claude-sonnet-5-5" : null }),
    memory: () => ({ mode: state.memory ?? "unset", remoteBaseUrl: null }),
    slack: () => (state.slack === undefined ? { configured: false, autoReply: true, account: null } : state.slack ? { ...state.slack, account: "Acme" } : null),
    connections: () => ["atlassian", "github", "notion"].map((key) => ({
      key, state: state.connected?.includes(key) ? "connected" : "disconnected", account: state.connected?.includes(key) ? "loveholly" : null,
    })),
  };
}

describe("the setup items", () => {
  it("reads each source into ready and a short detail", async () => {
    const items = await computeSetupItems(db, sources({
      brain: true, memory: "local", slack: { configured: true, autoReply: false }, connected: ["github"],
    }));
    expect(items).toEqual([
      { key: "brain", ready: true, detail: "anthropic/claude-sonnet-5-5" },
      { key: "memory", ready: true, detail: "本机模型" },
      // 连上了，但「自动代你处理」关着：还不算配好。
      { key: "slack", ready: false, detail: "已连上，「自动代你处理」关着" },
      { key: "profile", ready: false, detail: null },
      { key: "github", ready: true, detail: "已连接 · loveholly" },
      { key: "jira", ready: false, detail: null },
      { key: "notion", ready: false, detail: null },
    ]);
  });

  it("counts the profile once the user has changed it", async () => {
    writeLeadProfile(db, { name: "Jarvis", persona: "", interactionStyle: "" }, { by: "user", at: t0 });
    const items = await computeSetupItems(db, sources({ brain: true }));
    expect(items.find((item) => item.key === "profile")).toEqual({ key: "profile", ready: true, detail: "叫 Jarvis" });
  });

  it("treats a brain check that throws as not ready", async () => {
    const items = await computeSetupItems(db, { ...sources({ brain: true }), brain: async () => { throw new Error("boom"); } });
    expect(items[0]).toEqual({ key: "brain", ready: false, detail: null });
  });
});

describe("the checklist", () => {
  it("is shown when the brain becomes ready after the daemon started without one", async () => {
    const state = { brain: false };
    const tracker = createSetupTracker({ db, sources: sources(state) });
    await tracker.refresh(t0);
    expect(loadSetupChecklist(db)).toBeNull();
    state.brain = true;
    await tracker.refresh(new Date(t0.getTime() + 60_000));
    expect(loadSetupChecklist(db)).toEqual({ state: "shown", at: new Date(t0.getTime() + 60_000).toISOString() });
  });

  // Core Invariants：功能上线前大脑就能用的老用户，不补发清单。
  it("is skipped when the brain is already ready on the first check", async () => {
    const tracker = createSetupTracker({ db, sources: sources({ brain: true }) });
    await tracker.refresh(t0);
    expect(loadSetupChecklist(db)).toEqual({ state: "skipped", at: t0.toISOString() });
    expect(loadSetupStatus(db)!.items[0]!.ready).toBe(true);
  });
});

describe("the hint after a turn", () => {
  it("only comes after the user's own turn that succeeded", async () => {
    const tracker = createSetupTracker({ db, sources: sources({ brain: true }) });
    expect(await tracker.afterTurn({ userTurn: false, succeeded: true }, t0)).toBeNull();
    expect(await tracker.afterTurn({ userTurn: true, succeeded: false }, t0)).toBeNull();
    expect(loadSetupHints(db).cards).toEqual([]);
    expect(await tracker.afterTurn({ userTurn: true, succeeded: true }, t0)).toMatchObject({ id: 1, item: "memory", state: "open" });
    // 两天内不再发。
    expect(await tracker.afterTurn({ userTurn: true, succeeded: true }, new Date(t0.getTime() + DAY))).toBeNull();
    expect(loadSetupHints(db).cards).toHaveLength(1);
  });
});
