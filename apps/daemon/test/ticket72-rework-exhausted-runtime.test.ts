// 运行态验收（工单 #72 验收标准第三条）。
//
// 前两条要求由 test/review-deadlock.test.ts 用单测与集成断言覆盖；这一条要求的是**跑一遍**：
// 真起一个 daemon 进程内实例、真开 HTTP paired server、真配对一个 companion 客户端，
// 然后沿着 #66 走过的那条路——用户在授权面板里点"授权并返工"（POST /v1/lead/delegation
// start_rework=true）→ 返工交付 → 第二轮独立核查仍然 FAIL → 返工额度用尽——
// 最后从**线上接口**读回通知与工单投影，而不是从源码或内部函数返回值上读。
//
// 跑出来的原始响应写进 artifacts/ticket-72-rework-exhausted/，作为运行态证据留档。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDispatcher } from "@pi-lead-child/engine";
import { tempDir } from "@pi-lead-child/core/testing";
import { startDaemon } from "../src/server.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { createRun, updateRun } from "@pi-lead-child/store";
import type { NotificationDto, TicketSummary } from "@pi-lead-child/protocol";

const EVIDENCE_DIR = join("artifacts", "ticket-72-rework-exhausted");

function leadSessionFactory() {
  return async () => ({
    modelName: "stub/ticket-72",
    session: {
      sessionId: "ticket-72-runtime",
      subscribe: () => () => {},
      prompt: async () => {},
      steer: async () => {},
    },
  });
}

function auth(token: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

async function pair(db: Db, base: string, scopes: string[]): Promise<string> {
  const { code } = createPairing(db, { name: "ticket-72-companion", kind: "companion", scopes });
  const response = await fetch(`${base}/v1/paired/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pairing_code: code }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as { access_token: string }).access_token;
}

function finishExecutorRun(db: Db, itemId: number): number {
  const runId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
  updateRun(db, runId, { state: "finished", endedAt: true, exitCode: 0 });
  return runId;
}

describe("runtime acceptance: rework exhaustion reaches the user over the wire", () => {
  it("drives the #66 path on a live daemon and reads the new notice back from HTTP", async () => {
    const dataDir = tempDir("plc-ticket-72-");
    const dbPath = join(dataDir, "plc.db");

    // ── 起始状态：一张执行已结束、停在 review、等待独立核查的工单 ──
    const seed = openDb(dbPath);
    const itemId = createItem(seed, {
      title: "[#72 runtime] rework exhaustion reaches the user",
      brief: "reproduce the #66 rework-exhaustion path end to end",
      createdBy: "user",
      workdir: dataDir,
      verificationPolicy: "independent_reviewer",
    });
    transition(seed, { itemId, to: "active", actor: "system", reason: "spawn_child" });
    const firstExecutorRunId = finishExecutorRun(seed, itemId);
    transition(seed, {
      itemId,
      to: "review",
      actor: "child",
      reason: "Implementation complete; independent review requested",
      runId: firstExecutorRunId,
    });
    seed.close();

    const daemon = await startDaemon({
      dataDir,
      dbPath,
      sessionFactory: leadSessionFactory() as never,
      gatewayPort: 0,
      log: () => {},
    });
    const base = `http://127.0.0.1:${daemon.pairedPort}`;
    // daemon 拥有它自己的连接；驱动侧另开一条，模拟 reviewer / child 那一端的真实写入。
    const driver = openDb(dbPath);

    try {
      const token = await pair(driver, base, ["tickets:view", "tickets:create", "notices"]);

      // ── 用户在授权面板里点"授权并返工"：这一步同时授权与消耗掉唯一一次返工额度 ──
      const delegation = await fetch(`${base}/v1/lead/delegation`, {
        method: "POST",
        headers: auth(token, true),
        body: JSON.stringify({
          ticket_id: itemId,
          granted: true,
          max_rework_cycles: 1,
          start_rework: true,
          reason: "授权 Lead 无人值守交付，并立即启动本次返工",
        }),
      });
      expect(delegation.status).toBe(200);
      const delegationBody = await delegation.json() as {
        policy: { max_rework_cycles: number };
        reworkStarted?: boolean;
      };
      expect(delegationBody.policy.max_rework_cycles).toBe(1);
      expect(getItem(driver, itemId)?.stage).toBe("active");

      // ── 返工交付，重新进入 review ──
      const reworkRunId = finishExecutorRun(driver, itemId);
      transition(driver, {
        itemId,
        to: "review",
        actor: "child",
        reason: "Rework delivered; independent review requested",
        runId: reworkRunId,
      });

      // ── 第二轮独立核查仍然 FAIL：额度已经在授权那一步用掉了 ──
      const reviewerRunId = createRun(driver, {
        itemId,
        role: "reviewer",
        purpose: "review",
        runtime: "codex",
      });
      createDispatcher(driver).submitReviewVerdict({
        runId: reviewerRunId,
        verdict: "fail",
        evidence: "第二轮独立核查 FAIL：返工没有修好原始验收范围内的回归。",
      });

      // ── 从线上接口读回来：通知 ──
      const notices = await fetch(`${base}/v1/notifications`, { headers: auth(token) });
      expect(notices.status).toBe(200);
      const noticeBody = await notices.json() as { items: NotificationDto[] };
      const exhausted = noticeBody.items.find((notice) => notice.kind === "rework_exhausted");

      expect(exhausted, "rework_exhausted notification missing from GET /v1/notifications")
        .toBeDefined();
      expect(exhausted!).toMatchObject({
        ticketId: itemId,
        kind: "rework_exhausted",
        urgency: "immediate",
        title: `工单 #${itemId} 返工次数已用尽（1/1），自动化已停止`,
      });
      expect(exhausted!.body).toContain("已用返工次数：1/1");
      expect(exhausted!.body).toContain(`当前验证状态：FAIL（reviewer Run #${reviewerRunId}）`);
      expect(exhausted!.body).toContain("各轮失败原因：");
      expect(exhausted!.body).toContain("[用户授权返工");
      expect(exhausted!.body).toContain("自动派发已停止");

      // ── 从线上接口读回来：工单投影不再是一张普通的"待验收"卡片 ──
      const tickets = await fetch(`${base}/v1/tickets`, { headers: auth(token) });
      expect(tickets.status).toBe(200);
      const ticket = (await tickets.json() as { items: TicketSummary[] })
        .items.find((row) => row.id === itemId);

      expect(ticket).toBeDefined();
      expect(ticket!.stage).toBe("review");
      expect(ticket!.reviewState).toMatchObject({
        state: "rework_exhausted",
        label: "返工已用尽，自动化已停止",
        verdict: "fail",
        reworkCyclesUsed: 1,
        maxReworkCycles: 1,
      });

      // ── 运行态证据留档 ──
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      writeFileSync(
        join(EVIDENCE_DIR, "runtime-evidence.json"),
        `${JSON.stringify({
          scenario: "ticket #72 acceptance: delegated grant + rework, second reviewer FAIL",
          pairedBase: base,
          ticketId: itemId,
          runs: { firstExecutorRunId, reworkRunId, reviewerRunId },
          "GET /v1/notifications": { status: notices.status, reworkExhausted: exhausted },
          "GET /v1/tickets": {
            status: tickets.status,
            stage: ticket!.stage,
            reviewState: ticket!.reviewState,
            attention: ticket!.attention,
          },
        }, null, 2)}\n`,
        "utf8",
      );
    } finally {
      driver.close();
      await daemon.close();
    }
  }, 30_000);
});
