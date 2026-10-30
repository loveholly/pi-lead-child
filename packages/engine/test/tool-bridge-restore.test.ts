// 工单 15：daemon 重启后接管 Run 时，在原来的路径、用原来的 token 重建工具桥。
// CLI 的 plc MCP 服务器只认这两个值，所以重建后它的工具调用要照常成功。
// 路径和 token 来自库，所以只接受本 Run 的 socket 目录里、格式和新建时相同的值。
import { rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { startAgentToolBridge } from "../src/agent-tools/host-bridge.js";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { parseLauncherIdentity } from "@pi-lead-child/runtime";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-bridge-restore-");
  db = openDb(join(dir, "plc.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(socketPath: string, token: string): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    attachJsonlReader(socket, (line) => {
      if (!line.trim()) return;
      resolve(JSON.parse(line));
      socket.end();
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ type: "agent_tool", id: "1", token, name: "list_descendants", arguments: {} })}\n`);
    });
  });
}

describe("restoring the agent tool bridge of an adopted run", () => {
  it("answers the CLI's calls again at the same path with the same token", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    const first = await startAgentToolBridge({ db, itemId, runId, workdir: dir, dataDir: dir });
    expect(await call(first.socketPath, first.token)).toMatchObject({ success: true });
    await first.close();
    await expect(call(first.socketPath, first.token)).rejects.toThrow();

    const restored = await startAgentToolBridge({
      db, itemId, runId, workdir: dir, dataDir: dir, reuse: { socketPath: first.socketPath, token: first.token },
    });
    try {
      expect(restored).toMatchObject({ socketPath: first.socketPath, token: first.token });
      expect(await call(first.socketPath, first.token)).toMatchObject({ success: true });
    } finally {
      await restored.close();
    }
  });

  // 旧版本把 socket 开在工作目录的 .plc 里。升级时还活着的 Run 要在原来的路径重建工具桥。
  it("restores a bridge that an older version opened in the workdir", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    const workdir = join(dir, "work");
    const legacy = { socketPath: join(workdir, ".plc", `r${runId}-0123abcd.sock`), token: "a".repeat(48) };
    const restored = await startAgentToolBridge({ db, itemId, runId, workdir, dataDir: dir, reuse: legacy });
    try {
      expect(restored.socketPath).toBe(legacy.socketPath);
      expect(await call(legacy.socketPath, legacy.token)).toMatchObject({ success: true });
    } finally {
      await restored.close();
    }
  });

  it("refuses a stored path or token that does not belong to the run", async () => {
    const itemId = createItem(db, { title: "t", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    const token = "a".repeat(48);
    const restore = (socketPath: string, reuseToken = token) => startAgentToolBridge({
      db, itemId, runId, workdir: dir, dataDir: dir, reuse: { socketPath, token: reuseToken },
    });
    await expect(restore(join(dir, "elsewhere", `r${runId}-0123abcd.sock`))).rejects.toThrow(/not a socket of run/);
    await expect(restore(join(dir, ".plc", `r${runId + 1}-0123abcd.sock`))).rejects.toThrow(/not a socket of run/);
    await expect(restore(join(dir, ".plc", "..", "plc.db"))).rejects.toThrow(/not a socket of run/);
    await expect(restore(join(dir, ".plc", `r${runId}-0123abcd.sock`), "short")).rejects.toThrow(/malformed/);
  });

  it("keeps the stored bridge in the launcher identity, and rejects a malformed one", () => {
    const base = { version: 1, pid: 10, childPid: 11, token: "t".repeat(48), dir, controlPath: join(dir, "ctl.sock") };
    expect(parseLauncherIdentity(JSON.stringify({ ...base, toolBridge: { socketPath: "/x.sock", token: "y" } })))
      .toMatchObject({ toolBridge: { socketPath: "/x.sock", token: "y" } });
    expect(parseLauncherIdentity(JSON.stringify({ ...base, toolBridge: { socketPath: 1 } }))).toBeNull();
    expect(parseLauncherIdentity(JSON.stringify(base))).toMatchObject({ pid: 10 });
  });

  // 同一个 Run 的第二个进程（会话过期后开的新会话）的事件偏移。接管时按它重放，坏的值不能用。
  it("keeps the event offset of a second process, and rejects a malformed one", () => {
    const base = { version: 1, pid: 10, childPid: 11, token: "t".repeat(48), dir, controlPath: join(dir, "ctl.sock") };
    expect(parseLauncherIdentity(JSON.stringify({ ...base, seqBase: 3 }))).toMatchObject({ seqBase: 3 });
    expect(parseLauncherIdentity(JSON.stringify({ ...base, seqBase: -1 }))).toBeNull();
    expect(parseLauncherIdentity(JSON.stringify({ ...base, seqBase: "3" }))).toBeNull();
  });
});
