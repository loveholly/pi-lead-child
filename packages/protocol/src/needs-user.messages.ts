// 「需要你」的原因的名字（needs-user.ts）。界面按用户的语言取；Lead 的工具和输入取 zh。
import { defineMessages } from "./i18n.ts";

export const needsUserMessages = defineMessages({
  en: {
    approval: "Needs approval",
    blocked: "Needs you",
    decision: "Needs your decision",
    review_dispatch: "Review not sent",
    acceptance: "Needs acceptance",
    stalled: "Stalled",
    paused: "Paused too long",
    capability: "Waits for a capability",
    confirmation: "Needs confirmation",
  },
  zh: {
    approval: "待审批",
    blocked: "需介入",
    decision: "待你决定",
    review_dispatch: "核查未派发",
    acceptance: "待验收",
    stalled: "停滞",
    paused: "停太久",
    capability: "等待能力",
    confirmation: "待确认",
  },
});
