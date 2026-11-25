// @vitest-environment happy-dom
// 同一个外部对话里连续的几条合成一行（工单 #537，视觉稿方案 2b）。
// 分组规则（哪些行算连续、什么打断分组）、叠起来的条数、外面显示的那一条，和这一行的样子：
// 和结束行一样，时间前多一个「+N」徽标；点开在原位置列出每一条，点头收起；最新的卡还在进来时写「回答中」。
import type { ChannelCardDto } from '@pi-lead-child/protocol';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cssVar, renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import type { MessageEntity } from '../../state/types';
import { clockWords } from './channelCard';
import { ChannelStackRow } from './ChannelStackRow';
import { channelStackRole, type ChannelStackItem } from './channelStack';
import { buildLeadTimeline, groupChannelCardRuns, LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

afterEach(cleanup);

// 虚构的数据：机器人 Nova Bot 在 acme 的一个 thread 里跑夜间检查。
const THREAD = 'slack:C0ACME:1700000000.000100';
const NOW = new Date('2026-11-24T06:40:00.000Z');
const at = (minute: number, second = 0) => `2026-11-24T06:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;

function card(id: number, overrides: Partial<ChannelCardDto> = {}): ChannelCardDto {
  return {
    id, version: 2, source: 'slack', sourceLabel: 'Slack', objectKey: THREAD, laneLabel: '#nightly-checks',
    sender: { id: 'B0NOVA', name: 'Nova Bot', trust: 'colleague' }, excerpt: `progress ${id}`, messageCount: 1,
    recent: [{ at: at(id), text: `progress ${id}` }],
    delivery: 'card', state: 'handled', draft: null, gate: null, lookup: null, handling: null,
    sentText: null, snoozedUntil: null, revokeUntil: null, resolvedAt: at(id, 10),
    outcome: { by: 'lead', action: 'handled', note: null },
    actions: [], createdAt: at(id, 1), updatedAt: at(id, 10),
    ...overrides,
  };
}

// 对话还在进来、Lead 还没看的卡：开着、没有草稿、Lead 的决定是 null。
function replying(id: number, overrides: Partial<ChannelCardDto> = {}): ChannelCardDto {
  return card(id, {
    state: 'open', resolvedAt: null, outcome: null, actions: ['dismiss'],
    handling: { lead: { decision: null } } as unknown as ChannelCardDto['handling'],
    ...overrides,
  });
}

const message = (id: string, createdAt: string, role: 'user' | 'assistant' = 'assistant'): MessageEntity => ({
  id, sessionId: 's', turnId: `turn-${id}`, role, state: 'completed', createdAt, updatedAt: createdAt,
} as unknown as MessageEntity);

const stacks = (items: readonly { kind: string }[]) => items.filter((item): item is ChannelStackItem => item.kind === 'channel-stack');

describe('which channel cards can stack', () => {
  it('stacks a closed card without buttons and a card Lead has not looked at, and nothing that waits for you', () => {
    expect(channelStackRole(card(1), NOW)).toBe('done');
    expect(channelStackRole(card(1, { state: 'replied', sentText: 'ok' }), NOW)).toBe('done');
    expect(channelStackRole(replying(1), NOW)).toBe('replying');
    // 等你处理：有草稿、Lead 交给你、自动回复的撤回窗口还开着、摘要投递。
    expect(channelStackRole(replying(1, { draft: { text: '收到', drafter: 'model' } }), NOW)).toBeNull();
    expect(channelStackRole(card(1, { state: 'open', handling: null, actions: ['reply_myself'] }), NOW)).toBeNull();
    expect(channelStackRole(card(1, { state: 'auto_replied', revokeUntil: '2026-11-24T06:45:00.000Z', actions: ['undo_auto_reply'] }), NOW)).toBeNull();
    expect(channelStackRole(card(1, { delivery: 'digest' }), NOW)).toBeNull();
  });
});

describe('grouping consecutive rows of one conversation', () => {
  it('stacks four closed cards of one thread into one row that keeps the first row key', () => {
    const cards = [card(10), card(11), card(12), card(13)];
    const timeline = buildLeadTimeline([message('a', at(5)), message('b', at(30))], [], [], { channelCards: cards, now: NOW });
    expect(timeline.filter((item) => item.kind !== 'date').map((item) => item.key)).toEqual(['message:a', 'channel-stack:channel-card:10', 'message:b']);
    const [stack] = stacks(timeline);
    expect(stack).toMatchObject({ cardIds: [10, 11, 12, 13], at: Date.parse(at(13, 1)) });
    expect(stack!.entries.map((entry) => entry.text)).toEqual(['progress 10', 'progress 11', 'progress 12', 'progress 13']);
  });

  it('breaks the group at anything between, at another conversation, at a card that waits for you and at a new day', () => {
    const other = card(20, { objectKey: 'slack:D0ETHAN:main', sender: { id: 'U0ETHAN', name: 'Ethan', trust: 'colleague' } });
    const waiting = card(22, { state: 'open', draft: { text: '好的', drafter: 'model' }, actions: ['send_draft', 'dismiss'], resolvedAt: null });
    const cards = [card(10), card(11), card(13), card(14), other, card(21), card(23), card(24), waiting, card(25)];
    // 11 和 13 之间是 Fairy 的一条（12 分），14 和 21 之间是 Ethan 的卡，21 和 23 之间是等你处理的卡。
    const fixed = cards.map((value) => (value.id === 20 ? { ...value, createdAt: at(15) } : value.id === 22 ? { ...value, createdAt: at(22, 30) } : value));
    const timeline = buildLeadTimeline([message('fairy', at(12))], [], [], { channelCards: fixed, now: NOW });
    expect(timeline.filter((item) => item.kind !== 'date').map((item) => item.key)).toEqual([
      'channel-stack:channel-card:10',
      'message:fairy',
      'channel-stack:channel-card:13',
      'channel-card:20',
      'channel-card:21',
      'channel-card:22',
      'channel-stack:channel-card:23',
    ]);
    expect(stacks(timeline).map((stack) => stack.cardIds)).toEqual([[10, 11], [13, 14], [23, 24, 25]]);
    // 日期换了一天（按本地时间）：前一天的一行到午夜为止。
    const lateAt = new Date(2026, 10, 23, 23, 58).toISOString();
    const earlyAt = new Date(2026, 10, 24, 0, 2).toISOString();
    const late = card(30, { createdAt: lateAt, recent: [{ at: lateAt, text: 'late' }] });
    const early = card(31, { createdAt: earlyAt, recent: [{ at: earlyAt, text: 'early' }] });
    const days = buildLeadTimeline([], [], [], { channelCards: [late, early] });
    expect(stacks(days)).toHaveLength(0);
  });

  it('leaves a single closed card and a single replying card as they are', () => {
    expect(buildLeadTimeline([], [], [], { channelCards: [card(10)], now: NOW }).filter((item) => item.kind !== 'date').map((item) => item.key)).toEqual(['channel-card:10']);
    expect(buildLeadTimeline([], [], [], { channelCards: [replying(10)], now: NOW }).filter((item) => item.kind !== 'date').map((item) => item.key)).toEqual(['channel-card:10']);
  });

  it('stacks the progress messages of a bot that is still answering, with the open card on top', () => {
    const timeline = buildLeadTimeline([], [], [], { channelCards: [card(10), card(11), replying(12)], now: NOW });
    expect(stacks(timeline).map((stack) => stack.cardIds)).toEqual([[10, 11, 12]]);
  });

  it('takes the "new message" line of a stacked card into the stack, and lists each message once', () => {
    // 卡 10 开出来以后 Fairy 说了一句，机器人又发了两条（「Nova Bot 来了新消息」那一行），然后卡 11 开出来。
    const first = card(10, { messageCount: 3, recent: [{ at: at(10), text: 'Thinking' }, { at: at(14), text: 'lcp.png' }, { at: at(15), text: 'inp.png' }] });
    const timeline = buildLeadTimeline([message('fairy', at(12))], [], [], { channelCards: [first, card(16)], now: NOW });
    expect(timeline.filter((item) => item.kind !== 'date').map((item) => item.key)).toEqual(['channel-card:10', 'message:fairy', 'channel-stack:channel-news:10:' + Date.parse(at(14))]);
    const [stack] = stacks(timeline);
    expect(stack!.cardIds).toEqual([10, 16]);
    expect(stack!.entries.map((entry) => entry.text)).toEqual(['lcp.png', 'inp.png', 'progress 16']);
  });

  it('puts a stack into the same list as the other channel cards around it', () => {
    const other = card(20, { objectKey: 'slack:D0ETHAN:main', sender: { id: 'U0ETHAN', name: 'Ethan', trust: 'colleague' }, createdAt: at(20) });
    const rows = groupChannelCardRuns(buildLeadTimeline([], [], [], { channelCards: [card(10), card(11), other], now: NOW })).filter((row) => row.kind !== 'date');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'channel-cards', cardIds: [10, 11, 20] });
    const slots = rows[0]!.kind === 'channel-cards' ? rows[0]!.slots : [];
    expect(slots.map((slot) => ('kind' in slot ? slot.key : slot.cardId))).toEqual(['channel-stack:channel-card:10', 20]);
  });
});

describe('the stacked row', () => {
  const four = [card(19), card(20), card(21), card(22)];
  const entries = (cards: readonly ChannelCardDto[]) => stacks(buildLeadTimeline([], [], [], { channelCards: cards, now: NOW }))[0]!.entries;

  it('looks like the end row with the newest message, and a +N badge in front of the time', () => {
    renderUI(<ChannelStackRow cards={four} entries={entries(four)} now={NOW} />);
    expect(screen.getByTestId('channel-stack-22-line').textContent).toBe('progress 22');
    expect(screen.getByTestId('channel-stack-22-count').textContent).toBe('+3');
    expect(screen.getByTestId('channel-stack-22-outcome').textContent).toBe(`${clockWords(at(22, 10))} Handled`);
    expect(screen.getByTestId('channel-stack-22-expand').getAttribute('aria-label')).toBe('Show 4 messages from Nova Bot');
    // 徽标在时间前面：一行里的顺序是名字、那一句、徽标、结果。
    const row = screen.getByTestId('channel-stack-22-expand');
    const text = row.textContent ?? '';
    expect(text.indexOf('Nova Bot')).toBeLessThan(text.indexOf('progress 22'));
    expect(text.indexOf('progress 22')).toBeLessThan(text.indexOf('+3'));
    expect(text.indexOf('+3')).toBeLessThan(text.indexOf('Handled'));
  });

  it('opens a panel in place that lists each message, and closes from its header', async () => {
    renderUI(<ChannelStackRow cards={four} entries={entries(four)} now={NOW} />);
    fireEvent.click(screen.getByTestId('channel-stack-22-expand'));
    const list = await screen.findByTestId('channel-stack-22-list');
    for (const id of [19, 20, 21, 22]) expect(within(list).getByText(`progress ${id}`)).toBeTruthy();
    expect(within(list).getByText(clockWords(at(19))!)).toBeTruthy();
    fireEvent.click(screen.getByTestId('channel-stack-22-collapse'));
    await waitFor(() => expect(screen.queryByTestId('channel-stack-22-list')).toBeNull());
    // 收着的那一行一直在原位。
    expect(screen.getByTestId('channel-stack-22-expand')).toBeTruthy();
  });

  it('says Replying while the newest card is still coming in', () => {
    const cards = [card(19), card(20), replying(21)];
    renderUI(<ChannelStackRow cards={cards} entries={entries(cards)} now={NOW} />);
    expect(screen.getByTestId('channel-stack-21-outcome').textContent).toBe('Replying');
    expect(screen.getByTestId('channel-stack-21-count').textContent).toBe('+2');
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('names the sender of each line when more than one person wrote in the thread', async () => {
    const nina = card(23, { sender: { id: 'U0NINA', name: 'Nina', trust: 'colleague' }, recent: [{ at: at(23), text: 'thanks' }] });
    const cards = [card(22), nina];
    renderUI(<ChannelStackRow cards={cards} entries={entries(cards)} now={NOW} />);
    fireEvent.click(screen.getByTestId('channel-stack-23-expand'));
    const list = await screen.findByTestId('channel-stack-23-list');
    expect(list.textContent).toContain('Nova Bot');
    expect(list.textContent).toContain('Nina');
  });

  it('is drawn in the conversation inside the channel card list', () => {
    const runtime = createCompanionStateRuntime({
      client: {} as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    runtime.control.getState().replaceConversation('lead-session', []);
    runtime.control.getState().replaceChannelCards(four);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    const run = screen.getByTestId('channel-card-run');
    expect(within(run).getByTestId('channel-stack-22')).toBeTruthy();
    expect(within(run).queryByTestId('channel-card-19')).toBeNull();
    expect(getComputedStyle(run).gap).toBe(cssVar('--t-space-list-row'));
  });
});
