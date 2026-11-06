// 控制面投影里给人看的文字（2026-11-01 多语言）：工单的执行状态和核查状态（2026-11-03）、收件箱的原因、「Lead 已处理」的说明。
// 读的时候现算，按读的时候用户选的语言（store 的 getLocale）。Lead 的 get_ticket 读同一份摘要，用户的语言它也读得懂。
import { defineMessages, type ReviewEscalationReason } from "@pi-lead-child/protocol";

type ExecutionStep = "waiting_dispatch" | "starting" | "running" | "blocked" | "failed";
type MilestoneChange = "moved" | "cancelled" | "completed" | "missed" | "relabeled" | "restored";
type ReviewProgress = "running" | "queued" | "suspended";

export const controlPlaneMessages = defineMessages({
  en: {
    execution: {
      suspended: "Dispatch is suspended",
      backoff: "Temporary failure · waiting for an automatic retry",
      outcomeRepair: {
        waiting_dispatch: "Outcome repair · waiting for an agent",
        starting: "Outcome repair · starting",
        running: "Submitting the outcome again",
        blocked: "Outcome repair is blocked",
        failed: "Outcome repair failed",
        other: "Outcome repair",
      } satisfies Record<ExecutionStep | "other", string>,
      recovery: {
        waiting_dispatch: "Recovering · waiting for an agent",
        starting: "Recovering · starting",
        running: "Running",
        blocked: "Recovery is blocked",
        failed: "Recovery failed",
        other: "Recovering",
      } satisfies Record<ExecutionStep | "other", string>,
      rework: {
        waiting_dispatch: "Rework requested, waiting for an agent",
        starting: "The rework run is starting",
        running: "The rework run started",
        blocked: "Rework dispatch is blocked",
        failed: "The rework did not start",
        other: "Rework requested",
      } satisfies Record<ExecutionStep | "other", string>,
      execution: {
        waiting_dispatch: "Waiting for agent dispatch",
        starting: "The run is starting",
        running: "The run started",
        blocked: "Dispatch is blocked",
        failed: "The run did not start",
        other: "The run did not start",
      } satisfies Record<ExecutionStep | "other", string>,
      dependsOn: "Waiting for depends_on dependencies to finish",
      retryAt: (at: string) => `Temporary failure. The system retries automatically at ${at}.`,
    },
    review: {
      // 返工用完、成果没登记（rework_exhausted）。
      noAutoRework: "Automatic rework is not allowed",
      reworkUsedUp: (used: number, max: number) => `Rework ${used}/${max} used up`,
      exhaustedAndUnrecorded: "Rework is used up and the outcome is not recorded. You need to decide",
      exhausted: "Rework is used up. Automation stopped",
      unrecorded: "The outcome is not recorded, so it cannot be accepted",
      recoveryFailed: (runId: number) => `Run #${runId} ended without an outcome snapshot to record. Self-recovery failed`,
      verdictOf: (verdict: string, runId: number) => `Independent review ${verdict} (Run #${runId})`,
      verdictSuperseded: (runId: number, verdict: string) => `The current review state is unknown: the ${verdict} of Run #${runId} is void because of a later run`,
      neverReviewed: "The current review state is unknown: no independent review has given a verdict",
      separator: "; ",
      // 还没有结论：等你验收，或者独立核查在路上。
      waitingUser: "Waiting for your acceptance",
      chip: {
        running: "Independent review running",
        queued: "Independent review queued",
        suspended: "Independent review paused",
      } satisfies Record<ReviewProgress, string>,
      notDispatched: "Independent review not dispatched",
      waiting: "Waiting for independent review",
      why: {
        running: "The independent review is running.",
        queued: "The review request is queued. It waits for dispatch.",
        suspended: "The review request is suspended. It is dispatched after it resumes.",
      } satisfies Record<ReviewProgress, string>,
      gap: (runId: number) => `Nobody reviewed the delivery of Run #${runId} yet. The system does not dispatch a review on its own.`,
      soon: "The run ended. The independent review starts soon.",
      // 有结论：不通过、证据冲突、通过。
      escalation: {
        evidence_conflict: "the evidence conflicts",
        requirement_change: "the requirement changed",
        irreversible_action: "there is an irreversible action",
        external_approval: "an outside approval is necessary",
      } satisfies Record<ReviewEscalationReason, string>,
      escalated: (why: string) => `The reviewer asks you to decide: ${why}`,
      escalatedNote: (evidence: string, words: string, note: string) => `${evidence}\n${words}: ${note}`,
      conflict: "The evidence conflicts. You need to decide",
      failedEscalated: (words: string) => `Review failed. ${words}`,
      failed: "Review failed. You need to decide",
      passedEscalated: (words: string) => `Review passed. ${words}`,
      passed: "Review passed. Waiting for acceptance",
    },
    defaultModel: "Default model",
    inbox: {
      approval: (action: string) => `Waiting for your approval: ${action}`,
      stalled: "The run has had no activity for a long time",
      capability: "The continuation waits for a capability that is not deployed yet",
      draft: (lead: string) => `${lead} created this draft. It starts after you confirm it`,
      // 停了超过一天的暂停（工单 #111）。who 是「你」、Lead 的名字或「系统」；what 是暂停前在做的事。
      paused: (who: string, what: string | null) =>
        `${who} paused it more than a day ago${what ? `, during "${what}"` : ""}. Resume or cancel it`,
      pausedBy: { user: "You", system: "The system" },
    },
    leadHandled: {
      milestoneVerb: (change: string) => {
        switch (change as MilestoneChange) {
          case "moved": return "changed the date";
          case "cancelled": return "cancelled it";
          case "completed": return "marked it done";
          case "missed": return "marked it missed";
          case "relabeled": return "renamed it";
          default: return "restored it";
        }
      },
      milestone: (itemId: number, label: string, lead: string, verb: string) => `You set "${label}" of #${itemId}. ${lead} ${verb}`,
      reminder: (title: string, lead: string, to: string) => `You set the time of reminder "${title}". ${lead} moved it to ${to}`,
      stop: (lead: string, itemId: number, title: string) => `${lead} stopped ticket #${itemId} "${title}". It went back to ready`,
    },
  },
  zh: {
    execution: {
      suspended: "派发已挂起",
      backoff: "瞬时失败 · 等待自动重试",
      outcomeRepair: {
        waiting_dispatch: "成果修复 · 等待 agent",
        starting: "成果修复 · 启动中",
        running: "正在补交成果",
        blocked: "成果修复受阻",
        failed: "成果修复失败",
        other: "成果修复",
      },
      recovery: {
        waiting_dispatch: "正在恢复 · 等待 agent",
        starting: "正在恢复 · 启动中",
        running: "执行中",
        blocked: "恢复受阻",
        failed: "恢复失败",
        other: "正在恢复",
      },
      rework: {
        waiting_dispatch: "返工已请求，等待 agent",
        starting: "返工 Run 正在启动",
        running: "返工 Run 已启动",
        blocked: "返工派发受阻",
        failed: "返工启动失败",
        other: "返工已请求",
      },
      execution: {
        waiting_dispatch: "等待 agent 派发",
        starting: "Run 正在启动",
        running: "Run 已启动",
        blocked: "派发受阻",
        failed: "启动失败",
        other: "启动失败",
      },
      dependsOn: "等待 depends_on 依赖完成",
      retryAt: (at) => `瞬时失败，系统会在 ${at} 自动重试。`,
    },
    review: {
      noAutoRework: "自动返工未获授权",
      reworkUsedUp: (used, max) => `返工 ${used}/${max} 已用尽`,
      exhaustedAndUnrecorded: "返工已用尽且成果未登记，需要你决定",
      exhausted: "返工已用尽，自动化已停止",
      unrecorded: "成果未登记，无法验收",
      recoveryFailed: (runId) => `Run #${runId} 结束后没有可登记的成果快照，自我恢复失败`,
      verdictOf: (verdict, runId) => `独立核查 ${verdict}（Run #${runId}）`,
      verdictSuperseded: (runId, verdict) => `当前验证状态未知：Run #${runId} 的${verdict} 已被之后的执行作废`,
      neverReviewed: "当前验证状态未知：从未产生过独立核查裁决",
      separator: "；",
      waitingUser: "等你验收",
      chip: {
        running: "独立核查中",
        queued: "独立核查排队中",
        suspended: "独立核查已暂停",
      },
      notDispatched: "独立核查未派发",
      waiting: "等待独立核查",
      why: {
        running: "独立核查正在进行。",
        queued: "核查请求已排队，等待派发。",
        suspended: "核查请求已挂起，恢复后才会派发。",
      },
      gap: (runId) => `Run #${runId} 的交付还没有被独立核查，系统不会自动派发。`,
      soon: "执行已结束，独立核查即将开始。",
      escalation: {
        evidence_conflict: "证据矛盾",
        requirement_change: "需求变了",
        irreversible_action: "有不可逆的操作",
        external_approval: "要外部批准",
      },
      escalated: (why) => `核查员要你决定：${why}`,
      escalatedNote: (evidence, words, note) => `${evidence}\n${words}：${note}`,
      conflict: "证据冲突，等你决定",
      failedEscalated: (words) => `核查不通过，${words}`,
      failed: "核查不通过，等你决定",
      passedEscalated: (words) => `核查通过，${words}`,
      passed: "核查通过，等待验收",
    },
    defaultModel: "默认模型",
    inbox: {
      approval: (action) => `等你批准：${action}`,
      stalled: "Run 很久没有动静",
      capability: "续作在等一个还没部署的能力",
      draft: (lead) => `${lead} 建的草稿，等你确认才会开始`,
      paused: (who, what) => `${who}暂停的，已经停了超过 1 天${what ? `，停在「${what}」` : ""}。继续还是取消？`,
      pausedBy: { user: "你", system: "系统" },
    },
    leadHandled: {
      milestoneVerb: (change) => {
        switch (change as MilestoneChange) {
          case "moved": return "改了日期";
          case "cancelled": return "取消了它";
          case "completed": return "标为完成";
          case "missed": return "标为没赶上";
          case "relabeled": return "改了名字";
          default: return "恢复了它";
        }
      },
      milestone: (itemId, label, lead, verb) => `#${itemId} 的「${label}」是你定的，${lead} ${verb}`,
      reminder: (title, lead, to) => `提醒「${title}」的时间是你定的，${lead} 改到了 ${to}`,
      stop: (lead, itemId, title) => `${lead} 停下了工单 #${itemId}「${title}」，它回到了待开始`,
    },
  },
});
