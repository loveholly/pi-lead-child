import { connect } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { startAgentToolBridge } from "../src/agent-tools/host-bridge.js";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { openDb } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";

describe("agent tool host bridge", () => {
  // Regression for the shape a real child observes. The handler-level suites
  // prove the snapshot is written; this proves the completion handoff survives
  // the socket, because a child can only ever see what comes back over it —
  // a missing `outcome_snapshot_id` in that reply is indistinguishable, from
  // the child's side, from a registry that never ran.
  it("returns the registered outcome snapshot id over the socket", async () => {
    const dir = tempDir("plc-agent-bridge-outcome-");
    const workdir = join(dir, "workdir");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "bridge outcome", brief: "b", createdBy: "system", workdir });
    transition(db, { itemId, to: "active", actor: "system", reason: "started" });
    const runId = createRun(db, { itemId, runtime: "codex" });
    updateRun(db, runId, { state: "running" });
    const bridge = await startAgentToolBridge({ db, itemId, runId, workdir: dir, dataDir: dir });
    const socket = connect(bridge.socketPath);
    const response = new Promise<any>((resolve) => {
      attachJsonlReader(socket, (line) => { if (line.trim()) resolve(JSON.parse(line)); });
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    try {
      socket.write(`${JSON.stringify({
        type: "agent_tool",
        id: "handoff",
        token: bridge.token,
        name: "ticket_update",
        arguments: {
          status: "review",
          reason: "implementation complete",
          checkpoint: {
            kind: "completed",
            title: "Outcome registry implemented",
            summary: "Registration and recovery both land in the ledger.",
            next_step: "Independent review.",
            outcome: {
              summary: "Implemented the outcome snapshot registry.",
              changes: [
                { kind: "file", ref: "src/pipeline/outcome-recovery.ts", summary: "Explicit registration" },
              ],
              deliverables: [
                { kind: "path", ref: "src/pipeline/outcome-recovery.ts", label: "registry" },
              ],
              validations: [{
                command: "npm test",
                outcome: "passed",
                exit_code: 0,
                summary: "suite passed",
                evidence_ref: null,
              }],
            },
          },
        },
      })}\n`);
      const message = await response;
      expect(message).toMatchObject({
        id: "handoff",
        success: true,
        data: {
          ticket_id: itemId,
          status: "review",
          checkpoint_id: expect.any(Number),
          outcome_snapshot_id: expect.any(Number),
        },
      });
      expect(db.prepare(
        `SELECT item_id, executor_run_id, completion_checkpoint_id, source, summary, completeness
         FROM outcome_snapshots WHERE id=?`,
      ).get(message.data.outcome_snapshot_id)).toEqual({
        item_id: itemId,
        executor_run_id: runId,
        completion_checkpoint_id: message.data.checkpoint_id,
        source: "agent_reported",
        summary: "Implemented the outcome snapshot registry.",
        completeness: "complete",
      });
      expect(getItem(db, itemId)?.stage).toBe("review");
    } finally {
      socket.end();
      await bridge.close();
      db.close();
    }
  });

  // run 66：socket 开在工单的工作目录里时，长工作目录让路径超过 Unix socket 的长度上限，listen 报 EINVAL。
  it("keeps the socket path short when the ticket's workdir is long", async () => {
    const dir = tempDir("plc-agent-bridge-long-");
    const workdir = join(dir, "w".repeat(60), "x".repeat(60));
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "long workdir", brief: "b", createdBy: "system", workdir });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running" });
    const bridge = await startAgentToolBridge({ db, itemId, runId, workdir, dataDir: dir });
    try {
      expect(bridge.socketPath.startsWith(workdir)).toBe(false);
      expect(Buffer.byteLength(bridge.socketPath)).toBeLessThanOrEqual(103);
      const socket = connect(bridge.socketPath);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.end();
    } finally {
      await bridge.close();
      db.close();
    }
  });

  it("refuses a data directory whose socket path would be too long, with a clear reason", async () => {
    const dir = tempDir("plc-agent-bridge-long-data-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "long data dir", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId });
    try {
      await expect(startAgentToolBridge({
        db, itemId, runId, workdir: dir, dataDir: join(dir, "d".repeat(120)),
      })).rejects.toThrow(/socket path .* too long/);
    } finally {
      db.close();
    }
  });

  it("rejects calls without the run capability token", async () => {
    const dir = tempDir("plc-agent-bridge-");
    const db = openDb(join(dir, "plc.db"));
    const itemId = createItem(db, { title: "bridge", brief: "b", createdBy: "system" });
    const runId = createRun(db, { itemId });
    updateRun(db, runId, { state: "running" });
    const bridge = await startAgentToolBridge({ db, itemId, runId, workdir: dir, dataDir: dir });
    const socket = connect(bridge.socketPath);
    const response = new Promise<any>((resolve) => {
      attachJsonlReader(socket, (line) => { if (line.trim()) resolve(JSON.parse(line)); });
    });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    try {
      socket.write(`${JSON.stringify({
        type: "agent_tool",
        id: "bad-token",
        token: "wrong",
        name: "begin_planning",
        arguments: {},
      })}\n`);
      await expect(response).resolves.toMatchObject({
        id: "bad-token",
        success: false,
        error: "unauthorized agent tool request",
      });
      expect(db.prepare("SELECT plan_state FROM items WHERE id=?").get(itemId))
        .toEqual({ plan_state: "none" });
    } finally {
      socket.end();
      await bridge.close();
      db.close();
    }
  });
});
