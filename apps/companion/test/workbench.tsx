import type { ConversationTurn, KernelIntervention, TicketAction, TicketDelivery, TicketSummary } from '@pi-lead-child/protocol';

import Workbench from '../src/features/workspace/Workbench.web';
import { CompanionRuntimeProvider } from '../src/state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../src/state/runtime';
import { renderUI } from './render';

// 工单 #66 的摘要：在 review，最新交付 Run #49 等独立核查（复核用的那张工单）。
export function ticket66(overrides: Partial<TicketSummary> = {}): TicketSummary {
  return {
    id: 66,
    title: 'FINAL #45 implementation - outcome snapshot and registry mechanism',
    summary: '把任务完成协议的成果快照和登记机制落地。',
    kind: 'task',
    hasRun: true,
    priority: 'normal',
    project: 'pi-lead-child',
    dueAt: null,
    deferUntil: null,
    updatedAt: '2026-10-14T08:00:00.000Z',
    parentTicketId: null,
    rootTicketId: 66,
    runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
    attention: { pendingApprovalCount: 0, blockerCount: 0 },
    stage: 'review',
    status: 'review',
    ...overrides,
  };
}

// 操作清单里的一项（GET /v1/tickets/:id/actions，工单 03）。缺省是能做的。
export function ticketAction(id: string, overrides: Partial<TicketAction> = {}): TicketAction {
  return {
    id, label: id, area: 'ticket', permission: 'user_only', external: false, irreversible: false, undoable: false,
    available: true, reason: null, ...overrides,
  };
}

// 一次交付：改动在隔离分支上，还没合并。
export function ticketDelivery(ticketId: number, overrides: Partial<NonNullable<TicketDelivery['workspace']>> = {}): TicketDelivery {
  return {
    ticketId, attemptId: 49, source: 'isolated', files: [], truncated: false, totals: null,
    workspace: {
      workspaceId: 7, branch: `plc/item-${ticketId}`, head: 'a'.repeat(40), target: 'main', commits: 1, uncommittedFiles: 0,
      integration: 'unmerged', mergedInto: null, pullRequestUrl: null, ...overrides,
    },
    actions: {
      merge: { available: true, reason: null, acceptsTicket: false },
      openPullRequest: { available: true, reason: null },
      abandon: { available: true, reason: null },
    },
  };
}

export function setViewportWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 });
  window.dispatchEvent(new Event('resize'));
}

/**
 * 在给定宽度下渲染整个工作台，选中这张工单并打开它的详情。只能在 jsdom 环境的测试里用。
 * 测试文件自己 mock expo-crypto 和 expo-router（vi.mock 只在测试文件里提升）。
 */
export function renderWorkbenchWithTicket(
  ticket: TicketSummary,
  { width = 1280, turns = [], interventions = [], actions = [], delivery }: {
    width?: number; turns?: ConversationTurn[]; interventions?: KernelIntervention[]; actions?: TicketAction[];
    delivery?: TicketDelivery;
  } = {},
) {
  setViewportWidth(width);
  const runtime = createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets([ticket]);
  if (turns.length > 0) runtime.control.getState().replaceConversation('lead-session-1', turns, { ticketId: ticket.id });
  if (interventions.length > 0) {
    // 绑定有回答权限、daemon 支持介入接口。真实运行时这两样来自配对凭据和 hello；这里直接给。
    const internals = runtime as unknown as { scopes: Set<string>; capabilities: Set<string> };
    internals.scopes = new Set(['chat', 'tickets:view', 'approvals:respond']);
    internals.capabilities = new Set(['kernel.interventions.v1']);
    runtime.control.getState().replaceInterventions(interventions, ticket.id);
    // 已经加载好（真实运行时由 GET /v1/interventions 加载），渲染时不再去取，测试保持同步。
    runtime.control.setState((state) => ({
      resourceState: {
        ...state.resourceState,
        [`interventions:${ticket.id}`]: { state: 'ready', generation: 1, observerCount: 0, lastSuccessAt: 0, error: null },
      },
    }));
  }
  // 这张工单现在能做的操作。真实运行时由 GET /v1/tickets/:id/actions 读来。
  if (actions.length > 0) runtime.control.getState().replaceTicketActions(ticket.id, actions);
  // 这次交付（GET /v1/tickets/:id/delivery）。合并、开 PR、放弃改动要等它读到才能点。
  if (delivery) runtime.control.getState().replaceDelivery(ticket.id, delivery);
  runtime.workspace.setState({ hydrated: true, selectedTicketId: ticket.id, threadOpen: true });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
  return runtime;
}
