// 发布评审（Lead 信任修复留下的一项）：daemon 的轮询器先推送、后记已送达。记已送达这一步抛错时，
// 通知已经推出去了，下一拍又推一遍；抛错落在定时器回调里没人接住，daemon 直接退出，重启后再推一遍，
// 一直错就一直崩溃重启。现在先记已送达再推送：记不上就不推。一拍出错只记一行日志，轮询照常继续。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { addInbox, addNotification, createApproval, getNotification, openDb, type Db } from "@pi-lead-child/store";
import { startDaemon } from "../src/server.js";

let dir: string;
let dbPath: string;
let db: Db;

beforeEach(() => {
  dir = tempDir("plc-poller-resilience-");
  vi.stubEnv("PLC_NOTICE_POLL_MS", "20");
  dbPath = join(dir, "plc.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

function stubLead(prompts: string[] = []) {
  return async () => ({
    modelName: "stub/model",
    session: {
      sessionId: "stub-session",
      subscribe() { return () => {}; },
      async prompt(text: string) { prompts.push(text); },
      async steer() {},
      async followUp() {},
      dispose() {},
    },
  });
}

describe("the notice poller when the ledger write fails", () => {
  it("does not push a notice it could not mark delivered, keeps polling, and pushes it once the ledger works", async () => {
    const noticeId = addNotification(db, {
      kind: "lead_notice", urgency: "immediate", title: "Claude Code 需要你重新登录", createdAt: new Date().toISOString(),
    });
    // 记已送达（把 state 从 pending 改掉）这一步失败，就像磁盘写满或者库被锁住。
    db.exec(`CREATE TRIGGER fail_notice_mark BEFORE UPDATE OF state ON notifications
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`);
    const pushed: string[] = [];
    const logs: string[] = [];
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stubLead() as never,
      notifyDesktop: (text) => { pushed.push(text); },
      log: (line) => { logs.push(line); },
    });
    try {
      await vi.waitFor(() => expect(logs.some((line) => line.includes("disk I/O error"))).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(pushed).toEqual([]);
      expect(getNotification(db, noticeId)?.state).toBe("pending");

      db.exec("DROP TRIGGER fail_notice_mark");
      await vi.waitFor(() => expect(getNotification(db, noticeId)?.state).toBe("delivered"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(pushed).toEqual(["Claude Code 需要你重新登录"]);
    } finally {
      await daemon.close();
    }
  });
});

// 发布评审 reliability-backlog：一拍里只有一个 try。排在前面的一步一直出错（例如一条坏了的审批让「审批过期」每次都抛），
// 后面的每一步都跑不到：通知不推、Lead 不被叫醒，每一拍都一样。现在每一步各自接住错误，各记各的日志。
describe("a poller step that keeps failing", () => {
  it("still runs the later steps, so a new blocker wakes Lead, and logs the failing step once", async () => {
    createApproval(db, { requestedBy: "lead", tool: "bash", action: "rm -rf build", ttlMs: -60_000 });
    db.exec(`CREATE TRIGGER fail_approval_expiry BEFORE UPDATE OF status ON approvals
      BEGIN SELECT RAISE(ABORT, 'approvals row is corrupt'); END;`);
    const blockerId = addInbox(db, { dedupScope: "poller-test", severity: "blocker", source: "structural", summary: "工单 #9 执行失败" }).id!;
    const prompts: string[] = [];
    const logs: string[] = [];
    const daemon = await startDaemon({
      dataDir: dir, dbPath, sessionFactory: stubLead(prompts) as never, notifyDesktop: () => {},
      log: (line) => { logs.push(line); },
    });
    try {
      await vi.waitFor(() => expect(prompts.some((text) => text.includes("工单 #9 执行失败"))).toBe(true), { timeout: 5_000 });
      expect(db.prepare("SELECT state FROM inbox WHERE id=?").get(blockerId)).not.toEqual({ state: "pending" });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const failures = logs.filter((line) => line.includes("approvals row is corrupt"));
      expect(failures).toHaveLength(1);
      expect(failures[0]).toContain("[poller] interventions failed");
    } finally {
      await daemon.close();
    }
  });
});
