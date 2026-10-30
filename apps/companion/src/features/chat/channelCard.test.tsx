// @vitest-environment jsdom
// 外部来源的会话卡（工单 11，spec D10）：发信人、原文摘录、起草的回复，和「用草稿回复」「我自己回」「稍后」「不回」。
// 每种状态的显示；按钮调到 runtime；卡的版本只升不降（spec D16）；网关推 channel-cards 时只重取卡；卡按时间插进对话。
// 带代查的卡（Slack 代查与按信心代回 spec D9，工单 05）：代查轨和代回轨的每一种组合、过时提示、受众、review、读过的文件；
// 「改一下再发」的输入和发送、发送中禁用按钮、错误；三张样例卡（已自动回复、问你、没查到）的渲染；结束后收成一行。
import { PROTOCOL_VERSION, type ChannelCardDto } from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  askYouCard, autoRepliedCard, localAt, LOOKUP_NOW, lookupCard, lookupDto, notFoundCard,
} from '../../../test/channelLookupCards';
import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { mergeChannelCardSnapshot, upsertChannelCard } from '../../state/control-plane/channelCards';
import { reduceGatewayEvent } from '../../state/control-plane/eventReducer';
import { adaptGatewayEvent } from '../../state/control-plane/protocolAdapter';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import type { MessageEntity } from '../../state/types';
import { channelCardView, channelDraftDisclosure } from './channelCard';
import { ChannelMessageCard } from './ChannelMessageCard';
import { buildLeadTimeline, groupChannelCardRuns, LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});

afterEach(cleanup);

function card(overrides: Partial<ChannelCardDto> = {}): ChannelCardDto {
  return {
    id: 7, version: 3, source: 'slack', sourceLabel: 'Slack', objectKey: 'slack:D0ZHANG:main', laneLabel: '张三的私信',
    sender: { id: 'U0ZHANG', name: '张三', trust: 'colleague' }, excerpt: '周五评审的材料收到了吗？谢谢', messageCount: 1,
    delivery: 'card', state: 'open', draft: { text: '收到，谢谢！', drafter: 'template' },
    gate: { decision: 'shadow', category: 'acknowledgement', reasons: ['这一类还没有通过影子模式并由你批准开放'] },
    lookup: null, handling: null,
    sentText: null, snoozedUntil: null, revokeUntil: null, resolvedAt: null,
    actions: ['send_draft', 'reply_myself', 'snooze', 'dismiss'],
    createdAt: '2026-10-17T02:00:00.000Z', updatedAt: '2026-10-17T02:00:05.000Z',
    ...overrides,
  };
}

describe('what a channel card says in each state', () => {
  it('shows the sender, the excerpt, the draft and four actions while it waits for the user', () => {
    const view = channelCardView(card());
    expect(view).toMatchObject({
      context: 'Slack · 张三的私信', sender: '张三（同事）', excerpt: '周五评审的材料收到了吗？谢谢', draft: '收到，谢谢！',
      badge: { label: '等你处理' }, compact: false, closed: false,
    });
    expect(view.note).toContain('影子模式');
    expect(view.buttons.map((button) => button.label)).toEqual(['用草稿回复', '我自己回', '稍后', '不回']);
  });

  // 用户 2026-10-21：草稿按对话内容写（drafter model）。助手写的草稿发出时加「confirmed by」的署名，没有代查的卡也要说一声；
  // 模板的草稿原样发，不说。
  it('says the byline will be added for a model draft even without a lookup, and not for a template draft', () => {
    const modelDraft = channelCardView(card({ draft: { text: '在 docs/api.md，我晚点把链接发你。', drafter: 'model' } }));
    expect(modelDraft.disclosure).toBe('直接回复时，开头会加一行助手的署名，写明是你确认发出的');
    expect(channelCardView(card()).disclosure).toBeNull();
  });

  // 用户 2026-10-26：你让 Lead 去做卡上的事，Lead 做完了，卡自己结束，不再等你点；页面上也不多一个按钮。
  it('closes as a receipt when Lead did what the card asked, and never shows a handled button', () => {
    expect(channelCardView(card({ actions: ['send_draft', 'dismiss', 'handled'] })).buttons.map((button) => button.label))
      .toEqual(['用草稿回复', '不回']);
    const handled = channelCardView(card({
      state: 'handled', actions: [], resolvedAt: '2026-10-17T02:10:00.000Z',
      outcome: { by: 'lead', action: 'handled', note: '私信 Nina、Lucas 更新状态' },
    }));
    expect(handled).toMatchObject({ badge: { label: '已处理' }, note: '已照你的话处理：私信 Nina、Lucas 更新状态', closed: true, buttons: [] });
    expect(handled.folded?.outcome).toContain('已处理');
    const replied = channelCardView(card({
      state: 'replied', actions: [], sentText: '能来', outcome: { by: 'lead', action: 'send_message', note: null },
    }));
    expect(replied.note).toBe('已代你回复：「能来」');
  });

  it('names the lookup actions (Slack 代查 spec D9) in a fixed order when the daemon offers them', () => {
    const view = channelCardView(card({ actions: ['cancel_lookup', 'send_draft', 'send_edited'] }));
    expect(view.buttons.map((button) => button.label)).toEqual(['用草稿回复', '改一下再发', '停掉工单']);
    expect(view.buttons.filter((button) => button.primary).map((button) => button.action)).toEqual(['send_draft']);
  });

  it('ends quietly when the user replied in the source, and has no buttons', () => {
    const view = channelCardView(card({ state: 'resolved_elsewhere', actions: [], resolvedAt: '2026-10-17T02:05:00.000Z' }));
    expect(view).toMatchObject({ badge: { label: '已在别处处理' }, draft: null, buttons: [], closed: true });
    expect(view.note).toBe('你已在 Slack 里自己回复，不再提醒');
  });

  it('offers undo only inside the revoke window of an automatic reply', () => {
    const revokeUntil = new Date(Date.now() + 5 * 60_000).toISOString();
    const auto = card({ state: 'auto_replied', sentText: '收到，谢谢！', revokeUntil, actions: ['undo_auto_reply'] });
    const view = channelCardView(auto);
    expect(view.note).toMatch(/^已按常设指令代你回复「收到，谢谢！」，\d\d:\d\d 前可以撤回$/);
    expect(view.buttons.map((button) => button.label)).toEqual(['撤回']);
    expect(channelCardView({ ...auto, actions: [] }, new Date(Date.now() + 10 * 60_000)).note).toBe('已按常设指令代你回复「收到，谢谢！」');
  });

  // 统一消息事件 spec D11：点了「我自己回」，卡马上结束，写明结局，不再说等你在来源里回复。
  it('shows a card you said you would reply to yourself as ended', () => {
    const view = channelCardView(card({ state: 'left_to_user', actions: [], resolvedAt: '2026-10-17T02:10:00.000Z' }));
    expect(view).toMatchObject({ closed: true, note: '你说会自己回复', badge: { label: '你自己回', tone: 'muted' }, buttons: [], draft: null });
    expect(view.note).not.toContain('等你在');
    expect(view.folded?.outcome).toMatch(/你自己回$/);
  });

  it('describes the other states and keeps digest cards to one line', () => {
    expect(channelCardView(card({ state: 'replied', sentText: '收到，谢谢！', actions: [] })).note).toBe('你用草稿回复了：「收到，谢谢！」');
    expect(channelCardView(card({ state: 'dismissed', actions: [] })).badge.label).toBe('不回');
    expect(channelCardView(card({ state: 'replying_self', actions: ['snooze', 'dismiss'] })).note).toBe('你在 Slack 里回过一句，还没回答对方');
    expect(channelCardView(card({ state: 'snoozed', snoozedUntil: new Date(2026, 9, 17, 11, 0).toISOString() })).note).toBe('11:00 再提醒你');
    expect(channelCardView(card({ gate: { decision: 'denied', category: null, reasons: ['发信人的信任级别不允许代回'] } })).note)
      .toBe('没有代你回复：发信人的信任级别不允许代回');
    expect(channelCardView(card({ delivery: 'digest' })).compact).toBe(true);
    expect(channelCardView(card({ sender: { id: 'x', name: '王五', trust: 'customer' } })).sender).toBe('王五（外部客户）');
  });
});

// 2026-10-27 按画布重画：草稿、详情、输入框都在撑开的浮层里。点卡片的空白处打开。
async function openCard(id: number) {
  fireEvent.click(screen.getByTestId(`surface-disclosure-channel-card-${id}-summary`));
  return screen.findByTestId(`channel-card-${id}-panel`);
}

describe('the channel card component', () => {
  it('sends the chosen action and shows the error when it fails', async () => {
    const onAction = vi.fn()
      .mockRejectedValueOnce(new Error('没有发出去，系统会用同一个幂等键再试：ECONNRESET'))
      .mockResolvedValue(undefined);
    renderUI(<ChannelMessageCard card={card()} onAction={onAction} />);
    expect(screen.getByText('周五评审的材料收到了吗？谢谢')).toBeTruthy();
    // 收起态：Fairy 的一行写草稿原文。
    expect(screen.getByTestId('channel-card-7-fairy').textContent).toContain('收到，谢谢！');
    fireEvent.click(screen.getByTestId('channel-card-7-send_draft'));
    expect(onAction).toHaveBeenCalledWith('send_draft');
    await waitFor(() => expect(screen.getByTestId('channel-card-7-error').textContent).toContain('ECONNRESET'));
    fireEvent.click(screen.getByTestId('channel-card-7-reply_myself'));
    expect(onAction).toHaveBeenLastCalledWith('reply_myself');
    await waitFor(() => expect(screen.queryByTestId('channel-card-7-error')).toBeNull());
  });

  // 统一消息事件工单 06 和 genui v3 合到一起：Lead 还没处理时，Fairy 那一行写排队中，不再写「几点前不定就由系统兜底」。
  it('says the card is queued for Fairy, with no deadline or fallback, while Lead has not decided', () => {
    const waiting = card({
      draft: null, gate: null,
      handling: {
        authority: { intent: 'code_review', action: 'work', reason: '要干活' },
        lead: { stage: 'intake', decision: null, by: null, note: null, deadlineAt: localAt(14, 36) },
        reply: null,
      },
    });
    renderUI(<ChannelMessageCard card={waiting} onAction={vi.fn()} now={LOOKUP_NOW} />);
    const fairy = screen.getByTestId('channel-card-7-fairy').textContent ?? '';
    expect(fairy).toContain('排队中');
    expect(fairy).toContain('代码 review');
    expect(fairy).not.toContain('兜底');
  });

  // 回归（2026-10-28 09:44–10:23）：Lead 的上下文满了，每一轮都失败，卡上一直写「排队中，等 Fairy 处理」，用户以为 Lead 在忙别的。
  // 现在 Lead 的模型调用在失败时（顶栏是降级、失败次数大于 0），卡上写 Fairy 卡住了和原因；只是压缩失败、Lead 还能工作时照旧写排队中。
  it('says Fairy is stuck, and why, instead of queued while Lead cannot work', () => {
    const waiting = card({
      draft: null, gate: null,
      handling: {
        authority: { intent: 'code_review', action: 'work', reason: '要干活' },
        lead: { stage: 'intake', decision: null, by: null, note: null },
        reply: null,
      },
    });
    const stuck = {
      state: 'degraded' as const, since: '2026-10-28T01:44:24.000Z', failures: 3, reason: 'Fairy 的上下文压缩失败',
      detail: 'Context overflow recovery failed: Summarization failed: generation hit the token cap and the summary is incomplete',
      nextAttemptAt: null, lastSuccessAt: null, lastPatrolAt: null,
    };
    renderUI(<ChannelMessageCard card={waiting} onAction={vi.fn()} now={LOOKUP_NOW} lead={stuck} />);
    const fairy = screen.getByTestId('channel-card-7-fairy').textContent ?? '';
    expect(fairy).toContain('Fairy 卡住了');
    expect(fairy).toContain('上下文满了');
    expect(fairy).not.toContain('排队中');
    cleanup();
    renderUI(<ChannelMessageCard card={waiting} onAction={vi.fn()} now={LOOKUP_NOW} lead={{ ...stuck, failures: 0 }} />);
    expect(screen.getByTestId('channel-card-7-fairy').textContent).toContain('排队中');
  });

  it('keeps a digest card without buttons until the user opens it', async () => {
    renderUI(<ChannelMessageCard card={card({ delivery: 'digest' })} onAction={vi.fn()} />);
    expect(screen.queryByTestId('channel-card-7-send_draft')).toBeNull();
    await openCard(7);
    expect(screen.getByTestId('channel-card-7-send_draft-p')).toBeTruthy();
  });

  // 画布状态 8：处理完的卡收成一行（结束行），点开在浮层里看全部。
  it('folds into one line once the card is closed, and opens without buttons', async () => {
    const closed = card({ state: 'resolved_elsewhere', actions: [], resolvedAt: new Date(2026, 9, 17, 10, 5).toISOString() });
    renderUI(<ChannelMessageCard card={closed} onAction={vi.fn()} />);
    expect(screen.getByTestId('channel-card-7-line').textContent).toBe('周五评审的材料收到了吗？谢谢');
    expect(screen.getByTestId('channel-card-7-outcome').textContent).toBe('10:05 已在别处处理');
    expect(screen.queryByTestId('channel-card-7-dismiss')).toBeNull();
    await openCard(7);
    // 结束的卡：Fairy 那一行已经写了结果，浮层里不再重复一句结束说明（2026-10-28 用户报的重复尾巴）。
    expect(screen.getByTestId('channel-card-7-panel').textContent).toContain('你在 Slack 里自己回了');
    expect(screen.queryByTestId('channel-card-7-note')).toBeNull();
    expect(screen.queryByTestId('channel-card-7-dismiss-p')).toBeNull();
    fireEvent.click(screen.getByTestId('channel-card-7-collapse'));
    expect(screen.getByTestId('channel-card-7-line')).toBeTruthy();
  });

  // 2026-10-28 用户报：照你的话处理完的卡，浮层里「已照你的话处理 回了表情 :heart:」下面又写了一遍同样的话。
  it('says what Lead did once in the panel of a handled card', async () => {
    const handled = card({
      state: 'handled', actions: [], draft: null, resolvedAt: new Date(2026, 9, 17, 10, 5).toISOString(),
      outcome: { by: 'lead', action: 'react', note: '回了表情 :heart:' },
    });
    renderUI(<ChannelMessageCard card={handled} onAction={vi.fn()} />);
    const panel = await openCard(7);
    expect(panel.textContent?.split('回了表情 :heart:').length).toBe(2);
    expect(screen.queryByTestId('channel-card-7-note')).toBeNull();
  });

  // Slack 发来的原文常常是 Markdown 或 Slack 自己的 mrkdwn：撑开的气泡按格式画，收起的一行只留文字。
  it('renders the formatting of Slack messages in the bubble and keeps the folded line plain', async () => {
    const text = [
      '原因主要有两条：',
      '',
      '1. _定位器更严格_，写法靠猜：',
      '    ◦ `text=Select` 是子串匹配。',
      '    ◦ 用旧编号 `@119` 去点。',
      '1. _页面本身的坑_：',
      '    ◦ 单选框被 `<span>` 挡住。',
      '报错看起来多，还有一个原因。',
      '',
      '*Sent using* @Claude',
    ].join('\n');
    const formatted = card({ excerpt: text.replace(/\s+/g, ' '), recent: [{ at: '2026-10-17T02:00:00.000Z', text }] });
    renderUI(<ChannelMessageCard card={formatted} onAction={vi.fn()} />);
    expect(screen.getByTestId('channel-card-7-latest').textContent).not.toMatch(/[_`◦*]/);
    await openCard(7);
    const bubble = screen.getByTestId('channel-card-7-messages');
    expect(within(bubble).getAllByTestId('markdown-message').length).toBe(1);
    // ◦ 是二级列表自己画的圆点，不是原文的标记。
    expect(bubble.textContent).not.toMatch(/[_`*]/);
    expect(bubble.textContent).toContain('<span>');
    // 两层列表：两个编号项，每项下面是子项；列表后面那一句是单独的段落，不并进最后一个子项。
    const lists = within(bubble).getAllByTestId('markdown-list');
    expect(lists.length).toBe(3);
    expect(lists.some((list) => list.textContent?.includes('报错看起来多'))).toBe(false);
    expect(bubble.textContent).toContain('Sent using @Claude');
  });
});

describe('channel cards in the client state', () => {
  it('only takes a higher version of a card (spec D16)', () => {
    const held = [card({ version: 5, state: 'replied', actions: [] })];
    // 刚做完动作手上是第 5 版，晚到的快照还是第 3 版：留手上的。
    expect(mergeChannelCardSnapshot(held, [card({ version: 3 })])[0]).toMatchObject({ version: 5, state: 'replied' });
    expect(mergeChannelCardSnapshot(held, [card({ version: 6, state: 'dismissed' })])[0]).toMatchObject({ version: 6 });
    // 快照里没有的卡不留。
    expect(mergeChannelCardSnapshot(held, [])).toEqual([]);
    expect(upsertChannelCard(held, card({ version: 4 }))[0]!.version).toBe(5);
    expect(upsertChannelCard(held, card({ id: 8, version: 1 })).map((item) => item.id)).toEqual([7, 8]);
  });

  it('refetches only the cards when the gateway says they changed', () => {
    const result = adaptGatewayEvent({
      protocolVersion: PROTOCOL_VERSION, eventId: 'e1', seq: 1, type: 'snapshot.required', occurredAt: '2026-10-17T02:00:00.000Z',
      requiredScope: 'chat', audienceBindingId: null, turnId: null, ticketId: null, payload: { resource: 'channel-cards' },
    });
    if (!result.ok) throw new Error(result.error);
    expect(reduceGatewayEvent(result.event).invalidations).toEqual(['channel-cards']);
  });

  it('places a card in the conversation by the time it was opened', () => {
    const message = (id: string, at: string): MessageEntity => ({
      id, sessionId: 's', turnId: `turn-${id}`, role: 'user', state: 'completed', createdAt: at, updatedAt: at,
    } as unknown as MessageEntity);
    const timeline = buildLeadTimeline(
      [message('a', '2026-10-17T01:00:00.000Z'), message('b', '2026-10-17T03:00:00.000Z')], [], [],
      { channelCards: [card()] },
    );
    expect(timeline.map((item) => item.key)).toEqual(['message:a', 'channel-card:7', 'message:b']);
    // 摘要投递的消息在 06 的「Lead 动态」卡片里，对话里不再放一张通道卡。
    const digest = buildLeadTimeline(
      [message('a', '2026-10-17T01:00:00.000Z')], [], [], { channelCards: [card({ delivery: 'digest' })] },
    );
    expect(digest.map((item) => item.key)).toEqual(['message:a']);
  });
});

// ── 带代查的卡（工单 05） ─────────────────────────────────────────────────────────────

describe('the two tracks on a card with a lookup (spec D9)', () => {
  it('asks the user like the agreed sample: lookup line, reply line, checks, draft and four buttons', () => {
    const view = channelCardView(askYouCard(), LOOKUP_NOW);
    expect(view).toMatchObject({ badge: { label: '等你处理' }, note: null, closed: false, folded: null });
    expect(view.lookup!.track).toMatchObject({ text: '✓ 工单 #482 · 完成于 14:32 · 2 处出处已核实', ticketId: 482, status: null });
    expect(view.reply!.text).toBe('问你 · 信心 0.71（自动门槛 0.85）');
    expect(view.reply!.checks.map((check) => `${check.label} ${check.mark}${check.value ? ` ${check.value}` : ''}`))
      .toEqual(['依据核实 ✓', '做到了所求 ✓', '有依据 △', '理解了请求 ✓ 0.80']);
    expect(view.reply!.history).toBe('这一段历史 15/20');
    expect(view.reply!.reasons).toEqual(['信心 0.71 低于自动门槛 0.85']);
    expect(view.lookup!.audience).toEqual({ text: '谁能看到回复：#proj-x', external: false });
    expect(view.lookup!.stale).toBeNull();
    // 草稿不带署名；旁边一行小字说明直接回复时加什么。
    expect(view.draft).toBe('订单 123 在 14:02 被标成了测试单，测试单不触发 webhook（见 src/dispatch/filter.ts）。');
    expect(view.disclosure).toBe(channelDraftDisclosure('Leo'));
    expect(view.disclosure).toBe('直接回复时，开头会加一行助手的署名：confirmed by Leo');
    expect(view.buttons.map((button) => button.label)).toEqual(['直接回复', '改一下再发', '我自己回', '不用回']);
    expect(view.buttons.filter((button) => button.primary).map((button) => button.action)).toEqual(['send_draft']);
  });

  it('shows an automatic reply with its confidence and the revoke window, then folds after the window', () => {
    const view = channelCardView(autoRepliedCard(), LOOKUP_NOW);
    expect(view.badge.label).toBe('已代你回复');
    expect(view.reply!.text).toBe('已自动回复 · 信心 0.93（自动门槛 0.90） · 14:43 前可以撤回');
    expect(view.reply!.history).toBe('这一段历史 4/20');
    expect(view.note).toBe('已代你回复「Fairy (Assistant) · auto-reply for Leo\n订单 123 在 14:02 被标成了测试单，测试单不触发 webhook（见 src/dispatch/filter.ts）。」，14:43 前可以撤回');
    expect(view.buttons.map((button) => button.label)).toEqual(['撤回']);
    expect(view.folded).toBeNull();
    const later = channelCardView({ ...autoRepliedCard(), actions: [] }, new Date(2026, 9, 20, 14, 50));
    expect(later.reply!.text).toBe('已自动回复 · 信心 0.93（自动门槛 0.90）');
    expect(later.folded).toEqual({ who: '张三：订单 123 的 webhook 为什么没触发？', outcome: '14:33 已代你回复' });
  });

  it('says a prefix will be added only for drafts the lookup or Lead wrote', () => {
    // 模板草稿（「收到，谢谢！」）hub 原样发出，卡上不能说会加「已确认」前缀。
    const template = channelCardView(lookupCard({ draft: { text: '收到，谢谢！', drafter: 'template' } }), LOOKUP_NOW);
    expect(template.disclosure).toBeNull();
    const byLead = channelCardView(lookupCard({ draft: { text: '收到，谢谢，我晚点看。', drafter: 'lead' } }), LOOKUP_NOW);
    expect(byLead.disclosure).toBe(channelDraftDisclosure('Leo'));
  });

  it('says where it looked when nothing was found, and hands the card over', () => {
    const view = channelCardView(notFoundCard(), LOOKUP_NOW);
    expect(view.lookup!.track.text).toBe('✗ 没查到 · 工单 #484 · 14:32 查完 · 查过 3 处');
    expect(view.lookup!.checkedVisible).toBe(true);
    expect(view.lookup!.checked).toEqual(['acme/webhooks src/signing/', 'acme/webhooks docs/', 'GitHub 代码搜索 rotate signing key']);
    expect(view.reply).toMatchObject({ status: '交给你', text: '交给你 · 没查到', reasons: ['没查到，交给你'] });
    expect(view.lookup!.answer).toBeNull();
    expect(view.draft).toBeNull();
    expect(view.disclosure).toBeNull();
    expect(view.buttons.map((button) => button.label)).toEqual(['我自己回', '不用回']);
  });

  // 画布 Slack 状态 2（2026-10-27 核对）：派了工单还在查时，Fairy 那一行写派了哪张工单，后面一根细进度条。
  it('shows which ticket Fairy sent and a thin progress bar while it runs', () => {
    const running = lookupCard({ draft: null, actions: ['cancel_lookup', 'dismiss'] }, { state: 'running', finishedAt: null, result: null, confidence: null, reply: null });
    renderUI(<ChannelMessageCard card={running} onAction={vi.fn()} now={LOOKUP_NOW} />);
    expect(screen.getByTestId(`channel-card-${running.id}-fairy`).textContent).toContain('Fairy 派了 #482 去查');
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('describes every state of the lookup track', () => {
    const track = (lookup: Parameters<typeof lookupCard>[1], overrides: Partial<ChannelCardDto> = {}) =>
      channelCardView(lookupCard({ draft: null, actions: [], ...overrides }, lookup), LOOKUP_NOW);
    const queued = track({ state: 'queued', ticketId: null, finishedAt: null, result: null, confidence: null, reply: null });
    expect(queued.lookup!.track.text).toBe('… 排队中 · 同时进行的代查满了，空出来就开始');
    expect(queued.reply!.text).toBe('等工单结束再定');
    expect(queued.lookup!.active).toBe(true);
    const running = track({ state: 'running', finishedAt: null, result: null, confidence: null, reply: null }, { actions: ['cancel_lookup', 'dismiss'] });
    expect(running.lookup!.track.text).toBe('… 进行中 · 工单 #482 · 14:30 开始');
    // 没结束时卡上写「进行中」。
    expect(running.badge.label).toBe('进行中');
    expect(running.buttons.map((button) => button.label)).toEqual(['不用回', '停掉工单']);
    const partial = track({
      result: { ...lookupDto().result!, found: 'partial', sources: lookupDto().result!.sources.map((source, index) => ({ ...source, verified: index === 0 })) },
    });
    expect(partial.lookup!.track.text).toBe('△ 部分查到 · 工单 #482 · 完成于 14:32 · 1/2 处出处已核实');
    expect(partial.lookup!.sources.map((source) => source.verified)).toEqual([true, false]);
    const failed = track({ state: 'failed', result: null, confidence: null, reply: null, error: '代查超过 15 分钟，停掉了' });
    expect(failed.lookup!.track).toMatchObject({ text: '✗ 没做成 · 工单 #482 · 14:32', reasons: ['代查超过 15 分钟，停掉了'] });
    // 查完了、代回还没判断：核对中。
    expect(failed.reply!.text).toBe('核对中');
    const cancelled = track({ state: 'cancelled', result: null, confidence: null, reply: null });
    expect(cancelled.lookup!.track.text).toBe('– 已停止 · 工单 #482 · 14:32');
    expect(cancelled.reply).toBeNull();
    const denied = track({
      state: 'denied', ticketId: null, finishedAt: null, result: null, confidence: null, reply: null, reads: { count: 0, items: [] },
      deniedReasons: ['有人提了敏感请求（个人信息），没有查'],
    });
    expect(denied.lookup!.track).toMatchObject({ text: '✗ 没有查', reasons: ['有人提了敏感请求（个人信息），没有查'] });
    expect(denied.reply).toBeNull();
    expect(denied.lookup!.reads).toBeNull();
    expect(denied.badge.label).toBe('等你处理');
  });

  it('breaks the reply decision down: vetoes, missing confidence, calibrated history, an auto reply that did not happen', () => {
    const vetoed = channelCardView(lookupCard({}, {
      confidence: { ...lookupDto().confidence!, value: 0.91, vetoes: ['这条消息以后又来了新消息'] },
      reply: { decision: 'ask_user', reasons: ['这条消息以后又来了新消息', '草稿可能替你做了承诺'], at: localAt(14, 32) },
      newerMessages: 1,
    }), LOOKUP_NOW);
    expect(vetoed.reply).toMatchObject({ vetoes: ['这条消息以后又来了新消息'], reasons: ['草稿可能替你做了承诺'] });
    expect(vetoed.lookup!.stale).toBe('之后又来了 1 条消息');
    const noScore = channelCardView(lookupCard({}, { confidence: { ...lookupDto().confidence!, value: null, threshold: null, calibration: null } }), LOOKUP_NOW);
    expect(noScore.reply).toMatchObject({ text: '问你 · 信心算不出', history: null });
    const calibrated = channelCardView(lookupCard({}, {
      confidence: { ...lookupDto().confidence!, calibration: { bucket: 0.8, samples: 25, agreed: 23, minSamples: 20 } },
    }), LOOKUP_NOW);
    expect(calibrated.reply!.history).toBe('这一段历史 照发 23/25');
    // 决定了自动回复，但卡还是等你处理（撤回了，或者出站在重试）。
    const undone = channelCardView(lookupCard({}, { reply: { decision: 'auto_send', reasons: [], at: localAt(14, 33) } }), LOOKUP_NOW);
    expect(undone.reply).toMatchObject({ status: '自动回复没有生效', text: '自动回复没有生效 · 信心 0.71（自动门槛 0.85）' });
    // 不过的检查把原因写出来。
    expect(channelCardView(askYouCard(), LOOKUP_NOW).reply!.checks.find((check) => check.status === 'weak')!.detail)
      .toBe('出处说明了跳过测试单，没有说明订单为什么被标成测试单');
  });

  it('warns when the result is old or newer messages came, but not on a closed card', () => {
    const old = lookupCard({}, { finishedAt: localAt(13, 50), newerMessages: 2 });
    expect(channelCardView(old, LOOKUP_NOW).lookup!.stale).toBe('之后又来了 2 条消息，结果是 45 分钟前的');
    expect(channelCardView(old, new Date(2026, 9, 20, 16, 0)).lookup!.stale).toBe('之后又来了 2 条消息，结果是 2 小时前的');
    expect(channelCardView(lookupCard({}, { finishedAt: localAt(14, 10) }), LOOKUP_NOW).lookup!.stale).toBeNull();
    expect(channelCardView({ ...old, state: 'dismissed', actions: [] }, LOOKUP_NOW).lookup!.stale).toBeNull();
  });

  it('says who will see the reply, and flags a conversation shared with another organization', () => {
    const shared = channelCardView(lookupCard({}, { audience: { label: '#acme-partners', externalShared: true } }), LOOKUP_NOW);
    expect(shared.lookup!.audience).toEqual({ text: '谁能看到回复：#acme-partners · 和外部组织共享的对话', external: true });
  });

  it('shows a PR review with its summary, comment count and comments, and the review buttons', () => {
    const review = channelCardView(lookupCard({ actions: ['send_draft', 'reply_myself', 'dismiss'] }, {
      playbook: 'review',
      review: {
        summary: '改动整体没问题，有两处边界条件要确认。', commentCount: 2,
        comments: [
          { path: 'src/dispatch/filter.ts', line: 14, side: 'RIGHT', body: '这里 isTest 为 undefined 时会走到发送分支吗？' },
          { path: 'src/dispatch/retry.ts', line: 30, side: 'RIGHT', body: '重试次数建议放进配置。' },
        ],
      },
    }), LOOKUP_NOW);
    expect(review.lookup!.reviewSummary).toBe('改动整体没问题，有两处边界条件要确认。');
    expect(review.lookup!.comments).toEqual({
      count: 2,
      items: [
        { where: 'src/dispatch/filter.ts:14', body: '这里 isTest 为 undefined 时会走到发送分支吗？' },
        { where: 'src/dispatch/retry.ts:30', body: '重试次数建议放进配置。' },
      ],
    });
    expect(review.buttons.map((button) => [button.label, button.primary])).toEqual([['直接回复', true], ['我自己处理', false], ['不用', false]]);
  });

  it('lists what the lookup read, including refused reads, and says when the list is partial', () => {
    expect(channelCardView(askYouCard(), LOOKUP_NOW).lookup!.reads).toEqual({
      count: 3, partial: false,
      items: ['search acme/webhooks', 'read_file acme/webhooks src/dispatch/filter.ts:1-80', 'read_file acme/webhooks .env · 被拒：禁止名单里的文件'],
    });
    expect(channelCardView(notFoundCard(), LOOKUP_NOW).lookup!.reads).toEqual({ count: 5, partial: true, items: [] });
  });

  it('adds the disclosure note only to a lookup draft the user can send as is', () => {
    expect(channelCardView(card(), LOOKUP_NOW).disclosure).toBeNull();
    expect(channelCardView(lookupCard({ actions: ['send_edited', 'dismiss'] }), LOOKUP_NOW).disclosure).toBeNull();
  });
});

// 通道怎么处理这条消息、信心模型的分数面板（落地计划 D2、D3，2026-10-22）。
describe('the handling and the score panel on a card (landing plan D3)', () => {
  type Handling = NonNullable<ChannelCardDto['handling']>;
  const waiting: Handling['lead'] = { stage: 'intake', decision: null, by: null, note: null };
  const review: Handling['authority'] = { intent: 'code_review', action: 'work', reason: '要干活' };
  const handled = (handling: Partial<Handling>, overrides: Partial<ChannelCardDto> = {}) =>
    card({ draft: null, gate: null, handling: { authority: review, lead: waiting, reply: null, ...handling }, ...overrides });
  const score: NonNullable<Handling['reply']> = {
    draftKind: 'lead_answer', decision: 'ask_user', audit: true, raw: 0.8, confidence: 0.62, threshold: 0.6,
    calibration: { bucket: 0.8, samples: 3.5, agreed: 1.5, minSamples: 20 },
    checks: [{ id: 'needs_reply', label: '要回', status: 'pass', value: 0.9, detail: '请求 A 90%' }],
    vetoes: [], reasons: ['抽查：信心够代你发，这次照样放到卡上问你（抽 5%），你怎么做就是高分段的标签'], at: localAt(14, 33),
  };

  // 统一消息事件工单 06：没有期限，系统不替 Lead 定。Lead 还没处理的卡写「排队中」，没有草稿。
  it('says what the authority decided, and that the card is queued for Lead, with no deadline', () => {
    const view = channelCardView(handled({}), LOOKUP_NOW);
    expect(view.handling).toEqual({
      text: '代码 review · 要干活 · 排队中，等 Lead 处理', tone: 'accent', note: null, reason: null, ruleChange: null,
    });
    expect(view).toMatchObject({ badge: { label: '排队中', tone: 'accent' }, draft: null });
    // 过了以前的期限也一样：系统不兜底。旧 daemon 还给 deadlineAt 时不读它。
    const old = { ...waiting!, deadlineAt: localAt(14, 36) };
    expect(channelCardView(handled({ lead: old }), new Date(2026, 9, 20, 15, 37)).handling!.text).toBe('代码 review · 要干活 · 排队中，等 Lead 处理');
    // 子 agent 答完、信心模型问你：交回 Lead，排队等它决定怎么告诉你。
    expect(channelCardView(handled({ lead: { ...waiting!, stage: 'reply' } }), LOOKUP_NOW).handling!.text)
      .toBe('代码 review · 要干活 · 交回 Lead，排队等它决定怎么告诉你');
    // Lead 处理过的卡不再写排队中。
    expect(channelCardView(handled({ lead: { ...waiting!, decision: 'told', by: 'lead' } }), LOOKUP_NOW).badge.label).toBe('等你处理');
    // 通道没有判断过的旧卡没有处理轨，照旧写模板闸门的话。
    expect(channelCardView(card(), LOOKUP_NOW)).toMatchObject({ handling: null, reply: null });
  });

  it("shows Lead's words when Lead pushes the card to you, and the reason the system notes", () => {
    const pushed = channelCardView(handled({
      lead: { stage: 'reply', decision: 'push', by: 'lead', note: '王小明的 PR 看完了，有两处要改，草稿在卡上' },
    }), LOOKUP_NOW);
    expect(pushed.handling).toEqual({
      text: '代码 review · 要干活 · Lead 推送给你', tone: 'neutral', note: 'Lead：王小明的 PR 看完了，有两处要改，草稿在卡上', reason: null,
      ruleChange: null,
    });
    const merged = channelCardView(handled({
      authority: { intent: 'other', action: 'ask', reason: '问你' },
      lead: { stage: 'intake', decision: 'superseded', by: 'system', note: '同一张卡又来了新消息（事件 #9），并进新的请求' },
    }), LOOKUP_NOW);
    expect(merged.handling).toMatchObject({
      text: '别的 · 问你 · 并进了新消息的请求', note: null, reason: '同一张卡又来了新消息（事件 #9），并进新的请求',
    });
    // Lead 用固定的话拒绝（回复到来源的固定拒绝）。
    expect(channelCardView(handled({
      authority: { intent: 'secret', action: 'refuse', reason: '问的是涉密信息，用固定的话拒绝' },
      lead: { stage: 'intake', decision: 'refuse', by: 'lead', note: 'Lead 用固定的话拒绝了涉密的请求' },
    }), LOOKUP_NOW).handling!.text).toBe('涉密 · 代你拒绝 · Lead 用固定的话拒绝了');
  });

  it('shows the score panel of the draft on the card, without a task: the audit, the score before calibration and the history', () => {
    const view = channelCardView(handled(
      { lead: { ...waiting!, decision: 'answer', by: 'lead' }, reply: score },
      { draft: { text: '可以，三点以后都行。', drafter: 'lead' } },
    ), LOOKUP_NOW);
    expect(view.lookup).toBeNull();
    expect(view.reply).toEqual({
      status: '问你', tone: 'accent', audit: true, text: '问你 · 抽查 · 信心 0.62（校准前 0.80，自动门槛 0.60）',
      checks: [{ label: '要回', mark: '✓', status: 'pass', value: '0.90', detail: '请求 A 90%' }],
      history: '这一段历史 3.5/20', vetoes: [], reasons: score.reasons,
    });
    // 样本够了：写照发的比例。最高档：不写门槛。
    const warm = channelCardView(handled({ reply: {
      ...score, audit: false, decision: 'ask_user', raw: 0.5, confidence: 0.5, threshold: null,
      calibration: { bucket: 0.5, samples: 24.5, agreed: 20, minSamples: 20 },
    } }, { draft: { text: '好的', drafter: 'lead' } }), LOOKUP_NOW);
    expect(warm.reply).toMatchObject({ text: '问你 · 信心 0.50', history: '这一段历史 照发 20/24.5', audit: false });
  });

  // 工单 08（spec D10 的 Jev 标记）：对方要求改规则时，处理轨写明要改什么、没有照做。
  it('says on the handling track that the sender asked to change the rules and nothing was changed', async () => {
    const asked = handled({
      authority: { intent: 'approve', action: 'ask', reason: '问你' },
      ruleChange: { probability: 0.95, kinds: ['permissions', 'auto_reply'] },
    } as Partial<Handling>);
    expect(channelCardView(asked, LOOKUP_NOW).handling).toMatchObject({
      ruleChange: '对方要求修改助手的权限、自动回复和通知的名单，没有照做',
    });
    // 没有这一项、判断不是改规则的卡：不写。
    expect(channelCardView(handled({}), LOOKUP_NOW).handling!.ruleChange).toBeNull();
    // 只有这一项（授权表还没定）也有处理轨。
    expect(channelCardView(handled({ authority: null, lead: null, ruleChange: { probability: 0.8, kinds: [] } } as Partial<Handling>), LOOKUP_NOW)
      .handling).toMatchObject({ ruleChange: '对方要求修改助手或系统的规则，没有照做' });

    // genui v3 的卡收起态只有两三行（主题 A-4），这一行在点开以后的浮层里。
    renderUI(<ChannelMessageCard card={asked} onAction={vi.fn()} now={LOOKUP_NOW} />);
    await openCard(7);
    expect(screen.getByTestId('channel-card-7-rule-change').textContent).toBe('对方要求修改助手的权限、自动回复和通知的名单，没有照做');
  });

  it('renders the handling track, the score panel and the actions the sub-agent took, with links', async () => {
    const withTask = lookupCard({
      handling: {
        authority: review, lead: { ...waiting!, stage: 'reply', decision: 'told', by: 'lead', note: '在回复里说了 PR 看完了' },
        reply: { ...score, draftKind: 'task', audit: false },
      },
    }, {
      result: {
        ...lookupDto().result!,
        actions: [
          { summary: '在 acme/webhooks#12 提交了 COMMENT review（1 条评论）', url: 'https://github.com/acme/webhooks/pull/12#pullrequestreview-1', visible: true },
          { summary: '开了一个 pending review', url: null, visible: false },
        ],
        connectionSources: [{ via: 'connection', connection: 'cdp', tool: 'get_customer', quote: 'plan: enterprise', verified: true }],
      },
    });
    const view = channelCardView(withTask, LOOKUP_NOW);
    expect(view.lookup!.actions).toEqual([
      { text: '在 acme/webhooks#12 提交了 COMMENT review（1 条评论）', url: 'https://github.com/acme/webhooks/pull/12#pullrequestreview-1' },
    ]);
    expect(view.lookup!.sources.at(-1)).toEqual({ verified: true, where: 'cdp · get_customer', quote: 'plan: enterprise' });
    expect(view.lookup!.track.text).toBe('✓ 工单 #482 · 完成于 14:32 · 3 处出处已核实');

    renderUI(<ChannelMessageCard card={withTask} onAction={vi.fn()} now={LOOKUP_NOW} />);
    await openCard(12);
    fireEvent.click(screen.getByTestId('channel-card-12-more'));
    const shown = screen;
    expect(shown.getByTestId('channel-card-12-handling').textContent).toContain('代码 review · 要干活 · Lead 已经告诉你');
    expect(shown.getByTestId('channel-card-12-lead-note').textContent).toBe('Lead：在回复里说了 PR 看完了');
    expect(shown.getByRole('link', { name: '在 acme/webhooks#12 提交了 COMMENT review（1 条评论）' })).toBeTruthy();
    expect(shown.queryByText('开了一个 pending review')).toBeNull();
    expect(shown.getByTestId('channel-card-12-reply-track').textContent).toContain('问你 · 信心 0.62（校准前 0.80，自动门槛 0.60）');
  });
});

describe('the channel card component with a lookup', () => {
  it('renders the three sample cards: asks you, replied automatically, found nothing', async () => {
    renderUI(
      <>
        <ChannelMessageCard card={askYouCard()} onAction={vi.fn()} now={LOOKUP_NOW} />
        <ChannelMessageCard card={autoRepliedCard()} onAction={vi.fn()} now={LOOKUP_NOW} />
        <ChannelMessageCard card={notFoundCard()} onAction={vi.fn()} now={LOOKUP_NOW} />
      </>,
    );
    // 收起态：状态、信心胶囊、主操作（「稍后」「不回」只在浮层里）。
    expect(screen.getByTestId('channel-card-12-state').textContent).toBe('等你确认');
    expect(screen.getByTestId('channel-card-12-confidence').textContent).toBe('信心 0.71');
    expect(['send_draft', 'send_edited', 'reply_myself'].map((action) => screen.getByTestId(`channel-card-12-${action}`).textContent))
      .toEqual(['发出', '改一下再发', '我自己回']);
    expect(screen.queryByTestId('channel-card-12-dismiss')).toBeNull();
    expect(screen.getByTestId('channel-card-13-state').textContent).toBe('已代回');
    expect(screen.getByTestId('channel-card-13-undo_auto_reply').textContent).toMatch(/^撤回( 还剩 \d+:\d\d)?$/);

    await openCard(12);
    expect(screen.getByTestId('channel-card-12-draft').textContent).toContain('订单 123 在 14:02 被标成了测试单');
    expect(screen.getByTestId('channel-card-12-disclosure').textContent).toBe(channelDraftDisclosure('Leo'));
    expect(screen.getByTestId('channel-card-12-score').textContent).toContain('3/4 · 差在「有依据」');
    expect(screen.getByTestId('channel-card-12-dismiss-p').textContent).toBe('不用回');
    fireEvent.click(screen.getByTestId('channel-card-12-more'));
    expect(screen.getByTestId('channel-card-12-lookup-track').textContent).toBe('干活✓工单 #482·完成于 14:32·2 处出处已核实');
    expect(screen.getByLabelText('✓ 工单 #482 · 完成于 14:32 · 2 处出处已核实')).toBeTruthy();
    expect(screen.getByTestId('channel-card-12-reply-track').textContent).toContain('问你 · 信心 0.71（自动门槛 0.85）');
    expect(screen.getByTestId('channel-card-12-checks').textContent).toContain('!有依据');
    expect(screen.getByTestId('channel-card-12-checks').textContent).toContain('这一段历史 15/20');
    expect(screen.getByTestId('channel-card-12-audience').textContent).toBe('谁能看到回复：#proj-x');
    fireEvent.click(screen.getByTestId('channel-card-12-collapse'));

    await openCard(13);
    // 发出的原文在「已发出」框里，不再写一句结束说明重复它（2026-10-28）。
    expect(screen.getByTestId('channel-card-13-sent').textContent).toContain('Fairy (Assistant) · auto-reply for Leo');
    expect(screen.queryByTestId('channel-card-13-note')).toBeNull();
    expect(screen.queryByTestId('channel-card-13-draft')).toBeNull();
    fireEvent.click(screen.getByTestId('channel-card-13-more'));
    expect(screen.getByTestId('channel-card-13-reply-track').textContent).toContain('已自动回复 · 信心 0.93（自动门槛 0.90） · 14:43 前可以撤回');
    fireEvent.click(screen.getByTestId('channel-card-13-collapse'));

    await openCard(14);
    fireEvent.click(screen.getByTestId('channel-card-14-more'));
    expect(screen.getByTestId('channel-card-14-lookup-track').textContent).toContain('没查到');
    expect(screen.getByTestId('channel-card-14-checked').textContent)
      .toBe('查过：acme/webhooks src/signing/查过：acme/webhooks docs/查过：GitHub 代码搜索 rotate signing key');
    expect(screen.getByTestId('channel-card-14-reply-track').textContent).toContain('交给你');
    expect(screen.queryByTestId('channel-card-14-rerun_lookup')).toBeNull();
  });

  it('opens the lookup ticket from its number', async () => {
    const onOpenTicket = vi.fn();
    renderUI(<ChannelMessageCard card={askYouCard()} onAction={vi.fn()} onOpenTicket={onOpenTicket} now={LOOKUP_NOW} />);
    await openCard(12);
    fireEvent.click(screen.getByTestId('channel-card-12-more'));
    fireEvent.click(screen.getByTestId('channel-card-12-ticket'));
    expect(onOpenTicket).toHaveBeenCalledWith(482);
  });

  it('expands the answer and sources, the comments and the reads', async () => {
    const review = lookupCard({}, {
      review: { summary: '有一处要确认。', commentCount: 1, comments: [{ path: 'src/a.ts', line: 3, side: 'RIGHT', body: '这里会空指针。' }] },
    });
    renderUI(<ChannelMessageCard card={review} onAction={vi.fn()} now={LOOKUP_NOW} />);
    await openCard(12);
    fireEvent.click(screen.getByTestId('channel-card-12-more'));
    expect(screen.queryByTestId('channel-card-12-details')).toBeNull();
    fireEvent.click(screen.getByTestId('channel-card-12-details-toggle'));
    const details = screen.getByTestId('channel-card-12-details').textContent!;
    expect(details).toContain('订单 123 的 webhook 没有触发');
    expect(details).toContain('✓ acme/webhooks · src/dispatch/filter.ts:12-18');
    expect(details).toContain('if (order.isTest) return skip("test order");');
    expect(details).toContain('查过：acme/webhooks docs/');
    expect(details).toContain('不确定：没有查生产日志，只看了代码和文档');
    fireEvent.click(screen.getByTestId('channel-card-12-comments-toggle'));
    expect(screen.queryByTestId('channel-card-12-details')).toBeNull();
    expect(screen.getByTestId('channel-card-12-comments').textContent).toBe('src/a.ts:3这里会空指针。');
    fireEvent.click(screen.getByTestId('channel-card-12-reads-toggle'));
    expect(screen.getByTestId('channel-card-12-reads').textContent).toContain('read_file acme/webhooks .env · 被拒：禁止名单里的文件');
  });

  it('edits the draft and sends the edited text with send_edited', async () => {
    let finish: () => void = () => {};
    const onAction = vi.fn((_action: string, _text?: string) => new Promise<void>((resolve) => { finish = resolve; }));
    renderUI(<ChannelMessageCard card={askYouCard()} onAction={onAction} now={LOOKUP_NOW} />);
    fireEvent.click(screen.getByTestId('channel-card-12-send_edited'));
    // 浮层打开，草稿框原地变成输入框，预填草稿，还没有发。
    expect(onAction).not.toHaveBeenCalled();
    const input = await screen.findByTestId('channel-card-12-edit-input') as HTMLTextAreaElement;
    expect(input.value).toBe('订单 123 在 14:02 被标成了测试单，测试单不触发 webhook（见 src/dispatch/filter.ts）。');
    expect(screen.getByTestId('channel-card-12-panel').textContent).toContain('改过的文字按你写的原样发出，不加助手的署名');
    expect(screen.queryByTestId('channel-card-12-send_draft-p')).toBeNull();
    fireEvent.change(input, { target: { value: '  是测试单，所以没触发，谢谢！  ' } });
    fireEvent.click(screen.getByTestId('channel-card-12-edit-send'));
    expect(onAction).toHaveBeenCalledWith('send_edited', '是测试单，所以没触发，谢谢！');
    // 发送中：按钮和输入框都不能用。
    expect(screen.getByTestId('channel-card-12-edit-send').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('channel-card-12-edit-send').textContent).toBe('发出…');
    expect(screen.getByTestId('channel-card-12-edit-cancel').getAttribute('aria-disabled')).toBe('true');
    await act(async () => finish());
    // 发出以后浮层收起。
    await waitFor(() => expect(screen.queryByTestId('channel-card-12-editor')).toBeNull());
    expect(screen.getByTestId('channel-card-12-send_draft')).toBeTruthy();
  });

  it('keeps the editor open with the error when sending fails, and will not send empty text', async () => {
    const onAction = vi.fn().mockRejectedValueOnce(new Error('卡 #12 已经变了（现在是第 5 版），刷新后再操作'));
    renderUI(<ChannelMessageCard card={askYouCard()} onAction={onAction} now={LOOKUP_NOW} />);
    fireEvent.click(screen.getByTestId('channel-card-12-send_edited'));
    const input = await screen.findByTestId('channel-card-12-edit-input');
    fireEvent.change(input, { target: { value: '   ' } });
    expect(screen.getByTestId('channel-card-12-edit-send').getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(input, { target: { value: '好的' } });
    fireEvent.click(screen.getByTestId('channel-card-12-edit-send'));
    await waitFor(() => expect(screen.getByTestId('channel-card-12-error').textContent).toContain('刷新后再操作'));
    expect(screen.getByTestId('channel-card-12-editor')).toBeTruthy();
    expect((screen.getByTestId('channel-card-12-edit-input') as HTMLTextAreaElement).value).toBe('好的');
    fireEvent.click(screen.getByTestId('channel-card-12-edit-cancel'));
    expect(screen.queryByTestId('channel-card-12-editor')).toBeNull();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('disables every button while an action is being sent', async () => {
    let finish: () => void = () => {};
    const onAction = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderUI(<ChannelMessageCard card={askYouCard()} onAction={onAction} now={LOOKUP_NOW} />);
    fireEvent.click(screen.getByTestId('channel-card-12-send_draft'));
    expect(onAction).toHaveBeenCalledWith('send_draft');
    expect(screen.getByTestId('channel-card-12-send_draft').textContent).toBe('发出…');
    for (const action of ['send_draft', 'send_edited', 'reply_myself']) {
      expect(screen.getByTestId(`channel-card-12-${action}`).getAttribute('aria-disabled')).toBe('true');
    }
    await act(async () => finish());
    await waitFor(() => expect(screen.getByTestId('channel-card-12-reply_myself').getAttribute('aria-disabled')).toBeNull());
  });
});

describe('a lookup card in the conversation', () => {
  it('sends the edited text through the runtime with the held version and takes the returned card', async () => {
    const sent = { ...askYouCard(), version: 5, state: 'replied' as const, sentText: '是测试单，所以没触发。', draft: null, actions: [] };
    const actOnChannelCard = vi.fn(async () => sent);
    const runtime = createCompanionStateRuntime({
      client: { actOnChannelCard } as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    runtime.control.getState().replaceConversation('lead-session', []);
    runtime.control.getState().replaceChannelCards([askYouCard()]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    fireEvent.click(screen.getByTestId('channel-card-12-send_edited'));
    fireEvent.change(await screen.findByTestId('channel-card-12-edit-input'), { target: { value: '是测试单，所以没触发。' } });
    fireEvent.click(screen.getByTestId('channel-card-12-edit-send'));
    await waitFor(() => expect(actOnChannelCard).toHaveBeenCalledWith(12, 'send_edited', 4, '是测试单，所以没触发。'));
    // 服务端回的新版本进了 store，卡结束以后收成一行。
    await waitFor(() => expect(screen.getByTestId('channel-card-12-line')).toBeTruthy());
    expect(runtime.control.getState().channelCards[0]).toMatchObject({ version: 5, state: 'replied' });
  });

  it('sends other actions without text', async () => {
    const actOnChannelCard = vi.fn(async () => ({ ...askYouCard(), version: 5, state: 'dismissed' as const, actions: [] }));
    const runtime = createCompanionStateRuntime({
      client: { actOnChannelCard } as unknown as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.getState().replaceChannelCards([askYouCard()]);
    await runtime.actOnChannelCard(12, 'dismiss');
    expect(actOnChannelCard).toHaveBeenCalledWith(12, 'dismiss', 4, undefined);
  });
});

// 2026-10-21 用户要求：会话里块和块之间 14（conversation-block）；连着的几张外部消息卡是一张列表，卡和卡之间 6（list-row）。
// 数值由语义 token 决定（组件库的 tokens.test.ts 固定了它们），这里检查用的是哪个 token。
describe('channel cards that follow each other', () => {
  const message = (id: string, at: string): MessageEntity => ({
    id, sessionId: 's', turnId: `turn-${id}`, role: 'user', state: 'completed', createdAt: at, updatedAt: at,
  } as unknown as MessageEntity);
  const slack = (id: number, createdAt: string) => card({ id, objectKey: `slack:D0ZHANG:${id}`, createdAt });

  it('groups only the cards with nothing between them', () => {
    const timeline = buildLeadTimeline(
      [message('a', '2026-10-17T01:00:00.000Z'), message('b', '2026-10-17T03:00:00.000Z')], [], [],
      { channelCards: [slack(1, '2026-10-17T00:30:00.000Z'), slack(2, '2026-10-17T02:00:00.000Z'), slack(3, '2026-10-17T02:10:00.000Z')] },
    );
    expect(groupChannelCardRuns(timeline)).toEqual([
      { kind: 'channel-cards', key: 'channel-card:1', cardIds: [1] },
      { kind: 'message', key: 'message:a', messageId: 'a', cardIds: [] },
      { kind: 'channel-cards', key: 'channel-card:2', cardIds: [2, 3] },
      { kind: 'message', key: 'message:b', messageId: 'b', cardIds: [] },
    ]);
  });

  it('draws the cards as one list list-row apart, and keeps conversation-block between the blocks of the conversation', () => {
    const runtime = createCompanionStateRuntime({
      client: {} as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    runtime.control.getState().replaceConversation('lead-session', []);
    runtime.control.getState().replaceChannelCards([slack(1, '2026-10-17T02:00:00.000Z'), slack(2, '2026-10-17T02:10:00.000Z')]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    const run = screen.getByTestId('channel-card-run');
    expect(within(run).getByTestId('channel-card-1')).toBeTruthy();
    expect(within(run).getByTestId('channel-card-2')).toBeTruthy();
    expect(getComputedStyle(run).gap).toBe('var(--t-space-list-row)');
    expect(getComputedStyle(screen.getByTestId('conversation-column')).gap).toBe('var(--t-space-conversation-block)');
  });
});
