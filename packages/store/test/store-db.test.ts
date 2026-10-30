import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb } from "../src/db.js";

describe("openDb", () => {
  it("creates all tables and enables WAL", () => {
    const db = openDb(join(tempDir("plc-"), "plc.db"));
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((r: any) => r.name);
    for (const t of ["items", "runs", "activities", "inbox", "notes"]) {
      expect(names).toContain(t);
    }
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });
});
