// 工单操作的名字（2026-11-15）：daemon 的操作清单只给中文名，界面按你选的语言写，按操作的 id 查。
// 这里没有的 id（daemon 新加的操作）照用 daemon 给的名字。
import type { TicketActionId } from '@pi-lead-child/protocol';

import { defineMessages, type Locale } from '@/i18n';

// 每个操作都要有两种语言的名字：daemon 加了操作而这里没加时，类型检查报错。
type Labels = Record<TicketActionId, string>;

export const ticketActionLabelMessages = defineMessages<{ labels: Labels }>({
  en: {
    labels: {
      confirm: 'Confirm and start',
      start: 'Start',
      stop: 'Stop ticket',
      unconfirm: 'Withdraw confirmation',
      restore: 'Restore',
      cancel: 'Cancel ticket',
      set_priority: 'Change priority',
      set_project: 'Change project',
      set_due: 'Set due date',
      set_budget: 'Set budget',
      link: 'Link ticket',
      unlink: 'Unlink',
      pause_run: 'Pause',
      resume_run: 'Resume',
      stop_run: 'Stop',
      request_review: 'Request review',
      change_reviewer: 'Change reviewer',
      widen_grant: "Widen the sub-agent's permissions",
      complete: 'Accept',
      // 底部操作条上和「Accept」并排，要短。
      rework: 'Rework',
      merge: 'Merge into the original branch',
      set_auto_pr: 'Open draft PRs automatically',
      open_pr: 'Open draft PR',
      link_pr: 'Link an existing PR',
      abandon: 'Discard changes',
      open_delivery_file: 'Open file',
      delegate: 'Delegate',
      retry_review: 'Retry review',
      set_run_profile: 'Change model and effort',
      change_executor_runtime: 'Change executor agent',
      accept_without_review: 'Accept without review',
      edit_acceptance_criteria: 'Edit acceptance criteria',
      confirm_criterion: 'Confirm a criterion',
      unconfirm_criterion: 'Unconfirm',
    },
  },
  zh: {
    labels: {
      confirm: '确认开跑',
      start: '开始执行',
      stop: '停下工单',
      unconfirm: '撤回确认',
      restore: '恢复',
      cancel: '取消工单',
      set_priority: '改优先级',
      set_project: '改项目',
      set_due: '设置截止',
      set_budget: '设置预算',
      link: '关联工单',
      unlink: '解除关联',
      pause_run: '暂停',
      resume_run: '继续',
      stop_run: '停下',
      request_review: '派发核查',
      change_reviewer: '换核查员',
      widen_grant: '放宽子 agent 的权限',
      complete: '验收',
      rework: '打回返工',
      merge: '合并到原分支',
      set_auto_pr: '自动开草稿 PR',
      open_pr: '开草稿 PR',
      link_pr: '登记已有的 PR',
      abandon: '放弃改动',
      open_delivery_file: '打开文件',
      delegate: '授权托管',
      retry_review: '重试核查',
      set_run_profile: '换模型和强度',
      change_executor_runtime: '换执行 agent',
      accept_without_review: '不等核查，直接验收',
      edit_acceptance_criteria: '编辑验收标准',
      confirm_criterion: '确认一条验收标准',
      unconfirm_criterion: '取消确认',
    },
  },
});

/** 按界面语言换掉操作的名字；不认识的 id 保留 daemon 给的名字。 */
export function localizeTicketActions<T extends { id: string; label: string }>(actions: readonly T[], locale: Locale): T[] {
  const labels = ticketActionLabelMessages(locale).labels as Record<string, string | undefined>;
  return actions.map((action) => {
    const label = labels[action.id];
    return label && label !== action.label ? { ...action, label } : action;
  });
}
