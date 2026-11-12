// Same-kind cards of one turn merge into one group (design P9.10, P4.2; user decision 2026-11-12).
// When Lead sets ten reminders in one turn (for example a calendar sync), ten full reminder cards flood the
// conversation. Instead, three or more cards of the same kind become one line that opens an anchored panel.
//   - Kinds: reminders (any reminder operation), and newly created tickets (last operation create_task).
//   - Stay out of a group (shown on their own, in their place): a failed or unfinished operation, a reminder that is
//     due and not yet acknowledged (it needs the user), a dispatch card (each one shows its own progress).
//   - The group takes the place of its first card; the other cards leave the list.
// Pure: the caller passes what it knows about each card. The current state still comes from the same TicketSummary.
import type { ConversationCardEntity } from '../../state/types';

import { REMINDER_OPERATIONS } from './itemOperationWords';

export const TURN_CARD_GROUP_MIN = 3;

export type TurnCardGroupKind = 'reminder' | 'task';
export type ReminderGroupAction = 'created' | 'rescheduled' | 'cancelled' | 'acknowledged' | 'other';

export type TurnCardGroup = {
  key: string;
  kind: TurnCardGroupKind;
  cardIds: string[];
  ticketIds: number[];
  // Reminders only: what the last finished operation on each card did, counted.
  actions: Record<ReminderGroupAction, number>;
};

export type TurnCardSlot = { kind: 'card'; cardId: string } | { kind: 'group'; group: TurnCardGroup };

export type TurnCardFacts = {
  // The item kind when the client already knows it (TicketSummary or TicketDetail). null when not loaded yet.
  itemKind: (ticketId: number) => 'task' | 'reminder' | null;
  // The item's current stage when known.
  stage: (ticketId: number) => string | null;
  // A card that shows as a dispatch card (it has a dispatch window).
  isDispatch: (cardId: string) => boolean;
};

type TicketCard = ConversationCardEntity & { kind: 'ticket_execution' };

function reminderAction(name: string): ReminderGroupAction {
  if (name === 'create_reminder') return 'created';
  if (name === 'reschedule_reminder') return 'rescheduled';
  if (name === 'cancel_item') return 'cancelled';
  if (name === 'ack_reminder') return 'acknowledged';
  return 'other';
}

/** Which group a card may join, or null when it stays on its own. */
export function turnCardGroupKind(card: ConversationCardEntity, cardId: string, facts: TurnCardFacts): TurnCardGroupKind | null {
  if (card.kind !== 'ticket_execution' || facts.isDispatch(cardId)) return null;
  const operations = (card as TicketCard).operations;
  if (!operations.length || operations.some((operation) => operation.state !== 'completed')) return null;
  const kind = facts.itemKind(card.ticketId);
  const reminder = kind === 'reminder' || (kind === null && operations.some((operation) => REMINDER_OPERATIONS.has(operation.name)));
  if (reminder) return facts.stage(card.ticketId) === 'fired' ? null : 'reminder';
  if (operations.at(-1)!.name === 'create_task') return 'task';
  return null;
}

/** Split one turn's cards into single cards and groups (see the file header). */
export function groupTurnCards(
  cardIds: readonly string[],
  cardsById: Readonly<Record<string, ConversationCardEntity | undefined>>,
  facts: TurnCardFacts,
  min: number = TURN_CARD_GROUP_MIN,
): TurnCardSlot[] {
  const members = new Map<TurnCardGroupKind, string[]>();
  for (const cardId of cardIds) {
    const card = cardsById[cardId];
    if (!card) continue;
    const kind = turnCardGroupKind(card, cardId, facts);
    if (!kind) continue;
    members.set(kind, [...(members.get(kind) ?? []), cardId]);
  }
  const grouped = new Map<string, TurnCardGroup>();
  for (const [kind, ids] of members) {
    if (ids.length < min) continue;
    const actions: Record<ReminderGroupAction, number> = { created: 0, rescheduled: 0, cancelled: 0, acknowledged: 0, other: 0 };
    const ticketIds: number[] = [];
    for (const id of ids) {
      const card = cardsById[id] as TicketCard;
      ticketIds.push(card.ticketId);
      if (kind === 'reminder') actions[reminderAction(card.operations.at(-1)!.name)] += 1;
    }
    const group: TurnCardGroup = { key: `group:${kind}:${ids[0]}`, kind, cardIds: ids, ticketIds, actions };
    for (const id of ids) grouped.set(id, group);
  }
  const slots: TurnCardSlot[] = [];
  const placed = new Set<string>();
  // Cards that stay on their own keep their place; each group sits where its first card was.
  for (const cardId of cardIds) {
    const group = grouped.get(cardId);
    if (!group) {
      slots.push({ kind: 'card', cardId });
      continue;
    }
    if (placed.has(group.key)) continue;
    placed.add(group.key);
    slots.push({ kind: 'group', group });
  }
  return slots;
}
