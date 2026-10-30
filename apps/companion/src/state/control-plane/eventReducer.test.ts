import { PROTOCOL_VERSION, type GatewayEvent } from '@pi-lead-child/protocol';
import { describe, expect, it } from 'vitest';

import { reduceGatewayEvent } from './eventReducer';
import { adaptGatewayEvent, type ValidatedGatewayEvent } from './protocolAdapter';

function valid(type: GatewayEvent['type'], payload: Record<string, unknown>, overrides: Partial<GatewayEvent> = {}): ValidatedGatewayEvent {
  const result = adaptGatewayEvent({
    protocolVersion: PROTOCOL_VERSION,
    eventId: `event-${type}`,
    seq: 1,
    type,
    occurredAt: '2026-07-24T08:00:00.000Z',
    requiredScope: type.startsWith('lead.') || type === 'notice.created' ? 'chat' : 'tickets:view',
    audienceBindingId: null,
    turnId: type.startsWith('lead.') || type === 'notice.created' ? 'turn-1' : null,
    ticketId: 42,
    payload,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.error);
  return result.event;
}

describe('pure gateway event reduction', () => {
  it('ensures the Lead shell before appending a delta', () => {
    const reduction = reduceGatewayEvent(valid('lead.message.delta', {
      messageId: 'message-1',
      delta: 'hello',
    }));

    expect(reduction.control[0]).toMatchObject({ type: 'lead.ensure-shell', turnId: 'turn-1' });
    expect(reduction.streams).toEqual([{
      type: 'message.append-delta',
      turnId: 'turn-1',
      delta: 'hello',
    }]);
  });

  it('commits canonical completion text before clearing transient text', () => {
    const reduction = reduceGatewayEvent(valid('lead.message.completed', {
      messageId: 'message-1',
      text: 'complete',
    }));

    expect(reduction.control.map((item) => item.type)).toEqual([
      'lead.ensure-shell',
      'lead.complete-message',
    ]);
    expect(reduction.streams).toEqual([{
      type: 'message.clear-transient',
      turnId: 'turn-1',
    }]);
    expect(reduction.invalidations).toContain('conversation:current');
  });

  it('creates one composite tool part and orders canonical terminal state before stream drain', () => {
    const reduction = reduceGatewayEvent(valid('lead.tool.completed', {
      toolCallId: 'call-1',
      toolName: 'read',
      result: { value: 'done' },
      isError: false,
    }));

    expect(reduction.control).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'lead.ensure-shell', turnId: 'turn-1' }),
      expect.objectContaining({
        type: 'lead.upsert-tool-part',
        partId: 'turn-1:call-1',
        call: expect.objectContaining({ phase: 'completed', callId: 'call-1', name: 'read' }),
      }),
    ]));
    expect(reduction.streams).toEqual([{
      type: 'tool.drain-progress',
      partId: 'turn-1:call-1',
    }]);
  });

  it('derives ticket and artifact message parts from validated tool projections', () => {
    const reduction = reduceGatewayEvent(valid('lead.tool.completed', {
      toolCallId: 'call-1',
      toolName: 'create_ticket',
      result: {
        ticket_id: 42,
        artifactId: 'artifact-1',
      },
      isError: false,
    }));

    expect(reduction.control).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'lead.upsert-ticket-part',
        partId: 'turn-1:ticket:42',
        ticketId: 42,
      }),
      expect.objectContaining({
        type: 'lead.upsert-artifact-part',
        partId: 'turn-1:artifact:artifact-1',
        artifactId: 'artifact-1',
      }),
    ]));
  });

  it('projects create_ticket cards only from an authoritative completed result', () => {
    for (const type of ['lead.tool.started', 'lead.tool.updated', 'lead.tool.failed'] as const) {
      const reduction = reduceGatewayEvent(valid(type, {
        toolCallId: `call-${type}`,
        toolName: 'create_ticket',
        partialResult: { message: 'created ticket #42' },
        result: { message: 'created ticket #42' },
        isError: type === 'lead.tool.failed',
      }));
      expect(reduction.control).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'lead.upsert-ticket-part' }),
        expect.objectContaining({ type: 'lead.upsert-live-ticket-card' }),
      ]));
    }

    const completed = reduceGatewayEvent(valid('lead.tool.completed', {
      toolCallId: 'call-created',
      toolName: 'create_ticket',
      result: { ticket_id: 43, status: 'backlog' },
      isError: false,
    }));
    expect(completed.control).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'lead.upsert-ticket-part',
        ticketId: 43,
      }),
      expect.objectContaining({
        type: 'lead.upsert-live-ticket-card',
        card: expect.objectContaining({ ticketId: 43, key: 'turn:turn-1:ticket:43' }),
      }),
    ]));
  });

  it('maps incomplete server entities to resource-specific invalidations', () => {
    expect(reduceGatewayEvent(valid('ticket.updated', { snapshotRequired: true })).invalidations)
      .toEqual(expect.arrayContaining(['tickets', 'ticket:42', 'overview', 'agenda:current']));
    expect(reduceGatewayEvent(valid('attempt.updated', {
      attemptId: 9,
      state: 'settled',
      snapshotRequired: true,
    })).invalidations).toContain('execution:42');
    expect(reduceGatewayEvent(valid('approval.required', {
      approvalId: 3,
      requestedBy: 'child',
      tool: 'shell',
      action: 'run tests',
      expiresAt: '2026-07-24T09:00:00.000Z',
    }, { requiredScope: 'approvals:respond' })).invalidations).toContain('approvals');
  });

  // 工单详情（工单 12）：操作清单、验收标准、执行计划跟着工单变；Run 的起止会改变暂停、继续、停下能不能做。
  it('refreshes the action list, the criteria and the plan of the ticket that changed', () => {
    expect(reduceGatewayEvent(valid('ticket.updated', { snapshotRequired: true })).invalidations)
      .toEqual(expect.arrayContaining(['actions:42', 'acceptance-criteria:42', 'plan:42']));
    expect(reduceGatewayEvent(valid('attempt.updated', { attemptId: 9, state: 'settled', snapshotRequired: true })).invalidations)
      .toContain('actions:42');
  });

  it('invalidates agenda only for schedule-mutating Lead tools', () => {
    expect(reduceGatewayEvent(valid('lead.tool.completed', {
      toolCallId: 'call-schedule',
      toolName: 'set_ticket_schedule',
      result: { message: 'updated schedule' },
      isError: false,
    })).invalidations).toContain('agenda:current');
    expect(reduceGatewayEvent(valid('lead.tool.completed', {
      toolCallId: 'call-schedule-enabled',
      toolName: 'set_schedule_enabled',
      result: { message: 'enabled schedule' },
      isError: false,
    })).invalidations).toContain('agenda:current');
    expect(reduceGatewayEvent(valid('lead.tool.completed', {
      toolCallId: 'call-read',
      toolName: 'read',
      result: { message: 'read file' },
      isError: false,
    })).invalidations).not.toContain('agenda:current');
  });

  it('marks a targeted notice error without inventing a notice entity', () => {
    const reduction = reduceGatewayEvent(valid('notice.created', {
      severity: 'error',
      message: 'model failed',
    }));

    expect(reduction.control).toEqual([
      expect.objectContaining({ type: 'lead.ensure-shell', turnId: 'turn-1' }),
      expect.objectContaining({ type: 'lead.fail-turn', message: 'model failed' }),
    ]);
    expect(reduction.invalidations).toContain('conversation:current');
  });

  // 2026-10-19：工单回复的动作按钮有了判断结果。只重取这张工单的对话（按钮跟着快照里的 replyActions 出来），
  // 不全部重取。
  it('refetches only the ticket conversation when a reply\'s actions were judged', () => {
    const reduction = reduceGatewayEvent(valid('snapshot.required', {
      resource: 'ticket-reply-actions', ticketId: 42, turnId: 'turn-9',
    }, { requiredScope: 'chat' }));
    expect(reduction.invalidations).toEqual(['conversation:ticket:42']);
  });

  // 2026-10-30：控件建了、改了、删了，或者视图改了名。只重取控件，不全部重取。
  it('refetches only the widgets when a widget changed', () => {
    const reduction = reduceGatewayEvent(valid('snapshot.required', { resource: 'widgets' }, { requiredScope: 'tickets:view' }));
    expect(reduction.invalidations).toEqual(['widgets']);
  });
});
