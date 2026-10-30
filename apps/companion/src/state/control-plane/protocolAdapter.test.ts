import { PROTOCOL_VERSION, type GatewayEvent } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import type { MessagePart } from '../types';
import { reduceGatewayEvent } from './eventReducer';
import { adaptGatewayEvent, projectToolDisplay } from './protocolAdapter';

function event(type: GatewayEvent['type'], payload: Record<string, unknown>, overrides: Partial<GatewayEvent> = {}): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: `event-${type}`,
    seq: 1,
    type,
    occurredAt: '2026-07-24T08:00:00.000Z',
    requiredScope: type.startsWith('lead.') || type === 'notice.created' ? 'chat' : 'tickets:view',
    audienceBindingId: null,
    turnId: type.startsWith('lead.') || type === 'notice.created' ? 'turn-1' : null,
    ticketId: null,
    payload,
    ...overrides,
  };
}

describe('gateway payload adaptation', () => {
  it('validates a Lead delta into a discriminated payload', () => {
    const result = adaptGatewayEvent(event('lead.message.delta', {
      messageId: 'message-1',
      delta: 'hello',
    }));

    expect(result).toMatchObject({
      ok: true,
      event: { type: 'lead.message.delta', payload: { messageId: 'message-1', delta: 'hello' } },
    });
  });

  it('rejects malformed payloads as invalidation-only diagnostics', () => {
    const result = adaptGatewayEvent(event('lead.message.delta', {
      messageId: 'message-1',
      delta: 42,
    }));

    expect(result).toEqual({
      ok: false,
      type: 'lead.message.delta',
      error: 'invalid payload for lead.message.delta',
      invalidations: ['conversation:current'],
    });
  });

  // 消费端一半的契约。生产端那一半在 test/gateway-event-payloads.test.ts：那里断言
  // src/ 里的 publish 助手确实产出下面这些键，改了任一侧都会有一侧先红。
  //
  // 这些形状此前**全部**校验失败：payload schema 是 additionalProperties:false，而生产端
  // 一直在带 ticketId / parentTicketId / snapshotRequired / operationState。失败的事件被降级到
  // invalidationsFor() 的粗兜底，ticket.updated 只剩 tickets+overview、attempt.* 只剩一个
  // 没人观察的 execution:<id>，于是任务栏收不到 work-items / workbench 的刷新，停在旧快照上。
  describe('daemon payload shapes', () => {
    const shapes: [GatewayEvent['type'], Record<string, unknown>, string][] = [
      ['ticket.created', { ticketId: 7 }, 'gateway/paired-server.ts createTicket'],
      ['ticket.created', { ticketId: 7, parentTicketId: 3, snapshotRequired: true }, 'coordinator/service.ts'],
      ['ticket.updated', { snapshotRequired: true }, 'daemon/server.ts SCHEDULE_MUTATING_LEAD_TOOLS'],
      ['ticket.updated', { ticketId: 7, snapshotRequired: true }, 'store/gateway-events.ts itemUpdatedEvent'],
      ['ticket.updated', { attemptId: 4, snapshotRequired: true }, 'daemon/server.ts runtime message.completed'],
      ['ticket.updated', { status: 'review', childError: null, snapshotRequired: true }, 'daemon/server.ts onChildDone'],
      ['attempt.started', { attemptId: 4, ticketId: 7, snapshotRequired: true }, 'store/gateway-events.ts runStartedEvent'],
      ['attempt.updated', { attemptId: 4, ticketId: 7, snapshotRequired: true }, 'store/gateway-events.ts runUpdatedEvent'],
      ['lead.tool.started', { toolCallId: 'call-1', toolName: 'create_task', operationState: 'started', args: {} }, 'gateway/event-projection.ts projectToolEvent'],
      ['lead.tool.completed', { toolCallId: 'call-1', toolName: 'create_task', operationState: 'completed', result: {}, isError: false }, 'gateway/event-projection.ts projectToolEvent'],
      ['child.tool.started', { attemptId: 4, toolCallId: 'call-1', toolName: 'shell', operationState: 'started', args: {} }, 'daemon/server.ts childRuntimeEvent'],
      ['approval.required', { approvalId: 9, ticketId: 7, snapshotRequired: true }, 'coordinator/interventions.ts requestApproval'],
      ['approval.required', { approvalId: 9, requestedBy: 'child', tool: 'shell', action: 'rm', expiresAt: '2026-07-28T00:00:00.000Z' }, 'daemon/server.ts approval broadcast'],
      ['approval.resolved', { approvalId: 9, status: 'resolved', sessionExempt: false, snapshotRequired: true }, 'coordinator/interventions.ts resolveApproval'],
      ['notice.created', { severity: 'error', message: 'boom' }, 'daemon/server.ts notice'],
    ];

    for (const [type, payload, origin] of shapes) {
      it(`accepts ${type} as published by ${origin}`, () => {
        expect(adaptGatewayEvent(event(type, payload))).toMatchObject({ ok: true });
      });
    }
  });

  // 网关的 snapshot.required 带着 resource（apps/daemon/src/server.ts 的连接、gateway/paired-server.ts 的项目和通知）。
  // 以前 payload 必须是空对象，这三种全被拒掉：连接页从来收不到刷新（issue 07）。
  describe('snapshot.required as the gateway publishes it', () => {
    const shapes: [Record<string, unknown>, string[], string][] = [
      [{ resource: 'connections' }, ['connections'], 'daemon/server.ts ConnectionHub onChange'],
      [{ resource: 'memory' }, ['memory'], 'daemon memory controller (settings, download progress)'],
      [{ resource: 'decision-model' }, ['decision-model'], 'daemon decision model settings'],
      [{ resource: 'runtime-settings' }, ['runtime-settings'], 'daemon runtime settings'],
      [{ resource: 'channel-settings' }, ['channel-settings'], 'daemon channel settings (connect, disconnect, error)'],
      [{ resource: 'projects', projectId: 3 }, ['core'], 'gateway/paired-server.ts project archive'],
      [{ resource: 'notifications', notificationId: 5 }, ['core'], 'gateway/paired-server.ts notification ack'],
      [{}, ['core'], 'older daemons'],
    ];

    for (const [payload, invalidations, origin] of shapes) {
      it(`accepts ${JSON.stringify(payload)} from ${origin} and invalidates ${invalidations.join(', ')}`, () => {
        const result = adaptGatewayEvent(event('snapshot.required', payload));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(reduceGatewayEvent(result.event).invalidations).toEqual(invalidations);
      });
    }

    it('still rejects a resource that is not a string', () => {
      expect(adaptGatewayEvent(event('snapshot.required', { resource: 42 }))).toMatchObject({ ok: false, invalidations: ['core'] });
    });
  });

  it('projects tool data into bounded redacted display text and artifact refs', () => {
    const projection = projectToolDisplay({
      path: '/tmp/repo',
      token: 'secret-token',
      binary: 'A'.repeat(20_000),
      artifactId: 'artifact-1',
    });

    expect(projection).not.toBeNull();
    expect(projection!.preview.length).toBeLessThanOrEqual(16 * 1_024);
    expect(projection).toMatchObject({ truncated: true, redacted: true, artifactRefs: ['artifact-1'] });
    expect(projection!.preview).not.toContain('secret-token');
    expect(projection!.preview).not.toContain('A'.repeat(256));
  });

  it('never permits raw unknown tool payloads in MessagePart', () => {
    const raw: unknown = { token: 'secret' };
    const part: MessagePart = {
      kind: 'tool',
      id: 'turn-1:call-1',
      callId: 'call-1',
      name: 'shell',
      state: 'started',
      // @ts-expect-error raw protocol values must be adapted before entering Zustand
      args: raw,
      result: null,
      error: null,
    };
    expect(part.kind).toBe('tool');
  });
});
