// Lead 的名字、人格和互动风格（2026-10-22）：输入的整理和检查，以及给人看的文字里用这个名字。
// 停摆卡片的标题开头是名字，daemon 和 companion 都要从文字里认出它：名字写下以后可能又改过，所以不认具体的名字。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LEAD_NAME, isLeadOutageHeadline, leadAvatarLabel, leadModelFailureReason, leadOutageCause, leadOutageHeadline,
  leadProfileProblem, leadTurnFailureSentence, LEAD_RESTART_INTERRUPTED_ERROR, normalizeLeadName, normalizeLeadProfileRequest,
  userFacingBacklogText,
} from "../src/index.ts";

describe("the Lead profile input", () => {
  it("keeps the name on one line and drops invisible characters", () => {
    expect(normalizeLeadName("  Jar​vis \n Bot  ")).toBe("Jarvis Bot");
    expect(normalizeLeadProfileRequest({ persona: "  沉稳\r\n干练\u0007  " })).toEqual({ persona: "沉稳\n干练" });
    expect(normalizeLeadProfileRequest({ name: " 派蒙 ", interactionStyle: "" })).toEqual({ name: "派蒙", interactionStyle: "" });
  });

  it("refuses an empty change, an empty or too long name, and too long text", () => {
    expect(leadProfileProblem({})).toBe("没有要改的内容");
    expect(leadProfileProblem({ name: "" })).toBe("名字不能是空的");
    expect(leadProfileProblem({ name: "派".repeat(25) })).toBe("名字最多 24 个字");
    expect(leadProfileProblem({ name: "派".repeat(24) })).toBeNull();
    expect(leadProfileProblem({ persona: "x".repeat(1_201) })).toBe("人格最多 1200 个字");
    expect(leadProfileProblem({ interactionStyle: "x".repeat(1_201) })).toBe("互动风格最多 1200 个字");
    // 清空人格和互动风格是允许的。
    expect(leadProfileProblem({ persona: "", interactionStyle: "" })).toBeNull();
  });

  it("puts the first letter of the name on the avatar", () => {
    expect(leadAvatarLabel("jarvis")).toBe("J");
    expect(leadAvatarLabel("派蒙")).toBe("派");
    expect(leadAvatarLabel("  ")).toBe(DEFAULT_LEAD_NAME[0]);
  });
});

describe("text that calls Lead by its name", () => {
  it("uses the given name, and Paimon when none is given", () => {
    expect(leadModelFailureReason("unavailable")).toBe("Paimon 的模型服务暂时连不上");
    expect(leadModelFailureReason("unavailable", "Jarvis")).toBe("Jarvis 的模型服务暂时连不上");
    expect(leadTurnFailureSentence(LEAD_RESTART_INTERRUPTED_ERROR, { system: false, name: "Jarvis" }))
      .toBe("Jarvis 的回复被重启打断；已经做完的事不会重做，重启后 Jarvis 会接着回复你。");
    expect(userFacingBacklogText("跟进：看一下 #5", "Jarvis")).toBe("Jarvis 设的一次跟进到点了");
  });

  it("recognizes an outage headline whatever the name was when it was written", () => {
    const headline = leadOutageHeadline({
      start: "19:11", end: null, cause: leadOutageCause("silent"), pending: 2, resumed: false, name: "Jarvis",
    });
    expect(headline).toBe("Jarvis 离线 19:11 起（没有响应）· 期间积压 2 件");
    expect(isLeadOutageHeadline(headline)).toBe(true);
    expect(isLeadOutageHeadline("Mr Smith 离线 9:05–9:40（网络中断）· 期间积压 1 件")).toBe(true);
    // 2026-10-22 以前写的标题。
    expect(isLeadOutageHeadline("Lead 离线 19:11–20:07（网络中断）· 期间积压 1 件 · 20:07 已恢复并补处理")).toBe(true);
    expect(isLeadOutageHeadline("工单 #5「离线 包」：19:11 发布")).toBe(false);
    expect(isLeadOutageHeadline("Lead 现在不可用：网络中断。积压了 2 件事：")).toBe(false);
  });
});
