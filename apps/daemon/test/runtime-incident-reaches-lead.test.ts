// 2026-10-15 用户决定：运行故障由 Lead 判断、自己处理。内核不再替它换模型，所以 Lead 必须在没人看着时也读到
// 故障说明，并且说明里写着故障出现在哪张工单的哪个 Run（recover_ticket_run 要用）。
// 没有客户端在线时，Lead 不播报通知；心跳巡检那一轮把积压的说明交给它。
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { defaultRuntimeProfile, typedFailure } from "@pi-lead-child/runtime";
import { createItem, createRun, openDb, recordRuntimeHealthFailure, transition, updateRun } from "@pi-lead-child/store";

import { startDaemon } from "../src/server.js";

let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;

afterEach(async () => {
  await daemon?.close();
  daemon = null;
  vi.unstubAllEnvs();
});

function recordingLead(prompts: string[]) {
  const listeners: Array<(event: any) => void> = [];
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  return async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe(listener: (event: any) => void) { listeners.push(listener); return () => {}; },
      async prompt(message: string) {
        prompts.push(message);
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "NO_REPLY" } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "NO_REPLY" }] } });
        emit({ type: "agent_end" });
      },
      async steer() {}, async followUp() {}, dispose() {},
    },
  });
}

describe("a runtime incident on a ticket run", () => {
  it("reaches Lead with the ticket and the run, even when nobody is watching", async () => {
    vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
    vi.stubEnv("PLC_HEARTBEAT_MS", "100");
    const dir = tempDir("plc-incident-lead-");
    const dbPath = join(dir, "plc.db");
    const db = openDb(dbPath);
    const itemId = createItem(db, { title: "#66", brief: "b", createdBy: "user" });
    transition(db, { itemId, to: "active", actor: "system", reason: "start" });
    transition(db, { itemId, to: "review", actor: "child", reason: "handoff" });
    const runId = createRun(db, { itemId, role: "reviewer", purpose: "review", runtime: "codex", model: "gpt-5.5" });
    updateRun(db, runId, { state: "failed", endedAt: true, errorCode: "codex_error", errorMessage: "model is not supported" });
    recordRuntimeHealthFailure(db, {
      profile: defaultRuntimeProfile("codex"), model: "gpt-5.5", itemId, runId,
      failure: typedFailure("model_unsupported", { errorCode: "codex_error", message: "model is not supported" }),
    });
    db.close();

    const prompts: string[] = [];
    daemon = await startDaemon({ dataDir: dir, dbPath, sessionFactory: recordingLead(prompts) as never, log: () => {} });

    await vi.waitFor(() => {
      expect(prompts.some((prompt) => prompt.includes(`工单 #${itemId} 的 Run #${runId}`))).toBe(true);
    }, { timeout: 5_000 });
  });
});
