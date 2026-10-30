// @ts-ignore Vitest executes source-boundary checks in Node.
import { existsSync, readFileSync } from 'node:fs';
import {
  PROTOCOL_VERSION,
  type GatewayEvent,
  type KernelCheckpoint,
  type KernelIntervention,
  type TicketSummary,
  type HelloV2,
} from '@pi-lead-child/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { CredentialStore } from '@pi-lead-child/client';
import { createCompanionStateRuntime, type CompanionTransport } from '../../state/runtime';
import type { ConversationCardEntity } from '../../state/types';
import type { Ticket } from '../workspace/model';
import {
  buildCheckpointCardViewModel,
  checkpointCurrentStateHint,
  checkpointDisplayTitle,
  formatCheckpointTime,
} from './CheckpointCard';
import {
  buildInterventionActionCommand,
  buildInterventionCardViewModel,
  buildInterventionEvidence,
  interventionDisplayTitle,
} from './InterventionCard';
import {
  buildTicketExecutionViewModel,
  selectTicketExecutionOperations,
} from './TicketExecutionCard';
import { toolStateLabel } from './ToolCallRow';

vi.mock('../../components/StatusBadge', () => ({ StatusBadge: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function runtimeWith(client: Partial<CompanionTransport>, ids = ['command-1', 'command-2']) {
  const credentials: CredentialStore = {
    async load() { return null; },
    async save() {},
    async clear() {},
  };
  const runtime = createCompanionStateRuntime({
    client: client as CompanionTransport,
    credentials,
    scheduler: {
      schedule(callback) { return setTimeout(callback, 0); },
      cancel(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
      now: () => 1,
    },
    createCommandId: () => ids.shift()!,
  });
  const hello: HelloV2 = {
    type: 'hello.v2',
    protocolVersion: PROTOCOL_VERSION,
    serverTime: '2026-07-24T08:00:00.000Z',
    timezone: 'Asia/Shanghai',
    latestSeq: 0,
    capabilities: [],
    binding: { id: 7, kind: 'companion', name: 'phone', scopes: ['chat'] },
    daemon: { model: 'stub', sessionId: 'session-1', busy: false },
  };
  runtime.handleHello(hello);
  runtime.control.setState({ connectionState: 'connected' });
  return runtime;
}

function started(commandId: string, ticketId: number | null = null): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: 'event-started',
    seq: 1,
    type: 'lead.turn.started',
    occurredAt: '2026-07-24T08:00:01.000Z',
    requiredScope: 'chat',
    audienceBindingId: 7,
    turnId: 'turn-1',
    ticketId,
    payload: { messageId: 'message-1', commandId, originKind: 'companion', mode: 'started' },
  };
}

describe('normalized Lead message parts', () => {
  it('formats checkpoint source times with the prototype 24-hour clock', () => {
    expect(formatCheckpointTime('2026-07-25T07:43:00.000Z', 'Asia/Shanghai')).toBe('15:43');
  });

  // 消息先进本机发件箱（packages/client 的 ChatOutbox），命令 id 就是它的 clientMessageId。
  it('shows a local message as soon as it is in the outbox, and aliases success without duplicates', async () => {
    const command = deferred<{ turnId: string }>();
    const sendChatCommand = vi.fn(() => command.promise);
    const runtime = runtimeWith({ sendChatCommand });

    const { clientMessageId } = await runtime.sendChat('hello');
    const optimistic = runtime.control.getState().messagesById[`optimistic:${clientMessageId}:user`];
    expect(optimistic).toMatchObject({ source: 'optimistic', state: 'queued', clientCommandId: clientMessageId });
    await vi.waitFor(() => expect(sendChatCommand).toHaveBeenCalledWith({ id: clientMessageId, message: 'hello', clientMessageId }));
    command.resolve({ turnId: 'turn-1' });

    await vi.waitFor(() => {
      const state = runtime.control.getState();
      expect(state.messageIdsBySession['session-1'].filter((id) => state.messagesById[id]?.role === 'user'))
        .toEqual(['session-1:turn-1:user']);
    });
    const state = runtime.control.getState();
    expect(state.messagesById['session-1:turn-1:user']).toMatchObject({ source: 'optimistic', state: 'completed' });
    expect(state.messagesById['session-1:turn-1:user']).not.toHaveProperty('delivery');
    expect(state.turnIdByCommandId[clientMessageId]).toBe('turn-1');
    expect(state.deliveredTurnIds['turn-1']).toBe(true);
  });

  it('keeps ticket-scoped local messages out of the Lead message list', async () => {
    const command = deferred<{ turnId: string }>();
    const runtime = runtimeWith({ sendChatCommand: vi.fn(() => command.promise) });

    const { clientMessageId } = await runtime.sendChat('这个单需要我干什么', 49);
    expect(runtime.control.getState().messageIdsBySession['session-1'] ?? []).toEqual([]);
    expect(runtime.control.getState().messageIdsByTicket[49]).toEqual([`optimistic:${clientMessageId}:user`]);
    runtime.handleEvent(started(clientMessageId, 49));
    await runtime.whenIdle();

    command.resolve({ turnId: 'turn-1' });
    await vi.waitFor(() => expect(runtime.control.getState().messageIdsByTicket[49]).toContain('session-1:turn-1:user'));
    expect(runtime.control.getState().messageIdsBySession['session-1'] ?? []).toEqual([]);
  });

  it('converges when lead.turn.started arrives before command.result', async () => {
    const command = deferred<{ turnId: string }>();
    const runtime = runtimeWith({ sendChatCommand: vi.fn(() => command.promise) });

    const { clientMessageId } = await runtime.sendChat('hello');
    runtime.handleEvent(started(clientMessageId));
    await runtime.whenIdle();
    command.resolve({ turnId: 'turn-1' });

    await vi.waitFor(() => {
      const state = runtime.control.getState();
      expect(state.turnIdsBySession['session-1']).toEqual(['turn-1']);
      expect(state.messageIdsBySession['session-1'].filter((id) => state.messagesById[id]?.role === 'user'))
        .toEqual(['session-1:turn-1:user']);
    });
  });

  it('keeps an unsent message through snapshots until the user deletes it', async () => {
    const sendChatCommand = vi.fn(async () => ({ turnId: 'turn-1' }));
    const runtime = runtimeWith({ sendChatCommand });
    runtime.control.setState({ connectionState: 'reconnecting' });

    const { clientMessageId } = await runtime.sendChat('hello');
    const messageId = `optimistic:${clientMessageId}:user`;
    expect(runtime.control.getState().messagesById[messageId]).toMatchObject({ state: 'queued', delivery: 'pending' });

    runtime.control.getState().replaceConversation('session-1', []);
    expect(runtime.control.getState().messagesById[messageId]).toBeDefined();
    runtime.dismissLocalMessage(messageId);
    expect(runtime.control.getState().messagesById[messageId]).toBeUndefined();
    // 删掉的消息不会在连上以后再发出去。
    runtime.handlers().onStateChange?.('connected');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendChatCommand).not.toHaveBeenCalled();
  });

  it('renders dynamic message parts without hard-coded ticket tools', () => {
    const viewUrl = new URL('./MessagePartView.tsx', import.meta.url);
    expect(existsSync(viewUrl)).toBe(true);
    const embedded = readFileSync(new URL('./EmbeddedTicketCard.tsx', import.meta.url), 'utf8');
    const conversation = readFileSync(new URL('./LeadConversation.tsx', import.meta.url), 'utf8');
    expect(embedded).not.toContain('<ToolCallRow tool="create_ticket"');
    expect(conversation).toContain('<MessagePartView');
    expect(conversation).toContain('useConversationCards');
    expect(conversation).toContain('useControlPlaneStore');
    expect(conversation).not.toMatch(/\buseControlPlane\(/);
  });

  it('renders agent text as markdown while keeping user messages plain', () => {
    const messageParts = readFileSync(new URL('./MessagePartView.tsx', import.meta.url), 'utf8');

    expect(messageParts).toContain("import { MarkdownMessage } from './MarkdownMessage';");
    expect(messageParts).toContain("if (role !== 'assistant')");
    expect(messageParts).toContain('<MarkdownMessage markdown={text || \'…\'} />');
    expect(messageParts).toMatch(/if \(role !== 'assistant'\) \{[^}]*<Text[^>]*>\{text \|\| '…'\}<\/Text>/s);
  });

  it('keeps maintenance notices on the same Markdown rendering path as assistant messages', () => {
    const conversation = readFileSync(new URL('./LeadConversation.tsx', import.meta.url), 'utf8');
    // 通知在最后的回复里（LeadReply），和回复走同一个 Markdown 渲染。
    expect(conversation).toContain('const { notice, remainder } = splitMaintenanceNotice(reply);');
    expect(conversation).toContain('{remainder ? <MarkdownMessage markdown={remainder} /> : null}');
    expect(conversation).toContain('<MarkdownMessage markdown={notice} />');
    expect(conversation).not.toContain('<UiText textStyle={styles.leadRemainder}>{maintenanceRemainder}</UiText>');
  });

  it('renders intervention command lifecycle from shared workspace state', () => {
    const conversation = readFileSync(new URL('./LeadConversation.tsx', import.meta.url), 'utf8');
    const intervention = readFileSync(new URL('./InterventionCard.tsx', import.meta.url), 'utf8');

    expect(conversation).toContain('interventionCommandStateById');
    expect(conversation).toContain("const connected = useConnectionState() === 'connected'");
    expect(conversation).toContain('onResolve={connected ?');
    expect(intervention).toContain('commandState');
    expect(intervention).toContain('disabled={disabled}');
    expect(intervention).not.toContain('useState<InterventionActionKey | null>');
  });

  it('separates cached conversation hydration from the live connection state', () => {
    const conversation = readFileSync(new URL('./LeadConversation.tsx', import.meta.url), 'utf8');
    const identity = readFileSync(new URL('../../components/LeadIdentity.tsx', import.meta.url), 'utf8');

    expect(conversation).toContain('useConnectionState');
    expect(conversation).toContain("const hydrated = phase === 'ready'");
    expect(conversation).toContain("const connected = connectionState === 'connected'");
    expect(conversation).toContain('显示已缓存会话 · 等待重新连接');
    // 断线时输入框照样能用：消息先进本机发件箱（outbox.test.tsx）。
    expect(conversation).toContain('连接恢复后发送');
    expect(conversation).not.toContain('disabled={!connected}');
    expect(conversation).toContain('if (!connected || historyRequest.loading) return');
    expect(conversation).toContain('disabled={!connected || historyRequest.loading || !conversationCardPage?.hasMore}');
    // 状态点不再只看连接：连接正常时还要看 Lead 的模型调用（./leadPresence，渲染测试在 leadHealthHeader.test.tsx）。
    expect(identity).toContain('leadPresence({ connectionState, phase, lead, now, name })');
  });

  it('preserves the compact destination before opening a web ticket thread', () => {
    const openTicket = readFileSync(new URL('./useOpenTicket.ts', import.meta.url), 'utf8');

    expect(openTicket).toContain('state.compactDestination');
    expect(openTicket).toContain('state.setTicketReturnDestination');
    expect(openTicket).toContain('state.setCompactDestination');
    expect(openTicket).toMatch(/setTicketReturnDestination\(compactDestination\);\s*setCompactDestination\('tickets'\);\s*openCompactPanel\('thread'\);/s);
  });

  it('projects bounded ticket execution rows with authoritative ticket metadata', () => {
    const card = {
      id: 'turn:turn-1:ticket:42',
      durableId: 9,
      source: 'durable',
      key: 'turn:turn-1:ticket:42',
      kind: 'ticket_execution',
      turnId: 'turn-1',
      ticketId: 42,
      operations: Array.from({ length: 19 }, (_, index) => ({
        id: `operation-${index}`,
        name: index === 0 ? 'create_ticket' : 'spawn_child',
        state: index === 0 ? 'completed' as const : 'running' as const,
        label: index === 0 ? '创建工单 #42' : `启动 child ${index}`,
        detail: index === 0 ? 'created ticket #42' : null,
      })),
      operationsTruncated: false,
      createdAt: '2026-07-24T08:00:00.000Z',
      updatedAt: '2026-07-24T08:01:00.000Z',
    } satisfies ConversationCardEntity;
    const ticket: Ticket = {
      id: '42',
      title: '移动控制面协议缺口审计',
      summary: '完成 protocol gap audit',
      kind: 'task',
      status: 'active',
      statusLabel: '进行中',
      hasRun: true,
      priority: 'high',
      priorityLabel: '高',
      project: 'pi-lead-child',
      runtimeLabel: '运行中',
      heartbeat: true,
      needsAttention: false,
      turn: 'running',
    };

    expect(buildTicketExecutionViewModel(card, ticket)).toMatchObject({
      ticketId: '42',
      title: ticket.title,
      statusLabel: '进行中',
      priorityLabel: '高',
      project: 'pi-lead-child',
      operationsTruncated: true,
    });
    expect(buildTicketExecutionViewModel(card, ticket).operations).toHaveLength(16);
    expect(selectTicketExecutionOperations(buildTicketExecutionViewModel(card, ticket).operations, false))
      .toHaveLength(4);
    expect(selectTicketExecutionOperations(buildTicketExecutionViewModel(card, ticket).operations, false).map((item) => item.id))
      .toEqual(['operation-0', 'operation-16', 'operation-17', 'operation-18']);
    expect(toolStateLabel).toEqual({
      started: 'starting', running: 'running', completed: 'done', failed: 'failed',
    });
  });

  it('labels child and system checkpoints without inventing progress metrics', () => {
    const childCheckpoint: KernelCheckpoint = {
      id: 12,
      ticketId: 42,
      attemptId: 73,
      author: { kind: 'executor', runtime: 'codex' },
      source: 'agent_reported',
      kind: 'completed',
      stage: 'implementation',
      title: '实现完成',
      summary: '定向测试已通过。',
      keyFacts: [{ label: 'tests', value: '35 passing' }],
      artifactRefs: ['artifact:patch-12'],
      relatedTicketIds: [],
      nextStep: '等待验收',
      actionRef: null,
      createdAt: '2026-07-24T08:00:00.000Z',
    };
    const systemCheckpoint: KernelCheckpoint = {
      ...childCheckpoint,
      id: 13,
      attemptId: null,
      author: { kind: 'system', runtime: null },
      source: 'system_derived',
      kind: 'progress',
      title: 'Runtime recovered',
    };
    const currentTicket: TicketSummary = {
      id: 42,
      title: '实现完成',
      summary: '',
      kind: 'task',
      stage: 'review',
      status: 'review',
      hasRun: true,
      priority: 'normal',
      project: 'pi-lead-child',
      dueAt: null,
      deferUntil: null,
      updatedAt: '2026-07-24T08:05:00.000Z',
      reviewState: {
        state: 'review_failed',
        label: '核查不通过，等你决定',
        reviewerAttemptId: 74,
        verdict: 'fail',
        reason: 'tests failed',
      },
      runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 0 },
    };

    expect(buildCheckpointCardViewModel(childCheckpoint, currentTicket)).toMatchObject({
      sourceLabel: expect.stringContaining('来自 child #73 的消息'),
      kindLabel: '已提交复核',
      nowLabel: '现在：核查不通过，等你决定',
      title: '实现完成',
      facts: [{ label: 'tests', value: '35 passing' }],
      artifactRefs: ['artifact:patch-12'],
    });
    expect(buildCheckpointCardViewModel(systemCheckpoint)).toMatchObject({
      sourceLabel: expect.stringContaining('系统更新'),
      kindLabel: '进展',
    });
    expect(JSON.stringify(buildCheckpointCardViewModel(childCheckpoint))).not.toMatch(/progress|percent|coverage/i);
  });

  it('explains an authorization event when the authoritative ticket is still blocked', () => {
    const checkpoint = {
      id: 14,
      ticketId: 38,
      attemptId: null,
      author: { kind: 'system' as const, runtime: null },
      source: 'system_derived' as const,
      kind: 'progress' as const,
      stage: null,
      title: 'Authorization approved, execution resumed',
      summary: 'user via paired binding:13 approved approval #1. Execution may continue.',
      keyFacts: [],
      artifactRefs: [],
      relatedTicketIds: [],
      nextStep: null,
      actionRef: null,
      createdAt: '2026-07-24T08:06:00.000Z',
    } satisfies KernelCheckpoint;
    const ticket = {
      id: 38,
      title: '迁移 daemon',
      summary: '',
      kind: 'task',
      stage: 'blocked',
      status: 'blocked',
      hasRun: true,
      priority: 'normal',
      project: 'pi-lead-child',
      dueAt: null,
      deferUntil: null,
      updatedAt: '2026-07-24T08:06:00.000Z',
      runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
      attention: { pendingApprovalCount: 0, blockerCount: 1 },
    } as unknown as TicketSummary;

    expect(checkpointDisplayTitle(checkpoint)).toBe('授权已记录，等待执行状态确认');
    expect(checkpointCurrentStateHint(checkpoint, ticket)).toContain('工单仍处于阻塞');
  });

  it('maps only explicit intervention actions to strict authority commands', () => {
    const approval: KernelIntervention = {
      id: 'approval:18',
      kind: 'approval',
      authorityId: 18,
      ticketId: 42,
      attemptId: 73,
      audience: 'user',
      state: 'pending',
      title: '需要 sudo 授权',
      detail: '安装 launchd 服务需要系统权限。',
      actions: ['approve', 'reject', 'approve_session'],
      resolution: null,
      createdAt: '2026-07-24T08:00:00.000Z',
      resolvedBy: null,
      resolvedAt: null,
    };
    const decision: KernelIntervention = {
      id: 'decision:7',
      kind: 'decision',
      authorityId: 7,
      ticketId: 42,
      attemptId: 73,
      audience: 'lead_or_user',
      blocking: true,
      allowCustom: true,
      state: 'pending',
      title: '选择兼容策略',
      detail: '请选择下一步。',
      options: [{ id: 'strict', label: '严格兼容', description: null }],
      actions: [
        { kind: 'select', optionId: 'strict', label: '严格兼容' },
        { kind: 'respond', label: '自定义回复' },
        { kind: 'dismiss', label: '暂不处理' },
      ],
      resolution: null,
      createdAt: '2026-07-24T08:00:00.000Z',
      resolvedBy: null,
      resolvedAt: null,
    };

    expect(buildInterventionActionCommand(approval, 'approve_session')).toEqual({
      authority: 'approval', decision: 'approve_session',
    });
    expect(buildInterventionActionCommand(decision, 'option:strict')).toEqual({
      authority: 'decision_request', decision: 'select', optionId: 'strict',
    });
    expect(buildInterventionActionCommand(decision, 'respond', '保持 v2')).toEqual({
      authority: 'decision_request', decision: 'respond', resolution: '保持 v2',
    });
    expect(buildInterventionActionCommand(decision, 'dismiss')).toEqual({
      authority: 'decision_request', decision: 'dismiss',
    });
    expect(() => buildInterventionActionCommand(decision, 'respond', '  ')).toThrow(/回复内容/);
  });

  it('projects only display-safe intervention fields and never forwards opaque payloads', () => {
    const intervention = {
      id: 'approval:18',
      kind: 'approval',
      authorityId: 18,
      ticketId: 42,
      attemptId: 73,
      audience: 'user',
      state: 'pending',
      title: '需要系统授权',
      detail: 'Operation not permitted: /Library/LaunchDaemons',
      actions: ['approve', 'reject'],
      resolution: null,
      createdAt: '2026-07-24T08:00:00.000Z',
      resolvedBy: null,
      resolvedAt: null,
      rawPayload: { authorization: 'Bearer privileged-secret' },
    } as unknown as KernelIntervention;

    const projection = buildInterventionCardViewModel(intervention, 'Paimon');
    expect(projection).toMatchObject({
      title: '需要系统授权',
      detail: 'Operation not permitted: /Library/LaunchDaemons',
      pending: true,
      // 和收件箱、状态标签同一种说法（2026-10-16）。
      stateLabel: '待审批',
    });
    expect(buildInterventionCardViewModel({ ...intervention, kind: 'decision', options: [], allowCustom: false } as unknown as KernelIntervention, 'Paimon').stateLabel)
      .toBe('待你决定');
    expect(JSON.stringify(projection)).not.toContain('privileged-secret');
    expect(JSON.stringify(projection)).not.toContain('rawPayload');
  });

  it('retains checkpoint diagnostic evidence when an intervention replaces its checkpoint card', () => {
    const checkpoint: KernelCheckpoint = {
      id: 12,
      ticketId: 42,
      attemptId: 73,
      author: { kind: 'executor', runtime: 'codex' },
      source: 'agent_reported',
      kind: 'blocked',
      stage: 'installation',
      title: 'launchd 安装被阻止',
      summary: '需要用户授权后继续。',
      keyFacts: [
        { label: 'stderr', value: 'Operation not permitted' },
        { label: 'path', value: '/Library/LaunchDaemons' },
      ],
      artifactRefs: [],
      relatedTicketIds: [],
      nextStep: '批准后重试',
      actionRef: { type: 'approval', id: 18 },
      createdAt: '2026-07-24T08:00:00.000Z',
    };

    expect(buildInterventionEvidence(checkpoint)).toEqual([
      { label: 'stderr', value: 'Operation not permitted' },
      { label: 'path', value: '/Library/LaunchDaemons' },
    ]);
    expect(interventionDisplayTitle({ title: 'Approval required' }, checkpoint)).toBeNull();
    expect(interventionDisplayTitle({ title: 'Approval required' })).toBe('Approval required');
  });
});
