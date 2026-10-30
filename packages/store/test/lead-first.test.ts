// 系统异常先交给 Lead（2026-10-15 用户决定）：「系统的异常情况，lead 应该都是及时感知的，并且尽可能介入处理，
// UI 上我希望除非需要我介入，否则我希望是弱反馈」。
// 每条异常记下谁要行动：needsUser=false 的先交给 Lead，不发用户通知；Lead 处理不了（它的模型调用失败，
// 或者一轮卡死）时，系统再升级给用户，保证送达不只靠 Lead（升级见 lead-events.test.ts）。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import type { TypedFailure } from "@pi-lead-child/core";

import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import { addInbox, inboxNeedsUser, inboxWakesLead, listInbox } from "../src/inbox.js";
import { raiseBlocker } from "../src/blockers.js";
import { recordRuntimeHealthFailure } from "../src/runtime-health.js";

let db: Db;
let itemId: number;
const profile = { runtime: "codex" as const, executable: "/usr/local/bin/codex", configDir: "/Users/test/.codex", version: "0.162.1" };

beforeEach(() => {
  db = openDb(join(tempDir("plc-lead-first-"), "plc.db"));
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
});

// runtime 包的 FAILURE_CLASSES 里的两行（store 不依赖 runtime）。
const modelUnsupported: TypedFailure = { scope: "runtime", retry: "other_runtime", needs: "config", code: "model_unsupported", evidence: "model is not supported" };
const authRequired: TypedFailure = { scope: "account", retry: "never", needs: "login", code: "auth_required", evidence: "Please run /login" };

const notifications = () => db.prepare("SELECT kind, urgency, title, dedup_key FROM notifications ORDER BY id").all() as Array<Record<string, string>>;

describe("who must act on a system event", () => {
  it("gives a Lead-first blocker to Lead only, and a user blocker to both", () => {
    raiseBlocker(db, { itemId, code: "terminal_handoff_failed", title: "交接失败", summary: "s", source: "structural", needsUser: false });
    expect(notifications()).toEqual([]);
    const [leadRow] = listInbox(db, { severity: "blocker" });
    expect(inboxWakesLead(leadRow!, db)).toBe(true);
    expect(inboxNeedsUser(leadRow!)).toBe(false);

    raiseBlocker(db, { itemId, code: "retry_exhausted", title: "重试用完", summary: "s", source: "structural" });
    expect(notifications()).toHaveLength(1);
    expect(inboxNeedsUser(listInbox(db, { severity: "blocker" })[1]!)).toBe(true);
    // 没有标记的旧行按原来的意思：blocker 要用户知道，attention 不叫醒 Lead。
    addInbox(db, { itemId, severity: "attention", source: "structural", summary: "info" });
    const info = listInbox(db, { severity: "attention" })[0]!;
    expect(inboxWakesLead(info, db)).toBe(false);
    expect(inboxNeedsUser(info)).toBe(false);
  });

  it("notifies the user about a runtime incident only when the user must log in or pay", () => {
    recordRuntimeHealthFailure(db, {
      profile, model: "gpt-5.5", itemId, runId: null,
      failure: modelUnsupported,
    });
    expect(notifications()).toEqual([]);
    const modelRow = listInbox(db, {}).find((row) => JSON.parse(row.payload).kind === "runtime_incident")!;
    expect(inboxWakesLead(modelRow, db)).toBe(true);
    expect(inboxNeedsUser(modelRow)).toBe(false);

    recordRuntimeHealthFailure(db, {
      profile: { ...profile, runtime: "claude", executable: "/usr/local/bin/claude", configDir: "/Users/test/.claude" },
      model: null, itemId, runId: null,
      failure: authRequired,
    });
    expect(notifications()).toEqual([expect.objectContaining({ kind: "runtime_incident", urgency: "immediate" })]);
    const loginRow = listInbox(db, {}).filter((row) => JSON.parse(row.payload).kind === "runtime_incident")[1]!;
    expect(inboxWakesLead(loginRow, db)).toBe(true);
    expect(inboxNeedsUser(loginRow)).toBe(true);
  });
});
