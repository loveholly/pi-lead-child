// @vitest-environment jsdom
// 工单详情底部的对话坞（方案 D）：收起时露出最新一条、你刚做的动作和正在跑的 Run，输入框一直在。
// #66：对话排在长页面的最后（第 3 到第 10 屏）；手机上没有输入框；点了「派发独立核查」对话里什么都没有，
// 核查 Run #73 停在 starting 也没有任何地方说。
import type { ConversationTurn } from '@pi-lead-child/protocol';
import type { CredentialStore } from '@pi-lead-child/client';
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionTransport } from '../../state/runtime';
import { TicketChatDock, type TicketChatDockProps } from './TicketChatDock';

vi.mock('../../components/StatusBadge', () => ({ StatusBadge: () => null }));
vi.mock('expo-crypto', () => ({}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const TICKET = 66;

function turn(overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id: 'turn_72',
    originBindingId: 7,
    originKind: 'paired:companion:ticket-agent',
    ticketId: TICKET,
    state: 'completed',
    userText: '现在需要我做什么',
    assistantText: '我建议派一次新的核查，把 **typecheck** / `build` 补齐。你要我现在就发起吗？',
    error: null,
    createdAt: '2026-10-14T09:57:07.000Z',
    updatedAt: '2026-10-14T09:58:43.000Z',
    ...overrides,
  };
}

function renderDock(
  props: Partial<TicketChatDockProps> = {},
  turns: ConversationTurn[] = [turn({ replyActions: ['request_review'] })],
) {
  const credentials: CredentialStore = { async load() { return null; }, async save() {}, async clear() {} };
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionTransport,
    credentials,
    scheduler: { schedule: (callback) => setTimeout(callback, 0), cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => 1 },
  });
  runtime.control.getState().replaceConversation('lead-session-1', turns, { ticketId: TICKET });
  const messageIds = runtime.control.getState().messageIdsByTicket[TICKET] ?? [];
  const handlers = { onExpandedChange: vi.fn(), onSeen: vi.fn(), onSendMessage: vi.fn() };
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <TicketChatDock
        ticketId={TICKET}
        ticketDisplayId="66"
        messageIds={messageIds}
        expanded={false}
        seenMessageId={null}
        receipt={null}
        liveRun={null}
        agentName="Claude Code"
        {...handlers}
        {...props}
      />
    </CompanionRuntimeProvider>,
  );
  return { ...handlers, messageIds };
}

describe('the ticket chat dock', () => {
  it('shows the latest reply as plain text while collapsed, with the composer', () => {
    renderDock();
    const preview = screen.getByTestId('ticket-chat-preview');
    expect(preview.textContent).toContain('执行 agent · ');
    expect(preview.textContent).toContain('我建议派一次新的核查，把 typecheck / build 补齐。');
    expect(within(screen.getByTestId('ticket-chat-dock')).getByRole('textbox')).toBeTruthy();
    // 2026-10-15 方案 A：说明写清楚消息会去哪里。没有 Run 在跑时开一个对话 Run。
    // （以前写「发给 #66 的执行 agent · child #87 · 每条消息开一次对话 Run」：#87 其实是核查 agent，运行中也不会开对话 Run。）
    expect(screen.getByTestId('ticket-chat-identity').textContent)
      .toBe('发给 #66 的 agent · 开一次对话 Run，不改变工单状态');
  });

  it('marks a reply that arrived after the last one you saw', () => {
    renderDock({ seenMessageId: 'something-older' });
    expect(screen.getByTestId('ticket-chat-dock-toggle').textContent).toContain('新回复');
  });

  it('counts the messages you already had as seen the first time', () => {
    const { onSeen, messageIds } = renderDock({ seenMessageId: null });
    expect(onSeen).toHaveBeenCalledWith(messageIds[messageIds.length - 1]);
    expect(screen.getByTestId('ticket-chat-dock-toggle').textContent).not.toContain('新回复');
  });

  it('regression #66: shows your latest action when it is newer than the last message', () => {
    renderDock({ receipt: { title: '你派发了独立核查', createdAt: '2026-10-14T10:10:53.000Z' } });
    expect(screen.getByTestId('ticket-chat-receipt').textContent).toContain('你派发了独立核查');
    expect(screen.queryByTestId('ticket-chat-preview')).toBeNull();
  });

  it('regression #66: says a run that has been starting for minutes may be stuck', () => {
    renderDock({
      liveRun: {
        runId: 73, purpose: 'review', label: '核查 Run #73 · 正在准备', phase: 'starting', elapsedMs: 13 * 60_000, stalled: true,
      },
    });
    const row = screen.getByTestId('ticket-chat-live-run');
    expect(row.textContent).toContain('核查 Run #73 · 正在准备');
    expect(row.textContent).toContain('已 13 分钟');
    expect(row.textContent).toContain('可能卡住了');
  });

  it('expands when you send a message, so you see your message and the answer', () => {
    const { onSendMessage, onExpandedChange } = renderDock();
    const input = within(screen.getByTestId('ticket-chat-dock')).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'typecheck 为什么没跑？' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSendMessage).toHaveBeenCalledWith('typecheck 为什么没跑？');
    expect(onExpandedChange).toHaveBeenCalledWith(true);
  });

  // 复核 P1-9：回复问「你要我现在就发起吗？」，答案在决策卡上。现在回复下面就有按钮。
  // 回复在问哪几个动作由 daemon 的快模型判断，结果在这一轮的 replyActions 里（2026-10-19）。
  const ACTIONS: TicketChatDockProps['actions'] = [
    { id: 'request_review', label: '派发独立核查', tone: 'primary', recommended: true, disabled: false },
    { id: 'complete', label: '仍要验收通过', tone: 'danger', recommended: false, disabled: false },
    { id: 'cancel', label: '取消工单', tone: 'danger', recommended: false, disabled: false },
  ];

  it('regression #66: puts the action the reply asks about under the reply', () => {
    const onAction = vi.fn();
    const { onExpandedChange } = renderDock({ actions: ACTIONS, onAction });
    const row = screen.getByTestId('ticket-chat-actions');
    // 模型说回复只问到核查，所以只有这一个按钮。
    expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(['派发独立核查']);

    fireEvent.click(within(row).getByTestId('ticket-chat-action-request_review'));

    expect(onAction).toHaveBeenCalledWith('request_review');
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it('puts the actions under the last reply while expanded', () => {
    renderDock({ expanded: true, actions: ACTIONS, onAction: vi.fn() });
    const body = screen.getByTestId('ticket-chat-dock-body');
    expect(within(body).getByTestId('ticket-chat-action-request_review')).toBeTruthy();
  });

  // 按钮 = 模型说在问的动作 ∩ 工单现在能做的动作。模型说的「返工」工单现在做不了：不显示。
  it('shows only the asked actions that the ticket can take now', () => {
    renderDock({ actions: ACTIONS, onAction: vi.fn() }, [turn({ replyActions: ['rework', 'complete', 'request_review'] })]);
    const row = screen.getByTestId('ticket-chat-actions');
    expect(within(row).getAllByRole('button').map((button) => button.textContent)).toEqual(['派发独立核查', '仍要验收通过']);
  });

  // 以前这里用关键词表和「最后一段有问号」判断。现在没有模型的结果（还在判断、模型不可用）就不给按钮，
  // 哪怕回复里有问号、提到了核查：决策卡上照样有真正的按钮。
  it('offers nothing without a judgment from the model, whatever the reply says', () => {
    renderDock({ actions: ACTIONS, onAction: vi.fn() }, [turn({})]);
    expect(screen.queryByTestId('ticket-chat-actions')).toBeNull();
  });

  it('offers nothing when the model says the reply asks about nothing', () => {
    renderDock({ actions: ACTIONS, onAction: vi.fn() }, [turn({ replyActions: [] })]);
    expect(screen.queryByTestId('ticket-chat-actions')).toBeNull();
  });

  it('drops the actions once you acted after the reply', () => {
    renderDock({
      actions: ACTIONS,
      onAction: vi.fn(),
      receipt: { title: '你派发了独立核查', createdAt: '2026-10-14T10:10:53.000Z' },
    });
    expect(screen.queryByTestId('ticket-chat-actions')).toBeNull();
  });

  it('shows the whole conversation while expanded', () => {
    renderDock({ expanded: true });
    expect(within(screen.getByTestId('ticket-chat-dock-body')).getAllByTestId('ticket-message-bubble')).toHaveLength(2);
    expect(screen.queryByTestId('ticket-chat-preview')).toBeNull();
  });
});

// 2026-10-16 用户报告：工单详情里的对话列表滚不动。内容区写了 flex 1（react-native-web：flex-basis 0、min-height 0），
// 内容缩成一屏高，贴底对齐时多出来的部分溢出到顶部之外。内容区只能伸展，不能收缩。
// 审查发现（3688968）：收起时的预览对每一种失败都说「工单本身没有变化。展开后可以重发。」。agent 调过工具时，
// 工单可能已经变了，展开以后也没有「重发」。预览和失败行（failurePresentation）用同一条规则。
describe('a failed ticket reply in the collapsed dock', () => {
  const failed = { state: 'failed' as const, assistantText: '', error: 'process_exit: Claude Code exited with code 1' };

  it('does not promise an unchanged ticket or a resend after the agent ran a tool', () => {
    renderDock({}, [turn({
      ...failed,
      toolCalls: [{
        callId: 'call-1', name: 'Bash', state: 'completed', textOffset: 0,
        args: { preview: '{"command":"git push"}', truncated: false, redacted: false, artifactRefs: [] },
        result: { preview: 'ok', truncated: false, redacted: false, artifactRefs: [] },
        error: null, startedAt: '2026-10-14T09:57:10.000Z', endedAt: '2026-10-14T09:57:12.000Z',
      }],
    })]);
    const preview = screen.getByTestId('ticket-chat-preview').textContent ?? '';
    expect(preview).not.toContain('工单本身没有变化');
    expect(preview).not.toContain('重发');
    expect(preview).toContain('做过的事不会重做');
  });

  // 展开后的失败行拿到这一轮的工具（TicketConversation 传 tools）：去掉它，「重发」会回来，这条就失败。
  it('offers no resend in the expanded conversation after the agent ran a tool', () => {
    renderDock({ expanded: true }, [turn({
      ...failed,
      toolCalls: [{
        callId: 'call-1', name: 'Bash', state: 'completed', textOffset: 0,
        args: { preview: '{"command":"git push"}', truncated: false, redacted: false, artifactRefs: [] },
        result: { preview: 'ok', truncated: false, redacted: false, artifactRefs: [] },
        error: null, startedAt: '2026-10-14T09:57:10.000Z', endedAt: '2026-10-14T09:57:12.000Z',
      }],
    })]);
    const card = screen.getByTestId('failure-card');
    expect(within(card).queryByRole('button', { name: '重发' })).toBeNull();
    expect(card.textContent).toContain('做过的事不会重做');
  });

  it('still offers the resend when no tool ran', () => {
    renderDock({}, [turn(failed)]);
    expect(screen.getByTestId('ticket-chat-preview').textContent).toContain('没能回答这条消息，工单本身没有变化。展开后可以重发。');
  });
});

describe('the expanded ticket chat', () => {
  it('keeps the whole conversation inside the scroll area, so it scrolls', () => {
    renderDock({ expanded: true });
    const scroll = screen.getByTestId('ticket-chat-scroll');
    const collapsing: string[] = [];
    for (let node = screen.getByTestId('ticket-conversation').parentElement; node && node !== scroll; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.flexShrink === '1' && /^0(%|px)?$/.test(style.flexBasis)) collapsing.push(node.outerHTML.slice(0, 80));
    }
    expect(collapsing).toEqual([]);
  });
});

// 2026-10-16：工单对话和主会话同一个规则。面板宽时，对话和输入框在一个居中的列里，互相对齐。
describe('the ticket chat column', () => {
  it('puts the conversation and the composer in the same centered column', () => {
    renderDock({ expanded: true });
    const column = screen.getByTestId('ticket-chat-column');
    const composer = screen.getByTestId('ticket-chat-composer-column');
    expect(column.contains(screen.getByTestId('ticket-conversation'))).toBe(true);
    expect(getComputedStyle(column).alignSelf).toBe('center');
    expect(getComputedStyle(composer).maxWidth).toBe(getComputedStyle(column).maxWidth);
    expect(getComputedStyle(composer).alignSelf).toBe('center');
    // 你的气泡靠这一列的右边，最宽 70%，和主会话一样。
    const bubble = screen.getByTestId('ticket-user-message');
    expect(column.contains(bubble)).toBe(true);
    expect(getComputedStyle(bubble).alignSelf).toBe('flex-end');
    expect(getComputedStyle(bubble).maxWidth).toBe('70%');
  });
});


// 工单对话的消息一律交给这张工单的 agent（2026-10-19 用户的决定，spec D13）。输入框不再预告「由 Lead 回答」，
// 也没有「改问 Lead / 改问执行者」。续接已结束的会话时照样写预估成本：2026-10-16 #77 的一问花了 45.6 万 token。
describe('the ticket chat composer', () => {
  const resume = { attemptId: 73, role: 'reviewer' as const, runtime: 'codex' as const, lastTokens: 456_000 };
  const type = (text: string) => fireEvent.change(
    within(screen.getByTestId('ticket-chat-dock')).getByRole('textbox'), { target: { value: text } },
  );

  it('sends a progress question to the agent, with no answerer and no switch', () => {
    const { onSendMessage } = renderDock({ chatResume: resume });
    type('现在进展怎么样');
    expect(screen.getByTestId('ticket-chat-identity').textContent).toBe('发给 #66 的核查 agent · 续接 Run #73 的会话，不改变工单状态');
    expect(screen.queryByText(/由 Lead 回答/)).toBeNull();
    expect(screen.queryByText('改问 Lead')).toBeNull();
    expect(screen.queryByText('改问执行者')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(onSendMessage).toHaveBeenCalledWith('现在进展怎么样');
  });

  it('shows the estimated cost of resuming an ended session', () => {
    renderDock({ chatResume: resume });
    expect(screen.getByTestId('ticket-chat-cost').textContent).toBe('预估成本：约 45.6 万 token（按这个会话上次的用量）');
  });

  it('says it cannot estimate the cost when the last run reported no usage', () => {
    renderDock({ chatResume: { ...resume, lastTokens: null } });
    expect(screen.getByTestId('ticket-chat-cost').textContent).toBe('预估成本：无法估算');
  });

  it('shows no cost when nothing is resumed', () => {
    renderDock();
    expect(screen.queryByTestId('ticket-chat-cost')).toBeNull();
  });

  // 2026-10-19 以前，工单对话里的一些消息由 Lead 回答（工单 08 的第一版）。这些旧轮次照样写 Lead。
  it('labels an older reply from Lead in the ticket conversation', () => {
    renderDock({}, [turn({ originKind: 'paired:companion', assistantText: '#77 现在是 done。' })]);
    expect(screen.getByTestId('ticket-chat-preview').textContent).toContain('Paimon · ');
  });
});
