// 同一个外部对话里连续的几条合成一行（工单 #537，视觉稿方案 2b）。
//
// 一个机器人在 thread 里跑长任务时，每条进度消息都开过一张卡、又很快被 Lead 关掉（#530 修之前），会话里就是一长串
// 一模一样的「Nova Bot … Handled」。这里把它们合成一行：外面只显示最新的一条，前面一个「+N」徽标；点开在原位置列出每一条。
//
// 分组规则（纯函数，决策边界）：
//   - 同一个对话：卡的 objectKey 相同（Slack 是同一个频道里的同一个 thread，私信是同一个私信）。
//   - 能叠的卡：已经结束、也没有按钮的卡（结束行，channelCardView 的 folded），和对话还在进来、Lead 还没看的卡
//     （state 是 open、Lead 的决定还是 null、没有草稿：「回答中」）。等你处理的卡（有草稿、有按钮、Lead 交给你的）不叠，
//     照旧单独一张卡，并且打断分组。
//   - 「来了新消息」那一行（channel-news）跟着它的卡：卡能叠时它也叠进去。
//   - 连续：会话里中间没有别的东西。Lead 或你的一条消息、另一个对话的卡、Lead 动态、到点提醒、引导卡、话题行，
//     还有日期换了一天，都打断分组。
//   - 至少两行才叠；只有一行时照旧画那一行。
// 叠起来的条数按消息算：每一行画的是它那几条消息（卡那一行是卡的消息，「来了新消息」那一行是它合进去的几条），按行的顺序列出。
// 卡只带最近的几条（recent，最多 5 条），更早的不在里面；没有 recent 的卡算一条（摘录）。「+N」的 N 是条数减一。

import type { ChannelCardDto } from '@pi-lead-child/protocol';

import { channelCardView } from './channelCard';

/** 一张卡在叠起来的一行里是什么：done 是结束行，replying 是对话还在进来、Lead 还没看。null：不能叠。 */
export type ChannelStackRole = 'done' | 'replying';

export function channelStackRole(card: ChannelCardDto, now: Date): ChannelStackRole | null {
  if (card.delivery === 'digest') return null;
  if (channelCardView(card, now).folded) return 'done';
  if (card.state === 'open' && !card.draft && card.handling?.lead?.decision === null) return 'replying';
  return null;
}

type ChannelRowItem = { kind: 'channel-card' | 'channel-news'; key: string; cardId: number; at: number; count?: number };

/** 叠起来的一条：哪张卡、什么时候、谁、说了什么（原文，画的时候再按来源转成一行字）。 */
export type ChannelStackEntry = { key: string; cardId: number; at: string; sender: string; text: string };

/** 叠起来的一行。cardIds 从早到晚，最后一张是外面显示的那张；entries 是浮层里列的每一条，从早到晚。 */
export type ChannelStackItem = { kind: 'channel-stack'; key: string; cardIds: number[]; entries: ChannelStackEntry[]; at: number };

function isChannelRow(item: { kind: string }): item is ChannelRowItem {
  return item.kind === 'channel-card' || item.kind === 'channel-news';
}

function dayOf(at: number): string {
  return new Date(at).toDateString();
}

type Message = { at: string; text: string; time: number };

function messagesOf(card: ChannelCardDto): Message[] {
  const recent = card.recent?.length ? card.recent : [{ at: card.updatedAt, text: card.excerpt }];
  return recent.map((message) => ({ ...message, time: Date.parse(message.at) }));
}

/**
 * 每一行画的是卡的哪几条消息。「来了新消息」那一行是它之前的 count 条（placeChannelNews 合进去的）；剩下的属于卡那一行。
 * 卡只带最近几条（recent），更早的不在里面。
 */
function ownership(items: readonly { kind: string; key: string }[], byId: ReadonlyMap<number, ChannelCardDto>): Map<string, Message[]> {
  const rowsByCard = new Map<number, ChannelRowItem[]>();
  for (const item of items) {
    if (!isChannelRow(item)) continue;
    rowsByCard.set(item.cardId, [...(rowsByCard.get(item.cardId) ?? []), item]);
  }
  const owned = new Map<string, Message[]>();
  for (const [cardId, rows] of rowsByCard) {
    const card = byId.get(cardId);
    if (!card) continue;
    const left = messagesOf(card);
    const news = rows.filter((row) => row.kind === 'channel-news').sort((a, b) => a.at - b.at);
    for (const row of news) {
      const candidates = left.filter((message) => !(message.time > row.at));
      const taken = candidates.slice(-Math.max(1, row.count ?? 1));
      owned.set(row.key, taken);
      for (const message of taken) left.splice(left.indexOf(message), 1);
    }
    for (const row of rows) if (row.kind === 'channel-card') owned.set(row.key, left);
  }
  return owned;
}

/**
 * 把会话流里同一个对话的连续几行合成一个 channel-stack（规则见文件开头）。别的项原样留着，位置不变。
 * 叠起来的一行用它第一行的 key：对话又来一条时这一行原地更新，不在列表里挪动。
 */
export function stackChannelConversations<T extends { kind: string; key: string }>(
  items: readonly T[],
  cards: readonly ChannelCardDto[],
  now: Date,
): (T | ChannelStackItem)[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const roles = new Map<number, ChannelStackRole | null>();
  const roleOf = (cardId: number) => {
    if (!roles.has(cardId)) {
      const card = byId.get(cardId);
      roles.set(cardId, card ? channelStackRole(card, now) : null);
    }
    return roles.get(cardId) ?? null;
  };
  let owned: Map<string, Message[]> | null = null;
  const result: (T | ChannelStackItem)[] = [];
  let run: { objectKey: string; day: string; items: (T & ChannelRowItem)[] } | null = null;
  const flush = () => {
    if (!run) return;
    if (run.items.length < 2) {
      result.push(...run.items);
    } else {
      owned ??= ownership(items, byId);
      const entries: ChannelStackEntry[] = [];
      for (const item of run.items) {
        const card = byId.get(item.cardId)!;
        for (const message of owned.get(item.key) ?? []) {
          entries.push({ key: `${item.key}|${message.at}|${entries.length}`, cardId: card.id, at: message.at, sender: card.sender.name, text: message.text });
        }
      }
      result.push({
        kind: 'channel-stack',
        key: `channel-stack:${run.items[0]!.key}`,
        cardIds: [...new Set(run.items.map((item) => item.cardId))],
        entries,
        at: run.items.at(-1)!.at,
      });
    }
    run = null;
  };
  for (const item of items) {
    const card = isChannelRow(item) ? byId.get(item.cardId) : undefined;
    if (!card || !isChannelRow(item) || roleOf(card.id) === null) {
      flush();
      result.push(item);
      continue;
    }
    const day = dayOf(item.at);
    if (!run || run.objectKey !== card.objectKey || run.day !== day) {
      flush();
      run = { objectKey: card.objectKey, day, items: [] };
    }
    run.items.push(item as T & ChannelRowItem);
  }
  flush();
  return result;
}
