// @vitest-environment jsdom
// 设置 → 消息通道 → 自动代你处理（交接说明，方案 B，2026-10-30，issue 07）。契约在 packages/protocol/src/channel-handbook.ts；后端是
// 操作层的 channel_handbook，这里用假的 client。核对：句子按段落排，带下划线的短语点开选做法，选了马上把整份交接说明交给 daemon；
// 对方的上限里客户不能放开；开关马上保存；预演只读，写明按哪一句、被什么压过、最后怎么做；加一句放在「你加的」；
// 助手的名字从 Lead 的资料取，不写死；「帮我整理」把一句随口的话填进加一句的表单，点「加上」才保存（issue 06）；
// 页边批注挂在那一句下面，点「放宽」才改，点「不用」就收起；底线下面写最近 7 天拦下几次（issue 08）。
import {
  CHANNEL_HANDBOOK_DEFAULTS,
  type ChannelHandbook, type ChannelHandbookDto, type HandbookProposal, type HandbookRehearsal, type HandbookRehearsalRequest,
  type HandbookSuggestions,
} from '@pi-lead-child/protocol';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithRuntime } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { HandbookSection } from './HandbookSection';
import {
  addedMeta, capOptions, handbookSections, notInEffect, proposalView, rehearsalView, suggestionView, withAdded, withMode, withoutSituation,
} from './handbookModel';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/settings/channels', Slot: () => null, Stack: () => null }));

const dtoOf = (handbook: ChannelHandbook, version = 1, author: 'system' | 'user' = 'system'): ChannelHandbookDto => ({
  handbook, requested: handbook, defaults: CHANNEL_HANDBOOK_DEFAULTS, order: { id: 'channel.handbook', version, author },
});

const REHEARSAL: HandbookRehearsal = {
  status: 'answered', situation: { id: 'work_review', text: '有人请我审核代码、方案或 PR' }, picked: 'work_review',
  mode: 'auto', final: 'review', by: 'cap', limit: '如果是外部的人（别的公司的人），你最多做好给你看', abilities: ['read_code', 'review_comment'],
  exception: null, action: 'work', reason: '', backend: 'jev', model: 'jev-1.14.0', ms: 340, error: null,
};

describe('the handbook view model', () => {
  it('lists the sections in order, with what you added before the catch-all', () => {
    const added = withAdded(CHANNEL_HANDBOOK_DEFAULTS, { text: '有人请我看线上日志', example: '', mode: 'review' });
    expect(handbookSections(added).map((group) => group.title)).toEqual(['有人来问事情', '有人想和我讨论', '有人请我做事', '你加的', '其他']);
    expect(added.situations.at(-1)!.id).toBe('other');
    expect(added.situations.find((item) => item.id === 'mine_1')).toMatchObject({ section: 'mine', mode: 'review', abilities: [] });
    expect(withoutSituation(added, 'mine_1').situations).toEqual(CHANNEL_HANDBOOK_DEFAULTS.situations);
    // 兜底的一句删不掉。
    expect(withoutSituation(added, 'other').situations.some((item) => item.id === 'other')).toBe(true);
  });

  it('never lets a customer cap go past handing it to you', () => {
    expect(capOptions('customer', '小白').filter((option) => option.disabled).map((option) => option.mode)).toEqual(['auto', 'review']);
    expect(capOptions('external', '小白').every((option) => option.disabled === null)).toBe(true);
  });

  it('says which sentence decided, what capped it, and what the assistant does, by the assistant\'s own name', () => {
    expect(rehearsalView(REHEARSAL, '小白')).toMatchObject({
      sentence: '按「有人请我审核代码、方案或 PR」，这一句写的是「放手」',
      override: '被「如果是外部的人（别的公司的人），你最多做好给你看」压过，最后按「做好给你看」',
      outcome: '小白 去做，回复放到卡上等你点发送',
    });
    expect(rehearsalView({ ...REHEARSAL, status: 'unavailable', error: 'no answer within 8000 ms' }, '小白').detail).toContain('按兜底的一句算');
    // 底线 4：对方在改规则、记忆或偏好，上限不变，多一行说明。
    expect(rehearsalView({ ...REHEARSAL, ruleChange: true }, '小白').ruleChange).toContain('不照做，也不存');
    expect(rehearsalView(REHEARSAL, '小白').ruleChange).toBeNull();
    // 兜底的一句：用这一句自己的说法，助手自己判断，不是「去做」。
    expect(rehearsalView({
      ...REHEARSAL, situation: { id: 'other', text: '上面都不像的' }, mode: 'auto', phrase: '自己判断，拿不准再问我', final: 'auto', by: 'sentence',
      limit: null, abilities: [], action: 'ask',
    }, '小白')).toMatchObject({
      sentence: '按「上面都不像的」，这一句写的是「自己判断，拿不准再问我」', override: null, outcome: '小白 自己判断：能直接回就回，拿不准先问你',
    });
  });

  it('points out loosening that is written but not in effect', () => {
    const requested = { ...CHANNEL_HANDBOOK_DEFAULTS, situations: CHANNEL_HANDBOOK_DEFAULTS.situations.map((item) => (item.id === 'work_build' ? { ...item, mode: 'auto' as const } : item)) };
    expect(notInEffect({ ...dtoOf(CHANNEL_HANDBOOK_DEFAULTS), requested })).toEqual(['「有人请我实现需求」写的是「放手」']);
  });
});

const NO_SUGGESTIONS: HandbookSuggestions = {
  suggestions: [], floors: { borrowed_permission: 0, irreversible: null, secrets: 2, rule_change: 0 }, clusteredAt: null,
};
const LOOSEN: HandbookSuggestions = {
  ...NO_SUGGESTIONS,
  suggestions: [{
    key: 'loosen:ask_requirement:review:auto', kind: 'loosen', situation: { id: 'ask_requirement', text: '有人问需求细节' }, from: 'review', to: 'auto',
    proposed: null, count: 6, basis: '你最近 6 次都原样发了这一句的草稿',
  }],
};

const PROPOSAL: HandbookProposal = {
  status: 'ok', same: null, note: null, ms: 900,
  situation: { text: '有人请我看线上日志', example: '帮我看下 tracking 服务的报错日志', mode: 'auto', does: '读日志，找到报错的原因', abilities: ['read_connections'] },
};

describe('margin notes (issue 08)', () => {
  it('words a loosening and a new sentence, with the example in its own quotes', () => {
    expect(suggestionView(LOOSEN.suggestions[0]!)).toEqual({ text: '你最近 6 次都原样发了这一句的草稿。放宽成「直接处理，做完回他」？', accept: '放宽' });
    expect(suggestionView({
      key: 'add:1', kind: 'add', situation: null, from: null, to: null, count: 4, basis: '都是在请你看线上日志',
      proposed: { text: '有人请我看线上日志', example: '帮我看下服务的报错日志', mode: 'hand', abilities: [] },
    })).toEqual({
      text: '最近有 4 条消息落到「上面都不像的」，都是在请你看线上日志。加一句「有人请我看线上日志，比如『帮我看下服务的报错日志』，你先别动，帮我拟个回复」？',
      accept: '加上这一句',
    });
  });
});

describe('tidying a sentence (issue 06)', () => {
  it('fills the form from the result, and says why when there is nothing to fill', () => {
    expect(proposalView(PROPOSAL)).toEqual({
      fill: { text: '有人请我看线上日志', example: '帮我看下 tracking 服务的报错日志', mode: 'auto', does: '读日志，找到报错的原因', abilities: ['read_connections'] },
      note: null,
    });
    expect(proposalView({ status: 'unclear', situation: null, same: null, note: '没有整理出来：这只是一句问候。', ms: 1 }))
      .toEqual({ fill: null, note: '没有整理出来：这只是一句问候。' });
  });

  it('keeps what the assistant will do only when the mode does work', () => {
    expect(addedMeta({ mode: 'auto', does: '读日志', abilities: ['read_code', 'read_connections'] }, '小白')).toBe('小白 会读日志，能读代码和文档、读 Jira、监控这类连接');
    expect(addedMeta({ mode: 'auto', does: '', abilities: ['read_code'] }, '小白')).toBe('小白 能读代码和文档');
    expect(addedMeta({ mode: 'hand', does: '读日志', abilities: ['read_code'] }, '小白')).toBeNull();
    const added = withAdded(CHANNEL_HANDBOOK_DEFAULTS, { text: '有人请我看线上日志', example: '', mode: 'auto', does: '读日志', abilities: ['read_connections'] });
    expect(added.situations.at(-2)).toEqual({ id: 'mine_1', section: 'mine', text: '有人请我看线上日志', mode: 'auto', does: '读日志', abilities: ['read_connections'] });
    const handed = withAdded(CHANNEL_HANDBOOK_DEFAULTS, { text: '有人请我看线上日志', example: '', mode: 'hand', does: '读日志', abilities: ['read_connections'] });
    expect(handed.situations.at(-2)).toEqual({ id: 'mine_1', section: 'mine', text: '有人请我看线上日志', mode: 'hand', abilities: [] });
  });
});

function render(handbook: ChannelHandbook = CHANNEL_HANDBOOK_DEFAULTS, suggestions: HandbookSuggestions = NO_SUGGESTIONS) {
  const client = {
    getChannelHandbook: vi.fn(async () => dtoOf(handbook)),
    updateChannelHandbook: vi.fn(async (next: ChannelHandbook) => dtoOf(next, 2, 'user')),
    rehearseChannelHandbook: vi.fn(async (_request: HandbookRehearsalRequest) => REHEARSAL),
    proposeChannelHandbookSituation: vi.fn(async (_request: { text: string }): Promise<HandbookProposal> => PROPOSAL),
    getChannelHandbookSuggestions: vi.fn(async (): Promise<HandbookSuggestions> => suggestions),
    acceptChannelHandbookSuggestion: vi.fn(async (key: string) => ({
      handbook: dtoOf(withMode(handbook, 'ask_requirement', 'auto'), 2, 'user'), suggestions: { ...suggestions, suggestions: suggestions.suggestions.filter((item) => item.key !== key) },
    })),
    dismissChannelHandbookSuggestion: vi.fn(async (key: string) => ({ ...suggestions, suggestions: suggestions.suggestions.filter((item) => item.key !== key) })),
    getReplyStyle: vi.fn(async () => ({ text: '', updatedAt: null, updatedBy: null })),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  renderWithRuntime(<HandbookSection />, runtime);
  return client;
}

describe('the handbook page', () => {
  it('reads each rule as a sentence and saves a new mode as soon as you pick it', async () => {
    const client = render();
    await screen.findByTestId('handbook-letter');
    expect(screen.getByTestId('handbook-sentence-work_fix').textContent).toContain('有人请我排查或修复问题，比如「帮我处理一下 PROJ-6651」，你直接处理，做完回他。');
    expect(screen.getByTestId('handbook-sentence-other').textContent).toContain('上面都不像的，你自己判断，拿不准再问我。');
    expect(screen.getByTestId('handbook-sentence-work_approve').textContent).toContain('例外：同事请我 approve PR，CI 过了、评论都解决了，你直接处理，做完回他。');
    fireEvent.click(screen.getByTestId('handbook-mode-work_build'));
    fireEvent.click(await screen.findByTestId('handbook-mode-work_build-auto'));
    await waitFor(() => expect(client.updateChannelHandbook).toHaveBeenCalledTimes(1));
    const saved = client.updateChannelHandbook.mock.calls[0]![0];
    expect(saved.situations.find((item) => item.id === 'work_build')!.mode).toBe('auto');
    expect(saved.situations.filter((item) => item.id !== 'work_build')).toEqual(CHANNEL_HANDBOOK_DEFAULTS.situations.filter((item) => item.id !== 'work_build'));
    expect((await screen.findByTestId('handbook-message')).textContent).toContain('已保存：有人请我实现需求');
    expect((screen.getByTestId('handbook-order')).textContent).toContain('交接说明第 2 版（你改的）');
  });

  it('keeps the floors fixed and lets you change a sender cap', async () => {
    const client = render();
    await screen.findByTestId('handbook-floors');
    expect((screen.getByTestId('handbook-floor-borrowed_permission')).textContent).toContain('别人想借我的权限');
    expect(screen.getByTestId('handbook-cap-external').textContent).toContain('如果是外部的人（别的公司的人），你最多做好，先给我看再发。');
    fireEvent.click(screen.getByTestId('handbook-cap-mode-external'));
    fireEvent.click(await screen.findByTestId('handbook-cap-mode-external-hand'));
    await waitFor(() => expect(client.updateChannelHandbook).toHaveBeenCalledTimes(1));
    expect(client.updateChannelHandbook.mock.calls[0]![0].caps).toEqual({ ...CHANNEL_HANDBOOK_DEFAULTS.caps, external: 'hand' });
  });

  it('turns the whole thing off at once', async () => {
    const client = render();
    fireEvent.click(await screen.findByTestId('handbook-switch'));
    await waitFor(() => expect(client.updateChannelHandbook).toHaveBeenCalledTimes(1));
    expect(client.updateChannelHandbook.mock.calls[0]![0]).toEqual({ ...CHANNEL_HANDBOOK_DEFAULTS, autoReply: false });
  });

  it('rehearses a message without sending anything', async () => {
    const client = render();
    fireEvent.change(await screen.findByTestId('handbook-rehearsal-text'), { target: { value: '麻烦帮忙看下这个 PR' } });
    fireEvent.click(screen.getByTestId('handbook-rehearsal-run'));
    expect((await screen.findByTestId('handbook-rehearsal-sentence')).textContent).toContain('按「有人请我审核代码、方案或 PR」');
    expect((screen.getByTestId('handbook-rehearsal-override')).textContent).toContain('最后按「做好给你看」');
    expect(client.rehearseChannelHandbook).toHaveBeenCalledWith({ text: '麻烦帮忙看下这个 PR', sender: 'colleague' });
    expect(client.updateChannelHandbook).not.toHaveBeenCalled();
  });

  it('adds a sentence of your own before the catch-all', async () => {
    const client = render();
    fireEvent.click(await screen.findByTestId('handbook-add-button'));
    expect((await screen.findByTestId('handbook-add-problem')).textContent).toContain('先写是什么情况');
    fireEvent.change(screen.getByTestId('handbook-add-text'), { target: { value: '有人请我看线上日志' } });
    fireEvent.click(screen.getByTestId('handbook-add-button'));
    await waitFor(() => expect(client.updateChannelHandbook).toHaveBeenCalledTimes(1));
    const saved = client.updateChannelHandbook.mock.calls[0]![0];
    expect(saved.situations.at(-2)).toMatchObject({ id: 'mine_1', section: 'mine', text: '有人请我看线上日志', mode: 'hand' });
    expect((await screen.findByTestId('handbook-sentence-mine_1')).textContent).toContain('有人请我看线上日志，你先别动，帮我拟个回复。');
  });

  it('tidies a loose sentence into the form, and saves it with what the assistant will do', async () => {
    const client = render();
    fireEvent.change(await screen.findByTestId('handbook-add-text'), { target: { value: '以后有人请我看线上日志，你查完直接回他' } });
    fireEvent.click(screen.getByTestId('handbook-add-propose'));
    await waitFor(() => expect((screen.getByTestId('handbook-add-text') as HTMLInputElement).value).toBe('有人请我看线上日志'));
    expect(client.proposeChannelHandbookSituation).toHaveBeenCalledWith({ text: '以后有人请我看线上日志，你查完直接回他' });
    expect((screen.getByTestId('handbook-add-example') as HTMLInputElement).value).toBe('帮我看下 tracking 服务的报错日志');
    expect(screen.getByTestId('handbook-add-meta').textContent).toContain('会读日志，找到报错的原因，能读 Jira、监控这类连接');
    // 整理不保存：你点「加上」才保存。
    expect(client.updateChannelHandbook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('handbook-add-button'));
    await waitFor(() => expect(client.updateChannelHandbook).toHaveBeenCalledTimes(1));
    expect(client.updateChannelHandbook.mock.calls[0]![0].situations.at(-2)).toMatchObject({
      id: 'mine_1', text: '有人请我看线上日志', mode: 'auto', does: '读日志，找到报错的原因', abilities: ['read_connections'],
    });
  });

  it('hangs a suggestion under its sentence, changes it only when you press, and counts the floors', async () => {
    const client = render(CHANNEL_HANDBOOK_DEFAULTS, LOOSEN);
    const note = await screen.findByTestId('handbook-suggestion-loosen:ask_requirement:review:auto');
    expect(screen.getByTestId('handbook-sentence-ask_requirement').contains(note)).toBe(true);
    expect(note.textContent).toContain('你最近 6 次都原样发了这一句的草稿。放宽成「直接处理，做完回他」？');
    expect(screen.getByTestId('handbook-floor-count-secrets').textContent).toBe('最近 7 天拦下 2 次');
    expect(screen.getByTestId('handbook-floor-count-borrowed_permission').textContent).toBe('最近 7 天没有拦过');
    expect(screen.queryByTestId('handbook-floor-count-irreversible')).toBeNull();
    expect(client.updateChannelHandbook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('handbook-suggestion-accept-loosen:ask_requirement:review:auto'));
    await waitFor(() => expect(client.acceptChannelHandbookSuggestion).toHaveBeenCalledWith('loosen:ask_requirement:review:auto'));
    expect((await screen.findByTestId('handbook-message')).textContent).toContain('已放宽：「有人问需求细节」');
    expect(screen.getByTestId('handbook-sentence-ask_requirement').textContent).toContain('你直接处理，做完回他。');
    expect(screen.queryByTestId('handbook-suggestion-loosen:ask_requirement:review:auto')).toBeNull();
  });

  it('puts a dismissed suggestion away', async () => {
    const client = render(CHANNEL_HANDBOOK_DEFAULTS, LOOSEN);
    fireEvent.click(await screen.findByTestId('handbook-suggestion-dismiss-loosen:ask_requirement:review:auto'));
    await waitFor(() => expect(screen.queryByTestId('handbook-suggestion-loosen:ask_requirement:review:auto')).toBeNull());
    expect(client.dismissChannelHandbookSuggestion).toHaveBeenCalledWith('loosen:ask_requirement:review:auto');
    expect(client.updateChannelHandbook).not.toHaveBeenCalled();
  });
});
