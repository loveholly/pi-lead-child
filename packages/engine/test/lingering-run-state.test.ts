// 进程退出以后，Run 不能还停在 running（2026-10-19 工单 #93 的 Run #106）。
//
// Run #106 的这一轮在 05:55:31 结束，Run 记为 finished，pi 进程按 linger 停留。05:56 Lead 把一条指令发进这个进程，
// 新一轮里 agent 的交接工具被拒（Run 已结束），它就用 sqlite3 直接把 runs.state 改回了 running。
// 06:00:31 linger 到期，进程以 143 退出，可是内核在收尾时只处理「进程失败」，不看 Run 是不是还挂着：
// 这一行一直是 running，工单对话显示「Run #106 正在执行」，直到 07:12:45 daemon 重启接管时才收尾。
//
// 规则：进程退出时，Run 的状态必须是终态。仍是 starting 或 running 时，内核按退出结果收尾，并记下这次纠正。
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { tempDir } from "@pi-lead-child/core/testing";
import { createItem, getRun, listActivities, openDb } from "@pi-lead-child/store";
import { liveChildren, runItem } from "../src/children/manager.js";

const FAKE_PI = resolve("node_modules/.bin/tsx");
const FAKE_PI_ARGS = [resolve("packages/runtime/testing/fake-pi.ts")];

describe("a run whose process exits", () => {
  it("does not stay running after its process exits, even when something reopened the row during linger", async () => {
    const dir = tempDir("plc-linger-state-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "t", brief: "写一个 hello world", createdBy: "system" });
    const done = runItem(db, itemId, {
      dbPath, piBin: FAKE_PI, piArgs: FAKE_PI_ARGS,
      prompt: "do it", sessionDir: tempDir("plc-sess-"),
      // 足够长：进程在测试里由我们停止，相当于 linger 到期。
      lingerMs: 60_000,
    });
    try {
      // 这一轮结束，Run 记为 finished，进程在停留。
      await waitFor(() => liveChildren().get(itemId)?.settled === true);
      const { runId } = { runId: liveChildren().get(itemId)!.runId };
      expect(getRun(db, runId)!.state).toBe("finished");

      // Run #106 的 agent 做的事：绕过工具，直接把这一行改回 running。
      db.prepare("UPDATE runs SET state='running', ended_at=NULL WHERE id=?").run(runId);

      // linger 到期：进程退出。
      await liveChildren().get(itemId)!.handle!.interrupt("linger timeout");
      await done;

      const run = getRun(db, runId)!;
      expect(run.state).toBe("finished");
      expect(run.ended_at).not.toBeNull();
      const reconciled = listActivities(db, itemId)
        .filter((activity) => activity.kind === "decision")
        .map((activity) => JSON.parse(activity.payload))
        .find((payload) => payload.decision === "run_state_reconciled_at_exit");
      expect(reconciled).toMatchObject({ runId, from: "running", to: "finished" });
    } finally {
      await liveChildren().get(itemId)?.handle?.interrupt("test cleanup");
      await done.catch(() => {});
      db.close();
    }
  }, 30_000);
});

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
