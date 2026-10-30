// @vitest-environment jsdom
// 会话里的一轮助手回复：任务卡在上，最后的回复在下；工具之间说的话在卡片里面。
// 卡片展开以后，同一个页面上重新渲染还是展开的（展开状态记在 workspace store）。
import { Text } from '@pi-lead-child/components';
import { foldTurnToolCalls, PROTOCOL_VERSION, type GatewayEvent } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { reduceGatewayEvent } from '../../state/control-plane/eventReducer';
import { adaptGatewayEvent } from '../../state/control-plane/protocolAdapter';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { AssistantTurnView } from './AssistantTurnView';

// CompanionStateProvider 引入 expo-crypto，它在 jsdom 里加载不了。这里只用到 store，不用加密。
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
// 消息里的工单卡片用 useOpenTicket 打开工单，它引入 expo-router。expo-router 在 jsdom 里也加载不了。
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const TURN = 'turn-1';
const ASSISTANT = `${SESSION}:${TURN}:assistant`;

function event(seq: number, type: GatewayEvent['type'], payload: Record<string, unknown>): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type,
    occurredAt: `2026-10-13T04:00:${String(seq).padStart(2, '0')}.000Z`,
    requiredScope: 'chat', audienceBindingId: null, turnId: TURN, ticketId: null, payload,
  };
}

function emptyRuntime() {
  return createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
}

function applyLive(runtime: ReturnType<typeof emptyRuntime>, events: GatewayEvent[]) {
  for (const item of events) {
    const adapted = adaptGatewayEvent(item);
    if (!adapted.ok) throw new Error(adapted.error);
    for (const mutation of reduceGatewayEvent(adapted.event).control) applyControlPlaneMutation(runtime.control, SESSION, mutation);
  }
  return runtime;
}

const started = event(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'paired:companion', mode: 'started' });

function runtimeWithTurn() {
  return applyLive(emptyRuntime(), [
    started,
    event(2, 'lead.tool.started', { toolCallId: 'a', toolName: 'query_tickets', args: { stage: 'review' }, textOffset: 7 }),
    event(3, 'lead.tool.completed', { toolCallId: 'a', toolName: 'query_tickets', result: '[]', textOffset: 7 }),
    event(4, 'lead.message.completed', { messageId: `msg_${TURN}`, text: '我先去查一下。没有待验收的工单。' }),
  ]);
}

// 把卡片和每一步都展开，直到没有收起的按钮。
function expandEverything() {
  for (let round = 0; round < 10; round += 1) {
    const closed = screen.queryAllByRole('button').filter((button) => button.getAttribute('aria-expanded') === 'false');
    if (!closed.length) return;
    for (const button of closed) fireEvent.click(button);
  }
}

function view(runtime: ReturnType<typeof runtimeWithTurn>) {
  return (
    <CompanionRuntimeProvider runtime={runtime}>
      <AssistantTurnView
        messageId={ASSISTANT}
        messageState="completed"
        renderReply={(reply) => <Text testID="reply">{reply}</Text>}
      />
    </CompanionRuntimeProvider>
  );
}

describe('an assistant turn in the conversation', () => {
  it('renders the task card above the final reply, with the narration inside the card', () => {
    const runtime = runtimeWithTurn();
    renderUI(view(runtime));

    const toggle = screen.getByRole('button', { name: /1 个工具/ });
    const reply = screen.getByTestId('reply');
    expect(reply.textContent).toBe('没有待验收的工单。');
    expect(toggle.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('我先去查一下。')).toBeNull();

    fireEvent.click(toggle);
    const narration = screen.getByText('我先去查一下。');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)!.contains(narration)).toBe(true);
    expect(narration.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('stays expanded when the conversation renders the turn again', () => {
    const runtime = runtimeWithTurn();
    const first = renderUI(view(runtime));
    fireEvent.click(screen.getByRole('button', { name: /1 个工具/ }));
    fireEvent.click(screen.getByRole('button', { name: /query_tickets/ }));
    first.unmount();

    renderUI(view(runtime));
    expect(screen.getByRole('button', { name: /1 个工具/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /query_tickets/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/"stage": "review"/)).toBeTruthy();
  });

  it('puts the reply directly below the card and the attachments after the reply', () => {
    const runtime = runtimeWithTurn();
    applyLive(runtime, [event(5, 'approval.required', { approvalId: 3 })]);
    renderUI(view(runtime));

    const toggle = screen.getByRole('button', { name: /1 个工具/ });
    const reply = screen.getByTestId('reply');
    const attachment = screen.getByText('审批 #3');
    expect(toggle.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reply.compareDocumentPosition(attachment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

// 发布评审 cb8a582：命令和输出里的密钥到了界面上。网关现在会先去掉，但卡片这一跳也要守住：
// 客户端自己的投影（protocol 的 projectToolDisplay）也会去掉，实时和刷新两条路都一样。
describe('secrets in tool calls', () => {
  const secrets = [
    'ghp_FAKEaaaaBBBBccccDDDDeeeeFFFFgggg1234', 'hunter2', 'glpat-FAKEabcdefghij0123', 'p4ssw0rd',
    'abc123def456', 'S3cret', 'gho_FAKE9999zzzzYYYYxxxxWWWWvvvvUUUU0000', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ',
    'kubepass1', 'dockerpass1', 'jsonpass1', 'pythonpass1',
  ];
  const commands = [
    "curl -H 'Authorization: token ghp_FAKEaaaaBBBBccccDDDDeeeeFFFFgggg1234' https://api.github.com/user",
    'curl -u admin:hunter2 https://x',
    'git clone https://oauth2:glpat-FAKEabcdefghij0123@gitlab.com/g/r.git',
    'DATABASE_URL=postgres://app:p4ssw0rd@db psql',
    "curl -H 'Cookie: session=abc123def456' https://x",
    'mysql -uroot -pS3cret appdb',
    'kubectl create secret generic db --from-literal=password=kubepass1',
    'docker run --env=MYSQL_ROOT_PASSWORD=dockerpass1 mysql:8',
  ];
  const output = 'gho_FAKE9999zzzzYYYYxxxxWWWWvvvvUUUU0000\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----'
    + '\n{"data":{"password":"jsonpass1"}}\n{\'password\': \'pythonpass1\'}';
  const events = [
    started,
    ...commands.flatMap((command, index) => [
      event(2 + index * 2, 'lead.tool.started', { toolCallId: `c${index}`, toolName: 'bash', args: { command }, textOffset: 0 }),
      event(3 + index * 2, 'lead.tool.completed', { toolCallId: `c${index}`, toolName: 'bash', result: { content: [{ type: 'text', text: output }] }, textOffset: 0 }),
    ]),
    event(20, 'lead.message.completed', { messageId: `msg_${TURN}`, text: '做完了。' }),
  ];

  it('never renders them, live or after a reload', () => {
    const live = renderUI(view(applyLive(emptyRuntime(), events)));
    expandEverything();
    for (const secret of secrets) expect.soft(document.body.textContent, `live: ${secret}`).not.toContain(secret);
    expect(document.body.textContent).toContain('https://api.github.com/user');
    live.unmount();

    const reloaded = emptyRuntime();
    reloaded.control.getState().replaceConversation(SESSION, [{
      id: TURN, originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'completed',
      userText: '跑一下', assistantText: '做完了。', error: null,
      createdAt: '2026-10-13T04:00:00.000Z', updatedAt: '2026-10-13T04:00:30.000Z',
      toolCalls: foldTurnToolCalls(events),
    }]);
    renderUI(view(reloaded));
    expandEverything();
    for (const secret of secrets) expect.soft(document.body.textContent, `reload: ${secret}`).not.toContain(secret);
  });
});

// 2026-10-15 用户决定（方案 A）：主会话把工具调用并进消息头，不再单独画一张卡。
describe('the tools in the message header', () => {
  it('puts the tool summary next to the sender and time, without a card', () => {
    renderUI(
      <CompanionRuntimeProvider runtime={runtimeWithTurn()}>
        <AssistantTurnView
          messageId={ASSISTANT}
          messageState="completed"
          header="Lead · 12:00"
          taskVariant="inline"
          renderReply={(reply) => <Text testID="reply">{reply}</Text>}
        />
      </CompanionRuntimeProvider>,
    );
    expect(screen.getByText('Lead · 12:00')).toBeTruthy();
    expect(screen.getByRole('button', { name: /1 个工具/ })).toBeTruthy();
    expect(screen.queryByTestId(`task-card-${ASSISTANT}`)).toBeNull();
    expect(screen.getByTestId(`task-card-${ASSISTANT}-inline`)).toBeTruthy();
  });

  it('still shows the header when the turn used no tools', () => {
    const runtime = applyLive(emptyRuntime(), [
      started,
      event(2, 'lead.message.completed', { messageId: `msg_${TURN}`, text: '好的。' }),
    ]);
    renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <AssistantTurnView
          messageId={ASSISTANT}
          messageState="completed"
          header="Lead · 12:00"
          taskVariant="inline"
          renderReply={(reply) => <Text testID="reply">{reply}</Text>}
        />
      </CompanionRuntimeProvider>,
    );
    expect(screen.getByText('Lead · 12:00')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /个工具/ })).toBeNull();
  });
});

// 2026-10-15 方案 A：回复下面的「依据」标签按这一轮实际读过的东西生成（provenance.test.ts）。
describe('the provenance under a reply', () => {
  it('lists what Lead read, in the main conversation only', () => {
    const runtime = applyLive(emptyRuntime(), [
      started,
      event(2, 'lead.tool.started', { toolCallId: 'r', toolName: 'read_run_events', args: { run_id: 87 }, textOffset: 0 }),
      event(3, 'lead.tool.completed', { toolCallId: 'r', toolName: 'read_run_events', result: '…', textOffset: 0 }),
      event(4, 'lead.message.completed', { messageId: `msg_${TURN}`, text: '复跑的 E2E 两个用例都通过。' }),
    ]);
    const view = renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <AssistantTurnView messageId={ASSISTANT} messageState="completed" header="Lead · 18:00" taskVariant="inline"
          renderReply={(reply) => <Text testID="reply">{reply}</Text>} />
      </CompanionRuntimeProvider>,
    );
    expect(screen.getByText('依据：Run #87 的事件')).toBeTruthy();
    view.unmount();
    renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <AssistantTurnView messageId={ASSISTANT} messageState="completed" renderReply={(reply) => <Text testID="reply">{reply}</Text>} />
      </CompanionRuntimeProvider>,
    );
    expect(screen.queryByText('依据：Run #87 的事件')).toBeNull();
  });

  // 2026-10-16 用户要求：标签可以点开，看 Lead 依据的具体工单、通知或事件；点一张工单就打开它。
  it('opens what Lead read, and a listed ticket opens that ticket', async () => {
    const runtime = applyLive(emptyRuntime(), [
      started,
      event(2, 'lead.tool.started', { toolCallId: 'n', toolName: 'list_needs_user', args: {}, textOffset: 0 }),
      event(3, 'lead.tool.completed', {
        toolCallId: 'n', toolName: 'list_needs_user', textOffset: 0,
        result: { content: [{ type: 'text', text: '需要用户处理的工单共 1 张：\n#66 [review] 成果快照与登记机制 — 核查未派发' }] },
      }),
      event(4, 'lead.message.completed', { messageId: `msg_${TURN}`, text: '有 1 件要你处理。' }),
    ]);
    runtime.control.getState().replaceTickets([{
      id: 66, title: '[E2E #51] FINAL #45 implementation', displayTitle: '成果快照与登记机制', summary: '', kind: 'task', hasRun: true,
      priority: 'normal', project: null, dueAt: null, deferUntil: null, updatedAt: '2026-10-16T08:00:00.000Z', parentTicketId: null,
      rootTicketId: 66, runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 0 }, stage: 'review', status: 'review',
    }]);
    renderUI(
      <CompanionRuntimeProvider runtime={runtime}>
        <AssistantTurnView messageId={ASSISTANT} messageState="completed" header="Lead · 18:00" taskVariant="inline"
          renderReply={(reply) => <Text testID="reply">{reply}</Text>} />
      </CompanionRuntimeProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '依据：等你处理的工单，查看来源' }));
    const source = await screen.findByRole('button', { name: '打开工单 #66 成果快照与登记机制' });
    fireEvent.click(source);
    expect(runtime.workspace.getState().selectedTicketId).toBe(66);
  });
});

// 2026-10-16：那一轮从 19:02 跑到 20:14，回合头写的是「3 秒」：那是工具的用时，压缩的一个多小时没算进去。
// 回合头写这一轮从开始到结束的时间；还在跑时写已经过去的时间（spec D9）。实时和刷新以后一样。
describe('the time in the turn header', () => {
  const timed = (seq: number, type: GatewayEvent['type'], payload: Record<string, unknown>, occurredAt: string): GatewayEvent =>
    ({ ...event(seq, type, payload), occurredAt });
  const inline = (runtime: ReturnType<typeof emptyRuntime>, messageState: 'completed' | 'streaming') => (
    <CompanionRuntimeProvider runtime={runtime}>
      <AssistantTurnView messageId={ASSISTANT} messageState={messageState} header="Lead · 19:02" taskVariant="inline"
        renderReply={(reply) => <Text testID="reply">{reply}</Text>} />
    </CompanionRuntimeProvider>
  );
  const longTurn = [
    timed(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'paired:companion', mode: 'started' }, '2026-10-16T11:02:00.000Z'),
    timed(2, 'lead.tool.started', { toolCallId: 'a', toolName: 'get_ticket', args: { id: 77 }, textOffset: 0 }, '2026-10-16T11:02:05.000Z'),
    timed(3, 'lead.tool.completed', { toolCallId: 'a', toolName: 'get_ticket', result: '…', textOffset: 0 }, '2026-10-16T11:02:08.000Z'),
    timed(4, 'lead.message.completed', { messageId: `msg_${TURN}`, text: 'trace PR 已经合并。' }, '2026-10-16T12:14:00.000Z'),
  ];

  it('is the whole turn from its start to its end, not the time its tools took', () => {
    const live = renderUI(inline(applyLive(emptyRuntime(), longTurn), 'completed'));
    expect(screen.getByRole('button', { name: /1 个工具 · 1 小时 12 分/ })).toBeTruthy();
    live.unmount();

    const reloaded = emptyRuntime();
    reloaded.control.getState().replaceConversation(SESSION, [{
      id: TURN, originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'completed',
      userText: 'trace 的 PR 合了吗', assistantText: 'trace PR 已经合并。', error: null,
      createdAt: '2026-10-16T11:02:00.000Z', updatedAt: '2026-10-16T12:14:00.000Z',
      toolCalls: foldTurnToolCalls(longTurn),
    }]);
    renderUI(inline(reloaded, 'completed'));
    expect(screen.getByRole('button', { name: /1 个工具 · 1 小时 12 分/ })).toBeTruthy();
  });

  it('counts up from the start of the turn while it is still running', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(new Date('2026-10-16T11:02:12.000Z'));
      const runtime = applyLive(emptyRuntime(), longTurn.slice(0, 2));
      renderUI(inline(runtime, 'streaming'));
      expect(screen.getByRole('button', { name: /get_ticket.*12 秒/ })).toBeTruthy();
      act(() => { vi.advanceTimersByTime(5_000); });
      expect(screen.getByRole('button', { name: /get_ticket.*17 秒/ })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
