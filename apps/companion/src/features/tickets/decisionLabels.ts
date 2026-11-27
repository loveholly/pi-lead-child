// 生命周期里一条决策活动的标题。服务端写的是机器 id（rework_grant_attributed、runtime_failure_classified…），
// 界面上只给人看的话。#66 的生命周期里 56 行有 13 行直接显示了原始 id。
// 没收录的 id 不原样当标题：标题写「系统记录」，id 留在说明里，方便排查。
// 称呼 Lead 的标题写 Lead 的名字（leadName，useLeadName 取到的）。
import type { Locale } from '@pi-lead-child/protocol';

import { START_RUN_DECISION, STOP_RUN_DECISION } from './activityKeys';
import { decisionLabelMessages } from './decisionLabels.messages';

// 文字在 decisionLabels.messages.ts：titles 是固定的标题，leadTitles 是称呼 Lead 的标题，verdictTitles 按核查结论分开写。
function knownTitle(decision: string, leadName: string, locale: Locale): string | undefined {
  const m = decisionLabelMessages(locale);
  const byLead = (m.leadTitles as Record<string, ((name: string) => string) | undefined>)[decision];
  return byLead ? byLead(leadName) : (m.titles as Record<string, string | undefined>)[decision];
}

// 按凭什么做的分开写（payload.authority）。托管下 Lead 凭证据验收（工单 11，D11），要写明没有独立核查。
function authorityTitle(decision: string, authority: unknown, leadName: string, locale: Locale): string | undefined {
  if (decision === 'accepted_without_review' && authority === 'delegated') return decisionLabelMessages(locale).acceptedWithoutReviewDelegated(leadName);
  return undefined;
}

export type DecisionLabel = {
  title: string;
  /** 没收录的机器 id。界面放在说明里，不当标题。 */
  unknownId: string | null;
};

export function decisionLabel(
  decision: string | null,
  leadName: string,
  payload: Record<string, unknown> = {},
  locale: Locale = 'en',
): DecisionLabel {
  const m = decisionLabelMessages(locale);
  if (decision === null) {
    // 决策类 checkpoint 写的活动没有 decision，只有标题和摘要。
    const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : m.recordedDecision;
    return { title, unknownId: null };
  }
  const verdict = typeof payload.verdict === 'string' ? payload.verdict : null;
  const byVerdict = verdict
    ? (m.verdictTitles as Record<string, Record<string, string> | undefined>)[decision]?.[verdict]
    : undefined;
  if (byVerdict) return { title: byVerdict, unknownId: null };
  const byAuthority = authorityTitle(decision, payload.authority, leadName, locale);
  if (byAuthority) return { title: byAuthority, unknownId: null };
  // link_pr 登记的 PR 也写 workspace_pr_opened（带 linked 标记）：不是系统开的，也不一定是草稿。
  if (decision === 'workspace_pr_opened' && payload.linked === true) return { title: m.linkedPullRequest, unknownId: null };
  const known = knownTitle(decision, leadName, locale);
  if (known) return { title: known, unknownId: null };
  // 用户动作直接用中文记（「开始执行」「停止执行」），不是机器 id。认得的按当前语言写，别的原样显示。
  if (decision === START_RUN_DECISION) return { title: m.startRun, unknownId: null };
  if (decision === STOP_RUN_DECISION) return { title: m.stopRun, unknownId: null };
  if (!/^[a-z0-9_]+$/.test(decision)) return { title: decision, unknownId: null };
  return { title: m.systemRecord, unknownId: decision };
}
