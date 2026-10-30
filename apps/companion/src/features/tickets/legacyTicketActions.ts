// 还不在操作清单（GET /v1/tickets/:id/actions）里的 4 个操作：恢复已取消的工单、ready 的开始执行、撤回确认、释放工作区。
//
// 临时做法（协调会话 2026-10-22 定的）：这 4 个先走旧接口，能不能做也先用旧的判断。旧的判断只在这个文件里用，
// 页面别处只读这里的结果。
// P03/P04（`.scratch/ui-action-parity/plan.md`）把它们登记进操作层以后，页面改读清单，删掉这个文件：
//   - 撤回确认、恢复是 user_only，开始执行是 lead_allowed，释放工作区按共享和隔离分档；
//   - 恢复要先把 item-restore.ts 从 gateway 搬到 engine。
// ticketDetailSkeleton.test.tsx 的「legacy actions」那几条测试钉住了这里的行为，换成读清单时会提醒改。
import type { Ticket } from '@/features/workspace/model';

import { ticketDecisionActions } from './ticketDecision';

export type LegacyTicketActionId = 'restore' | 'start' | 'unconfirm' | 'release';

export type LegacyTicketAction = {
  id: LegacyTicketActionId;
  label: string;
  /** 点之前写在这一项下面的一句话：做了以后会怎样。 */
  note: string | null;
};

const LEGACY_IDS: readonly LegacyTicketActionId[] = ['start', 'unconfirm', 'restore', 'release'];

const NOTES: Record<LegacyTicketActionId, string | null> = {
  start: null,
  unconfirm: '回到草稿，等你再确认开跑。',
  restore: '恢复以后回到草稿，不会自动开跑。',
  release: '把隔离工作区还回去，改动留在分支上。',
};

function isLegacyId(id: string): id is LegacyTicketActionId {
  return (LEGACY_IDS as readonly string[]).includes(id);
}

/**
 * 旧的判断说现在能做的那几个（ticketDecisionActions：protocol 的 userItemActionsFor 和工作区的 availableActions，
 * 加上受阻、恢复中不给开始这些过滤）。草稿下面还有已取消的子工单时，恢复叫「继续恢复」。
 */
export function legacyTicketActions(ticket: Ticket, context: { cancelledChildCount?: number } = {}): LegacyTicketAction[] {
  return ticketDecisionActions(ticket, context).flatMap((action) => isLegacyId(action.id)
    ? [{ id: action.id, label: action.label, note: NOTES[action.id] }]
    : []);
}
