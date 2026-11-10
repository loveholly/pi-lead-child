import type { KernelCheckpoint, TicketSummary } from '@pi-lead-child/protocol';

import type { Locale } from '@/i18n';

import type { ConversationCardEntity } from '../../state/types';
import { buildCheckpointCardViewModel } from './CheckpointCard';
import { dispatchMessages } from './dispatch.messages';
import type { LeadTimelineItem } from './LeadConversation';

// 一件事，一张卡（2026-10-17，会话方案第五版，用户定的）：
//   · 工单卡只在 Lead 派活时出现，挂在派活那条回复下面；
//   · 这次派活以后 child 发来的消息不再单独出卡片，收进这张卡，点开浮层看；
//   · Lead 只写了批注、读了工单的回合不出卡片（以前 #77 从派发到完成出了 3 次卡片）。

type TicketCard = Extract<ConversationCardEntity, { kind: 'ticket_execution' }>;
type CheckpointCardEntity = Extract<ConversationCardEntity, { kind: 'checkpoint' }>;

// 派活：child 真的开跑了。hand_off 是交接（lead-scheduler spec H4）：建单和派出合成一次调用，卡片一样挂在那条回复下面。
const DISPATCH_OPERATIONS = new Set(['spawn_child', 'recover_ticket_run', 'hand_off']);
// Lead 的记账：写批注、读工单和日志。这些不是要你看的事。
const BOOKKEEPING_OPERATIONS = new Set([
  'add_comment', 'get_ticket', 'get_ticket_tree', 'query_tickets', 'grep', 'get_session_entries',
]);

export function isDispatchCard(card: ConversationCardEntity): card is TicketCard {
  return card.kind === 'ticket_execution'
    && card.operations.some((operation) => DISPATCH_OPERATIONS.has(operation.name) && operation.state !== 'failed');
}

export function isBookkeepingCard(card: ConversationCardEntity): boolean {
  return card.kind === 'ticket_execution'
    && card.operations.length > 0
    && card.operations.every((operation) => BOOKKEEPING_OPERATIONS.has(operation.name));
}

/** 一次派活管到哪里：从派活那一刻，到同一张工单下一次派活为止。收进来的 child 消息记在 checkpointIds。 */
export type DispatchWindow = { from: string; until: string | null; checkpointIds: number[] };

export type DispatchFold = {
  items: LeadTimelineItem[];
  /** 派活卡片的 id → 它管的那一段。不在这里的工单卡照旧画。 */
  windows: Record<string, DispatchWindow>;
};

/**
 * 按时间顺序走一遍会话：去掉记账的工单卡；派活的工单卡开一段；之后同一张工单的 child 消息卡片收进这一段。
 * canFold 说一条 child 消息能不能收进去：还要你处理的（工单仍然阻塞）留在会话里。
 */
export function foldTicketDispatches(
  items: readonly LeadTimelineItem[],
  cardsById: Readonly<Record<string, ConversationCardEntity>>,
  canFold: (card: CheckpointCardEntity) => boolean,
): DispatchFold {
  const windows: Record<string, DispatchWindow> = {};
  const active = new Map<number, string>();
  const open = (card: TicketCard) => {
    const previous = active.get(card.ticketId);
    if (previous && windows[previous]) windows[previous].until = card.createdAt;
    windows[card.id] = { from: card.createdAt, until: null, checkpointIds: [] };
    active.set(card.ticketId, card.id);
  };
  const out: LeadTimelineItem[] = [];
  for (const item of items) {
    if (item.kind === 'message') {
      const cardIds = item.cardIds.filter((id) => {
        const card = cardsById[id];
        return !card || !isBookkeepingCard(card);
      });
      for (const id of cardIds) {
        const card = cardsById[id];
        if (card && isDispatchCard(card)) open(card);
      }
      out.push(cardIds.length === item.cardIds.length ? item : { ...item, cardIds });
      continue;
    }
    if (item.kind === 'card') {
      const card = cardsById[item.cardId];
      if (card && isBookkeepingCard(card)) continue;
      if (card && isDispatchCard(card)) open(card);
      if (card?.kind === 'checkpoint') {
        const owner = active.get(card.ticketId);
        if (owner && windows[owner] && canFold(card)) {
          windows[owner].checkpointIds.push(card.checkpointId);
          continue;
        }
      }
    }
    out.push(item);
  }
  return { items: out, windows };
}

/** 一条 child 消息能不能收进派活卡片：阻塞而且工单现在还阻塞，就是还要你处理，留在会话里。 */
export function canFoldCheckpoint(checkpoint: KernelCheckpoint | undefined, ticket: TicketSummary | undefined): boolean {
  if (!checkpoint || checkpoint.kind !== 'blocked') return true;
  return ticket !== undefined && ticket.stage !== 'blocked';
}

export type DispatchUpdateTone = 'accent' | 'success' | 'warning' | 'danger' | 'neutral';

/** 浮层里的一条关键更新。label 是那一刻的说法（「已提交复核」），不是工单现在的状态。 */
export type DispatchUpdate = {
  id: string;
  at: string;
  label: string;
  tone: DispatchUpdateTone;
  source: string | null;
  title: string;
  body: string | null;
};

// 关键更新：阶段完成、提交复核、阻塞、方向调整、委派。「Run started」这类进展不算。
const KEY_KINDS = new Set<KernelCheckpoint['kind']>(['milestone', 'completed', 'blocked', 'decision', 'delegation']);
// 派活卡片和第一条 child 消息之间可能差几十毫秒的时钟误差。
const CLOCK_SKEW_MS = 5_000;

export function dispatchUpdates({ ticketId, scope, checkpoints, ticket, locale = 'en' }: {
  ticketId: number;
  scope: DispatchWindow;
  checkpoints: readonly KernelCheckpoint[];
  ticket?: TicketSummary;
  // 文案的语言（dispatch.messages.ts、checkpoint.messages.ts）。
  locale?: Locale;
}): DispatchUpdate[] {
  const from = Date.parse(scope.from);
  const until = scope.until ? Date.parse(scope.until) : Number.POSITIVE_INFINITY;
  const inWindow = (value: string) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && Number.isFinite(from) && time >= from - CLOCK_SKEW_MS && time < until;
  };
  const folded = new Set(scope.checkpointIds);
  const seen = new Set<number>();
  const rows: DispatchUpdate[] = [];
  for (const checkpoint of checkpoints) {
    if (checkpoint.ticketId !== ticketId || seen.has(checkpoint.id)) continue;
    if (!folded.has(checkpoint.id) && !(KEY_KINDS.has(checkpoint.kind) && inWindow(checkpoint.createdAt))) continue;
    seen.add(checkpoint.id);
    const model = buildCheckpointCardViewModel(checkpoint, ticket, locale);
    rows.push({
      id: `checkpoint:${checkpoint.id}`,
      at: checkpoint.createdAt,
      label: model.kindLabel,
      tone: model.tone,
      source: checkpointAuthor(checkpoint, locale),
      title: model.title,
      body: checkpoint.kind === 'completed' || checkpoint.kind === 'blocked' ? model.summary.trim() || null : null,
    });
  }
  rows.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const ending = ticket ? stageUpdate(ticket, inWindow, locale) : null;
  if (ending) rows.push(ending);
  return rows;
}

const ENDINGS: Partial<Record<TicketSummary['stage'], { title: 'ticketDone' | 'ticketCancelled'; tone: DispatchUpdateTone }>> = {
  done: { title: 'ticketDone', tone: 'success' },
  cancelled: { title: 'ticketCancelled', tone: 'neutral' },
};

// 这一段里工单走到了头（完成、取消），或者还在 review、核查出了结论：最后一条。时间是进入当前阶段的时间。
// 核查结论只在 review 阶段有（gateway 的 reviewState）：结单以后不知道是谁、怎样验收的，就不说。
function stageUpdate(ticket: TicketSummary, inWindow: (value: string) => boolean, locale: Locale): DispatchUpdate | null {
  const m = dispatchMessages(locale);
  const at = ticket.stageChangedAt;
  if (!at || !inWindow(at)) return null;
  const ending = ENDINGS[ticket.stage];
  if (ending) return { id: 'stage', at, label: m.ended, tone: ending.tone, source: null, title: m[ending.title], body: null };
  const review = ticket.reviewState;
  if (ticket.stage !== 'review' || !review || review.verdict === null) return null;
  const reviewer = review.reviewerAttemptId ? `reviewer #${review.reviewerAttemptId}` : null;
  return review.verdict === 'pass'
    ? { id: 'stage', at, label: m.reviewPassed, tone: 'success', source: reviewer, title: review.label, body: null }
    : { id: 'stage', at, label: m.reviewFailed, tone: 'danger', source: reviewer, title: review.label, body: review.reason };
}

function checkpointAuthor(checkpoint: KernelCheckpoint, locale: Locale): string {
  if (checkpoint.source === 'system_derived' || checkpoint.author.kind === 'system') return dispatchMessages(locale).system;
  const role = checkpoint.author.kind === 'reviewer' ? 'reviewer' : 'child';
  return checkpoint.attemptId === null ? role : `${role} #${checkpoint.attemptId}`;
}
