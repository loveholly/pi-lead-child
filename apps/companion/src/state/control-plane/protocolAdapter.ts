import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import {
  LeadStatusSchema,
  projectToolDisplay,
  surfaceNeedsNewerCatalog,
  TurnPlacementSchema,
  toolCallUpdateFromEvent,
  validateUiSurface,
  type GatewayEvent,
  type GatewayEventType,
  type ToolCallUpdate,
  type UiSurface,
} from '@pi-lead-child/protocol';

import type { ToolDisplayProjection, ToolState } from '../types';

export { projectToolDisplay };

// 事件 payload 是**开放集合**。packages/protocol 把 GatewayEvent.payload 冻结成
// Record<string, unknown>，生产端按需要往里放路由与快照提示字段：ticketId、parentTicketId、
// snapshotRequired（src/store/gateway-events.ts）、operationState（src/gateway/event-projection.ts）、
// sessionExempt（src/coordinator/interventions.ts）。
//
// 曾经这里用 additionalProperties:false 校验 payload，于是"生产端多带一个字段"被判成
// "事件非法"：adaptGatewayEvent 返回 ok:false，整条事件被降级到 invalidationsFor() 的粗兜底。
// 代价是任务栏停在旧快照上——ticket.updated 只剩 tickets+overview（work-items / workbench /
// checkpoints / conversation-cards 全丢），attempt.* 只剩一个没人观察的 execution:<id>，
// 于是 child 一跑起来 companion 一个请求都不发。实测线上库里每一条带 ticketId 的
// ticket.updated、每一条 attempt.started、每一条带 operationState 的 tool 事件都在被丢弃。
//
// 契约的正确形状是：**只校验 reducer 真正读的字段，其余放行**。字段类型仍然被校验
// （delta 是 string 就必须是 string），只是不再把"未知键"当成错误。
// 生产端实际发出的 payload 形状由两侧共同钉住：
//   - 生产端：test/gateway-event-payloads.test.ts
//   - 消费端：./protocolAdapter.test.ts 的 "daemon payload shapes" 用例
const open = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: true });

// 只有真正会被原样摊进 state 的 payload 才继续闭合（见 overview.patch）。
const strict = <T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const LeadTurnStartedSchema = open({
  messageId: Type.String(),
  commandId: Type.Union([Type.String(), Type.Null()]),
  originKind: Type.String(),
  // queued：在跑的 Run 不能中途接收消息，工单消息排队，Run 结束后转交（2026-10-15）；
  // 也是 Lead 忙时用户选了「排队」的消息（工单 04）。
  mode: Type.Union([Type.Literal('started'), Type.Literal('steered'), Type.Literal('queued')]),
  // 用户的消息现在怎么放的（工单 04）：排队中、已插入、下一轮回答，或者和 answeredWith 那一条一起答了。
  // 旧 daemon 不发它们；不认识的取值当作没有（下面的 adapt 只在校验通过时用它）。
  placement: Type.Optional(Type.String()),
  answeredWith: Type.Optional(Type.String()),
});
const LeadDeltaSchema = open({ messageId: Type.String(), delta: Type.String() });
const LeadCompletedSchema = open({ messageId: Type.String(), text: Type.String() });
// textOffset：调用开始时这一轮的回复有多少字（只有属于某一轮的工具事件才带）。error：runtime 说的失败原因。
const ToolPayloadSchema = open({
  toolCallId: Type.String(),
  toolName: Type.String(),
  args: Type.Optional(Type.Unknown()),
  partialResult: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
  textOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
});
const ChildToolPayloadSchema = open({
  attemptId: Type.Integer({ minimum: 1 }),
  toolCallId: Type.String(),
  toolName: Type.String(),
  args: Type.Optional(Type.Unknown()),
  partialResult: Type.Optional(Type.Unknown()),
  result: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
  textOffset: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
});
const TicketCreatedSchema = open({ ticketId: Type.Integer({ minimum: 1 }) });
const TicketUpdatedSchema = open({
  status: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  childError: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  attemptId: Type.Optional(Type.Integer({ minimum: 1 })),
  snapshotRequired: Type.Optional(Type.Boolean()),
});
// state 是可选的：生产端（runStartedEvent / runUpdatedEvent）从来不发它，reducer 也不读它。
// 把它标成必填等于让每一条 attempt 事件都校验失败。
const AttemptStartedSchema = open({
  attemptId: Type.Integer({ minimum: 1 }),
  state: Type.Optional(Type.String()),
});
const AttemptUpdatedSchema = open({
  attemptId: Type.Integer({ minimum: 1 }),
  state: Type.Optional(Type.String()),
  errorCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  snapshotRequired: Type.Optional(Type.Boolean()),
});
// coordinator 的 requestApproval 只发 approvalId（+ 路由字段）；描述性字段只有 daemon 的
// 审批广播才带。reducer 只读 approvalId，其余按可选处理。
const ApprovalRequiredSchema = open({
  approvalId: Type.Integer({ minimum: 1 }),
  requestedBy: Type.Optional(Type.String()),
  tool: Type.Optional(Type.String()),
  action: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.String()),
});
const ApprovalResolvedSchema = open({
  approvalId: Type.Integer({ minimum: 1 }),
  status: Type.String(),
});
// retry=waiting：用户的一轮没答上，daemon 等网络或模型恢复后会自动再试一次（waitingFor 是 network 或 model）。
const NoticeCreatedSchema = open({
  severity: Type.Literal('error'),
  message: Type.String(),
  retry: Type.Optional(Type.String()),
  waitingFor: Type.Optional(Type.String()),
});
const DaemonStatusSchema = Type.Object({
  busy: Type.Optional(Type.Boolean()),
  model: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  runningTicketIds: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
  // Lead 的模型调用健康。只有连接时带 include=lead_health 才会收到带它的事件。
  lead: Type.Optional(LeadStatusSchema),
}, { additionalProperties: false });
// 网关说「这一类资源变了，重取一次」。resource 说是哪一类（"connections"、"projects"、"notifications"），
// 别的键（projectId、notificationId）跟着资源走。以前这里是一个严格的空对象：带 resource 的事件全被拒掉，
// 只剩 invalidationsFor 的 core 兜底，连接页收不到刷新（issue 07）。
const SnapshotRequiredSchema = Type.Object({
  resource: Type.Optional(Type.String()),
}, { additionalProperties: true });

type ToolPayload = Static<typeof ToolPayloadSchema>;
type ChildToolPayload = Static<typeof ChildToolPayloadSchema>;

export interface AdaptedToolPayload {
  toolCallId: string;
  toolName: string;
  // render_ui 画的卡片（只有声明了 include=ui_surfaces 的连接才收得到）。不合格的当作没有，
  // 只是用了这个版本还没有的组件的除外（见 adaptSurface）。
  surface?: { surface: UiSurface; textOffset: number; partial: boolean } | null;
  args: ToolDisplayProjection | null;
  partialResult: ToolDisplayProjection | null;
  result: ToolDisplayProjection | null;
  isError: boolean;
  // 这条事件在一轮的工具调用里的样子（protocol 的 foldToolCall 的输入）。
  // 和服务端折叠快照用的是同一个函数，所以实时和刷新得到同样的工具调用。
  call: ToolCallUpdate;
}

export interface AdaptedChildToolPayload extends AdaptedToolPayload {
  attemptId: number;
}

type EventWith<T extends GatewayEventType, P> = Omit<GatewayEvent, 'type' | 'payload'> & {
  type: T;
  payload: P;
};

export type ValidatedGatewayEvent =
  | EventWith<'lead.turn.started', Static<typeof LeadTurnStartedSchema>>
  | EventWith<'lead.message.delta', Static<typeof LeadDeltaSchema>>
  | EventWith<'lead.message.completed', Static<typeof LeadCompletedSchema>>
  | EventWith<'lead.tool.started' | 'lead.tool.updated' | 'lead.tool.completed' | 'lead.tool.failed', AdaptedToolPayload>
  | EventWith<'ticket.created', Static<typeof TicketCreatedSchema>>
  | EventWith<'ticket.updated', Static<typeof TicketUpdatedSchema>>
  | EventWith<'attempt.started', Static<typeof AttemptStartedSchema>>
  | EventWith<'attempt.updated', Static<typeof AttemptUpdatedSchema>>
  | EventWith<'child.tool.started' | 'child.tool.updated' | 'child.tool.completed' | 'child.tool.failed', AdaptedChildToolPayload>
  | EventWith<'approval.required', Static<typeof ApprovalRequiredSchema>>
  | EventWith<'approval.resolved', Static<typeof ApprovalResolvedSchema>>
  | EventWith<'notice.created', Static<typeof NoticeCreatedSchema>>
  | EventWith<'daemon.status.changed', Static<typeof DaemonStatusSchema>>
  | EventWith<'snapshot.required', Static<typeof SnapshotRequiredSchema>>;

export type GatewayEventAdaptation =
  | { ok: true; event: ValidatedGatewayEvent }
  | { ok: false; type: GatewayEventType; error: string; invalidations: string[] };

const schemaByType: Partial<Record<GatewayEventType, TSchema>> = {
  'lead.turn.started': LeadTurnStartedSchema,
  'lead.message.delta': LeadDeltaSchema,
  'lead.message.completed': LeadCompletedSchema,
  'lead.tool.started': ToolPayloadSchema,
  'lead.tool.updated': ToolPayloadSchema,
  'lead.tool.completed': ToolPayloadSchema,
  'lead.tool.failed': ToolPayloadSchema,
  'ticket.created': TicketCreatedSchema,
  'ticket.updated': TicketUpdatedSchema,
  'attempt.started': AttemptStartedSchema,
  'attempt.updated': AttemptUpdatedSchema,
  'child.tool.started': ChildToolPayloadSchema,
  'child.tool.updated': ChildToolPayloadSchema,
  'child.tool.completed': ChildToolPayloadSchema,
  'child.tool.failed': ChildToolPayloadSchema,
  'approval.required': ApprovalRequiredSchema,
  'approval.resolved': ApprovalResolvedSchema,
  'notice.created': NoticeCreatedSchema,
  'daemon.status.changed': DaemonStatusSchema,
  'snapshot.required': SnapshotRequiredSchema,
};

export function adaptGatewayEvent(event: GatewayEvent): GatewayEventAdaptation {
  const schema = schemaByType[event.type];
  if (!schema || !Value.Check(schema, event.payload)) return invalid(event);
  if (event.type.startsWith('lead.tool.')) {
    return { ok: true, event: { ...event, payload: adaptToolPayload(event) } as ValidatedGatewayEvent };
  }
  if (event.type.startsWith('child.tool.')) {
    const payload = event.payload as ChildToolPayload;
    return {
      ok: true,
      event: {
        ...event,
        payload: { attemptId: payload.attemptId, ...adaptToolPayload(event) },
      } as ValidatedGatewayEvent,
    };
  }
  return { ok: true, event: event as ValidatedGatewayEvent };
}

function adaptToolPayload(event: GatewayEvent): AdaptedToolPayload {
  const payload = event.payload as ToolPayload;
  return {
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    args: projectToolDisplay(payload.args),
    partialResult: projectToolDisplay(payload.partialResult),
    result: projectToolDisplay(payload.result),
    isError: payload.isError ?? false,
    call: toolCallUpdateFromEvent(event, null)!,
    surface: adaptSurface(event.payload),
  };
}

function adaptSurface(payload: Record<string, unknown>): { surface: UiSurface; textOffset: number; partial: boolean } | null {
  if (!payload.surface || typeof payload.surface !== 'object') return null;
  const checked = validateUiSurface(payload.surface);
  // 用了这个版本还没有的组件的卡（2026-10-20）：结构是对的，服务端也校验过，说明 App 旧了。留着它，
  // SurfaceView 说明要刷新，下面照旧显示 fallbackText。以前这里直接丢掉，连 fallbackText 都没有。
  if (!checked.ok && !surfaceNeedsNewerCatalog(checked)) return null;
  const textOffset = typeof payload.textOffset === 'number' && payload.textOffset >= 0 ? Math.floor(payload.textOffset) : 0;
  return { surface: checked.ok ? checked.surface : payload.surface as UiSurface, textOffset, partial: payload.partial === true };
}

function invalid(event: GatewayEvent): GatewayEventAdaptation {
  return {
    ok: false,
    type: event.type,
    error: `invalid payload for ${event.type}`,
    invalidations: invalidationsFor(event),
  };
}

function invalidationsFor(event: GatewayEvent): string[] {
  const ticketConversation = event.ticketId === null ? [] : [`conversation:ticket:${event.ticketId}`];
  if (event.type.startsWith('lead.')) return ['conversation:current', ...ticketConversation];
  if (event.type === 'notice.created') return ['conversation:current', ...ticketConversation, 'notifications', 'overview'];
  if (event.type.startsWith('approval.')) return ['approvals'];
  if (event.type.startsWith('attempt.') || event.type.startsWith('child.tool.')) {
    return event.ticketId === null ? ['tickets'] : [`execution:${event.ticketId}`];
  }
  if (event.type.startsWith('ticket.')) return ['tickets', 'overview'];
  if (event.type === 'daemon.status.changed') return ['overview'];
  return ['core'];
}

export function toolStateFor(type: ValidatedGatewayEvent['type']): ToolState {
  if (type.endsWith('.started')) return 'started';
  if (type.endsWith('.updated')) return 'running';
  if (type.endsWith('.failed')) return 'failed';
  return 'completed';
}
