// 工单 #102（2026-10-21）：pi 的 message.usage 是一次 API 调用的用量，不是累计。旧映射按 cumulative 报，
// ingest 只记下最大的一次调用，所以 pi 的工单偏低。这里经 adapter、runItem 和 ingest 走一遍落库的路径：
// 一个回合两次调用，工单和 Run 的 token 数都是两次之和。
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runItem } from "../src/children/manager.js";
import { PiRuntime } from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, runTokenUsage } from "@pi-lead-child/store";

const TSX = resolve("node_modules/.bin/tsx");
const FAKE_PI = resolve("packages/runtime/testing/fake-pi.ts");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-pi-usage-");
  db = openDb(join(dir, "plc.db"));
});

afterEach(() => {
  db.close();
});

describe("a pi run's token usage", () => {
  it("adds every model call of the run, on the ticket and in the run's event log", async () => {
    const itemId = createItem(db, { title: "pi usage", brief: "b", createdBy: "user", workdir: join(dir, "work") });
    const { runId } = await runItem(db, itemId, {
      dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions"), prompt: "do it", lingerMs: 0,
      runtime: new PiRuntime({
        bin: TSX, prefixArgs: [FAKE_PI], env: { FAKE_SCENARIO: "usage_two_calls" }, solPiExtension: null,
      }),
    });

    const item = getItem(db, itemId)!;
    expect(item.total_tokens).toBe(59_152 + 150);
    expect(item.total_cost_usd).toBeCloseTo(0.004 + 0.003, 9);
    expect(runTokenUsage(db, runId)).toBe(59_152 + 150);
  });
});
