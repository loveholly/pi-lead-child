// lead 自己发起的回合（daemon 唤醒 lead 处理 blocker、播报通知、心跳巡检、整理笔记），
// 以及 daemon 自己发出的系统通知，都是会话流里的一轮，originKind 以 system: 开头。
// 客户端按 originKind 给它们贴标签：plc 和 companion 用同一个函数。
import { describe, expect, it } from "vitest";
import { PRESENCE_IDLE_MS, SYSTEM_TURN_ORIGINS, isSystemTurnOrigin, systemTurnLabel } from "../src/index.js";

describe("system turn origins", () => {
  // 2026-10-15 用户决定（方案 A 画布评论）：不要「Lead 主动」这类字样。Lead 自己发起的回合也只写「Lead」，
  // 发生了什么由消息内容说明。daemon 自己写的通知不是 Lead 在说话，仍然标成系统通知。
  it("label every turn the daemon starts itself", () => {
    expect(systemTurnLabel(SYSTEM_TURN_ORIGINS.blocker)).toBe("Lead");
    expect(systemTurnLabel(SYSTEM_TURN_ORIGINS.notification)).toBe("Lead");
    expect(systemTurnLabel(SYSTEM_TURN_ORIGINS.heartbeat)).toBe("Lead");
    expect(systemTurnLabel(SYSTEM_TURN_ORIGINS.precipitate)).toBe("Lead");
    expect(systemTurnLabel(SYSTEM_TURN_ORIGINS.blockerNotice)).toBe("系统通知 · blocker");
    expect(systemTurnLabel(SYSTEM_TURN_ORIGINS.fallbackNotice)).toBe("系统通知");
  });

  it("give an unknown system origin a generic label, so a newer daemon still shows up", () => {
    expect(systemTurnLabel("system:something-new")).toBe("Lead");
    expect(isSystemTurnOrigin("system:something-new")).toBe(true);
  });

  it("leave user-originated turns unlabelled", () => {
    for (const originKind of ["paired:cli", "paired:companion", "paired:companion:ticket", "aish", "live", "", null, undefined]) {
      expect(isSystemTurnOrigin(originKind)).toBe(false);
      expect(systemTurnLabel(originKind)).toBeNull();
    }
  });
});

describe("presence", () => {
  it("expires after five minutes without user input", () => {
    expect(PRESENCE_IDLE_MS).toBe(5 * 60_000);
  });
});

describe("isQuietReply", () => {
  it("treats an empty reply and NO_REPLY (with trailing punctuation) as nothing for the user", async () => {
    const { isQuietReply } = await import("../src/system-turns.ts");
    for (const quiet of ["", "  ", "NO_REPLY", " no_reply。", "NO_REPLY.\n"]) expect(isQuietReply(quiet)).toBe(true);
    for (const said of ["没有新增笔记。", "NO_REPLY 但是 #66 卡住了", "#66 需要你决定"]) expect(isQuietReply(said)).toBe(false);
  });
});

describe("blocker notice lines", () => {
  it("say which ticket is stuck in one plain line, and the client reads the ticket back", async () => {
    const { blockerNoticeText, blockerNoticeTicketId } = await import("../src/system-turns.ts");
    const line = blockerNoticeText(12, "工单 #12 执行重试已耗尽（执行失败 2/2），已停止派发。");
    expect(line).toBe("工单 #12 卡住了：执行重试已耗尽（执行失败 2/2），已停止派发。");
    expect(blockerNoticeText(7, "工单 #7 的必需子工单已取消，无法继续集成")).toBe("工单 #7 卡住了：必需子工单已取消，无法继续集成");
    expect(blockerNoticeTicketId(line)).toBe(12);
    expect(blockerNoticeTicketId("🔴 工单 #66 阻塞：Run crashed")).toBe(66);
    expect(blockerNoticeTicketId("有一处阻塞：磁盘满了")).toBeNull();
  });

  it("keep the other ticket's id when the reason names a different ticket", async () => {
    const { blockerNoticeText, blockerNoticeTicketId } = await import("../src/system-turns.ts");
    // orchestrator.ts 把子工单 #6 的 reviewer 重试耗尽记在父工单 #5 上。
    const line = blockerNoticeText(5, "工单 #6 reviewer 重试已耗尽（1/1）");
    expect(line).toBe("工单 #5 卡住了：工单 #6 reviewer 重试已耗尽（1/1）");
    expect(blockerNoticeTicketId(line)).toBe(5);
  });
});
