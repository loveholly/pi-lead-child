import {
  CHANNEL_CARDS_SNAPSHOT_RESOURCE, CHANNEL_SETTINGS_SNAPSHOT_RESOURCE, SETUP_RESOURCE, WIDGETS_RESOURCE, CONNECTIONS_SNAPSHOT_RESOURCE, LEAD_ACTIVITY_RESOURCE, LEAD_AVATAR_RESOURCE, LEAD_PROFILE_RESOURCE, MODEL_SETTINGS_RESOURCE, LeadActivityPushSchema,
  LEAD_QUEUE_RESOURCE, LeadQueueSchema, TICKET_REPLY_ACTIONS_RESOURCE, TurnPlacementSchema,
  type LeadActivityCard, type LeadInterrupt, type LeadQueue, type ReminderCard, type SetupChecklistCard, type SetupHintCard, type TurnPlacement, type UiSurface,
} from '@pi-lead-child/protocol';
import { Value } from 'typebox/value';
import type { ToolCallUpdate } from '@pi-lead-child/protocol';

import { toolStateFor, type ValidatedGatewayEvent } from './protocolAdapter';
import type { ToolDisplayProjection, ToolState, TransientConversationCard } from '../types';

export type ControlPlaneMutation =
  | { type: 'lead.ensure-shell'; turnId: string; ticketId: number | null; occurredAt: string; originKind?: string }
  | {
    type: 'lead.start-turn';
    turnId: string | null;
    occurredAt: string;
    payload: {
      commandId: string | null; mode: 'started' | 'steered' | 'queued'; originKind?: string;
      placement?: TurnPlacement; answeredWith?: string;
    };
  }
  | { type: 'lead.complete-message'; turnId: string | null; text: string; occurredAt: string }
  | { type: 'lead.upsert-tool-part'; turnId: string | null; partId: string; call: ToolCallUpdate }
  | { type: 'lead.upsert-surface-part'; turnId: string | null; partId: string; callId: string; textOffset: number; partial: boolean; surface: UiSurface }
  | { type: 'lead.drop-failed-surface-part'; turnId: string | null; partId: string }
  | { type: 'lead.upsert-ticket-part'; turnId: string | null; partId: string; ticketId: number }
  | { type: 'lead.upsert-approval-part'; turnId: string | null; partId: string; approvalId: number }
  | { type: 'lead.upsert-artifact-part'; turnId: string | null; partId: string; artifactId: string }
  | { type: 'lead.upsert-live-ticket-card'; card: TransientConversationCard }
  | { type: 'lead.fail-turn'; turnId: string | null; message: string; occurredAt: string; waitingFor?: 'network' | 'model' }
  | { type: 'overview.patch'; payload: Record<string, unknown> }
  // 「Lead 动态」的一张卡或一条横幅变了（工单 06）：按版本应用，比手上旧的忽略。
  | { type: 'lead-activity.apply'; card?: LeadActivityCard; interrupt?: LeadInterrupt; reminder?: ReminderCard; setup?: SetupChecklistCard; setupHint?: SetupHintCard }
  // Lead 忙时排着的外部消息变了（工单 10）：推送带着整份，整体替换。
  | { type: 'lead-queue.replace'; queue: LeadQueue };

export type StreamMutation =
  | { type: 'message.append-delta'; turnId: string | null; delta: string }
  | { type: 'message.clear-transient'; turnId: string | null }
  | { type: 'tool.set-progress'; partId: string; state: ToolState }
  | { type: 'tool.drain-progress'; partId: string };

export interface GatewayEventReduction {
  control: ControlPlaneMutation[];
  streams: StreamMutation[];
  invalidations: string[];
}

export function reduceGatewayEvent(event: ValidatedGatewayEvent): GatewayEventReduction {
  const control: ControlPlaneMutation[] = [];
  const streams: StreamMutation[] = [];
  const invalidations: string[] = [];
  const ensureShell = (originKind?: string) => {
    if (event.turnId) control.push({
      type: 'lead.ensure-shell',
      turnId: event.turnId,
      ticketId: event.ticketId,
      occurredAt: event.occurredAt,
      ...(originKind === undefined ? {} : { originKind }),
    });
  };

  switch (event.type) {
    case 'lead.turn.started':
      // originKind 区分用户发起的回合和 lead 自己发起的回合（system:…），会话据此贴标签。
      ensureShell(event.payload.originKind);
      control.push({
        type: 'lead.start-turn', turnId: event.turnId, occurredAt: event.occurredAt,
        payload: {
          commandId: event.payload.commandId,
          mode: event.payload.mode,
          ...(event.payload.originKind === undefined ? {} : { originKind: event.payload.originKind }),
          // 不认识的放置方式（以后的 daemon 新加的）当作没有。
          ...(Value.Check(TurnPlacementSchema, event.payload.placement) ? { placement: event.payload.placement as TurnPlacement } : {}),
          ...(typeof event.payload.answeredWith === 'string' ? { answeredWith: event.payload.answeredWith } : {}),
        },
      });
      // daemon 重试时会重新开始一条已经结束的系统回合：上一次没流完的文字不属于这一次。
      if (event.payload.mode === 'started') streams.push({ type: 'message.clear-transient', turnId: event.turnId });
      break;
    case 'lead.message.delta':
      ensureShell();
      streams.push({ type: 'message.append-delta', turnId: event.turnId, delta: event.payload.delta });
      break;
	    case 'lead.message.completed':
	      ensureShell();
	      control.push({ type: 'lead.complete-message', turnId: event.turnId, text: event.payload.text, occurredAt: event.occurredAt });
	      streams.push({ type: 'message.clear-transient', turnId: event.turnId });
	      invalidations.push('conversation:current');
	      if (event.ticketId !== null) invalidations.push(`conversation:ticket:${event.ticketId}`);
	      break;
    case 'lead.tool.started':
    case 'lead.tool.updated':
    case 'lead.tool.completed':
    case 'lead.tool.failed': {
      ensureShell();
      const partId = `${event.turnId}:${event.payload.toolCallId}`;
      const createdTicketTarget = event.type === 'lead.tool.completed' && event.payload.toolName === 'create_ticket'
        ? createdTicketId(event.payload.result)
        : null;
      control.push({ type: 'lead.upsert-tool-part', turnId: event.turnId, partId, call: event.payload.call });
      // render_ui 画的卡片（generative UI）：成为这一轮回复里的一个部件，按调用（callId）对齐。
      // 流式中途的版本（partial）先到，同一次调用的定稿版替换它；定稿以后不再被中途的版本盖掉。
      // 同一个 surface id 的重画和失败的调用按 protocol 的规则处理（ui-surfaces.ts 的 foldTurnSurfaces 上面）。
      if (event.type === 'lead.tool.failed' && event.payload.toolName === 'render_ui') {
        control.push({ type: 'lead.drop-failed-surface-part', turnId: event.turnId, partId: `${event.turnId}:surface:${event.payload.toolCallId}` });
      }
      if (event.payload.surface) {
        control.push({
          type: 'lead.upsert-surface-part',
          turnId: event.turnId,
          partId: `${event.turnId}:surface:${event.payload.toolCallId}`,
          callId: event.payload.toolCallId,
          textOffset: event.payload.surface.textOffset,
          partial: event.payload.surface.partial,
          surface: event.payload.surface.surface,
        });
      }
      if (event.type === 'lead.tool.completed') {
        if (createdTicketTarget !== null) {
          control.push({
            type: 'lead.upsert-ticket-part',
            turnId: event.turnId,
            partId: `${event.turnId}:ticket:${createdTicketTarget}`,
            ticketId: createdTicketTarget,
          });
        }
        const artifactIds = new Set([
          ...(event.payload.args?.artifactRefs ?? []),
          ...(event.payload.partialResult?.artifactRefs ?? []),
          ...(event.payload.result?.artifactRefs ?? []),
        ]);
        for (const artifactId of artifactIds) {
          control.push({
            type: 'lead.upsert-artifact-part',
            turnId: event.turnId,
            partId: `${event.turnId}:artifact:${artifactId}`,
            artifactId,
          });
        }
      }
      const liveCardTicketId = event.payload.toolName === 'create_ticket'
        ? createdTicketTarget
        : event.ticketId;
      if (event.turnId && liveCardTicketId !== null) {
        const detail = event.payload.result?.preview ?? event.payload.partialResult?.preview ?? null;
        control.push({
          type: 'lead.upsert-live-ticket-card',
          card: {
            key: `turn:${event.turnId}:ticket:${liveCardTicketId}`,
            kind: 'ticket_execution',
            turnId: event.turnId,
            ticketId: liveCardTicketId,
            operations: [{
              id: `${event.turnId}:${event.payload.toolCallId}`,
              name: event.payload.toolName,
              state: toolStateFor(event.type),
              label: event.payload.toolName,
              detail,
            }],
            operationsTruncated: false,
            createdAt: event.occurredAt,
            updatedAt: event.occurredAt,
          },
        });
      }
      if (event.type.endsWith('.completed') || event.type.endsWith('.failed')) {
        streams.push({ type: 'tool.drain-progress', partId });
        invalidations.push('conversation-cards');
        if (
          event.type === 'lead.tool.completed' &&
          (
            event.payload.toolName === 'set_ticket_schedule' ||
            event.payload.toolName === 'create_schedule' ||
            event.payload.toolName === 'set_schedule_enabled' ||
            // 阶段 3：节点和日程顶部的一句话。
            event.payload.toolName === 'set_milestone' ||
            event.payload.toolName === 'update_milestone' ||
            event.payload.toolName === 'update_agenda_note'
          )
        ) {
          invalidations.push('agenda:current');
        }
        if (liveCardTicketId !== null) {
          invalidations.push(`conversation-cards:ticket:${liveCardTicketId}`);
        }
      } else {
        streams.push({ type: 'tool.set-progress', partId, state: toolStateFor(event.type) });
      }
      break;
    }
    case 'ticket.created':
      invalidations.push(
        'tickets', 'projects', 'overview', 'agenda:current', 'work-items', 'conversation-cards',
        ...(event.ticketId === null ? [] : [`workbench:${event.ticketId}`, `conversation-cards:ticket:${event.ticketId}`]),
      );
      break;
    case 'ticket.updated':
      invalidations.push(
        'tickets', ...(event.ticketId === null ? [] : [
          `ticket:${event.ticketId}`,
          `workbench:${event.ticketId}`,
          `checkpoints:${event.ticketId}`,
          `artifacts:${event.ticketId}`,
          `delivery:${event.ticketId}`,
          `actions:${event.ticketId}`,
          `acceptance-criteria:${event.ticketId}`,
          `plan:${event.ticketId}`,
          `interventions:${event.ticketId}`,
          `conversation-cards:ticket:${event.ticketId}`,
        ]),
        'overview', 'projects', 'agenda:current', 'work-items', 'conversation-cards',
      );
      break;
    case 'attempt.started':
      invalidations.push(
        event.ticketId === null ? 'tickets' : `execution:${event.ticketId}`,
        'work-items', 'conversation-cards',
        ...(event.ticketId === null ? [] : [
          `workbench:${event.ticketId}`,
          `actions:${event.ticketId}`,
          `conversation-cards:ticket:${event.ticketId}`,
        ]),
      );
      break;
    case 'attempt.updated':
      invalidations.push(
        event.ticketId === null ? 'tickets' : `execution:${event.ticketId}`,
        'work-items', 'conversation-cards',
        ...(event.ticketId === null ? [] : [
          `workbench:${event.ticketId}`,
          `checkpoints:${event.ticketId}`,
          `delivery:${event.ticketId}`,
          `actions:${event.ticketId}`,
          `conversation-cards:ticket:${event.ticketId}`,
        ]),
      );
      break;
    case 'child.tool.started':
    case 'child.tool.updated':
    case 'child.tool.completed':
    case 'child.tool.failed':
      // 工单 agent 正在回答某一轮时，它的工具调用属于这一轮（daemon 带上 turnId），进这一轮的任务卡。
      // 不建外壳：不认识的轮次（别的 binding 发起的、还没拉到快照的）留给快照。
      if (event.turnId) {
        control.push({
          type: 'lead.upsert-tool-part',
          turnId: event.turnId,
          partId: `${event.turnId}:${event.payload.toolCallId}`,
          call: event.payload.call,
        });
      }
      invalidations.push(
        event.ticketId === null ? 'tickets' : `execution:${event.ticketId}`,
        'work-items',
        ...(event.ticketId === null ? [] : [`workbench:${event.ticketId}`]),
      );
      break;
    case 'approval.required':
      if (event.turnId) {
        ensureShell();
        control.push({
          type: 'lead.upsert-approval-part',
          turnId: event.turnId,
          partId: `${event.turnId}:approval:${event.payload.approvalId}`,
          approvalId: event.payload.approvalId,
        });
      }
      invalidations.push('approvals', 'conversation-cards');
      if (event.ticketId !== null) invalidations.push(
        `ticket:${event.ticketId}`, 'tickets', `interventions:${event.ticketId}`,
        `workbench:${event.ticketId}`, `conversation-cards:ticket:${event.ticketId}`,
      );
      break;
    case 'approval.resolved':
      invalidations.push('approvals', 'conversation-cards');
      if (event.ticketId !== null) invalidations.push(
        `ticket:${event.ticketId}`, 'tickets', `interventions:${event.ticketId}`,
        `checkpoints:${event.ticketId}`, `workbench:${event.ticketId}`,
        `conversation-cards:ticket:${event.ticketId}`,
      );
      break;
	    case 'notice.created':
	      ensureShell();
      control.push({
        type: 'lead.fail-turn',
        turnId: event.turnId,
        message: event.payload.message,
        occurredAt: event.occurredAt,
        ...(event.payload.retry === 'waiting'
          ? { waitingFor: event.payload.waitingFor === 'network' ? 'network' as const : 'model' as const }
          : {}),
      });
	      invalidations.push('conversation:current', 'notifications', 'overview');
	      if (event.ticketId !== null) invalidations.push(`conversation:ticket:${event.ticketId}`);
	      break;
    case 'daemon.status.changed':
      control.push({ type: 'overview.patch', payload: event.payload });
      invalidations.push('overview');
      break;
    case 'snapshot.required':
      // 「Lead 动态」的推送（工单 06，spec D16）带着变化后的卡片和版本：直接按版本应用，不用重取。
      // 带的东西认不出来（以后的 daemon 改了形状）时，重取会话（它会带回「Lead 动态」）。
      if (event.payload.resource === LEAD_ACTIVITY_RESOURCE) {
        if (Value.Check(LeadActivityPushSchema, event.payload)
          && (event.payload.card || event.payload.interrupt || event.payload.reminder || event.payload.setup || event.payload.setupHint)) {
          control.push({
            type: 'lead-activity.apply',
            ...(event.payload.card ? { card: event.payload.card } : {}),
            ...(event.payload.interrupt ? { interrupt: event.payload.interrupt } : {}),
            // 会话里的提醒卡（工单 07）。
            ...(event.payload.reminder ? { reminder: event.payload.reminder } : {}),
            // 首次启动引导的准备清单卡和建议卡。
            ...(event.payload.setup ? { setup: event.payload.setup } : {}),
            ...(event.payload.setupHint ? { setupHint: event.payload.setupHint } : {}),
          });
        } else {
          invalidations.push('conversation:current');
        }
        break;
      }
      // Lead 忙时排着的外部消息（工单 10）：推送带着整份排队，直接替换；认不出来时只重取排队。
      if (event.payload.resource === LEAD_QUEUE_RESOURCE) {
        const queue = (event.payload as Record<string, unknown>).queue;
        if (Value.Check(LeadQueueSchema, queue)) control.push({ type: 'lead-queue.replace', queue });
        else invalidations.push('lead-queue');
        break;
      }
      // 工单回复的动作按钮有了判断结果（2026-10-19）：只重取这张工单的对话，按钮跟着快照里的 replyActions 出来。
      if (event.payload.resource === TICKET_REPLY_ACTIONS_RESOURCE && event.ticketId !== null) {
        invalidations.push(`conversation:ticket:${event.ticketId}`);
        break;
      }
      // 连接、记忆、决策模型、执行器、消息通道的设置、外部来源的会话卡变了只重取它自己；别的资源照旧全部重取。
      invalidations.push(snapshotInvalidation(event.payload.resource));
      break;
  }
  return { control, streams, invalidations: [...new Set(invalidations)] };
}

function snapshotInvalidation(resource: unknown): string {
  if (resource === CONNECTIONS_SNAPSHOT_RESOURCE) return 'connections';
  if (resource === CHANNEL_CARDS_SNAPSHOT_RESOURCE) return 'channel-cards';
  if (resource === 'memory') return 'memory';
  if (resource === 'decision-model') return 'decision-model';
  if (resource === MODEL_SETTINGS_RESOURCE) return 'model-settings';
  if (resource === SETUP_RESOURCE) return 'setup';
  if (resource === WIDGETS_RESOURCE) return 'widgets';
  if (resource === 'runtime-settings') return 'runtime-settings';
  if (resource === LEAD_PROFILE_RESOURCE) return 'lead-profile';
  if (resource === LEAD_AVATAR_RESOURCE) return 'lead-avatar';
  if (resource === CHANNEL_SETTINGS_SNAPSHOT_RESOURCE) return 'channel-settings';
  return 'core';
}

function createdTicketId(projection: ToolDisplayProjection | null): number | null {
  if (!projection) return null;
  try {
    const structured = ticketIdFromValue(JSON.parse(projection.preview));
    if (structured !== null) return structured;
  } catch {
    // Text results are a supported compatibility fallback.
  }
  const match = /\bcreated\s+ticket\s+#(\d+)\b/i.exec(projection.preview);
  return match ? positiveTicketId(match[1]) : null;
}

function ticketIdFromValue(value: unknown, depth = 0): number | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const direct = positiveTicketId(record.ticketId) ?? positiveTicketId(record.ticket_id);
    if (direct !== null) return direct;
    for (const child of Object.values(record).slice(0, 20)) {
      const nested = ticketIdFromValue(child, depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 20)) {
      const nested = ticketIdFromValue(child, depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function positiveTicketId(value: unknown): number | null {
  const ticketId = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(ticketId) && ticketId > 0 ? ticketId : null;
}
