import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";
import { createRun, getRun, updateRun } from "../src/runs.js";

let db: Db;
let itemId: number;
beforeEach(() => {
  db = openDb(join(tempDir("plc-"), "plc.db"));
  // 不 hold 的 item 生于 ready，闸门直接放行；本文件测的是 runs DAO，不掺确认流程。
  itemId = createItem(db, { title: "t", brief: "b", createdBy: "user" });
});

describe("runs DAO", () => {
  it("creates run in starting state and patches fields", () => {
    const id = createRun(db, { itemId, role: "executor" });
    expect(getRun(db, id)!.state).toBe("starting");
    updateRun(db, id, {
      state: "running", pid: 4242,
      sessionId: "abc", sessionPath: "/tmp/s.jsonl",
    });
    const a = getRun(db, id)!;
    expect(a.state).toBe("running");
    expect(a.pid).toBe(4242);
    expect(a.session_path).toBe("/tmp/s.jsonl");
    updateRun(db, id, { state: "finished", endedAt: true });
    expect(getRun(db, id)!.ended_at).not.toBeNull();
  });
});
