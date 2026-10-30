// @vitest-environment jsdom
// generative UI（2026-10-15 用户决定，.scratch/generative-ui/spec.md）：Lead 用 render_ui 画的富交互卡片在 App 里的样子。
// 卡片来自 render_ui 的 lead.tool.updated（payload.surface），刷新时来自每一轮的 surfaces。
// App 用自己的组件画（方案 A 的决定卡）：工单头、事实、「我的建议」、带后果说明的选项。
// 工单的状态和决策的状态都按编号实时读取。点选项走现有的决策请求接口，选完显示结果。
import {
  PROTOCOL_VERSION, type ChannelCardDto, type ConversationTurn, type GatewayEvent, type KernelIntervention, type TicketSummary, type UiActionView, type UiSurface,
} from '@pi-lead-child/protocol';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { applyControlPlaneMutation } from '../../state/control-plane/actions';
import { reduceGatewayEvent } from '../../state/control-plane/eventReducer';
import { adaptGatewayEvent } from '../../state/control-plane/protocolAdapter';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { buildAssistantTurn } from '../chat/assistantTurn';
import { SurfaceView } from './SurfaceView';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const SESSION = 'lead-session';
const TURN = 'turn-1';
const ASSISTANT = `${SESSION}:${TURN}:assistant`;

const surface: UiSurface = {
  id: 'decide-66', catalogVersion: 1, root: 'card',
  fallbackText: '#66 核查不通过，需要你在并入 #72、取消里选一个。',
  nodes: [
    { id: 'card', type: 'Stack', props: { gap: 'md' }, children: ['head', 'title', 'facts', 'choice'] },
    { id: 'head', type: 'TicketRef', props: { ticket: 66 } },
    { id: 'title', type: 'Text', props: { text: '核查不通过，返工次数已用完', variant: 'title' } },
    { id: 'facts', type: 'FactList', props: { items: [
      { label: 'F1', text: '撤回的完成声明仍被登记成 complete', status: 'reproduced' },
      { text: '原来失败的重启 E2E 现在通过', status: 'passed' },
    ] } },
    { id: 'choice', type: 'ChoiceGroup', props: {
      ticket: 66, decision: 12,
      choices: [
        { id: 'merge', label: '并入 #72', consequence: '#66 关闭，F1 写进 #72 的验收条件' },
        { id: 'cancel', label: '取消 #66', consequence: '不再推进' },
      ],
      recommendation: { choiceId: 'merge', reason: 'F1 和 #72 改的是同一条 outcome-recovery 路径' },
    } },
  ],
};

function event(seq: number, type: GatewayEvent['type'], payload: Record<string, unknown>): GatewayEvent {
  return {
    protocolVersion: PROTOCOL_VERSION, eventId: `event-${seq}`, seq, type,
    occurredAt: `2026-10-15T10:15:${String(seq).padStart(2, '0')}.000Z`,
    requiredScope: 'chat', audienceBindingId: null, turnId: TURN, ticketId: null, payload,
  };
}

function emptyRuntime(extra: Partial<CompanionRuntimeDependencies> = {}) {
  return createCompanionStateRuntime({
    client: {} as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
    ...extra,
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

function parts(runtime: ReturnType<typeof emptyRuntime>) {
  const state = runtime.control.getState();
  return (state.partIdsByMessage[ASSISTANT] ?? []).map((id) => state.messagePartsById[id]!);
}

describe('a surface in the conversation', () => {
  it('becomes a part of the turn, and the render_ui call stays out of the tool summary', () => {
    const runtime = applyLive(emptyRuntime(), [
      event(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'system:blocker', mode: 'started' }),
      event(2, 'lead.tool.started', { toolCallId: 'call-1', toolName: 'render_ui', args: {}, textOffset: 11 }),
      event(3, 'lead.tool.updated', { toolCallId: 'call-1', toolName: 'render_ui', textOffset: 11, surface }),
      event(4, 'lead.tool.completed', { toolCallId: 'call-1', toolName: 'render_ui', result: 'ok', textOffset: 11 }),
      event(5, 'lead.message.completed', { messageId: `msg_${TURN}`, text: '#66 的核查不通过。' }),
    ]);
    const surfacePart = parts(runtime).find((part) => part.kind === 'surface');
    expect(surfacePart).toMatchObject({ kind: 'surface', surface: { id: 'decide-66' }, textOffset: 11 });
    const turn = buildAssistantTurn({ messageId: ASSISTANT, messageState: 'completed', text: '#66 的核查不通过。', parts: parts(runtime) });
    expect(turn.card).toBeNull();
    // 卡片在回复里它出现的位置：这一句之后（2026-10-24 起，以前放在附件里、总在回复下面）。
    expect(turn.body).toEqual([{ kind: 'text', text: '#66 的核查不通过。' }, { kind: 'part', partId: surfacePart!.id }]);
    expect(turn.attachmentPartIds).not.toContain(surfacePart!.id);
  });

  it('comes back after a refresh', () => {
    const runtime = emptyRuntime();
    const turn: ConversationTurn = {
      id: TURN, originBindingId: null, originKind: 'system:blocker', ticketId: null, state: 'completed',
      userText: '', assistantText: '#66 的核查不通过。', error: null,
      createdAt: '2026-10-15T10:15:00.000Z', updatedAt: '2026-10-15T10:15:10.000Z',
      toolCalls: [], surfaces: [{ callId: 'call-1', textOffset: 10, surface }],
    };
    runtime.control.getState().replaceConversation(SESSION, [turn]);
    expect(parts(runtime).find((part) => part.kind === 'surface')).toMatchObject({ surface: { id: 'decide-66' } });
  });
});

const ticket: TicketSummary = {
  id: 66, title: '[E2E #51] 成果快照与登记机制', summary: '', kind: 'task', hasRun: true, priority: 'normal',
  project: null, dueAt: null, deferUntil: null, updatedAt: '2026-10-15T10:15:00.000Z', parentTicketId: null, rootTicketId: 66,
  runtime: { state: 'idle', lastActivityAt: null, activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 1 }, stage: 'review', status: 'review',
};

function decision(state: 'pending' | 'resolved'): KernelIntervention {
  const options = [
    { id: 'merge', label: '并入 #72', description: '#66 关闭，F1 写进 #72 的验收条件' },
    { id: 'cancel', label: '取消 #66', description: '不再推进' },
  ];
  return {
    id: 'decision:12', kind: 'decision', authorityId: 12, ticketId: 66, attemptId: null, audience: 'user',
    blocking: true, allowCustom: false, state, title: '#66 接下来怎么办？', detail: '', options,
    actions: state === 'pending' ? options.map((option) => ({ kind: 'select' as const, optionId: option.id, label: option.label })) : [],
    resolution: state === 'pending' ? null : { kind: 'option', optionId: 'merge', text: null },
    createdAt: '2026-10-15T10:15:00.000Z', resolvedBy: state === 'pending' ? null : 'user via paired binding:7',
    resolvedAt: state === 'pending' ? null : '2026-10-15T10:20:00.000Z',
  } as KernelIntervention;
}

// web：这个页面的版本（current）、daemon 现在提供的版本（served，null 是没读到）和用户收起提示的版本（dismissed）。
type WebVersions = { current: string; served: string | null; dismissed?: string | null };

function renderSurface(
  value: UiSurface,
  state: 'pending' | 'resolved' = 'pending',
  options: { canReload?: boolean; web?: WebVersions } = {},
) {
  const reloadApp = vi.fn();
  const web = options.web;
  const runtime = emptyRuntime({
    ...(options.canReload === false ? {} : { reloadApp }),
    ...(web ? { webBuild: { current: web.current, served: async () => web.served } } : {}),
  });
  if (web) runtime.webVersion.setState({ served: web.served, dismissed: web.dismissed ?? null });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  runtime.control.getState().replaceTickets([ticket]);
  runtime.control.getState().replaceInterventions([decision(state)], 66);
  const resolve = vi.spyOn(runtime, 'resolveIntervention').mockResolvedValue();
  renderUI(<CompanionRuntimeProvider runtime={runtime}><SurfaceView surface={value} /></CompanionRuntimeProvider>);
  return { resolve, reloadApp, runtime };
}

describe('the decision card', () => {
  it('shows the ticket, the facts, my recommendation and the choices with their consequences', () => {
    renderSurface(surface);
    expect(screen.getByText('#66')).toBeTruthy();
    expect(screen.getByText('成果快照与登记机制')).toBeTruthy();
    expect(screen.getByText('核查不通过，返工次数已用完')).toBeTruthy();
    expect(screen.getByText('撤回的完成声明仍被登记成 complete')).toBeTruthy();
    expect(screen.getByText('已复现')).toBeTruthy();
    expect(screen.getByText('通过')).toBeTruthy();
    expect(screen.getByText('我的建议')).toBeTruthy();
    expect(screen.getByText('F1 和 #72 改的是同一条 outcome-recovery 路径')).toBeTruthy();
    expect(screen.getByRole('button', { name: /并入 #72/ }).textContent).toContain('推荐');
    expect(screen.getByText('#66 关闭，F1 写进 #72 的验收条件')).toBeTruthy();
  });

  // 2026-10-15 预览发现：同一屏上，会话里的工单卡写「独立核查未派发」，决定卡的工单头写「需介入」。
  // 两个工单头用同一个状态标签（TicketSummary 投影出来的 statusLabel），和 A4 的工单卡一致。
  it('labels the ticket the same way as the ticket card in the conversation', async () => {
    const { ticketSummaryToTicket } = await import('../workspace/model');
    renderSurface(surface);
    const head = screen.getByTestId('surface-ticket-66');
    expect(head.textContent).toContain(ticketSummaryToTicket(ticket).statusLabel);
    expect(head.textContent).not.toContain('需介入');
  });

  it('answers the decision request when a choice is pressed', () => {
    const { resolve } = renderSurface(surface);
    fireEvent.click(screen.getByRole('button', { name: /取消 #66/ }));
    expect(resolve).toHaveBeenCalledWith('decision:12', { authority: 'decision_request', decision: 'select', optionId: 'cancel' });
  });

  it('shows what was chosen once the decision is resolved, from the live decision state', () => {
    renderSurface(surface, 'resolved');
    expect(screen.getByText('你选了「并入 #72」')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /取消 #66/ })).toBeNull();
  });

  it('falls back to the plain sentence when the surface is not valid', () => {
    renderSurface({ ...surface, nodes: [{ id: 'card', type: 'Html', props: {} }] });
    expect(screen.getByText(surface.fallbackText)).toBeTruthy();
  });
});

// 组件目录 v2（2026-10-19 用户决定）：复杂的信息也用组件画。表格里的工单只存编号，标题和状态实时读取；
// 其余的数字和状态是画卡时的快照。
describe('a card that shows information', () => {
  const info = (nodes: UiSurface['nodes']): UiSurface => ({
    id: 'overview', catalogVersion: 1, root: 'card', fallbackText: '本周的工单概况。',
    nodes: [{ id: 'card', type: 'Stack', props: {}, children: nodes.map((node) => node.id) }, ...nodes],
  });

  it('draws a table whose ticket cells read the live ticket, with badges and right-aligned numbers', () => {
    renderSurface(info([{
      id: 'table', type: 'DataTable', props: {
        columns: [{ label: '工单' }, { label: 'CI' }, { label: '改动行数' }],
        rows: [[{ ticket: 66 }, { badge: '失败', tone: 'danger' }, 1234]],
      },
    }]));
    expect(screen.getByText('工单')).toBeTruthy();
    const cell = screen.getByTestId('surface-cell-ticket-66');
    expect(cell.textContent).toContain('成果快照与登记机制');
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText('1,234')).toBeTruthy();
  });

  it('shows the ticket status that is true now, not a status copied into the card', async () => {
    const { ticketSummaryToTicket } = await import('../workspace/model');
    renderSurface(info([{ id: 'table', type: 'DataTable', props: { columns: [{ label: '工单' }], rows: [[{ ticket: 66 }]] } }]));
    expect(screen.getByTestId('surface-cell-ticket-66').textContent).toContain(ticketSummaryToTicket(ticket).statusLabel);
  });

  it('draws stats with their unit and change', () => {
    renderSurface(info([{
      id: 'stats', type: 'Stats', props: { items: [{ label: '完成', value: 12, unit: '张', change: '比上周多 4 张', tone: 'success' }] },
    }]));
    expect(screen.getByText('完成')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('张')).toBeTruthy();
    expect(screen.getByText('比上周多 4 张')).toBeTruthy();
  });

  it('draws steps with a mark that names each state', () => {
    renderSurface(info([{
      id: 'steps', type: 'Steps', props: {
        items: [
          { label: '复现', state: 'done' },
          { label: '修复', state: 'current', detail: '改登记顺序' },
          { label: '核查', state: 'pending' },
        ],
      },
    }]));
    expect(screen.getByLabelText('已完成')).toBeTruthy();
    expect(screen.getByLabelText('进行中')).toBeTruthy();
    expect(screen.getByLabelText('未开始')).toBeTruthy();
    expect(screen.getByText('改登记顺序')).toBeTruthy();
  });

  it('draws a progress bar, and says so when the amount is unknown', () => {
    renderSurface(info([
      { id: 'known', type: 'Progress', props: { label: '迁移文件', value: 0.4, caption: '120 / 300 个' } },
      { id: 'unknown', type: 'Progress', props: { label: '等待 CI' } },
    ]));
    expect(screen.getByText('40%')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')[0]!.getAttribute('aria-valuenow')).toBe('40');
    expect(screen.getByText('进度未知')).toBeTruthy();
  });

  it('draws a timeline in the given order', () => {
    renderSurface(info([{
      id: 'timeline', type: 'Timeline', props: { items: [{ at: '09:58', text: 'CI 第一次失败' }, { at: '10:20', text: '修复后通过', tone: 'success' }] },
    }]));
    const text = screen.getByTestId('surface-timeline-timeline').textContent ?? '';
    expect(text.indexOf('CI 第一次失败')).toBeLessThan(text.indexOf('修复后通过'));
  });

  it('draws horizontal and vertical bar charts, each bar named with its value', () => {
    renderSurface(info([
      { id: 'bars', type: 'BarChart', props: { unit: '次', bars: [{ label: 'codex', value: 31 }, { label: 'claude', value: 18 }] } },
      { id: 'trend', type: 'BarChart', props: { orientation: 'vertical', bars: [{ label: '周一', value: 40 }, { label: '周二', value: 62 }] } },
    ]));
    expect(screen.getByLabelText('codex：31 次')).toBeTruthy();
    expect(screen.getByLabelText('周二：62')).toBeTruthy();
    expect(screen.getByText('周一')).toBeTruthy();
  });

  it('shows the fallback sentence instead of half a card when one of its components is not in the catalog', () => {
    renderSurface(info([{ id: 'chart', type: 'LineChart', props: { points: [1, 2] } }]));
    expect(screen.getByText('本周的工单概况。')).toBeTruthy();
    expect(screen.queryByTestId('surface-overview')).toBeNull();
  });
});

// 2026-10-20：部署了组件目录 v2 以后，01:27 打开的页面一直跑旧代码。Lead 画的带 DataTable、Stats、BarChart 的卡
// 服务端校验通过，旧页面却不认识这些组件，整张卡只剩 fallbackText，用户以为生成式 UI 坏了。
// 服务端校验过的卡里有这个版本不认识的组件：说明 App 旧了。在 fallbackText 前面说明原因，给刷新入口。
// 不自动刷新：用户可能正在输入。其他原因的不合格照旧只显示 fallbackText。
// genui v3 积木（2026-10-27）：图块、前导 + 正文、一排小格、别人说的话。和系统卡用同一套组件（packages/components）。
describe('a card built from the v3 blocks', () => {
  const card = (nodes: UiSurface['nodes']): UiSurface => ({
    id: 'v3', catalogVersion: 1, root: nodes[0]!.id, fallbackText: '提醒：周四 14:00 彪哥 last day。', nodes,
  });

  it('draws a ticket stub: a dated tile, a perforation, then the title', () => {
    renderSurface(card([
      { id: 'row', type: 'Media', props: { attach: true }, children: ['date', 'body'] },
      { id: 'date', type: 'Tile', props: { eyebrow: '10月', value: 29, caption: '周四', tone: 'info', size: 'sm' } },
      { id: 'body', type: 'Text', props: { text: '彪哥 last day', variant: 'title' } },
    ]));
    expect(screen.getByTestId('surface-tile-date-value').textContent).toBe('29');
    expect(screen.getByText('10月')).toBeTruthy();
    expect(screen.getByTestId('surface-media-row-perforation')).toBeTruthy();
    expect(getComputedStyle(screen.getByTestId('surface-tile-date-eyebrow')).backgroundColor).toBe('var(--c-accent-soft)');
    expect(screen.getByText('彪哥 last day')).toBeTruthy();
  });

  // 2026-10-27 用户定：照视觉稿，强调的图块（emphasis strong）小标题条用实色底、白字；普通的还是浅色底。边框颜色 jsdom 读不出来（只给 rgb(0, 0, 0)），在截图里核对。
  it('draws a solid eyebrow with white text on a strong tile, and a light one otherwise', () => {
    renderSurface(card([
      { id: 's', type: 'Stack', props: { direction: 'row' }, children: ['gate', 'plain'] },
      { id: 'gate', type: 'Tile', props: { eyebrow: '登机口', value: 'B12', tone: 'warning', emphasis: 'strong' } },
      { id: 'plain', type: 'Tile', props: { eyebrow: '待审', value: 12, tone: 'warning' } },
    ]));
    const style = (id: string) => getComputedStyle(screen.getByTestId(id));
    expect(style('surface-tile-gate-eyebrow').backgroundColor).toBe('var(--c-warning)');
    expect(getComputedStyle(screen.getByText('登机口')).color).toBe('var(--c-surface)');
    expect(style('surface-tile-plain-eyebrow').backgroundColor).toBe('var(--c-warning-soft)');
  });

  // 2026-10-27 用户对照视觉稿：日历页应该是卡片左边的一栏，贴住卡片的边（票根），不是卡片里一个带边框的小方框。
  it('makes the whole card a ticket stub when the root is an attached Media', () => {
    renderSurface(card([
      { id: 'row', type: 'Media', props: { attach: true }, children: ['date', 'body'] },
      { id: 'date', type: 'Tile', props: { eyebrow: '10月', value: 29 } },
      { id: 'body', type: 'Text', props: { text: '彪哥 last day', variant: 'title' } },
    ]));
    // 日历页贴住卡片的边，竖向撑满整张卡（Tile 的 attached）。jsdom 读不出 token 的内边距，内边距在截图里核对。
    expect(getComputedStyle(screen.getByTestId('surface-tile-date')).flexGrow).toBe('1');
    expect(screen.getByTestId('surface-media-row-perforation')).toBeTruthy();
    cleanup();
    // 不贴边的 Media 照常留卡片的内边距。
    renderSurface(card([
      { id: 'row', type: 'Media', props: {}, children: ['date', 'body'] },
      { id: 'date', type: 'Tile', props: { eyebrow: '10月', value: 29 } },
      { id: 'body', type: 'Text', props: { text: '彪哥 last day', variant: 'title' } },
    ]));
    expect(getComputedStyle(screen.getByTestId('surface-tile-date')).flexGrow).not.toBe('1');
  });

  it('keeps the tile the same width whatever its value', () => {
    renderSurface(card([
      { id: 's', type: 'Stack', props: { direction: 'row' }, children: ['a', 'b'] },
      { id: 'a', type: 'Tile', props: { value: 7 } },
      { id: 'b', type: 'Tile', props: { value: '87:84' } },
    ]));
    const width = (id: string) => getComputedStyle(screen.getByTestId(id)).width;
    expect(width('surface-tile-a')).toBe(width('surface-tile-b'));
  });

  it('draws one square per result, and the summary after them', () => {
    renderSurface(card([{ id: 'seg', type: 'Segments', props: {
      items: [{ label: '依据核实', tone: 'success' }, { label: '有依据', tone: 'warning' }], summary: '信心 0.71',
    } }]));
    expect(getComputedStyle(screen.getByTestId('surface-segments-seg-square-0')).backgroundColor).toBe('var(--c-success)');
    expect(screen.getByText('信心 0.71')).toBeTruthy();
  });

  it('quotes the latest message on one line with a count, and draws nothing before the server fills the words', () => {
    renderSurface(card([{ id: 'm', type: 'Message', props: {
      ref: { type: 'channel_card', id: 3 }, mode: 'latest', sender: '王小明', total: 5,
      messages: [{ at: '2026-10-27T02:04:00.000Z', text: '明哥，这个 pr 记得再帮我看看' }],
    } }]));
    expect(screen.getByText('王小明')).toBeTruthy();
    expect(screen.getByTestId('surface-message-m-count').textContent).toBe('5 条');
    expect(getComputedStyle(screen.getByTestId('surface-message-m-bubble-0')).backgroundColor).toBe('var(--c-accent-soft)');
    cleanup();
    renderSurface(card([{ id: 'm', type: 'Message', props: { ref: { type: 'channel_card', id: 3 }, mode: 'latest' } }]));
    expect(screen.queryByTestId('surface-message-m')).toBeNull();
  });
});

// genui v3 积木 3–6（2026-10-27）：用户要求提醒卡那种「点开改时间、实时剩余时间」也能用积木拼出来。
// 收起态留在会话里（列表不变高），点一下撑开成浮层；按钮做的是操作层的同一个操作，用户按下时是用户本人做。
describe('a reminder card built only from blocks', () => {
  const REMINDER = 83;
  const remindAt = new Date(Date.now() + (3 * 24 + 1) * 3_600_000 + 60_000).toISOString();
  const reminderSummary: TicketSummary = {
    ...ticket, id: REMINDER, title: '彪哥今天 last day', kind: 'reminder', hasRun: false, rootTicketId: REMINDER,
    attention: { pendingApprovalCount: 0, blockerCount: 0 }, stage: 'scheduled', status: 'scheduled',
  };
  const stub: UiSurface = {
    id: 'remind-83', catalogVersion: 1, root: 'box', fallbackText: '提醒：周四 14:00 彪哥今天 last day。',
    nodes: [
      { id: 'box', type: 'Disclosure', props: { label: '提醒的操作', lines: 2, detail: ['opts'] }, children: ['row', 'opts'] },
      { id: 'row', type: 'Media', props: { attach: true }, children: ['date', 'body'] },
      { id: 'date', type: 'Tile', props: { eyebrow: '10月', value: 29, size: 'sm', bind: { ticket: REMINDER, field: 'stage' } } },
      { id: 'body', type: 'Stack', props: { gap: 'sm' }, children: ['title', 'when'] },
      { id: 'title', type: 'Text', props: { text: '彪哥今天 last day', variant: 'title' } },
      { id: 'when', type: 'Text', props: { text: '周四 14:00', variant: 'caption', bind: { ticket: REMINDER, field: 'remindAt', format: 'remaining' } } },
      { id: 'opts', type: 'Stack', props: { gap: 'md' }, children: ['pick', 'save'] },
      { id: 'pick', type: 'Field', props: { for: 'save', param: 'remindAt', kind: 'datetime', presets: [{ label: '1 小时后', value: '+1h' }, { label: '明天 09:00', value: '+1d 09:00' }] } },
      { id: 'save', type: 'Action', props: { target: { type: 'reminder', id: String(REMINDER) }, action: 'reschedule', role: 'primary', label: '改时间' } },
    ],
  };
  const view = (id: string, available: boolean): UiActionView => ({
    target: { type: 'reminder', id: String(REMINDER) }, id, label: id === 'reschedule' ? '改时间' : '知道了', permission: 'lead_allowed',
    external: false, irreversible: false, where: '会话里的提醒卡', confirm: null, available, reason: available ? null : '提醒还没到点',
  });

  function renderReminder(stage: TicketSummary['stage'] = 'scheduled') {
    const { runtime } = renderSurface({ ...stub });
    runtime.control.getState().replaceTickets([{ ...reminderSummary, stage, status: stage }]);
    runtime.control.getState().replaceTicketDetail({
      ticket: { ...reminderSummary, stage, status: stage }, brief: '', body: '', workdir: null, createdAt: reminderSummary.updatedAt,
      totalTokens: 0, totalCostUsd: 0, remindAt,
    });
    const list = vi.spyOn(runtime, 'listUiActions').mockResolvedValue([view('ack', false), view('reschedule', true)]);
    const perform = vi.spyOn(runtime, 'performUiAction').mockResolvedValue({ target: { type: 'reminder', id: '83' }, action: 'reschedule', result: null });
    return { runtime, list, perform };
  }

  it('shows the time left, live from the reminder, instead of the snapshot Lead wrote', async () => {
    cleanup();
    renderReminder();
    expect(await screen.findByText('还有 3 天 1 小时')).toBeTruthy();
    expect(screen.queryByText('周四 14:00')).toBeNull();
    expect(getComputedStyle(screen.getByTestId('surface-tile-date-eyebrow')).backgroundColor).toBe('var(--c-accent-soft)');
  });

  it('opens from the card into a panel, and moves the reminder to the time the user picked', async () => {
    cleanup();
    const { perform } = renderReminder();
    expect(screen.queryByTestId('surface-action-save')).toBeNull();
    fireEvent.click(screen.getByTestId('surface-disclosure-box-summary'));
    const option = await screen.findByRole('radio', { name: '1 小时后' });
    fireEvent.click(option);
    // 卡片自己预览改动（绑定了提醒的时刻）：剩余时间先写到新时间的，Field 下面不再另写一行。
    expect(screen.queryByTestId('surface-field-pick-preview')).toBeNull();
    expect(screen.getAllByText(/^还有 \d+ 分钟$|^还有 1 小时$/).length).toBeGreaterThan(0);
    const before = Date.now();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: '改时间' })); });
    expect(perform).toHaveBeenCalledTimes(1);
    const [type, id, action, request] = perform.mock.calls[0]!;
    expect([type, id, action]).toEqual(['reminder', '83', 'reschedule']);
    const at = Date.parse((request as { input: { remindAt: string } }).input.remindAt);
    // 「1 小时后」按下时才换算：从按下的这一刻算，不是画卡的时候。
    expect(at - before).toBeGreaterThanOrEqual(3_600_000 - 1_000);
    expect(at - before).toBeLessThanOrEqual(3_600_000 + 5_000);
    // 做完一个操作，浮层收起。
    expect(screen.queryByRole('radio', { name: '1 小时后' })).toBeNull();
  });

  // 2026-10-27 截图：改了时间以后剩余时间变了，日历页上的「10月 29」还是画卡时写死的快照。
  it('turns a tile bound to the time into a calendar page that follows the new time', async () => {
    cleanup();
    const { runtime } = renderSurface({
      ...stub,
      nodes: stub.nodes.map((node) => (node.id === 'date' ? { ...node, props: { ...node.props, bind: { ticket: REMINDER, field: 'remindAt', format: 'date' } } } : node)),
    });
    runtime.control.getState().replaceTickets([reminderSummary]);
    const at = new Date(2026, 9, 30, 14, 0);
    runtime.control.getState().replaceTicketDetail({
      ticket: reminderSummary, brief: '', body: '', workdir: null, createdAt: reminderSummary.updatedAt, totalTokens: 0, totalCostUsd: 0,
      remindAt: at.toISOString(),
    });
    expect((await screen.findByTestId('surface-tile-date-value')).textContent).toBe('30');
    expect(screen.getByTestId('surface-tile-date-eyebrow').textContent).toBe('10月');
  });

  // 2026-10-27 用户对照视觉稿：日历页那一栏要延伸到整个浮层并放大，选了新时间先在卡上预览（旧的划掉、新的强调色），
  // 打孔线两头有半圆缺口。
  it('keeps the calendar page down the open panel, previews the picked day, and notches the perforation', async () => {
    cleanup();
    const { runtime } = renderSurface({
      ...stub,
      nodes: stub.nodes.map((node) => (node.id === 'date' ? { ...node, props: { ...node.props, bind: { ticket: REMINDER, field: 'remindAt', format: 'date' } } } : node)),
    });
    runtime.control.getState().replaceTickets([reminderSummary]);
    const at = new Date(2026, 9, 29, 14, 0);
    runtime.control.getState().replaceTicketDetail({
      ticket: reminderSummary, brief: '', body: '', workdir: null, createdAt: reminderSummary.updatedAt, totalTokens: 0, totalCostUsd: 0,
      remindAt: at.toISOString(),
    });
    vi.spyOn(runtime, 'listUiActions').mockResolvedValue([view('reschedule', true)]);
    expect(screen.getByTestId('surface-media-row-notch-top')).toBeTruthy();
    expect(screen.getByTestId('surface-media-row-notch-bottom')).toBeTruthy();
    fireEvent.click(screen.getByTestId('surface-disclosure-box-summary'));
    const panelTile = () => within(screen.getByTestId('surface-media-row-open')).getByTestId('surface-tile-date-value');
    expect((await screen.findByTestId('surface-media-row-open'))).toBeTruthy();
    expect(panelTile().textContent).toBe('29');
    expect(within(screen.getByTestId('surface-media-row-open')).getByText('周四')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '明天 09:00' }));
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    expect(panelTile().textContent).toBe(String(tomorrow.getDate()));
    expect(within(screen.getByTestId('surface-media-row-open')).getByText('原 周四 29')).toBeTruthy();
  });

  it('greys out a button the operation cannot do now and says why, without removing it', async () => {
    cleanup();
    const { runtime } = renderReminder();
    vi.spyOn(runtime, 'listUiActions').mockResolvedValue([view('reschedule', false)]);
    fireEvent.click(screen.getByTestId('surface-disclosure-box-summary'));
    expect((await screen.findByTestId('surface-action-save-reason')).textContent).toBe('提醒还没到点');
    expect(screen.getByRole('button', { name: '改时间' }).getAttribute('aria-disabled') ?? (screen.getByRole('button', { name: '改时间' }) as HTMLButtonElement).disabled.toString()).toMatch(/true/);
  });

  // 2026-10-27 截图：确认条只换掉了「取消提醒」一个按钮，和「改时间」错开。视觉稿是整排换成一行确认。
  it('turns the whole row of buttons into one confirm row before cancelling', async () => {
    cleanup();
    const { runtime } = renderSurface({
      ...stub,
      nodes: [
        ...stub.nodes.map((node) => (node.id === 'opts' ? { ...node, children: ['pick', 'acts'] } : node)),
        { id: 'acts', type: 'Stack', props: { direction: 'row' }, children: ['cancel', 'save'] },
        { id: 'cancel', type: 'Action', props: { target: { type: 'ticket', id: REMINDER }, action: 'cancel', role: 'default', label: '取消提醒' } },
      ].filter((node, index, all) => all.findIndex((other) => other.id === node.id) === index),
    });
    runtime.control.getState().replaceTickets([reminderSummary]);
    runtime.control.getState().replaceTicketActions(REMINDER, [{
      id: 'cancel', label: '取消', area: 'ticket', permission: 'user_only', external: false, irreversible: false, undoable: true, available: true, reason: null,
    }]);
    vi.spyOn(runtime, 'listUiActions').mockResolvedValue([view('reschedule', true)]);
    const cancel = vi.spyOn(runtime, 'runTicketAction').mockResolvedValue({} as never);
    fireEvent.click(screen.getByTestId('surface-disclosure-box-summary'));
    fireEvent.click(await screen.findByRole('button', { name: '取消提醒' }));
    expect(screen.getByTestId('surface-action-cancel-confirm')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '改时间' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认取消提醒' })); });
    expect(cancel).toHaveBeenCalledWith(REMINDER, 'cancel', { input: {} });
  });

  it('stays closed once the reminder is confirmed, and writes the time it was for', async () => {
    cleanup();
    renderReminder('acked');
    expect(await screen.findByText(/^周. \d{2}-\d{2} \d{2}:\d{2}$/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('surface-disclosure-box-summary'));
    expect(screen.queryByRole('radio', { name: '1 小时后' })).toBeNull();
    expect(getComputedStyle(screen.getByTestId('surface-tile-date-eyebrow')).backgroundColor).toBe('var(--c-success-soft)');
  });
});

// 对象组件（2026-10-27，三层）：Lead 只给提醒的编号，画出来的就是会话里系统的那张提醒卡，外面不再套一层卡片。
describe('a reminder referenced by its number', () => {
  it('is the system reminder card itself', async () => {
    const { runtime } = renderSurface({ id: 'r', catalogVersion: 1, root: 'r', fallbackText: '提醒 #83', nodes: [{ id: 'r', type: 'Reminder', props: { reminder: 83 } }] });
    runtime.control.getState().replaceTickets([{
      ...ticket, id: 83, title: '彪哥今天 last day', kind: 'reminder', hasRun: false, rootTicketId: 83, stage: 'scheduled', status: 'scheduled',
      attention: { pendingApprovalCount: 0, blockerCount: 0 },
    }]);
    expect(await screen.findByTestId('reminder-card-83')).toBeTruthy();
    expect(screen.getByText('彪哥今天 last day')).toBeTruthy();
    expect(screen.queryByTestId('surface-r')).toBeNull();
  });
});

// 模式组件「事项」（2026-10-27，三层）：画布「用同一套积木拼出的卡」的航班、比分、发布、一组待办。
describe('the Item pattern', () => {
  const one = (nodes: UiSurface['nodes']): UiSurface => ({ id: 'item', catalogVersion: 1, root: nodes[0]!.id, fallbackText: '一件事。', nodes });

  it('draws a flight: a strong amber tile, the route and times, a quiet button on the right', () => {
    renderSurface(one([
      { id: 'f', type: 'Item', props: { lead: { eyebrow: '登机口', value: 'B12', caption: '15:40 关闭', tone: 'warning', emphasis: 'strong' }, title: 'CA1501 北京 → 上海', meta: '16:10 起飞 · 18:25 到达 · 准点' }, children: ['pass'] },
      { id: 'pass', type: 'Action', props: { target: { type: 'ticket', id: 66 }, action: 'cancel', role: 'quiet', label: '登机牌' } },
    ]));
    expect(getComputedStyle(screen.getByTestId('surface-tile-f-lead-eyebrow')).backgroundColor).toBe('var(--c-warning)');
    expect(screen.getByText('CA1501 北京 → 上海')).toBeTruthy();
    expect(screen.getByText('16:10 起飞 · 18:25 到达 · 准点')).toBeTruthy();
    expect(screen.getByRole('button', { name: '登机牌' })).toBeTruthy();
  });

  it('draws a release as a stub attached to the card edge, with notches', () => {
    renderSurface(one([{ id: 'r', type: 'Item', props: { lead: { eyebrow: '发布', value: 'v2.4', tone: 'success', size: 'sm' }, attach: true, title: 'acme/orders 已部署到生产', meta: '12 个改动 · 3 个修复 · 10-26 16:20' } }]));
    expect(screen.getByTestId('surface-item-r-perforation')).toBeTruthy();
    expect(screen.getByTestId('surface-item-r-notch-top')).toBeTruthy();
    expect(getComputedStyle(screen.getByTestId('surface-tile-r-lead')).flexGrow).toBe('1');
  });

  it('draws a score with a sentence instead of a title', () => {
    renderSurface(one([{ id: 's', type: 'Item', props: { lead: { eyebrow: '第 3 节', value: '87:84', caption: '还剩 2:10', tone: 'info', emphasis: 'strong' }, text: '主队靠三分球追上来，最近 4 分钟打出 12:2。', meta: '更新于 21:42' } }]));
    expect(screen.getByText('主队靠三分球追上来，最近 4 分钟打出 12:2。')).toBeTruthy();
    expect(screen.getByText('更新于 21:42')).toBeTruthy();
  });

  it('opens a to-do group in place to show its table', async () => {
    renderSurface(one([
      { id: 'todo', type: 'Item', props: { lead: { eyebrow: '待审', value: 12, tone: 'warning', size: 'sm' }, title: '12 个 PR 等你 review', meta: '最早的一个等了 3 天 · #118 最急' }, children: ['t'] },
      { id: 't', type: 'DataTable', props: { columns: [{ label: 'PR' }, { label: '等了' }], rows: [[{ ticket: 66 }, '3 天']] } },
    ]));
    expect(screen.queryByText('等了')).toBeNull();
    fireEvent.click(screen.getByTestId('surface-disclosure-todo-summary'));
    expect(await screen.findByText('等了')).toBeTruthy();
  });
});

describe('a card made with a newer component catalog than this app', () => {
  const card = (nodes: UiSurface['nodes']): UiSurface => ({
    id: 'overview', catalogVersion: 1, root: 'card', fallbackText: '本周 12 张工单完成，3 张进行中。',
    nodes: [{ id: 'card', type: 'Stack', props: {}, children: nodes.map((node) => node.id) }, ...nodes],
  });
  const newer = card([
    { id: 'stats', type: 'Stats', props: { items: [{ label: '完成', value: 12 }] } },
    { id: 'chart', type: 'LineChart', props: { points: [1, 2] } },
  ]);

  const UNSUPPORTED = '这张卡用了当前版本还不支持的组件';

  it('says the card needs the new version when the daemon serves a newer page, and refreshes only when asked', () => {
    const { reloadApp } = renderSurface(newer, 'pending', { web: { current: 'build-a', served: 'build-b' } });
    const note = screen.getByTestId('surface-needs-update');
    expect(note.textContent).toContain('这张卡需要新版本，刷新后显示');
    expect(screen.getByText('本周 12 张工单完成，3 张进行中。')).toBeTruthy();
    expect(screen.queryByText('完成')).toBeNull();
    expect(reloadApp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(reloadApp).toHaveBeenCalledTimes(1);
  });

  // 2026-10-20 验收：daemon 的组件目录比网页新，但 daemon 提供的就是这个页面（例如部署了 daemon、没跑 build:web）。
  // 以前照样写「刷新后显示」并给刷新按钮，用户点了刷新还是纯文本。
  it('offers no refresh when the page already is the version the daemon serves', () => {
    renderSurface(newer, 'pending', { web: { current: 'build-a', served: 'build-a' } });
    const note = screen.getByTestId('surface-needs-update');
    expect(note.textContent).toContain(UNSUPPORTED);
    expect(note.textContent).not.toContain('刷新');
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
    expect(screen.getByText('本周 12 张工单完成，3 张进行中。')).toBeTruthy();
  });

  // 收起的是顶栏的提示，卡片照样说实话：刷新能拿到新版本，就给刷新。
  it('still offers the refresh on the card after the header notice for that version was dismissed', () => {
    renderSurface(newer, 'pending', { web: { current: 'build-a', served: 'build-b', dismissed: 'build-b' } });
    expect(screen.getByTestId('surface-needs-update').textContent).toContain('这张卡需要新版本，刷新后显示');
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
  });

  // 不知道 daemon 提供的版本时（还没读到、读失败、dev server、原生应用），不承诺刷新有用。
  it('does not promise a refresh when the served version is unknown', () => {
    renderSurface(newer, 'pending', { web: { current: 'build-a', served: null } });
    expect(screen.getByTestId('surface-needs-update').textContent).toContain(UNSUPPORTED);
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
    cleanup();
    renderSurface(newer);
    expect(screen.getByTestId('surface-needs-update').textContent).toContain(UNSUPPORTED);
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
    cleanup();
    renderSurface(newer, 'pending', { canReload: false });
    expect(screen.getByTestId('surface-needs-update').textContent).toContain(UNSUPPORTED);
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
    expect(screen.getByText('本周 12 张工单完成，3 张进行中。')).toBeTruthy();
  });

  it('offers the refresh once the check finds a newer page', async () => {
    const { runtime } = renderSurface(newer, 'pending', { web: { current: 'build-a', served: null } });
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
    await act(async () => { runtime.webVersion.setState({ served: 'build-b' }); });
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
  });

  it('shows only the fallback sentence when the card is invalid for another reason', () => {
    renderSurface(card([{ id: 'table', type: 'DataTable', props: { columns: [{ label: '工单' }, { label: 'CI' }], rows: [['#66']] } }]));
    expect(screen.getByText('本周 12 张工单完成，3 张进行中。')).toBeTruthy();
    expect(screen.queryByTestId('surface-needs-update')).toBeNull();
    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull();
  });

  // 实时事件里，客户端校验不过的卡以前被直接丢掉，连 fallbackText 都没有。
  it('arrives from a live event, so the note shows instead of nothing', () => {
    const runtime = applyLive(emptyRuntime(), [
      event(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'paired:companion', mode: 'started' }),
      event(2, 'lead.tool.updated', { toolCallId: 'call-1', toolName: 'render_ui', textOffset: 0, surface: newer }),
    ]);
    expect(parts(runtime).find((part) => part.kind === 'surface')).toMatchObject({ surface: { id: 'overview' } });
  });

  it('is still dropped from a live event when it is invalid for another reason', () => {
    const broken = card([{ id: 'table', type: 'DataTable', props: { columns: [{ label: '工单' }, { label: 'CI' }], rows: [['#66']] } }]);
    const runtime = applyLive(emptyRuntime(), [
      event(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'paired:companion', mode: 'started' }),
      event(2, 'lead.tool.updated', { toolCallId: 'call-1', toolName: 'render_ui', textOffset: 0, surface: broken }),
    ]);
    expect(parts(runtime).find((part) => part.kind === 'surface')).toBeUndefined();
  });
});

// 决定卡（surface 里的 ChoiceGroup）和它的决策请求是同一件事：主会话里不再另画一张介入卡片（不出现两个入口）。
describe('the main conversation', () => {
  it('drops the intervention card of a decision a surface already shows', async () => {
    const { surfaceBoundInterventionIds } = await import('../chat/LeadConversation');
    const ids = surfaceBoundInterventionIds([
      { kind: 'surface', id: 'p1', callId: 'call-1', textOffset: 0, partial: false, surface },
      { kind: 'text', id: 'p2', text: 'x' },
    ]);
    expect([...ids]).toEqual(['decision:12']);
  });

  // 对象节点 Intervention（2026-10-27）：Lead 在回复里引用了一条审批，卡画在回复里，会话里不再另画一张。
  it('drops the intervention card of an approval a surface refers to', async () => {
    const { surfaceBoundInterventionIds } = await import('../chat/LeadConversation');
    const refers: UiSurface = { id: 'r', catalogVersion: 1, root: 'i', fallbackText: '审批 #5。', nodes: [{ id: 'i', type: 'Intervention', props: { kind: 'approval', id: 5, ticket: 66 } }] };
    const ids = surfaceBoundInterventionIds([{ kind: 'surface', id: 'p1', callId: 'call-1', textOffset: 0, partial: false, surface: refers }]);
    expect([...ids]).toEqual(['approval:5']);
  });

  it('drops the timeline copy of an outside message card a surface refers to', async () => {
    const { surfaceBoundChannelCardIds } = await import('../chat/LeadConversation');
    const refers: UiSurface = { id: 'r', catalogVersion: 1, root: 'c', fallbackText: '王小明的私信。', nodes: [{ id: 'c', type: 'ChannelCard', props: { card: 1 } }] };
    expect([...surfaceBoundChannelCardIds([{ kind: 'surface', id: 'p1', callId: 'call-1', textOffset: 0, partial: false, surface: refers }])]).toEqual([1]);
  });

  // 这个版本画不出来的卡只显示说明和 fallbackText，没有选项按钮：决策请求照旧在主会话里有自己的卡片。
  it('keeps the intervention card of a decision in a card this app cannot draw', async () => {
    const { surfaceBoundInterventionIds } = await import('../chat/LeadConversation');
    const newer: UiSurface = { ...surface, nodes: surface.nodes.map((node) => node.id === 'head' ? { id: 'head', type: 'LineChart', props: {} } : node) };
    const ids = surfaceBoundInterventionIds([{ kind: 'surface', id: 'p1', callId: 'call-1', textOffset: 0, partial: false, surface: newer }]);
    expect([...ids]).toEqual([]);
  });
});

// 流式：参数还在写时先到一张「生成中」的卡片，定稿版替换它，始终是同一个部件（按 render_ui 的 callId）。
describe('a surface that is still being generated', () => {
  it('is replaced by the final version in the same place', () => {
    const partial: UiSurface = { ...surface, id: 's_call-1', fallbackText: '正在生成卡片…', nodes: [{ id: 'card', type: 'Stack', props: {}, children: ['head'] }, { id: 'head', type: 'TicketRef', props: { ticket: 66 } }] };
    const runtime = applyLive(emptyRuntime(), [
      event(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'system:blocker', mode: 'started' }),
      event(2, 'lead.tool.updated', { toolCallId: 'call-1', toolName: 'render_ui', textOffset: 0, surface: partial, partial: true }),
    ]);
    expect(parts(runtime).filter((part) => part.kind === 'surface')).toEqual([
      expect.objectContaining({ id: `${TURN}:surface:call-1`, partial: true, surface: expect.objectContaining({ id: 's_call-1' }) }),
    ]);
    applyLive(runtime, [event(3, 'lead.tool.updated', { toolCallId: 'call-1', toolName: 'render_ui', textOffset: 0, surface })]);
    expect(parts(runtime).filter((part) => part.kind === 'surface')).toEqual([
      expect.objectContaining({ id: `${TURN}:surface:call-1`, partial: false, surface }),
    ]);
  });

  // 2026-10-24 线上：第一次 render_ui 校验失败，Lead 用同一个 surface_id 重画。失败那次的「生成中」卡片一直留着，
  // 用户看到两张差不多的卡，第一张停在「正在生成…」。失败的调用的卡片撤掉；同一个 id 的重画替换旧卡。
  it('goes away when its call fails, and a redraw with the same id is the only card', () => {
    const streaming: UiSurface = { ...surface, fallbackText: '第一版' };
    const redraw: UiSurface = { ...surface, fallbackText: '第二版' };
    const runtime = applyLive(emptyRuntime(), [
      event(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'paired:companion', mode: 'started' }),
      event(2, 'lead.tool.updated', { toolCallId: 'call-1', toolName: 'render_ui', textOffset: 0, surface: streaming, partial: true }),
      event(3, 'lead.tool.started', { toolCallId: 'call-1', toolName: 'render_ui', args: {} }),
      event(4, 'lead.tool.failed', { toolCallId: 'call-1', toolName: 'render_ui', isError: true, result: { content: [{ type: 'text', text: 'surface 不合格' }] } }),
    ]);
    expect(parts(runtime).filter((part) => part.kind === 'surface')).toEqual([]);
    applyLive(runtime, [
      event(5, 'lead.tool.updated', { toolCallId: 'call-2', toolName: 'render_ui', textOffset: 0, surface: redraw, partial: true }),
      event(6, 'lead.tool.updated', { toolCallId: 'call-2', toolName: 'render_ui', textOffset: 0, surface: redraw }),
    ]);
    expect(parts(runtime).filter((part) => part.kind === 'surface')).toEqual([
      expect.objectContaining({ callId: 'call-2', partial: false, surface: redraw }),
    ]);
  });

  // 定稿以后同一个 id 再画：重画还在流时继续显示旧的定稿版，重画定稿时替换它，始终只有一张卡。
  it('stays a single card while a redraw with the same id streams and lands', () => {
    const first: UiSurface = { ...surface, fallbackText: '第一版' };
    const redraw: UiSurface = { ...surface, fallbackText: '第二版' };
    const runtime = applyLive(emptyRuntime(), [
      event(1, 'lead.turn.started', { messageId: `msg_${TURN}`, commandId: null, originKind: 'paired:companion', mode: 'started' }),
      event(2, 'lead.tool.updated', { toolCallId: 'call-1', toolName: 'render_ui', textOffset: 0, surface: first }),
      event(3, 'lead.tool.updated', { toolCallId: 'call-2', toolName: 'render_ui', textOffset: 0, surface: redraw, partial: true }),
    ]);
    expect(parts(runtime).filter((part) => part.kind === 'surface')).toEqual([
      expect.objectContaining({ callId: 'call-1', partial: false, surface: first }),
    ]);
    applyLive(runtime, [event(4, 'lead.tool.updated', { toolCallId: 'call-2', toolName: 'render_ui', textOffset: 0, surface: redraw })]);
    expect(parts(runtime).filter((part) => part.kind === 'surface')).toEqual([
      expect.objectContaining({ callId: 'call-2', partial: false, surface: redraw }),
    ]);
  });

  it('says it is still being generated and does not take a choice yet', () => {
    const runtime = emptyRuntime();
    runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
    runtime.control.getState().replaceTickets([ticket]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><SurfaceView surface={surface} partial /></CompanionRuntimeProvider>);
    expect(screen.getByText('正在生成…')).toBeTruthy();
    expect(screen.getByTestId('surface-choice-merge').getAttribute('aria-disabled')).toBe('true');
  });
});

// 转述改成引用（2026-10-19）：SourceQuote 的文字是服务端从账本取的原文，App 照原样显示，写出处。
describe('a quoted source', () => {
  const quote = (props: Record<string, unknown>): UiSurface => ({
    id: 'quote-98', catalogVersion: 1, root: 'q', fallbackText: '#98 的核查报告原文见卡片。',
    nodes: [{ id: 'q', type: 'SourceQuote', props: { ticket: 98, source: 'body', heading: '【独立核查报告】', ...props } }],
  });

  it('shows the original text and where it comes from', () => {
    renderSurface(quote({ text: '【独立核查报告】\n1. wrapper.ts 的参数可以绕过', label: '工单 #98 正文 ·「【独立核查报告】」' }));
    expect(screen.getByTestId('surface-source-quote-98').textContent).toContain('原文 · 工单 #98 正文 ·「【独立核查报告】」');
    expect(screen.getByText(/wrapper\.ts 的参数可以绕过/)).toBeTruthy();
  });

  it('says it is still fetching the original while the card is generated', () => {
    renderSurface(quote({}));
    expect(screen.getByText('正在取原文…')).toBeTruthy();
  });
});

// 对象节点 ChannelCard、Intervention（2026-10-27，覆盖表第 3、4 步）：Lead 只给编号，卡就是会话里的那一张系统卡。
describe('an outside message card and a child request as objects', () => {
  const object = (node: UiSurface['nodes'][number]): UiSurface => ({
    id: 'object', catalogVersion: 1, root: node.id, fallbackText: '见卡片。', nodes: [node],
  });

  it('draws the outside message card from the store, with its own actions', () => {
    const { runtime } = renderSurface(object({ id: 'c', type: 'ChannelCard', props: { card: 7 } }));
    expect(screen.getByTestId('channel-card-slot-7').textContent).toBe('外部消息卡 #7 正在同步。');
    const dto = {
      id: 7, version: 3, source: 'slack', sourceLabel: 'Slack', objectKey: 'slack:D0ZHANG:main', laneLabel: '张三的私信',
      sender: { id: 'U0ZHANG', name: '张三', trust: 'colleague' }, excerpt: '周五评审的材料收到了吗？谢谢', messageCount: 1,
      delivery: 'card', state: 'open', draft: { text: '收到，谢谢！', drafter: 'template' },
      gate: { decision: 'shadow', category: 'acknowledgement', reasons: ['影子模式'] },
      lookup: null, handling: null, sentText: null, snoozedUntil: null, revokeUntil: null, resolvedAt: null,
      actions: ['send_draft', 'reply_myself', 'snooze', 'dismiss'],
      createdAt: '2026-10-17T02:00:00.000Z', updatedAt: '2026-10-17T02:00:05.000Z',
    } as ChannelCardDto;
    act(() => runtime.control.getState().replaceChannelCards([dto]));
    expect(screen.getByTestId('channel-card-7')).toBeTruthy();
    expect(document.body.textContent).toContain('周五评审的材料收到了吗？谢谢');
    expect(screen.queryByTestId('channel-card-slot-7')).toBeNull();
  });

  it('draws the decision request from the ticket, and answers it with the same command', async () => {
    const { resolve } = renderSurface(object({ id: 'i', type: 'Intervention', props: { kind: 'decision', id: 12, ticket: 66 } }));
    expect(screen.getByTestId('intervention-decision:12').textContent).toContain('child #66：#66 接下来怎么办？');
    fireEvent.click(screen.getByRole('radio', { name: '取消 #66' }));
    fireEvent.click(screen.getByRole('button', { name: '就这样定' }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith('decision:12', { authority: 'decision_request', decision: 'select', optionId: 'cancel' }));
  });

  it('collapses an answered request into one end line', () => {
    renderSurface(object({ id: 'i', type: 'Intervention', props: { kind: 'decision', id: 12, ticket: 66 } }), 'resolved');
    expect(screen.getByTestId('intervention-decision:12').textContent).toContain('已解决');
  });
});

// 同类合并（2026-10-28 改版稿第 2 版第 5 组）：失败的那件单独写在前面，同类的几件收成一行写件数，点开一件一行。
describe('the Group node', () => {
  it('writes the count from its children, and lists them only in the anchored panel', async () => {
    const lines = Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, type: 'Text', props: { text: `skills/scope.py:${index + 100}` } }));
    renderSurface({
      id: 'review', catalogVersion: 1, root: 's', fallbackText: 'PR #119 的评审意见。',
      nodes: [
        { id: 's', type: 'Stack', props: {}, children: ['fail', 'ok'] },
        { id: 'fail', type: 'Text', props: { text: '第 4/13 条没加上：行号不在这次改动里' } },
        { id: 'ok', type: 'Group', props: { tag: '已加', label: '行内评论' }, children: lines.map((line) => line.id) },
        ...lines,
      ],
    });
    expect(screen.getByText('第 4/13 条没加上：行号不在这次改动里')).toBeTruthy();
    expect(screen.getByTestId('surface-group-ok-count').textContent).toBe('12 件');
    expect(screen.queryByText('skills/scope.py:111')).toBeNull();
    fireEvent.click(screen.getByTestId('surface-group-ok-expand'));
    expect(await screen.findByTestId('surface-group-ok-panel')).toBeTruthy();
    expect(screen.getByTestId('surface-group-ok-list').textContent).toContain('skills/scope.py:111');
  });
});
