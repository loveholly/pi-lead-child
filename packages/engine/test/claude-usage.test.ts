// 工单 #102 的 Run #118（2026-10-20，Claude Code 2.1.258）：items.total_tokens 记成 17,071,923。
// 这个 Run 自己的用量是 5,981,433 token（result 的 modelUsage，含缓存读写和后台子 agent），成本 $2.58。
// 旧代码把每一行 assistant 的 usage 当 delta 加起来（同一次响应按内容块拆成几行，每行都加），
// 又把只算第二回合主线程的 result.usage 当 cumulative 加上去。
// 这里用这个 Run 原始输出里的用量行，经 adapter、runItem 和 ingest 走一遍落库的路径。
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { runItem } from "../src/children/manager.js";
import { DEFAULT_TOKEN_BUDGET } from "../src/pipeline/ingest.js";
import { ClaudeRuntime } from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, listInbox, markInbox, runTokenUsage } from "@pi-lead-child/store";

const TSX = resolve("node_modules/.bin/tsx");
const FAKE_CLAUDE = [resolve("packages/runtime/testing/fake-claude.ts")];
const RUN_118 = resolve("packages/runtime/testing/fixtures/claude-usage-run-118.jsonl");

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-claude-usage-");
  db = openDb(join(dir, "plc.db"));
  // child 继承测试进程的环境。fake Claude 不读开发者真实的配置。
  vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

async function replayRun118(
  existing?: number,
): Promise<{ itemId: number; runId: number }> {
  const itemId = existing ?? createItem(db, { title: "ticket 102", brief: "b", createdBy: "user", workdir: join(dir, "work") });
  const { runId } = await runItem(db, itemId, {
    dbPath: join(dir, "plc.db"), dataDir: dir, sessionDir: join(dir, "sessions"), prompt: "do it", lingerMs: 0,
    runtime: new ClaudeRuntime({
      bin: TSX, prefixArgs: FAKE_CLAUDE,
      env: { FAKE_CLAUDE_SCENARIO: "replay", FAKE_CLAUDE_REPLAY: RUN_118 },
    }),
  });
  return { itemId, runId };
}

const budgetAlerts = (itemId: number) => listInbox(db)
  .filter((row) => row.item_id === itemId && JSON.parse(row.payload).kind === "token_budget_exceeded");

describe("a Claude run's token usage", () => {
  it("is the process total from modelUsage, the same on the ticket and in the run's event log", async () => {
    const { itemId, runId } = await replayRun118();

    const item = getItem(db, itemId)!;
    expect(item.total_tokens).toBe(5_981_433);
    expect(item.total_cost_usd).toBeCloseTo(2.5841609, 7);
    expect(runTokenUsage(db, runId)).toBe(5_981_433);
  });

  // 预算告警读 items.total_tokens。旧代码的 17,071,923 让 600 万的预算在这个 Run 里报警。
  it("does not raise a budget alert below the budget", async () => {
    vi.stubEnv("PLC_BUDGET_TOKENS", "6000000");
    const { itemId } = await replayRun118();
    expect(budgetAlerts(itemId)).toEqual([]);
  });

  // 2026-10-21 用户定的默认告警线：400 万。按新口径（含缓存读写），旧的 200 万让一个普通的执行 Run 就告警。
  // Run #118 是 598 万，超过 400 万，所以没有设 PLC_BUDGET_TOKENS 时告警一次。
  it("uses 4,000,000 tokens as the default budget", async () => {
    vi.stubEnv("PLC_BUDGET_TOKENS", undefined);
    expect(DEFAULT_TOKEN_BUDGET).toBe(4_000_000);
    const { itemId } = await replayRun118();
    expect(budgetAlerts(itemId)).toHaveLength(1);
    expect(listInbox(db).find((row) => row.item_id === itemId)?.summary).toContain("4000000");
  });

  it("raises one budget alert when the run goes over the budget", async () => {
    vi.stubEnv("PLC_BUDGET_TOKENS", "5000000");
    const { itemId } = await replayRun118();
    expect(budgetAlerts(itemId)).toHaveLength(1);
  });

  // 2026-10-28 晚：#158、#161 的每个新 Run 都从头告警一次。告警按工单算：越过预算说一次，之后到翻倍的档位再说。
  // 每个 Run 598 万：三个 Run 累计 598 万、1196 万、1794 万，越过 500 万和 1000 万两档，第三个 Run 不告警。
  it("alerts once per ticket threshold across runs, not once per run", async () => {
    vi.stubEnv("PLC_BUDGET_TOKENS", "5000000");
    const { itemId } = await replayRun118();
    for (let run = 0; run < 2; run++) {
      // Lead 处理完了上一条告警（还 pending 的会把新的一条合并进去）。
      markInbox(db, budgetAlerts(itemId).map((row) => row.id), "consumed");
      db.prepare("UPDATE items SET stage = 'active' WHERE id = ?").run(itemId);
      await replayRun118(itemId);
    }
    expect(getItem(db, itemId)!.total_tokens).toBe(3 * 5_981_433);
    expect(budgetAlerts(itemId).map((row) => JSON.parse(row.payload).threshold)).toEqual([5_000_000, 10_000_000]);
  });
});
