// @vitest-environment jsdom
// 会话里没有原始错误。实例上的样子：
//   · 每次心跳巡检多一个红框，框里是 503 的整段 JSON；
//   · 「Run crashed」卡片是一张键值表（Failure category / scope / Needs / Error code）加英文的下一步；
//   · 工单消息的回执只写「处理失败」。
// 现在每一种都是一句白话：发生了什么、系统在做什么、你能做什么（能做就给按钮）。原文收在「技术详情」里。
// 同一种失败连着出现时合成一张卡片，写次数和最近一次的时间。
import {
  PROTOCOL_VERSION, type ConversationTurn, type GatewayEvent, type KernelCheckpoint, type LeadStatus, type Overview,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { reduceGatewayEvent } from '../../state/control-plane/eventReducer';
import { adaptGatewayEvent } from '../../state/control-plane/protocolAdapter';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { formatConversationTime, LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const UNAVAILABLE = '503: {"message":"upstream connect error or disconnect/reset before headers (providers=claude)"}';
// 用户实际遇到的失败：代理返回 503 auth_unavailable，里面包着上游的 403 forbidden "Request not allowed"。
const LIVE_AUTH = '503: {"message":"auth_unavailable: no auth available (providers=claude, model=claude-sonnet-5-5; '
  + 'last upstream error: {\\n  \\"error\\": {\\n    \\"type\\": \\"forbidden\\",\\n    '
  + '\\"message\\": \\"Request not allowed\\"}}","type":"server_error"}';

const degraded: LeadStatus = {
  state: 'degraded', since: '2026-10-13T12:38:10.000Z', failures: 4, reason: 'Lead 的模型服务暂时连不上',
  detail: UNAVAILABLE, nextAttemptAt: '2026-10-13T14:08:00.000Z', lastSuccessAt: '2026-10-13T11:05:31.000Z',
};

function turn(id: string, overrides: Partial<ConversationTurn>): ConversationTurn {
  return {
    id, originBindingId: null, originKind: 'paired:companion', ticketId: null, state: 'completed',
    userText: '', assistantText: '', error: null,
    createdAt: '2026-10-13T12:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z',
    ...overrides,
  };
}

const heartbeats = ['12:38:10', '13:08:00', '13:38:00'].map((clock, index) => turn(`heartbeat-${index}`, {
  originKind: 'system:heartbeat', state: 'failed', error: UNAVAILABLE,
  createdAt: `2026-10-13T${clock}.000Z`, updatedAt: `2026-10-13T${clock}.000Z`,
}));
const userTurn = turn('user-1', {
  originBindingId: 1, userText: '现在有什么要我处理', state: 'failed', error: UNAVAILABLE,
  createdAt: '2026-10-13T13:40:00.000Z', updatedAt: '2026-10-13T13:40:02.000Z',
});
const ticketTurn = turn('ticket-1', {
  originBindingId: 1, originKind: 'paired:companion:ticket-agent', ticketId: 66, userText: '现在还需要我做什么',
  state: 'failed', error: 'No conversation found with session ID: 20fd5938-01a7-42ce-b4b4-bb1a98831c80',
  createdAt: '2026-10-13T13:42:00.000Z', updatedAt: '2026-10-13T13:42:04.000Z',
});

// engine 的 recordRunCrash 写下的检查点：任务作用域的失败请 Lead 判断，所以标题和下一步是写给 Lead 的英文。
const runCrashed: KernelCheckpoint = {
  id: 95, ticketId: 51, attemptId: 70, author: { kind: 'system', runtime: null }, source: 'system_derived',
  stage: null, kind: 'blocked', title: 'Run crashed',
  summary: 'Run #70 crashed (process_exit): Codex exited with code 1',
  keyFacts: [
    { label: 'Agent', value: 'Codex' },
    { label: 'Runtime', value: 'codex' },
    { label: 'Model', value: 'gpt-5.5' },
    { label: 'Failure category', value: 'unknown' },
    { label: 'Failure scope', value: 'unknown' },
    { label: 'Needs', value: 'none' },
    { label: 'Error code', value: 'process_exit' },
  ],
  artifactRefs: [], relatedTicketIds: [],
  nextStep: 'Inspect the runtime failure, adjust the execution path if needed, and retry.',
  actionRef: null,
  createdAt: '2026-10-13T13:45:00.000Z',
};

function overview(lead: LeadStatus): Overview {
  return {
    model: 'claude-sonnet-5-5', sessionId: SESSION, busy: false, runningTicketIds: [],
    counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
    aish: null, lead,
  };
}

function live(seq: number, turnId: string, type: GatewayEvent['type'], payload: Record<string, unknown>): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type,
    occurredAt: '2026-10-13T13:39:00.000Z', requiredScope: 'chat', audienceBindingId: null, turnId, ticketId: null, payload,
  };
}

function setup() {
  const sendChat = vi.fn(async () => ({ clientMessageId: 'resent' }));
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.sendChat = sendChat as typeof runtime.sendChat;
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', overview: overview(degraded) });
  runtime.control.getState().replaceConversation(SESSION, [...heartbeats, userTurn, ticketTurn]);
  runtime.control.getState().mergeConversationCardPage({
    items: [{
      id: 1, key: 'checkpoint:95', kind: 'checkpoint', turnId: null, ticketId: 51, checkpointId: 95,
      createdAt: runCrashed.createdAt, updatedAt: runCrashed.createdAt,
    }],
    checkpoints: [runCrashed],
    interventionRefs: [],
    hasMore: false,
    nextBeforeId: null,
  }, 'replace');
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return { sendChat, runtime };
}

function conversationText(): string {
  return screen.getByTestId('lead-conversation').textContent ?? '';
}

// 2026-10-16 用户要求：失败卡按内容定宽、Lead 动态占满一栏、正文限在 560，三种宽度混在一起。
// 现在 Lead 一侧所有的块都在同一个内容列里，各自占满这一列。
describe('the width of the Lead side', () => {
  it('puts every block in the one conversation column, each filling it', () => {
    setup();
    const columns = screen.getAllByTestId('conversation-column');
    expect(columns).toHaveLength(1);
    const column = columns[0]!;
    // 底栏（执行中 · 需要处理）和输入框用同一个居中的列，和上面的内容对齐（2026-10-16）。
    const footer = screen.getByTestId('conversation-footer-column');
    expect(getComputedStyle(footer).maxWidth).toBe(getComputedStyle(column).maxWidth);
    expect(getComputedStyle(footer).alignSelf).toBe('center');
    expect(footer.querySelector('[placeholder]')).toBeTruthy();
    for (const block of [...screen.getAllByTestId('failure-card'), ...screen.queryAllByTestId('markdown-message')]) {
      expect(column.contains(block)).toBe(true);
      expect(getComputedStyle(block).maxWidth).not.toBe('var(--t-size-prose)');
      const shrinking: string[] = [];
      for (let node: HTMLElement | null = block; node && node !== column; node = node.parentElement) {
        if (getComputedStyle(node).alignSelf === 'flex-start') shrinking.push(node.getAttribute('data-testid') ?? node.tagName);
      }
      expect(shrinking).toEqual([]);
    }
  });
});

describe('failures in the Lead conversation', () => {
  it('shows no raw error text until the user opens the technical details', () => {
    setup();
    const text = conversationText();
    for (const raw of ['503', 'upstream connect error', 'No conversation found', 'Failure category', 'Needs', 'Inspect the runtime failure', 'Run crashed']) {
      expect(text).not.toContain(raw);
    }
  });

  it('collapses repeated heartbeat failures into one card with the count and the latest time', () => {
    setup();
    const cards = screen.getAllByTestId('failure-card');
    const heartbeat = cards.find((card) => card.textContent?.includes('心跳巡检'))!;
    expect(cards.filter((card) => card.textContent?.includes('心跳巡检'))).toHaveLength(1);
    // 2026-10-27 画布「没有回答」状态 4：后台巡检失败合成居中的一行系统信息，写次数、最近一次和系统什么时候再试，不给按钮。
    expect(heartbeat.textContent).toBe(
      `心跳巡检没有完成 · 连续 3 次 · 最近 ${formatConversationTime('2026-10-13T13:38:00.000Z')}`
        + ` · 系统会在 ${formatConversationTime(degraded.nextAttemptAt!)} 自动再试`,
    );
    expect(within(heartbeat).queryAllByRole('button')).toHaveLength(0);
    expect(heartbeat.textContent).not.toContain('upstream connect error');
  });

  it('adds a heartbeat failure that arrives live to the same card', () => {
    // 只用快照里的三轮（不带后面的用户消息），新的一次心跳失败从事件流里来。
    const runtime = createCompanionStateRuntime({
      client: {} as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected', overview: overview(degraded) });
    runtime.control.getState().replaceConversation(SESSION, heartbeats);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    act(() => {
      for (const item of [
        live(1, 'heartbeat-live', 'lead.turn.started', { messageId: 'msg_heartbeat-live', commandId: null, originKind: 'system:heartbeat', mode: 'started' }),
        live(2, 'heartbeat-live', 'notice.created', { severity: 'error', message: UNAVAILABLE }),
      ]) {
        const adapted = adaptGatewayEvent(item);
        if (!adapted.ok) throw new Error(adapted.error);
        for (const mutation of reduceGatewayEvent(adapted.event).control) applyControlPlaneMutation(runtime.control, SESSION, mutation);
      }
    });
    const cards = screen.getAllByTestId('failure-card');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain('连续 4 次');
  });

  it('shows a blocker line from the daemon as a notice that opens its ticket', () => {
    const runtime = createCompanionStateRuntime({
      client: {} as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({ phase: 'ready', connectionState: 'connected', overview: overview(degraded) });
    runtime.control.getState().replaceConversation(SESSION, [turn('notice-1', {
      originKind: 'system:blocker-notice', assistantText: '工单 #12 卡住了：执行重试已耗尽（执行失败 2/2），已停止派发。',
      createdAt: '2026-10-13T13:50:00.000Z', updatedAt: '2026-10-13T13:50:00.000Z',
    })]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    const notice = screen.getByTestId('blocker-notice');
    expect(notice.textContent).toContain('工单 #12 卡住了：执行重试已耗尽（执行失败 2/2），已停止派发。');
    expect(within(notice).getByRole('button', { name: '打开工单 #12' })).toBeTruthy();
  });

  it('tells the user their message got no answer and offers to resend it', async () => {
    const { sendChat } = setup();
    // 2026-10-27 画布「没有回答」状态 1、2：一行虚线框引用你那句话；原因和接下来在点开的浮层里。
    const card = screen.getAllByTestId('failure-card').find((candidate) => candidate.textContent?.includes('没有回答'))!;
    expect(card.textContent).toContain('没有回答 · 你问的「现在有什么要我处理」');
    fireEvent.click(within(card).getByRole('button', { name: '没有回答，展开' }));
    const details = await screen.findByTestId('failure-card-details');
    expect(details.textContent).toContain('Paimon 的模型服务暂时连不上');
    expect(details.textContent).toContain('系统不会自动重发，你可以点「重发」。');
    fireEvent.click(screen.getByRole('button', { name: '没有回答，收起' }));
    act(() => fireEvent.click(within(card).getByRole('button', { name: '重发' })));
    expect(sendChat).toHaveBeenCalledWith('现在有什么要我处理');
  });

  // 2026-10-27 画布「没有回答」状态 2：点开以后「原因」一行写现在用的模型，后面「换个模型重发」：
  // 点开同一个模型浮层，选了另一个模型，就换上它，再发一次你那句话。
  it('switches Lead to another model and resends the question from the reason row', async () => {
    const { sendChat, runtime } = setup();
    const switchLeadModel = vi.spyOn(runtime, 'switchLeadModel').mockResolvedValue({
      previous: { model: 'claude-sonnet-5-5', effort: null }, selected: { model: 'vibeproxy/claude-opus-5-5', effort: null }, applied: 'now',
    } as never);
    vi.spyOn(runtime, 'loadLeadModels').mockResolvedValue({
      current: { model: 'claude-sonnet-5-5', effort: null }, selected: { model: 'claude-sonnet-5-5', effort: null },
      models: [
        { model: 'claude-sonnet-5-5', provider: 'vibeproxy', id: 'claude-sonnet-5-5', prefix: null, source: 'anthropic', name: null, image: true, efforts: [], defaultEffort: null, blockedUntil: null },
        { model: 'vibeproxy/claude-opus-5-5', provider: 'vibeproxy', id: 'claude-opus-5-5', prefix: null, source: 'anthropic', name: null, image: true, efforts: [], defaultEffort: null, blockedUntil: null },
      ],
    } as never);
    const card = screen.getAllByTestId('failure-card').find((candidate) => candidate.textContent?.includes('没有回答'))!;
    fireEvent.click(within(card).getByRole('button', { name: '没有回答，展开' }));
    const reason = await screen.findByTestId('failure-card-model');
    expect(reason.textContent).toContain('Paimon 的模型服务暂时连不上 · claude-sonnet-5-5');
    fireEvent.click(within(reason).getByRole('button', { name: '换个模型重发' }));
    fireEvent.click(await screen.findByTestId('lead-model-option-vibeproxy/claude-opus-5-5'));
    await waitFor(() => expect(sendChat).toHaveBeenCalledWith('现在有什么要我处理'));
    expect(switchLeadModel).toHaveBeenCalledWith({ model: 'vibeproxy/claude-opus-5-5', effort: null });
  });

  it('does not promise a retry for the proxy\'s 503 auth_unavailable around an upstream 403', () => {
    const runtime = createCompanionStateRuntime({
      client: {} as CompanionRuntimeDependencies['client'],
      credentials: {} as CompanionRuntimeDependencies['credentials'],
      scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    });
    runtime.control.setState({
      phase: 'ready', connectionState: 'connected',
      overview: overview({ ...degraded, reason: 'Lead 的模型账号认证失败', detail: LIVE_AUTH }),
    });
    runtime.control.getState().replaceConversation(SESSION, [
      turn('heartbeat-auth', {
        originKind: 'system:heartbeat', state: 'failed', error: LIVE_AUTH,
        createdAt: '2026-10-13T13:38:00.000Z', updatedAt: '2026-10-13T13:38:00.000Z',
      }),
      turn('user-auth', {
        originBindingId: 1, userText: '现在有什么要我处理', state: 'failed', error: LIVE_AUTH,
        createdAt: '2026-10-13T13:40:00.000Z', updatedAt: '2026-10-13T13:40:02.000Z',
      }),
    ]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    const cards = screen.getAllByTestId('failure-card');
    const heartbeat = cards.find((card) => card.textContent?.includes('心跳巡检'))!;
    const user = cards.find((card) => card.textContent?.includes('没有回答'))!;
    expect(heartbeat.textContent).toContain('心跳巡检没有完成 · 系统没法自己恢复，请检查 Paimon 的模型账号');
    // 认证失败时直接重发也一样失败：一行里先说要检查什么，不引用你那句话。
    expect(user.textContent).toContain('没有回答 · 请先检查 Paimon 的模型账号，再重发');
    for (const card of [heartbeat, user]) expect(card.textContent).not.toMatch(/自动再试|自动重试|请重试/);
  });

  // 2026-10-15 用户决定（方案 A）：主会话里发往工单的消息只留一行灰色的「消息尾巴」，不画红框、不给「重发」。
  // 送不到时系统把这条消息交给 Lead（daemon 的 handTicketMessageToLead），由它接手。
  it('shows a failed ticket message as a quiet tail that says Lead took it over', () => {
    const { sendChat } = setup();
    const receipt = screen.getByTestId('ticket-direct-notice-66');
    expect(within(receipt).getByRole('button', { name: '发给 #66 的工单消息' })).toBeTruthy();
    expect(receipt.textContent).toContain('你在 #66 问了「现在还需要我做什么」');
    expect(receipt.textContent).toContain('没送到 · 已交给 Paimon');
    expect(within(receipt).queryByRole('button', { name: '重发' })).toBeNull();
    expect(within(receipt).queryByTestId('failure-card')).toBeNull();
    expect(sendChat).not.toHaveBeenCalled();
  });

  // 2026-10-27：系统写的检查点是一行系统信息（居中一行中文，要你处理时带按钮，原文点开再看）。
  it('turns the Run crashed key-value card into one line with the facts behind it', async () => {
    setup();
    const line = screen.getByTestId('checkpoint-line-95');
    // 这时 Lead 的模型连不上（顶栏降级）：不说"Lead 会判断"，给出你现在能做的事。
    expect(line.textContent).toContain('工单 #51 的 Codex 运行出错，Paimon 现在连不上模型，恢复后会判断能不能安全重试；着急的话可以打开工单自己处理');
    expect(within(line).getByRole('button', { name: '打开工单 #51' })).toBeTruthy();
    expect(line.textContent).not.toContain('Failure category');
    fireEvent.click(within(line).getByRole('button', { name: '看原文' }));
    const details = await screen.findByTestId('checkpoint-line-95-details');
    expect(details.textContent).toContain('Failure category');
    expect(details.textContent).toContain('Codex exited with code 1');
  });
});
