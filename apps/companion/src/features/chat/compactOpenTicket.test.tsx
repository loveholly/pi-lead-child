// @vitest-environment jsdom
// 手机宽度下，在会话里点工单消息回执（「发给 #N 的工单消息」）或嵌入的工单卡片，要打开工单。
// 以前它们只选中工单、把面板设成 thread，没有离开会话页；而会话页不画工单面板，
// 用户看到的只是页眉变成「#N · 当前工单」。这里渲染真正的 Workbench，按用户看得到的结果断言。
import type { ConversationTurn, TicketSummary } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import Workbench from '../workspace/Workbench.web';
import { MessagePartView } from './MessagePartView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const ROUTED = 7;
const CREATED = 8;

function ticket(id: number): TicketSummary {
  return {
    id,
    title: `工单 ${id}`,
    summary: '',
    kind: 'task',
    hasRun: true,
    priority: 'normal',
    project: null,
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-10-14T08:00:00.000Z',
    parentTicketId: null,
    rootTicketId: id,
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    stage: 'ready',
    status: 'ready',
  };
}

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: null, originKind: 'paired:companion', ticketId: null, state: 'completed',
    userText: '', assistantText: '', error: null,
    createdAt: '2026-10-14T08:00:00.000Z', updatedAt: '2026-10-14T08:00:00.000Z',
    ...overrides,
  };
}

// 会话里有一条发给 #7 的工单消息（回执），和一轮建了 #8 的 Lead 回复（嵌入的工单卡片）。
function runtimeOnConversation() {
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets([ticket(ROUTED), ticket(CREATED)]);
  runtime.control.getState().replaceConversation(SESSION, [
    turn('turn-routed', { ticketId: ROUTED, userText: '先跑一遍测试' }),
    turn('turn-created', {
      userText: '帮我建个工单', assistantText: '建好了。',
      createdAt: '2026-10-14T08:01:00.000Z', updatedAt: '2026-10-14T08:01:00.000Z',
    }),
  ]);
  applyControlPlaneMutation(runtime.control, SESSION, {
    type: 'lead.upsert-ticket-part', turnId: 'turn-created', partId: `turn-created:ticket:${CREATED}`, ticketId: CREATED,
  });
  runtime.workspace.setState({ hydrated: true });
  return runtime;
}

// react-native-web 的窗口宽度读 document.documentElement.clientWidth，jsdom 里它是 0。
function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

function renderPhoneConversation() {
  setWidth(390);
  const runtime = runtimeOnConversation();
  renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
  act(() => runtime.workspace.getState().setCompactDestination('conversation'));
  expect(screen.getByTestId('lead-conversation')).toBeTruthy();
  return runtime;
}

function expectThreadOpenOn(runtime: ReturnType<typeof runtimeOnConversation>, ticketId: number) {
  const workspace = runtime.workspace.getState();
  expect(workspace.selectedTicketId).toBe(ticketId);
  expect(workspace.compactDestination).not.toBe('conversation');
  expect(workspace.compactPanel).toBe('thread');
  const thread = screen.getByTestId('ticket-thread');
  expect(within(thread).getByTestId('ticket-thread-header-id').textContent).toBe(`#${ticketId}`);
}

function closeThreadBackToConversation(runtime: ReturnType<typeof runtimeOnConversation>) {
  fireEvent.click(screen.getByTestId('ticket-thread-header-close'));
  expect(runtime.workspace.getState().compactDestination).toBe('conversation');
  expect(runtime.workspace.getState().compactPanel).toBeNull();
  expect(screen.queryByTestId('ticket-thread')).toBeNull();
  expect(screen.getByTestId('lead-conversation')).toBeTruthy();
}

afterEach(() => setWidth(0));

describe('opening a ticket from the phone conversation', () => {
  it('opens the ticket from a routed-message receipt, and 返回 goes back to the conversation', () => {
    const runtime = renderPhoneConversation();

    fireEvent.click(screen.getByRole('button', { name: `发给 #${ROUTED} 的工单消息` }));
    expectThreadOpenOn(runtime, ROUTED);
    // 你点回执是想看那条消息的回答：工单对话直接展开（方案 D），手机上也能回复（复核 P0-2）。
    expect(runtime.workspace.getState().ticketChatExpandedId).toBe(ROUTED);
    expect(screen.getByTestId('ticket-chat-dock-toggle').getAttribute('aria-expanded')).toBe('true');
    expect(within(screen.getByTestId('ticket-chat-dock')).getByRole('textbox')).toBeTruthy();

    closeThreadBackToConversation(runtime);
  });

  it('opens the ticket from an embedded ticket card, and 返回 goes back to the conversation', () => {
    const runtime = renderPhoneConversation();

    fireEvent.click(screen.getByTestId(`open-ticket-${CREATED}`));
    expectThreadOpenOn(runtime, CREATED);
    // 打开工单本身时先看概览：对话收在底部，输入框还在。
    expect(runtime.workspace.getState().ticketChatExpandedId).toBeNull();
    expect(screen.getByTestId('ticket-chat-dock-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(within(screen.getByTestId('ticket-chat-dock')).getByRole('textbox')).toBeTruthy();

    closeThreadBackToConversation(runtime);
  });
});

describe('opening a ticket from inside an open phone ticket thread', () => {
  it('keeps the destination that 返回 goes back to', () => {
    setWidth(390);
    const runtime = runtimeOnConversation();
    // 从会话打开了 #7 的工单详情；详情里有一张 #8 的嵌入卡片。
    runtime.workspace.setState({
      selectedTicketId: ROUTED,
      compactDestination: 'tickets',
      ticketReturnDestination: 'conversation',
      compactPanel: 'thread',
    });
    const partId = `turn-created:ticket:${CREATED}`;
    renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <MessagePartView compact messageId={`${SESSION}:turn-created:assistant`} partId={partId} role="assistant" messageState="completed" />
      </CompanionRuntimeProvider>,
    );

    fireEvent.click(screen.getByTestId(`open-ticket-${CREATED}`));

    const workspace = runtime.workspace.getState();
    expect(workspace.selectedTicketId).toBe(CREATED);
    expect(workspace.compactPanel).toBe('thread');
    expect(workspace.ticketReturnDestination).toBe('conversation');
  });
});
