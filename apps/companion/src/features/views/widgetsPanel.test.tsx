// @vitest-environment jsdom
// 视图面板（2026-10-30，.scratch/custom-views/spec.md D2，patterns P16、主题 11.14 第 7 项）：
//   顶栏最右边的按钮打开、收起面板；面板和工单详情共用右侧的位置；
//   面板列出控件（会话里同一个 SurfaceView 画），「⋯」里上移、下移、移到别的视图、删掉，删掉就地确认一次；
//   视图是控件的一个属性：只有一个视图时不显示 tab，有两个以上时显示，切 tab 只显示那个视图的控件。
// 客户端方法是假的，断言的是界面发出的操作（和 Lead 的 perform_action 同一个函数）。
import { UI_CATALOG_VERSION, type WidgetDto } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { createWorkspaceStore } from '../../state/workspace/store';
import { LeadConversation } from '../chat/LeadConversation';
import { ViewsPanel } from './ViewsPanel';
import { currentView, everyText, movedOrder, widgetMetaLine, widgetSourceProblem, widgetTimeText } from './widgetsModel';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

const AT = '2026-10-30T06:00:00.000Z';
const widget = (id: number, title: string, value: string, view = 'default', createdBy: WidgetDto['createdBy'] = 'lead'): WidgetDto => ({
  id, title, view, createdBy, createdAt: AT, updatedAt: AT,
  surface: {
    id: `widget_${id}`, catalogVersion: UI_CATALOG_VERSION, root: 'tile', fallbackText: `${title} ${value}`,
    nodes: [{ id: 'tile', type: 'Tile', props: { eyebrow: title, value } }],
  },
});

function setup(widgets: WidgetDto[]) {
  const client = {
    getWidgets: vi.fn(async () => widgets),
    performUiAction: vi.fn(async (type: string, id: string, action: string) => ({ target: { type, id }, action, result: { ok: true } })),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view']);
  runtime.control.setState({
    phase: 'ready', connectionState: 'connected',
    leadProfile: { name: 'Paimon', persona: '', interactionStyle: '', updatedAt: null, updatedBy: null },
  } as never);
  return { runtime, client };
}

function renderPanel(widgets: WidgetDto[]) {
  const made = setup(widgets);
  renderUI(<CompanionRuntimeProvider runtime={made.runtime}><ViewsPanel onClose={() => {}} /></CompanionRuntimeProvider>);
  return made;
}

describe('the views panel', () => {
  it('lists the widgets with the same genui renderer as the conversation, says who made each one, and shows no tabs for one view', async () => {
    renderPanel([widget(5, '纳斯达克', '18,532'), widget(3, '天气', '21°', 'default', 'user')]);
    await screen.findByTestId('widget-5');
    expect(screen.getByTestId('widget-title-5').textContent).toBe('纳斯达克');
    expect(screen.getByTestId('surface-widget_5').textContent).toContain('18,532');
    expect(screen.getByTestId('widget-meta-5').textContent).toBe(`Paimon 建的 · 更新于 ${widgetTimeText(AT)}`);
    expect(screen.getByTestId('widget-meta-3').textContent).toMatch(/^你建的/);
    expect(screen.queryByTestId('views-tabs')).toBeNull();
  });

  it('tells the user how to get a widget when there is none', async () => {
    renderPanel([]);
    expect((await screen.findByTestId('views-empty')).textContent).toContain('跟 Paimon 说你想一直看着的东西');
    expect(screen.queryByTestId('views-tabs')).toBeNull();
  });

  it('shows tabs once there are two views, default first, and shows only the chosen view', async () => {
    renderPanel([widget(7, '比特币', '68k', '投资'), widget(5, '纳斯达克', '18,532', '投资'), widget(3, '天气', '21°')]);
    await screen.findByTestId('views-tabs');
    expect(screen.getByTestId('views-tab-default').textContent).toBe('常用');
    expect(screen.getByTestId('views-tab-投资').textContent).toBe('投资');
    expect(screen.getByTestId('widget-3')).toBeTruthy();
    expect(screen.queryByTestId('widget-5')).toBeNull();
    fireEvent.click(screen.getByTestId('views-tab-投资'));
    expect(await screen.findByTestId('widget-5')).toBeTruthy();
    expect(screen.getByTestId('widget-7')).toBeTruthy();
    expect(screen.queryByTestId('widget-3')).toBeNull();
  });

  it('moves a widget to another view through the same update operation as Lead', async () => {
    const { client } = renderPanel([widget(5, '纳斯达克', '18,532', '投资'), widget(3, '天气', '21°')]);
    fireEvent.click(await screen.findByTestId('widget-more-3'));
    fireEvent.click(await screen.findByTestId('widget-move-to-3-投资'));
    await waitFor(() => expect(client.performUiAction).toHaveBeenCalledWith('widget', '3', 'update', { input: { view: '投资' } }));
  });

  it('deletes a widget only after the in-place confirm, through the same operation as Lead', async () => {
    const { client } = renderPanel([widget(5, '纳斯达克', '18,532')]);
    fireEvent.click(await screen.findByTestId('widget-more-5'));
    expect(screen.queryByTestId('widget-move-to-5-投资')).toBeNull();
    fireEvent.click(await screen.findByTestId('widget-delete-5'));
    expect(client.performUiAction).not.toHaveBeenCalled();
    expect(screen.getByTestId('widget-delete-confirm-5').textContent).toContain('删了不能恢复');
    client.getWidgets.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByTestId('widget-delete-confirm-yes-5'));
    await waitFor(() => expect(client.performUiAction).toHaveBeenCalledWith('widget', '5', 'delete', { input: { confirm: true } }));
    expect(await screen.findByTestId('views-empty')).toBeTruthy();
  });

  it('moves a widget down within its view with the full order, and cannot move the first one up', async () => {
    const { client } = renderPanel([widget(5, 'A', '1'), widget(9, 'X', '0', '投资'), widget(3, 'B', '2')]);
    fireEvent.click(await screen.findByTestId('widget-more-5'));
    expect((await screen.findByTestId('widget-move-up-5')).textContent).toContain('已经在最上面');
    fireEvent.click(screen.getByTestId('widget-move-down-5'));
    await waitFor(() => expect(client.performUiAction).toHaveBeenCalledWith('widget_board', 'widgets', 'reorder', { input: { ids: [3, 9, 5] } }));
  });
});

describe('widgets with a data source', () => {
  const sourced = (source: NonNullable<WidgetDto['source']>) => ({ ...widget(5, '纳斯达克', '18,532'), source });

  it('says how often it updates and when it last did, with no problem line while it works', async () => {
    renderPanel([sourced({ everySeconds: 900, lastRunAt: AT, lastOkAt: AT, lastError: null, paused: false })]);
    expect((await screen.findByTestId('widget-meta-5')).textContent).toBe(`每 15 分钟自动更新 · 上次 ${widgetTimeText(AT)}`);
    expect(screen.queryByTestId('widget-source-problem-5')).toBeNull();
  });

  it('shows why it stopped, keeps the last good card, and restarts it through the same refresh operation as Lead', async () => {
    const { client } = renderPanel([sourced({ everySeconds: 900, lastRunAt: AT, lastOkAt: AT, lastError: '命令退出码 7', paused: true })]);
    expect((await screen.findByTestId('widget-source-problem-5')).textContent)
      .toBe(`连续出错，已经停止更新，显示的是 ${widgetTimeText(AT)} 的数据。原因：命令退出码 7`);
    expect(screen.getByTestId('surface-widget_5').textContent).toContain('18,532');
    fireEvent.click(screen.getByTestId('widget-more-5'));
    const restart = await screen.findByTestId('widget-refresh-5');
    expect(restart.textContent).toContain('重新开始更新');
    fireEvent.click(restart);
    await waitFor(() => expect(client.performUiAction).toHaveBeenCalledWith('widget', '5', 'refresh', { input: {} }));
  });

  it('offers no refresh for a snapshot widget', async () => {
    renderPanel([widget(5, '纳斯达克', '18,532')]);
    fireEvent.click(await screen.findByTestId('widget-more-5'));
    await screen.findByTestId('widget-move-up-5');
    expect(screen.queryByTestId('widget-refresh-5')).toBeNull();
  });

  it('words the interval and the problems', () => {
    expect([everyText(60), everyText(900), everyText(3600), everyText(86_400), everyText(90)]).toEqual(['每 1 分钟', '每 15 分钟', '每 1 小时', '每 1 天', '每 90 秒']);
    expect(widgetSourceProblem({ source: { everySeconds: 60, lastRunAt: AT, lastOkAt: null, lastError: '超时', paused: false } }))
      .toBe('上一次更新出错。原因：超时');
    expect(widgetSourceProblem({ source: null })).toBeNull();
  });
});

describe('the views button in the top bar', () => {
  it('opens and closes the panel, and is only there when the parent gives it a place', () => {
    const { runtime } = setup([]);
    const toggle = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return <LeadConversation railOpen viewsOpen={open} onToggleViews={() => { toggle(); setOpen(!open); }} />;
    }
    const { unmount } = renderUI(<CompanionRuntimeProvider runtime={runtime}><Harness /></CompanionRuntimeProvider>);
    fireEvent.click(screen.getByRole('button', { name: '打开自定义视图' }));
    expect(toggle).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '收起自定义视图' }));
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: '打开自定义视图' })).toBeTruthy();
    unmount();
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation railOpen /></CompanionRuntimeProvider>);
    expect(screen.queryByTestId('views-toggle')).toBeNull();
  });
});

describe('the right-hand slot (P16.2)', () => {
  it('keeps one panel open at a time: views close the ticket, the ticket closes the views', () => {
    const store = createWorkspaceStore();
    act(() => store.getState().openThread());
    act(() => store.getState().openViews());
    expect(store.getState()).toMatchObject({ viewsOpen: true, threadOpen: false });
    act(() => store.getState().openThread());
    expect(store.getState()).toMatchObject({ viewsOpen: false, threadOpen: true });
    act(() => store.getState().openViews());
    act(() => store.getState().openCompactPanel('thread'));
    expect(store.getState()).toMatchObject({ viewsOpen: false, compactPanel: 'thread' });
  });
});

describe('the views text and order', () => {
  it('writes the short time, picks the shown view, and keeps other views in place when moving', () => {
    expect(widgetMetaLine({ createdBy: 'user', updatedAt: AT }, 'Paimon')).toBe(`你建的 · 更新于 ${widgetTimeText(AT)}`);
    expect(widgetTimeText('nope')).toBe('');
    expect(currentView(['default', '投资'], '投资')).toBe('投资');
    expect(currentView(['default', '投资'], '没了')).toBe('default');
    expect(currentView([], null)).toBe('default');
    const widgets = [{ id: 1, view: 'a' }, { id: 2, view: 'b' }, { id: 3, view: 'a' }];
    expect(movedOrder(widgets, 3, -1)).toEqual([3, 2, 1]);
    expect(movedOrder(widgets, 1, -1)).toBeNull();
    expect(movedOrder(widgets, 2, 1)).toBeNull();
  });
});
