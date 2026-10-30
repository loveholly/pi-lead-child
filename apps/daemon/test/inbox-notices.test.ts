// 收件箱里哪些通知单独露出来，走完整的持久化路径：通知和工单写进库，经 gateway 的 HTTP 接口读出来，
// 再过 protocol 的同一条规则（inboxNotices）。实例上（2026-10-15）已完成的 #46 还在报「交接失败」，
// #51 的 9 条通知一条一条冒出来，而它同时就在「需要你介入」里。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { inboxNotices } from "@pi-lead-child/protocol";
import { addNotification, createItem, openDb, transition, type Db } from "@pi-lead-child/store";
import { readGatewayNotifications, readGatewayTickets } from "@pi-lead-child/gateway/testing";
import { tempDir } from "@pi-lead-child/core/testing";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-inbox-notices-"), "plc.db"));
});

function task(title: string): number {
  return createItem(db, { title, brief: title, createdBy: "user", runtime: "claude" });
}

describe("notices in the inbox", () => {
  it("shows only what still asks the user for something, read through the gateway", async () => {
    const finished = task("为 Lead 系统提示加入泛化的审慎执行约束");
    transition(db, { itemId: finished, to: "active", actor: "system", reason: "run started" });
    transition(db, { itemId: finished, to: "review", actor: "system", reason: "delivered" });
    transition(db, { itemId: finished, to: "done", actor: "user", reason: "accepted" });
    addNotification(db, {
      itemId: finished, kind: "terminal_handoff_failed", urgency: "immediate",
      title: `工单 #${finished} 运行结束，但交接失败`, createdAt: "2026-08-11T09:59:02.597Z",
    });

    const stuck = task("部署并执行 #48 工单关系能力的真实运行态 E2E 验收");
    transition(db, { itemId: stuck, to: "active", actor: "system", reason: "run started" });
    transition(db, { itemId: stuck, to: "blocked", actor: "system", reason: "run crashed" });
    const firstStuck = addNotification(db, {
      itemId: stuck, kind: "blocked_checkpoint", urgency: "immediate",
      title: `工单 #${stuck} 阻塞：Runtime E2E blocked before migration`, createdAt: "2026-08-14T06:57:26.236Z",
    });
    const secondStuck = addNotification(db, {
      itemId: stuck, kind: "codex_error", urgency: "immediate",
      title: `工单 #${stuck} 阻塞：Child Run 崩溃`, createdAt: "2026-08-17T05:48:09.577Z",
    });

    const global = addNotification(db, {
      kind: "runtime_incident", urgency: "immediate",
      title: "Codex 不支持该模型（gpt-5.5）：派发已挂起", createdAt: "2026-10-14T16:41:11.302Z",
    });

    const result = inboxNotices(await readGatewayNotifications(db), await readGatewayTickets(db));

    expect(result.general.map((item) => item.id)).toEqual([global]);
    expect(result.byTicket[stuck]?.map((item) => item.id)).toEqual([secondStuck, firstStuck]);
    expect(result.byTicket[finished]).toBeUndefined();
    expect(Object.keys(result.byTicket)).toEqual([String(stuck)]);
  });
});
