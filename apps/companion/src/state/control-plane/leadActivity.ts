import {
  leadInterruptOpen, type LeadActivityCard, type LeadActivityView, type LeadInterrupt, type ReminderCard,
  type SetupChecklistCard, type SetupHintCard,
} from '@pi-lead-child/protocol';

import { equalValue } from './normalize';

// 「Lead 动态」的卡片和 interrupt 横幅（工单 06，spec D10、D16）。
//
// 按版本应用：服务端的快照（GET /v1/lead/activity?include=events）和推送（snapshot.required，resource=lead-activity）
// 每一项都带 entityKey 和 entityVersion。版本比手上的旧的一律不用：
//   · 推送和快照乱序到达时（例如启动时那次慢的快照比后来的推送晚到），旧的快照不会盖掉推送带来的新状态；
//   · 版本一样时照样换上（Lead 改口时版本不变、内容变了）。
// 快照里没有、手上有的一项：它的 lastSeq 比快照的 watermark 大，说明是快照算完以后才有的（推送先到了），留着；
// 否则它已经不在了（确认了、别处处理了、太旧了），去掉。
// 这一层不把原始事件归约成业务状态：卡片的内容由服务端算好，这里只按版本挑新的（spec D16）。

export interface LeadActivityState {
  cards: Readonly<Record<string, LeadActivityCard>>;
  interrupts: Readonly<Record<string, LeadInterrupt>>;
  // 会话里的提醒卡（工单 07）：一次到点一张，从到点到确认原地更新。同样按版本应用。
  reminders: Readonly<Record<string, ReminderCard>>;
  // 首次启动引导（.scratch/onboarding）：准备清单卡和建议卡。状态都在 daemon 的 kv 里，没有事件 seq：
  // 快照里有的按版本换上，快照里没有的去掉（建议卡最多留 20 张，旧的会被挤掉）。
  setup?: SetupChecklistCard | null;
  setupHints?: Readonly<Record<string, SetupHintCard>>;
}

export const EMPTY_LEAD_ACTIVITY: LeadActivityState = { cards: {}, interrupts: {}, reminders: {}, setup: null, setupHints: {} };

type Versioned = { key: string; entityVersion: number; lastSeq: number };

/** incoming 能不能替换手上的 stored：版本不比它旧。 */
export function acceptsVersion(stored: Pick<Versioned, 'entityVersion'> | undefined, incoming: Pick<Versioned, 'entityVersion'>): boolean {
  return stored === undefined || incoming.entityVersion >= stored.entityVersion;
}

function mergeSnapshot<T extends Versioned>(
  current: Readonly<Record<string, T>>,
  incoming: readonly T[],
  watermark: number,
): Readonly<Record<string, T>> {
  const next: Record<string, T> = {};
  for (const item of incoming) {
    const stored = current[item.key];
    if (!acceptsVersion(stored, item)) next[item.key] = stored!;
    else next[item.key] = stored !== undefined && equalValue(stored, item) ? stored : item;
  }
  for (const [key, stored] of Object.entries(current)) {
    if (!(key in next) && stored.lastSeq > watermark) next[key] = stored;
  }
  const keys = Object.keys(next);
  const unchanged = keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key]);
  return unchanged ? current : next;
}

export function applyLeadActivitySnapshot(state: LeadActivityState, view: LeadActivityView): LeadActivityState {
  const cards = mergeSnapshot(state.cards, view.cards, view.watermark);
  const interrupts = mergeSnapshot(state.interrupts, view.interrupts, view.watermark);
  // 旧 daemon 的快照没有 reminders：当成空的（推送来的、比快照新的留着）。
  const reminders = mergeSnapshot(state.reminders ?? {}, view.reminders ?? [], view.watermark);
  // 旧 daemon 或者没要 include=setup 时快照里没有这两项：手上的不动。
  const setup = view.setup === undefined ? state.setup ?? null : newerSetup(state.setup ?? null, view.setup);
  const setupHints = view.setupHints === undefined ? state.setupHints ?? {} : mergeSetupHints(state.setupHints ?? {}, view.setupHints);
  return cards === state.cards && interrupts === state.interrupts && reminders === state.reminders
    && setup === state.setup && setupHints === state.setupHints
    ? state : { cards, interrupts, reminders, setup, setupHints };
}

function newerSetup(stored: SetupChecklistCard | null, incoming: SetupChecklistCard | null): SetupChecklistCard | null {
  if (incoming === null) return null;
  if (stored && (!acceptsVersion(stored, incoming) || equalValue(stored, incoming))) return stored;
  return incoming;
}

function mergeSetupHints(current: Readonly<Record<string, SetupHintCard>>, incoming: readonly SetupHintCard[]): Readonly<Record<string, SetupHintCard>> {
  const next: Record<string, SetupHintCard> = {};
  for (const hint of incoming) {
    const stored = current[hint.key];
    next[hint.key] = stored && (!acceptsVersion(stored, hint) || equalValue(stored, hint)) ? stored : hint;
  }
  const keys = Object.keys(next);
  const unchanged = keys.length === Object.keys(current).length && keys.every((key) => current[key] === next[key]);
  return unchanged ? current : next;
}

/** 一条推送（或者确认以后路由回的那一条）。比手上旧的忽略。 */
export function applyLeadActivityPush(
  state: LeadActivityState,
  push: { card?: LeadActivityCard; interrupt?: LeadInterrupt; reminder?: ReminderCard; setup?: SetupChecklistCard; setupHint?: SetupHintCard },
): LeadActivityState {
  let next = state;
  if (push.setup) {
    const setup = newerSetup(state.setup ?? null, push.setup);
    if (setup !== (state.setup ?? null)) next = { ...next, setup };
  }
  if (push.setupHint) {
    const hints = state.setupHints ?? {};
    const stored = hints[push.setupHint.key];
    if (acceptsVersion(stored, push.setupHint) && !(stored && equalValue(stored, push.setupHint))) {
      next = { ...next, setupHints: { ...hints, [push.setupHint.key]: push.setupHint } };
    }
  }
  if (push.reminder) {
    const reminders = state.reminders ?? {};
    const stored = reminders[push.reminder.key];
    if (acceptsVersion(stored, push.reminder) && !(stored && equalValue(stored, push.reminder))) {
      next = { ...next, reminders: { ...reminders, [push.reminder.key]: push.reminder } };
    }
  }
  if (push.card) {
    const stored = state.cards[push.card.key];
    if (acceptsVersion(stored, push.card) && !(stored && equalValue(stored, push.card))) {
      next = { ...next, cards: { ...next.cards, [push.card.key]: push.card } };
    }
  }
  if (push.interrupt) {
    const stored = state.interrupts[push.interrupt.key];
    if (acceptsVersion(stored, push.interrupt) && !(stored && equalValue(stored, push.interrupt))) {
      next = { ...next, interrupts: { ...next.interrupts, [push.interrupt.key]: push.interrupt } };
    }
  }
  return next;
}

/** 会话里的卡片，按位置（第一条事件的时间）从旧到新。 */
export function leadActivityCards(state: LeadActivityState): LeadActivityCard[] {
  return Object.values(state.cards)
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.key.localeCompare(right.key));
}

/** 横幅上的事：还没确认、也不是别处已处理的 interrupt，旧的在前。 */
export function openLeadInterrupts(state: LeadActivityState): LeadInterrupt[] {
  return Object.values(state.interrupts).filter(leadInterruptOpen).sort((left, right) => left.seq - right.seq);
}

/** 会话里的提醒卡，按位置（到点的时间）从旧到新。 */
export function reminderCards(state: LeadActivityState): ReminderCard[] {
  return Object.values(state.reminders ?? {})
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.seq - right.seq);
}

/** Lead 为提醒单独回的那些轮次（它们说的话挂在提醒卡下面，不另起气泡）：轮次 id → 提醒卡的 key。 */
export function reminderTurnCards(state: LeadActivityState): ReadonlyMap<string, string> {
  const byTurn = new Map<string, string>();
  for (const card of Object.values(state.reminders ?? {})) if (card.leadTurnId) byTurn.set(card.leadTurnId, card.key);
  return byTurn;
}

/** 准备清单卡（首次上线时建的那一张）。没有时为 null。 */
export function setupChecklistCard(state: LeadActivityState): SetupChecklistCard | null {
  return state.setup ?? null;
}

/** 建议卡，按位置（那一轮结束的时间）从旧到新。 */
export function setupHintCards(state: LeadActivityState): SetupHintCard[] {
  return Object.values(state.setupHints ?? {})
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.hintId - right.hintId);
}
