// 一次停摆，一张卡片（2026-10-16）。2026-10-15 19:11–20:07 断网时，会话里有两张卡片说同一件事：
// 「系统通知 · 19:19」把 Lead 写给自己的跟进原样转给了用户（"跟进：看 #66 reviewer Run #87 … 用 notify_user（batchable）推送 …"），
// 另一张橙色的「Lead 的模型服务暂时连不上，这次没能处理新的 blocker … 共 2 次」。
// 现在是一张系统卡片："Lead 离线 19:11–20:07（网络中断）· 期间积压 1 件 · 20:07 已恢复并补处理"，积压的事写给用户看。
import { describe, expect, it } from "vitest";
import { leadOutageCause, leadOutageHeadline, userFacingBacklogText } from "../src/index.ts";

describe("the outage card's words", () => {
  it("say when, why, how much waited, and whether Lead is back", () => {
    expect(leadOutageHeadline({ start: "19:11", end: "20:07", cause: leadOutageCause("network"), pending: 1, resumed: true }))
      .toBe("Paimon 离线 19:11–20:07（网络中断）· 期间积压 1 件 · 20:07 已恢复并补处理");
    expect(leadOutageHeadline({ start: "19:11", end: null, cause: leadOutageCause("unavailable"), pending: 2, resumed: false }))
      .toBe("Paimon 离线 19:11 起（模型服务连不上）· 期间积压 2 件");
    expect(leadOutageCause("auth")).toBe("模型认证失败");
    // 标题开头已经是名字（「Paimon 离线 …（没有响应）」），原因里不再写一遍。
    expect(leadOutageCause("silent")).toBe("没有响应");
  });

  it("never pass on Lead's own notes or tool names", () => {
    const followUp = "跟进：看 #66 reviewer Run #87 恢复了没有；如果用户不在，用 notify_user（batchable）推送，再 record_disposition。";
    expect(userFacingBacklogText(followUp)).toBe("Paimon 设的一次跟进到点了");
    const text = userFacingBacklogText("工单 #71 执行重试已耗尽，Lead 应调用 recover_ticket_run（换 runtime）");
    expect(text).not.toMatch(/notify_user|record_disposition|recover_ticket_run/);
    expect(text).toContain("执行重试已耗尽");
    expect(userFacingBacklogText("Run #70 crashed (process_exit)")).toBe("Run #70 crashed");
  });
});

// 发布评审：同一分钟里开始又恢复的停摆写成「02:46–02:46」，看起来像一张时长为零的卡片。
describe("an outage that started and ended in the same minute", () => {
  it("says it lasted under a minute instead of showing an empty range", () => {
    const headline = leadOutageHeadline({ start: "02:46", end: "02:46", cause: leadOutageCause("network"), pending: 1, resumed: true });
    expect(headline).not.toContain("02:46–02:46");
    expect(headline).toBe("Paimon 离线 02:46，不到一分钟（网络中断）· 期间积压 1 件 · 已恢复并补处理");
  });

  // 发布评审 reliability-backlog：按 HH:MM 判断时，02:46:50 到 02:47:10 写成「02:46–02:47」，其实只有 20 秒。
  it("judges the length on the full times when it has them, not on the minutes", () => {
    const cause = leadOutageCause("network");
    expect(leadOutageHeadline({ start: "02:46", end: "02:47", cause, pending: 1, resumed: true, durationMs: 20_000 }))
      .toBe("Paimon 离线 02:46，不到一分钟（网络中断）· 期间积压 1 件 · 已恢复并补处理");
    expect(leadOutageHeadline({ start: "02:46", end: "02:47", cause, pending: 1, resumed: true, durationMs: 61_000 }))
      .toBe("Paimon 离线 02:46–02:47（网络中断）· 期间积压 1 件 · 02:47 已恢复并补处理");
  });
});

