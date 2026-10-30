// 后台检查的执行（.scratch/lead-watch/spec.md）：检查过程中不叫醒 Lead，有结果才写一条叫醒 Lead 的 inbox。
// 回放 2026-10-28 的两件事：设备码登录（until，授权以后马上叫醒 Lead）和每 20 分钟刷新一次 clime 登录（repeat，只在状态变化时叫醒）。
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  createItem, createWatch, getWatch, listWatchChecks, openDb, startWatchCheck, type Db,
} from "@pi-lead-child/store";
import { createWatchRunner, sandboxWatchCommand, type WatchCommandResult } from "../src/pipeline/watch-runner.js";

const T0 = new Date("2026-10-28T06:28:38.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

function setup(results: Array<WatchCommandResult | Error>, options: { startAgentCheck?: Parameters<typeof createWatchRunner>[1]["startAgentCheck"]; env?: Record<string, string> } = {}) {
  const db = openDb(join(tempDir("plc-watch-runner-"), "plc.db"));
  let clock = T0;
  const commands: string[] = [];
  const runner = createWatchRunner(db, {
    now: () => clock,
    runCommand: async (command) => {
      commands.push(command);
      const next = results.shift();
      if (!next) throw new Error("no more fake results");
      if (next instanceof Error) throw next;
      return next;
    },
    ...(options.startAgentCheck ? { startAgentCheck: options.startAgentCheck } : {}),
    env: options.env ?? {},
  });
  return { db, runner, commands, setClock: (seconds: number) => { clock = at(seconds); } };
}

const ok = (output = "alice@example.com"): WatchCommandResult => ({ exitCode: 0, output, timedOut: false });
const no = (output = "token refresh failed: Token is not active (invalid_grant)"): WatchCommandResult => ({ exitCode: 1, output, timedOut: false });

function wakes(db: Db): Array<{ summary: string; payload: Record<string, unknown> }> {
  return (db.prepare("SELECT summary, payload FROM inbox WHERE json_extract(payload, '$.kind') = 'watch_result' ORDER BY id").all() as Array<{ summary: string; payload: string }>)
    .map((row) => ({ summary: row.summary, payload: JSON.parse(row.payload) }));
}

function wakeEvents(db: Db): Array<Record<string, unknown>> {
  return (db.prepare("SELECT payload, level FROM events WHERE kind = 'inbox.attention' ORDER BY seq").all() as Array<{ payload: string; level: string }>)
    .map((row) => ({ level: row.level, ...JSON.parse(row.payload) }));
}

describe("a command watch until the device-code login goes through", () => {
  // 回归：14:28 发出设备码，14:29 用户授权，Lead 14:30 才知道（用户来问）。现在授权以后的下一次检查就叫醒 Lead。
  it("stays quiet while the login is pending and wakes Lead as soon as whoami passes", async () => {
    const { db, runner, commands, setClock } = setup([no(), no(), ok()]);
    const id = createWatch(db, {
      label: "clime 登录", check: { kind: "command", command: "clime auth whoami" }, mode: "until", everySeconds: 10,
      untilAt: at(600).toISOString(), note: "告诉用户登录好了，再设每 20 分钟刷新一次", origin: { kind: "user", turnId: "turn-1" },
    }, T0);
    await runner.tick();
    setClock(5);
    await runner.tick();
    expect(commands).toHaveLength(1);
    setClock(10);
    await runner.tick();
    expect(wakes(db)).toEqual([]);
    setClock(20);
    await runner.tick();
    expect(commands).toEqual(["clime auth whoami", "clime auth whoami", "clime auth whoami"]);
    expect(getWatch(db, id)).toMatchObject({ state: "done", ended_reason: "passed", check_count: 3 });
    const [woke] = wakes(db);
    expect(woke!.payload).toMatchObject({ kind: "watch_result", watch: id, reason: "passed", state: "done", wakeLead: true });
    expect(woke!.payload).not.toHaveProperty("external");
    expect(woke!.summary).toContain("后台检查 #1「clime 登录」通过了");
    expect(woke!.summary).toContain("alice@example.com");
    expect(woke!.summary).toContain("你设它时写的：告诉用户登录好了");
    // 事件日志里这一条会叫醒 Lead（inbox.wake_lead 按 wakeLead 定成 tell）。
    expect(wakeEvents(db).at(-1)).toMatchObject({ wakeLead: true });
    setClock(30);
    await runner.tick();
    expect(commands).toHaveLength(3);
  });

  it("wakes Lead when the deadline passes without a pass", async () => {
    const { db, runner, setClock } = setup([no(), no()]);
    const id = createWatch(db, {
      label: "CI", check: { kind: "command", command: "gh run view 1 --exit-status" }, mode: "until", everySeconds: 10,
      untilAt: at(15).toISOString(), note: "", origin: { kind: "system" },
    }, T0);
    await runner.tick();
    setClock(15);
    await runner.tick();
    expect(getWatch(db, id)).toMatchObject({ state: "done", ended_reason: "expired" });
    expect(wakes(db).map((row) => row.payload.reason)).toEqual(["expired"]);
  });

  it("stops after three errors in a row and says why", async () => {
    const down = new Error("沙箱起不来：proxy failed。命令没有运行");
    const { db, runner, setClock } = setup([down, down, down]);
    const id = createWatch(db, {
      label: "clime 登录", check: { kind: "command", command: "clime auth whoami" }, mode: "until", everySeconds: 10,
      untilAt: at(600).toISOString(), note: "", origin: { kind: "system" },
    }, T0);
    for (const seconds of [0, 10, 20]) {
      setClock(seconds);
      await runner.tick();
    }
    expect(getWatch(db, id)).toMatchObject({ state: "done", ended_reason: "errors", consecutive_errors: 3 });
    expect(wakes(db)).toMatchObject([{ payload: { reason: "errors" }, summary: expect.stringContaining("沙箱起不来") }]);
  });

  it("counts a command that runs too long as not passed", async () => {
    const { db, runner } = setup([{ exitCode: null, output: "waiting for browser", timedOut: true }]);
    const id = createWatch(db, {
      label: "慢", check: { kind: "command", command: "sleep 999" }, mode: "until", everySeconds: 10,
      untilAt: at(600).toISOString(), note: "", origin: { kind: "system" },
    }, T0);
    await runner.tick();
    expect(getWatch(db, id)).toMatchObject({ state: "waiting", last_status: "fail" });
    expect(listWatchChecks(db, id)[0]).toMatchObject({ status: "fail", exit_code: null, output: expect.stringContaining("命令被停了") });
  });
});

describe("a repeat command watch that keeps a login fresh", () => {
  // 回归：用户要「每 20 分钟用 clime auth 刷新一下 token」，Lead 只能把 launchd 配置交给用户（一天 72 轮跟进太贵）。
  it("runs every 20 minutes and wakes Lead only when the state changes", async () => {
    const { db, runner, commands, setClock } = setup([ok(), ok(), no(), no(), ok(), ok()]);
    const id = createWatch(db, {
      label: "刷新 clime 登录", check: { kind: "command", command: "clime auth whoami" }, mode: "repeat", everySeconds: 1200,
      note: "没通过就请用户重新登录", origin: { kind: "user", turnId: "turn-1" },
    }, T0);
    for (let index = 0; index < 6; index += 1) {
      setClock(index * 1200);
      await runner.tick();
      setClock(index * 1200 + 60);
      await runner.tick();
    }
    expect(commands).toHaveLength(6);
    expect(wakes(db).map((row) => row.payload.reason)).toEqual(["failed", "recovered"]);
    expect(wakes(db)[0]!.summary).toContain("检查还在继续");
    expect(wakes(db)[0]!.summary).toContain("watch:1");
    expect(getWatch(db, id)).toMatchObject({ state: "waiting", last_status: "pass", check_count: 6, next_check_at: at(7200).toISOString() });
  });
});

describe("agent checks", () => {
  const agentWatch = (db: Db, mode: "until" | "repeat" = "until") => createWatch(db, {
    label: "PR #119 的回复", check: { kind: "agent", brief: "看 PR #119 有没有新的评审意见" }, mode,
    everySeconds: mode === "until" ? 300 : 3600, ...(mode === "until" ? { untilAt: at(3600).toISOString() } : {}),
    note: "有回复就总结给用户", origin: { kind: "system" },
  }, T0);

  it("starts one light sub-agent with a brief that tells it how to check, and settles when it hands back", async () => {
    const started: Array<{ title: string; brief: string }> = [];
    let itemId = 0;
    const { db, runner, setClock } = setup([], {
      startAgentCheck: (_watch, task) => {
        started.push(task);
        itemId = createItem(db, { title: task.title, brief: task.brief, createdBy: "lead" });
        return itemId;
      },
    });
    const id = agentWatch(db);
    await runner.tick();
    setClock(600);
    await runner.tick();
    expect(started).toHaveLength(1);
    expect(started[0]!.title).toBe("后台检查 #1：PR #119 的回复");
    expect(started[0]!.brief).toContain("每隔 300 秒检查一次");
    expect(started[0]!.brief).toContain("看 PR #119 有没有新的评审意见");
    expect(getWatch(db, id)).toMatchObject({ running_since: T0.toISOString() });
    expect(listWatchChecks(db, id)[0]).toMatchObject({ status: "running", item_id: itemId });
    // Run 结束的说明叫醒 Lead：检查自己不再叫醒。
    expect(runner.settleAgentCheck(itemId, { delivered: true })?.watch).toMatchObject({ state: "done", ended_reason: "agent_done" });
    expect(runner.settleAgentCheck(itemId, { delivered: true })).toBeNull();
    expect(wakes(db)).toEqual([]);
  });

  it("does not start a sub-agent past the daily token cap and tells Lead once", async () => {
    let calls = 0;
    const { db, runner, setClock } = setup([], {
      env: { PLC_WATCH_AGENT_DAILY_TOKENS: "1000" },
      startAgentCheck: () => {
        calls += 1;
        return createItem(db, { title: "t", brief: "b", createdBy: "lead" });
      },
    });
    const earlier = agentWatch(db, "repeat");
    const first = startWatchCheck(db, earlier, T0)!;
    const spent = createItem(db, { title: "spent", brief: "b", createdBy: "lead" });
    db.prepare("UPDATE watch_checks SET item_id = ? WHERE id = ?").run(spent, first);
    db.prepare("UPDATE items SET total_tokens = 5000 WHERE id = ?").run(spent);
    const id = agentWatch(db, "repeat");
    await runner.tick();
    setClock(3600);
    await runner.tick();
    expect(calls).toBe(0);
    expect(wakes(db).map((row) => [row.payload.watch, row.payload.reason])).toEqual([[id, "agent_failed"]]);
    expect(wakes(db)[0]!.summary).toContain("PLC_WATCH_AGENT_DAILY_TOKENS");
    expect(getWatch(db, id)).toMatchObject({ state: "waiting", last_status: "error" });
  });

  it("tells Lead when the sub-agent cannot be started", async () => {
    const { db, runner } = setup([], { startAgentCheck: () => { throw new Error("runtime pi 不健康"); } });
    const id = agentWatch(db);
    await runner.tick();
    expect(getWatch(db, id)).toMatchObject({ state: "done", ended_reason: "errors" });
    expect(wakes(db)).toMatchObject([{ payload: { reason: "agent_failed" }, summary: expect.stringContaining("runtime pi 不健康") }]);
  });
});

describe("after a daemon restart", () => {
  it("re-runs an interrupted command check at once and settles an agent check whose ticket already ended", () => {
    const { db, runner } = setup([]);
    const command = createWatch(db, {
      label: "刷新", check: { kind: "command", command: "clime auth whoami" }, mode: "repeat", everySeconds: 1200, note: "", origin: { kind: "system" },
    }, T0);
    const agent = createWatch(db, {
      label: "PR", check: { kind: "agent", brief: "看 PR" }, mode: "until", everySeconds: 300, untilAt: at(3600).toISOString(), note: "", origin: { kind: "system" },
    }, T0);
    startWatchCheck(db, command, T0);
    const agentCheck = startWatchCheck(db, agent, T0)!;
    const itemId = createItem(db, { title: "后台检查", brief: "b", createdBy: "lead" });
    db.prepare("UPDATE watch_checks SET item_id = ? WHERE id = ?").run(itemId, agentCheck);
    db.prepare("UPDATE items SET stage = 'done' WHERE id = ?").run(itemId);
    runner.recover();
    expect(getWatch(db, command)).toMatchObject({ state: "waiting", running_since: null, consecutive_errors: 0, last_status: null });
    expect(getWatch(db, agent)).toMatchObject({ state: "done", ended_reason: "agent_done" });
    expect(wakes(db)).toEqual([]);
  });
});

describe("sandboxWatchCommand", () => {
  it("keeps the exit code and the output, and turns the sandbox timeout into timedOut", async () => {
    const pass = sandboxWatchCommand({
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from("hello "));
        onData(Buffer.from("world"));
        return { exitCode: 0 };
      },
    }, "/tmp");
    expect(await pass("echo", 5)).toEqual({ exitCode: 0, output: "hello world", timedOut: false });
    const slow = sandboxWatchCommand({
      exec: async (_command, _cwd, { onData, timeout }) => {
        onData(Buffer.from("partial"));
        throw new Error(`timeout:${timeout}`);
      },
    }, "/tmp");
    expect(await slow("sleep 999", 5)).toEqual({ exitCode: null, output: "partial", timedOut: true });
    const down = sandboxWatchCommand({ exec: async () => { throw new Error("沙箱起不来"); } }, "/tmp");
    await expect(down("true", 5)).rejects.toThrow("沙箱起不来");
  });
});
