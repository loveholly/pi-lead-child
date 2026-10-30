// 用量额度用完的故障（usage_limited，2026-10-19）。探针看不到额度：以前每个退避周期都会放出一个注定失败的 Run。
// 报错里写了重置时间时，下一次探针等到那个时间以后；suggest_route 和挂起的派发请求都写出这个时间。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { TypedFailure } from "@pi-lead-child/core";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import {
  dueProbeIncidents, recordRuntimeHealthFailure, runtimeCooldownUntil, runtimeSuspensionReason, markRuntimeDegraded,
} from "../src/runtime-health.js";
import { listInbox } from "../src/inbox.js";

let db: Db;
let itemId: number;
const profile = { runtime: "pi" as const, executable: "/repo/node_modules/.bin/pi", configDir: null, version: "1.1.0" };
const limited: TypedFailure = {
  scope: "account", retry: "never", needs: "none", code: "usage_limited",
  evidence: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 162h16m36s.",
};

beforeEach(() => {
  db = openDb(join(tempDir("plc-usage-limited-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
});

describe("a usage-limited model", () => {
  it("waits for the reset time before the next probe, and says so", () => {
    const at = new Date("2026-10-19T05:00:00.000Z");
    const { incident } = recordRuntimeHealthFailure(db, {
      profile, model: "vibeproxy/claude-opus-4-6-thinking", itemId, runId: null, failure: limited, at,
    })!;
    expect(incident.level).toBe("model");
    expect(incident.next_probe_at).toBe("2026-10-25T23:16:36.000Z");
    expect(dueProbeIncidents(db, new Date("2026-10-19T07:00:00.000Z"))).toEqual([]);
    expect(dueProbeIncidents(db, new Date("2026-10-26T00:00:00.000Z")).map((row) => row.id)).toEqual([incident.id]);
    expect(runtimeSuspensionReason(incident)).toContain("以后再重检");
    // 不发用户通知：不用充值，等重置就好。
    expect(db.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual({ n: 0 });
  });

  it("does not move the probe earlier when the same failure recurs without a reset time", () => {
    const at = new Date("2026-10-19T05:00:00.000Z");
    const { incident } = recordRuntimeHealthFailure(db, { profile, model: "m", itemId, runId: null, failure: limited, at })!;
    recordRuntimeHealthFailure(db, {
      profile, model: "m", itemId, runId: null, failure: { ...limited, evidence: "Usage limit reached" },
      at: new Date("2026-10-19T06:00:00.000Z"),
    });
    const row = db.prepare("SELECT next_probe_at FROM runtime_incidents WHERE id=?").get(incident.id) as { next_probe_at: string };
    expect(row.next_probe_at).toBe("2026-10-25T23:16:36.000Z");
  });
});

// 工单 #117（2026-10-29）：额度用完的失败重试了五次，Lead 一直没换 runtime。故障说明给 Lead 写清下一步（leadNextStep）。
// 同一次故障里后来的失败写了重置时间时，证据换成它：恢复按证据判断重置时间是否已知（health-recovery.ts）。
describe("what a usage-limited incident tells Lead", () => {
  it("carries Lead's next step on the incident note", () => {
    recordRuntimeHealthFailure(db, {
      profile, model: "m", itemId, runId: null, failure: { ...limited, evidence: "Usage limit reached" },
      leadNextStep: "用 recover_ticket_run（action=auto）换一个 runtime 接着做。",
    });
    const notes = listInbox(db).map((row) => JSON.parse(row.payload) as { kind?: string; leadNextStep?: string });
    expect(notes.filter((note) => note.kind === "runtime_incident")).toEqual([
      expect.objectContaining({ leadNextStep: "用 recover_ticket_run（action=auto）换一个 runtime 接着做。" }),
    ]);
  });

  it("keeps the evidence that names a reset time when a later failure of the same incident names one", () => {
    const { incident } = recordRuntimeHealthFailure(db, {
      profile, model: "m", itemId, runId: null, failure: { ...limited, evidence: "Usage limit reached" },
      at: new Date("2026-10-19T05:00:00.000Z"),
    })!;
    recordRuntimeHealthFailure(db, {
      profile, model: "m", itemId, runId: null, failure: limited, at: new Date("2026-10-19T06:00:00.000Z"),
    });
    const row = db.prepare("SELECT evidence, next_probe_at FROM runtime_incidents WHERE id=?").get(incident.id);
    expect(row).toEqual({ evidence: limited.evidence, next_probe_at: "2026-10-26T00:16:36.000Z" });
  });
});

describe("a cooling profile", () => {
  it("reports the recover time while degraded, and nothing afterwards", () => {
    const at = new Date("2026-10-19T05:00:00.000Z");
    markRuntimeDegraded(db, { profile, at, recoverAt: new Date("2026-10-19T06:00:00.000Z") });
    expect(runtimeCooldownUntil(db, profile, at)).toBe("2026-10-19T06:00:00.000Z");
    expect(runtimeCooldownUntil(db, profile, new Date("2026-10-19T06:00:01.000Z"))).toBeNull();
  });
});
