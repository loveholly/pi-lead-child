import { runtimeDisplayName } from '../workspace/runtimeNames';
// 对话坞里除了最后一条消息以外的两件事：你刚做的动作（回执），和正在跑的那次 Run（实时进度）。
// #66 上你点了「派发独立核查」，变化只出现在屏幕外的状态卡里；核查 Run #73 一直停在 starting，
// 界面上没有任何地方说它卡住了。现在回执和进度都落在对话坞里，也就是你点按钮时眼睛所在的地方。
import type { ActivityDto, TicketChatResume } from '@pi-lead-child/protocol';

import type { AttemptEntity } from '@/state/types';

import type { RunFacts, RunPurpose } from './runFacts';

export type TicketActionReceipt = {
  /** 用你的口吻写：「你派发了独立核查」。 */
  title: string;
  createdAt: string;
};

function userDecisionReceipts(leadName: string): Record<string, string> {
  return {
    review_requested_by_user: '你派发了独立核查',
    rework_dispatch_requested: '你发起了返工',
    delegation_preflight_accepted: `你授权了 ${leadName} 托管`,
    ticket_runtime_switched: '你切换了执行 agent',
    开始执行: '你开始了执行',
    停止执行: '你停止了执行',
  };
}

const USER_TRANSITION_RECEIPTS: Record<string, string> = {
  done: '你验收通过了这张工单',
  cancelled: '你取消了这张工单',
  active: '你让工单继续执行',
  ready: '你确认了这张工单',
};

/** 你在这张工单上做的最近一个动作。系统和 Lead 做的不算。leadName 是 Lead 的名字（useLeadName）。 */
export function latestUserAction(
  activities: readonly Pick<ActivityDto, 'actor' | 'kind' | 'payload' | 'createdAt'>[],
  leadName: string,
): TicketActionReceipt | null {
  const decisionReceipts = userDecisionReceipts(leadName);
  let latest: TicketActionReceipt | null = null;
  for (const activity of activities) {
    if (activity.actor !== 'user') continue;
    const key = activity.kind === 'decision'
      ? stringOf(activity.payload.decision)
      : activity.kind === 'transition' ? stringOf(activity.payload.to) : null;
    const title = key === null
      ? undefined
      : activity.kind === 'decision' ? decisionReceipts[key] : USER_TRANSITION_RECEIPTS[key];
    if (!title) continue;
    if (latest === null || activity.createdAt >= latest.createdAt) latest = { title, createdAt: activity.createdAt };
  }
  return latest;
}

/** Run 启动超过这么久还停在 starting，就说它可能卡住了。正常情况下 10 秒内开始。 */
export const RUN_START_STALL_MS = 60_000;

export type TicketRunProgress = {
  runId: number;
  purpose: RunPurpose;
  /** 「核查 Run #73 · 正在准备」 */
  label: string;
  phase: 'starting' | 'running' | 'paused';
  elapsedMs: number;
  /** 准备了超过一分钟还没开始。 */
  stalled: boolean;
};

const PURPOSE_NOUN: Record<RunPurpose, string> = {
  execution: '执行',
  review: '核查',
  conversation: '对话',
  integration: '合并',
  learning: '学习',
};

const RUNNING_TEXT: Record<RunPurpose, string> = {
  execution: '正在执行',
  review: '正在核查',
  conversation: '正在回答',
  integration: '正在合并',
  learning: '进行中',
};

/** 正在跑的那次 Run。有几次同时在跑时取最新的一次。 */
export function liveRunProgress(
  attempts: readonly Pick<AttemptEntity, 'id' | 'role' | 'purpose' | 'state' | 'startedAt'>[],
  facts: ReadonlyMap<number, Pick<RunFacts, 'purpose'>>,
  now: number,
): TicketRunProgress | null {
  const live = attempts
    .filter((attempt) => attempt.state === 'starting' || attempt.state === 'running' || attempt.state === 'paused')
    .sort((left, right) => right.id - left.id)[0];
  if (!live) return null;
  const purpose = facts.get(live.id)?.purpose ?? live.purpose ?? (live.role === 'reviewer' ? 'review' : 'execution');
  const phase = live.state as TicketRunProgress['phase'];
  const startedAt = Date.parse(live.startedAt);
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0;
  const phaseText = phase === 'starting' ? '正在准备' : phase === 'paused' ? '已暂停' : RUNNING_TEXT[purpose];
  return {
    runId: live.id,
    purpose,
    label: `${PURPOSE_NOUN[purpose]} Run #${live.id} · ${phaseText}`,
    phase,
    elapsedMs,
    stalled: phase === 'starting' && elapsedMs > RUN_START_STALL_MS,
  };
}

/** 「已 13 分钟」「已 40 秒」「已 1 小时 8 分钟」。 */
export function elapsedText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `已 ${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `已 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `已 ${hours} 小时` : `已 ${hours} 小时 ${rest} 分钟`;
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// 输入框说明：现在是谁在跑、消息会去哪里（2026-10-15 方案 A）。工单对话的消息一律交给这张工单的 agent
// （2026-10-19 用户的决定，spec D13）：有 Run 在跑时交给那个 Run，没有时开一个对话 Run，续接最近的会话。
// 哪些 runtime 能在 Run 中途接收消息，和服务端 adapter 的 capabilities.steering 一致（packages/runtime）：
// 只有 Pi 能；Codex 和 Claude Code 的消息排队，Run 结束后转交（daemon 的 queueTicketMessage）。
const RUNTIME_TAKES_MESSAGES_MID_RUN: Record<string, boolean> = { pi: true, codex: false, claude: false };

const AGENT_NOUN: Record<RunPurpose, string> = {
  execution: '执行 agent',
  review: '核查 agent',
  conversation: 'agent',
  integration: '合并 agent',
  learning: '学习 agent',
};

const ROLE_NOUN: Record<TicketChatResume['role'], string> = { executor: '执行 agent', reviewer: '核查 agent' };

export type TicketChatDestination = {
  hint: string;
  placeholder: string;
  /** 续接已结束的会话时的预估成本（2026-10-16：#77 的一问 45.6 万 token，#66 的一问 586 万 token）。其余情况为 null。 */
  cost: string | null;
};

/** 「约 45.6 万 token」「约 8,200 token」。 */
export function tokenEstimateText(tokens: number): string {
  if (tokens >= 10_000) {
    const wan = Math.round(tokens / 1_000) / 10;
    return `约 ${wan.toLocaleString('en-US', { maximumFractionDigits: 1 })} 万 token`;
  }
  return `约 ${Math.round(tokens).toLocaleString('en-US')} token`;
}

export function ticketChatDestination({ ticketDisplayId, liveRun, runtimeName, resume = null }: {
  ticketDisplayId: string;
  liveRun: TicketRunProgress | null;
  runtimeName?: string | null;
  /** 没有 Run 在跑时续接的会话（GET /v1/tickets/:id 的 chatResume）。没有可续接的会话、或者旧 daemon 不给时为 null。 */
  resume?: TicketChatResume | null;
}): TicketChatDestination {
  if (liveRun && liveRun.phase !== 'paused') {
    const noun = AGENT_NOUN[liveRun.purpose] ?? 'agent';
    const takesMessages = runtimeName ? RUNTIME_TAKES_MESSAGES_MID_RUN[runtimeName] ?? false : false;
    return {
      hint: takesMessages
        ? `${noun} 正在跑 · 消息会插进它当前的工作`
        : `${noun} 正在跑 · ${runtimeDisplayName(runtimeName) ?? '这个 runtime'} 不能中途插话，消息排队，结束后转交`,
      placeholder: `问${noun}，或者补充要求`,
      cost: null,
    };
  }
  if (resume) {
    const noun = ROLE_NOUN[resume.role];
    return {
      hint: `发给 #${ticketDisplayId} 的${noun} · 续接 Run #${resume.attemptId} 的会话，不改变工单状态`,
      placeholder: `问${noun}，或者补充要求`,
      cost: resume.lastTokens === null
        ? '预估成本：无法估算'
        : `预估成本：${tokenEstimateText(resume.lastTokens)}（按这个会话上次的用量）`,
    };
  }
  return {
    hint: `发给 #${ticketDisplayId} 的 agent · 开一次对话 Run，不改变工单状态`,
    placeholder: '问这张工单的 agent，或者补充要求',
    cost: null,
  };
}
