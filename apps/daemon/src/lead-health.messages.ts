// 顶栏的状态点读的原因（lead-health.ts）。读的时候按用户现在选的语言算。
import { defineMessages } from "@pi-lead-child/protocol";

export const leadHealthMessages = defineMessages({
  en: {
    compactionFailed: (name: string) => `The context compaction of ${name} failed`,
    // 模型暂停（lead 的 model-hold.ts）进入时给用户的一条通知。
    holdTitle: (name: string, kind: "account" | "breaker" | "budget") => kind === "account"
      ? `${name} stopped automatic work: the model account needs your attention`
      : kind === "breaker"
        ? `${name} stopped automatic work: the model service keeps failing`
        : `${name} paused automatic work: it reached the automatic call budget`,
    holdBody: (name: string, kind: "account" | "breaker" | "budget", detail: string, retryAt: string | null) => [
      kind === "account"
        ? `The system makes no automatic model call now. Check the model account, then send ${name} a message. When that message gets an answer, the queued work continues.`
        : kind === "breaker"
          ? `The system makes no automatic model call now. It tries one call${retryAt ? ` at ${retryAt}` : " later"}, and waits longer after each failure. Your own messages still go to the model.`
          : `The system makes no automatic model call${retryAt ? ` until ${retryAt}` : " for now"}. Your own messages still go to the model. You can change the limits in Settings → Lead → Limits on automatic model calls.`,
      `Detail: ${detail}`,
    ].join("\n"),
  },
  zh: {
    compactionFailed: (name) => `${name} 的上下文压缩失败`,
    holdTitle: (name, kind) => kind === "account"
      ? `${name} 停止了自动工作：模型账号需要你处理`
      : kind === "breaker"
        ? `${name} 停止了自动工作：模型服务一直失败`
        : `${name} 暂停了自动工作：自动调用达到了预算`,
    holdBody: (name, kind, detail, retryAt) => [
      kind === "account"
        ? `系统现在不自动调用模型。请检查模型账号，然后给 ${name} 发一条消息。这条消息得到回答以后，排着的事会接着处理。`
        : kind === "breaker"
          ? `系统现在不自动调用模型。${retryAt ? `${retryAt} ` : "稍后"}会试一次，每次失败以后等得更久。你自己发的消息照常发给模型。`
          : `系统${retryAt ? `在 ${retryAt} 以前` : "暂时"}不自动调用模型。你自己发的消息照常发给模型。上限可以在 设置 → Lead →「自动调用模型的上限」里改。`,
      `详情：${detail}`,
    ].join("\n"),
  },
});
