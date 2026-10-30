// @vitest-environment jsdom
// 高风险的主人操作（工单 15 第一步）：有人用 CLI 凭证、回环网页或临时 admin 建的配对做了高风险操作时，
// daemon 在会话里贴一张卡（轮次的来源是 system:owner-action），收件箱里也有一条通知。两处都有「不是我」：
// 先在卡上再确认一次，再请网关撤销这次操作、作废发出它的凭证。别的设备上已经点过的，直接显示结果。
// 发出操作的就是这个客户端自己的凭证（用户刚在这里点的）：收件箱里不放它，会话里只有一行记录。
// 推送照常发到手机、Slack 和桌面；冒用者用的是它自己的凭证，别的客户端照常看到提醒和卡。
import type { ConversationTurn, NotificationDto, OwnerActionDto } from '@pi-lead-child/protocol';
import { ownerActionNotificationDedupKey, ownerActionTurnId, SYSTEM_TURN_ORIGINS } from '@pi-lead-child/protocol';
import type { BindingDto, TicketSummary } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { InboxQueue } from '../workspace/InboxQueue';
import { userOutboxNotifications } from '../workspace/notificationOutbox';
import Workbench from '../workspace/Workbench.web';
import { LeadConversation } from './LeadConversation';
import { OwnerActionCard, OwnOwnerActionGroup } from './OwnerActionCard';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const EVENT_ID = '0199f1a2-3b4c-7d5e-8f60-718293a4b5c6';
// 发出这次操作的凭证（plc 的 CLI 凭证 #12），和别的客户端自己的凭证。
const PERFORMER = 12;
const binding = (id: number): BindingDto => ({ id, kind: 'companion', name: id === PERFORMER ? 'plc' : '我的手机', scopes: ['chat', 'notices'] });
const TEXT = '验收了工单 #5「登录页」\n凭证：plc（plc 的 CLI 凭证，#12）· CLI · 来自这台电脑\n不是你做的？点「不是我」：撤销这次操作，并作废这个凭证。';

function view(overrides: Partial<OwnerActionDto> = {}): OwnerActionDto {
  return {
    eventId: EVENT_ID, action: 'ticket.complete', label: '验收工单', summary: '验收了工单 #5「登录页」',
    target: { key: 'ticket:5', label: '工单 #5「登录页」', ticketId: 5 },
    credential: { bindingId: 12, kind: 'cli', name: 'plc', origin: 'cli', active: true },
    source: { client: 'cli', deviceName: 'plc', loopback: true, fromThisMachine: true },
    delivery: 'push', performedAt: '2026-10-17T10:00:00.000Z',
    undo: { possible: 'conditional', note: '工单回到待验收（review）。' },
    disownable: true, disowned: null,
    ...overrides,
  };
}

const DISOWNED = view({
  disownable: false,
  credential: { bindingId: 12, kind: 'cli', name: 'plc', origin: 'cli', active: false },
  disowned: {
    at: '2026-10-17T10:01:00.000Z', byName: '我的手机',
    revert: { status: 'reverted', message: '工单 #5「登录页」回到待验收（review）。' },
    credential: { bindingId: 12, revoked: true, message: '作废了凭证 plc（#12），用它的请求都会被拒绝。' },
  },
});

function runtimeFor(client: Partial<Record<'getOwnerAction' | 'disownOwnerAction', (eventId: string) => Promise<OwnerActionDto>>>, ownBindingId: number) {
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  vi.spyOn(runtime, 'currentBinding').mockReturnValue(binding(ownBindingId));
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  return runtime;
}

const ownerTurn = (): ConversationTurn => ({
  id: ownerActionTurnId(EVENT_ID, PERFORMER), originBindingId: null, originKind: SYSTEM_TURN_ORIGINS.ownerAction, ticketId: null,
  state: 'completed', userText: '', assistantText: TEXT, error: null,
  createdAt: '2026-10-17T10:00:00.000Z', updatedAt: '2026-10-17T10:00:00.000Z',
});

function setWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 800 });
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => setWidth(0));

function renderCard(client: Partial<Record<'getOwnerAction' | 'disownOwnerAction', (eventId: string) => Promise<OwnerActionDto>>>) {
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected' });
  renderUI(
    <CompanionRuntimeProvider runtime={runtime}>
      <OwnerActionCard eventId={EVENT_ID} text={TEXT} time="10:00" />
    </CompanionRuntimeProvider>,
  );
}

describe('the owner action card in the conversation', () => {
  it('says what was done and asks once more before 「不是我」 undoes it and kills the credential', async () => {
    const getOwnerAction = vi.fn(async () => view());
    const disownOwnerAction = vi.fn(async () => DISOWNED);
    renderCard({ getOwnerAction, disownOwnerAction });
    // 2026-10-27 画布「代你操作」状态 6：别的凭证做的，居中一行「CLI 凭证 #12 在 10:00 验收了…」，只有图标和「不是我」是红色。
    const card = screen.getByTestId(`owner-action-card-${EVENT_ID}`);
    await vi.waitFor(() => expect(card.textContent).toMatch(/^CLI 凭证 #12 在 \d{2}:\d{2} 验收了工单 #5「登录页」不是我$/));
    expect(getOwnerAction).toHaveBeenCalledWith(EVENT_ID);

    fireEvent.click(await screen.findByTestId(`owner-action-card-disown-${EVENT_ID}`));
    expect(disownOwnerAction).not.toHaveBeenCalled();
    expect(screen.getByText(/并作废发出它的凭证/)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`owner-action-card-confirm-${EVENT_ID}`));

    await vi.waitFor(() => expect(card.textContent).toContain('已处理「不是我」：已撤销 · 凭证已作废'));
    expect(disownOwnerAction).toHaveBeenCalledWith(EVENT_ID);
    expect(screen.getByTestId(`owner-action-outcome-${EVENT_ID}`).textContent).toMatch(/回到待验收/);
    expect(screen.queryByTestId(`owner-action-card-disown-${EVENT_ID}`)).toBeNull();
  });

  it('shows the outcome without a button when 「不是我」 was already pressed on another device', async () => {
    renderCard({ getOwnerAction: vi.fn(async () => DISOWNED), disownOwnerAction: vi.fn() });
    const card = screen.getByTestId(`owner-action-card-${EVENT_ID}`);
    await vi.waitFor(() => expect(card.textContent).toContain('已处理「不是我」：已撤销 · 凭证已作废'));
    expect(screen.queryByTestId(`owner-action-card-disown-${EVENT_ID}`)).toBeNull();
  });

  it('is what the conversation of another client (the phone) shows for the daemon\'s owner action turn', async () => {
    const getOwnerAction = vi.fn(async () => view());
    const runtime = runtimeFor({ getOwnerAction }, 30);
    runtime.control.getState().replaceConversation('lead-session', [ownerTurn()]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    const card = await screen.findByTestId(`owner-action-card-${EVENT_ID}`);
    expect(card.textContent).toContain('验收了工单 #5「登录页」');
    expect(await screen.findByTestId(`owner-action-card-disown-${EVENT_ID}`)).toBeTruthy();
    expect(getOwnerAction).toHaveBeenCalledWith(EVENT_ID);
    expect(screen.queryByTestId('owner-action-own')).toBeNull();
  });

  it('is only a quiet line in the conversation of the client whose credential did it', () => {
    const getOwnerAction = vi.fn(async () => view());
    const runtime = runtimeFor({ getOwnerAction }, PERFORMER);
    runtime.control.getState().replaceConversation('lead-session', [ownerTurn()]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    // 一行，左对齐（2026-10-28 改版稿第 1 组）：说明会截断，时间单独放，不被挤走；全文在点开的浮层里。
    expect(screen.getByTestId('owner-action-own-text').textContent).toBe('你刚刚验收了工单 #5「登录页」');
    expect(screen.getByTestId('owner-action-own-time').textContent).toMatch(/^· \d\d:\d\d$/);
    expect(screen.getByTestId('owner-action-own-expand')).toBeTruthy();
    expect(screen.queryByTestId(`owner-action-card-${EVENT_ID}`)).toBeNull();
    expect(screen.queryByText('不是我')).toBeNull();
    expect(screen.queryByText(/凭证：plc/)).toBeNull();
    expect(getOwnerAction).not.toHaveBeenCalled();
  });

  it('keeps the button and says why when 「不是我」 did not go through', async () => {
    renderCard({
      getOwnerAction: vi.fn(async () => view()),
      disownOwnerAction: vi.fn(async () => { throw new Error('网关连不上'); }),
    });
    fireEvent.click(await screen.findByTestId(`owner-action-card-disown-${EVENT_ID}`));
    fireEvent.click(screen.getByTestId(`owner-action-card-confirm-${EVENT_ID}`));
    expect(await screen.findByText('「不是我」没有完成：网关连不上')).toBeTruthy();
    expect(screen.getByTestId(`owner-action-card-confirm-${EVENT_ID}`)).toBeTruthy();
  });
});

describe('the owner action alert in the inbox', () => {
  const alert: NotificationDto = {
    id: 41, ticketId: null, kind: 'owner_action', dedupKey: ownerActionNotificationDedupKey(EVENT_ID, PERFORMER), urgency: 'immediate',
    title: '验收了工单 #5「登录页」', body: '凭证：plc（plc 的 CLI 凭证，#12）· CLI · 来自这台电脑', state: 'pending',
    createdAt: '2026-10-17T10:00:00.000Z', deliveredAt: null, deliveredVia: null, ackedAt: null,
  };

  it('is shown in the inbox even before the daemon pushed it, except on the client whose credential did it', () => {
    expect(userOutboxNotifications([alert])).toEqual([alert]);
    expect(userOutboxNotifications([alert], { ownBindingId: 30 })).toEqual([alert]);
    expect(userOutboxNotifications([alert], { ownBindingId: PERFORMER })).toEqual([]);
  });

  function inboxOn(ownBindingId: number) {
    setWidth(1280);
    const runtime = runtimeFor({}, ownBindingId);
    runtime.control.getState().replaceTickets([] as TicketSummary[]);
    runtime.control.getState().replaceNotifications([alert]);
    runtime.workspace.setState({ hydrated: true });
    renderUI(<CompanionRuntimeProvider runtime={runtime}><Workbench /></CompanionRuntimeProvider>);
    act(() => runtime.workspace.getState().setRailView('inbox'));
  }

  it('stays out of the inbox of the client whose credential did it', () => {
    inboxOn(PERFORMER);
    expect(screen.queryByTestId('owner-action-notice-41')).toBeNull();
    expect(screen.queryByTestId('notification-outbox')).toBeNull();
  });

  it('is in the inbox of every other client, with 「不是我」', () => {
    inboxOn(30);
    const outbox = screen.getByTestId('notification-outbox');
    expect(within(outbox).getByTestId('owner-action-notice-41')).toBeTruthy();
    expect(within(outbox).getByTestId('owner-action-disown-41')).toBeTruthy();
  });

  it('offers 「是我」 and 「不是我」, and 「不是我」 asks once more', () => {
    const onAck = vi.fn();
    const onDisown = vi.fn();
    renderUI(
      <InboxQueue
        items={[]}
        inbox={null}
        notices={{ general: [alert], reminders: [], byTicket: {} }}
        onOpenTicket={() => {}}
        onRunAction={async () => {}}
        onAckNotification={onAck}
        onDisownOwnerAction={onDisown}
      />,
    );
    expect(screen.getByText('验收了工单 #5「登录页」')).toBeTruthy();
    fireEvent.click(screen.getByTestId('owner-action-disown-41'));
    expect(onDisown).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('owner-action-disown-confirm-41'));
    expect(onDisown).toHaveBeenCalledWith(EVENT_ID, 41);
    fireEvent.click(screen.getByTestId('notification-ack-41'));
    expect(onAck).toHaveBeenCalledWith(41);
  });
});

// 工单 03 审查 M5：Lead 在对话里代你做的操作。点它最常见的原因是 Lead 理解错了你的话，不是凭证被盗：
// 按钮是「撤销」，只撤销这次操作、不作废凭证。它记在你这台设备的凭证名下，可这不是你刚在这里点的，
// 所以这台设备上也显示整张卡和提醒，不收成一行记录。
describe('an action Lead did for the user in conversation', () => {
  const LEAD_TEXT = 'Lead 代你确认了工单 #5「登录页」\nLead 在对话里代你做的。那一轮来自：我的电脑（本机网页，#30）\n'
    + 'Lead 理解错了？点「撤销」：撤销这次操作，不作废凭证。如果那句话不是你说的，请到「设置 → 已配对设备」撤销那台设备。';
  const leadView = (overrides: Partial<OwnerActionDto> = {}) => view({
    action: 'ticket.confirm', summary: 'Lead 代你确认了工单 #5「登录页」',
    credential: { bindingId: 30, kind: 'companion', name: '我的电脑', origin: 'loopback_web', active: true },
    source: { client: 'lead', deviceName: '我的电脑', loopback: false, fromThisMachine: true },
    ...overrides,
  });
  const UNDONE = leadView({
    disownable: false,
    disowned: {
      at: '2026-10-17T10:01:00.000Z', byName: '我的电脑',
      revert: { status: 'reverted', message: '工单 #5「登录页」回到草稿。' },
      credential: { bindingId: 30, revoked: false, message: '这是 Lead 在对话里代你做的：只撤销了这次操作，没有作废凭证。' },
    },
  });

  it('offers 「撤销」 on the card, asks once more, and keeps the credential', async () => {
    const disownOwnerAction = vi.fn(async () => UNDONE);
    renderCard({ getOwnerAction: vi.fn(async () => leadView()), disownOwnerAction });
    // 2026-10-27 画布「代你操作」状态 1–4：右对齐的注脚「Paimon 据此…」，点「撤销」原地换成确认，撤销以后原句划掉。
    await vi.waitFor(() => expect(screen.getByTestId(`owner-action-card-disown-${EVENT_ID}`).textContent).toBe('撤销'));
    const card = screen.getByTestId(`owner-action-card-${EVENT_ID}`);
    expect(card.textContent).toContain('据此Lead 代你确认了工单 #5「登录页」');
    fireEvent.click(screen.getByTestId(`owner-action-card-disown-${EVENT_ID}`));
    expect(card.textContent).toContain('撤销「Lead 代你确认了工单 #5「登录页」」？凭证照常能用。');
    expect(card.textContent).not.toMatch(/并作废发出它的凭证/);
    fireEvent.click(screen.getByTestId(`owner-action-card-confirm-${EVENT_ID}`));
    await vi.waitFor(() => expect(card.textContent).toMatch(/\d{2}:\d{2} 已撤销/));
    // 结果的说明在注脚点开的浮层里，注脚本身还是一行。
    expect(screen.queryByTestId(`owner-action-outcome-${EVENT_ID}`)).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: /，展开$/ }));
    expect((await screen.findByTestId(`owner-action-outcome-${EVENT_ID}`)).textContent).toContain('已处理「撤销」：已撤销 · 凭证没有作废');
    expect(disownOwnerAction).toHaveBeenCalledWith(EVENT_ID);
  });

  it('is a full card on the device the conversation turn came from', async () => {
    const getOwnerAction = vi.fn(async () => leadView());
    const runtime = runtimeFor({ getOwnerAction }, 30);
    // daemon 给代做的操作的轮次编号写凭证 0：它不是哪个客户端直接做的。
    runtime.control.getState().replaceConversation('lead-session', [{ ...ownerTurn(), id: ownerActionTurnId(EVENT_ID, 0), assistantText: LEAD_TEXT }]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    expect(await screen.findByTestId(`owner-action-card-${EVENT_ID}`)).toBeTruthy();
    expect(screen.queryByTestId('owner-action-own')).toBeNull();
  });

  const notice: NotificationDto = {
    id: 42, ticketId: null, kind: 'owner_action_on_behalf', dedupKey: ownerActionNotificationDedupKey(EVENT_ID, 30), urgency: 'immediate',
    title: 'Lead 代你确认了工单 #5「登录页」', body: LEAD_TEXT.split('\n').slice(1).join('\n'), state: 'pending',
    createdAt: '2026-10-17T10:00:00.000Z', deliveredAt: null, deliveredVia: null, ackedAt: null,
  };

  it('stays in the inbox of the device whose turn it came from', () => {
    expect(userOutboxNotifications([notice], { ownBindingId: 30 })).toEqual([notice]);
  });

  it('offers 「撤销」 and 「知道了」 in the inbox, and 「撤销」 asks once more', () => {
    const onAck = vi.fn();
    const onDisown = vi.fn();
    renderUI(
      <InboxQueue
        items={[]}
        inbox={null}
        notices={{ general: [notice], reminders: [], byTicket: {} }}
        onOpenTicket={() => {}}
        onRunAction={async () => {}}
        onAckNotification={onAck}
        onDisownOwnerAction={onDisown}
      />,
    );
    expect(screen.queryByTestId('owner-action-disown-42')).toBeNull();
    expect(screen.getByTestId('owner-action-undo-42').textContent).toBe('撤销');
    expect(screen.getByTestId('notification-ack-42').textContent).toBe('知道了');
    fireEvent.click(screen.getByTestId('owner-action-undo-42'));
    expect(onDisown).not.toHaveBeenCalled();
    expect(screen.getByText('撤销这次操作？不作废凭证。')).toBeTruthy();
    fireEvent.click(screen.getByTestId('owner-action-undo-confirm-42'));
    expect(onDisown).toHaveBeenCalledWith(EVENT_ID, 42);
  });
});

// 2026-10-27 画布「代你操作」状态 5：你说「都关了吧」，Lead 据此做了几件事。会话里连着几条代做的操作，
// 合成一行「Paimon 据此做了 3 件事：…」，点「逐件看」在浮层里一件一行，每一件照常能撤销。
// 中间隔着你说的话时不合并：那是两句话促成的。
describe('several actions one sentence led to', () => {
  const EVENTS = ['0199f1a2-0000-7000-8000-000000000001', '0199f1a2-0000-7000-8000-000000000002', '0199f1a2-0000-7000-8000-000000000003'];
  const turnOf = (eventId: string, summary: string, at: string): ConversationTurn => ({
    id: ownerActionTurnId(eventId, 0), originBindingId: null, originKind: SYSTEM_TURN_ORIGINS.ownerAction, ticketId: null,
    state: 'completed', userText: '', assistantText: `${summary}\nLead 在对话里代你做的。`, error: null, createdAt: at, updatedAt: at,
  });
  const leadAction = (eventId: string) => view({
    eventId, source: { client: 'lead', deviceName: '我的电脑', loopback: false, fromThisMachine: true },
    credential: { bindingId: 30, kind: 'companion', name: '我的电脑', origin: 'loopback_web', active: true },
  });

  it('merges them into one line with the count, and lists each with its own undo', async () => {
    const runtime = runtimeFor({ getOwnerAction: vi.fn(async (eventId: string) => leadAction(eventId)) }, 30);
    runtime.control.getState().replaceConversation('lead-session', [
      turnOf(EVENTS[0]!, '取消了工单 #104', '2026-10-27T04:42:01.000Z'),
      turnOf(EVENTS[1]!, '取消了工单 #105', '2026-10-27T04:42:02.000Z'),
      turnOf(EVENTS[2]!, '关闭了 #102 的 PR', '2026-10-27T04:42:03.000Z'),
    ]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    const group = screen.getByTestId('owner-action-group');
    expect(group.textContent).toContain('据此做了 3 件事：取消了工单 #104、取消了工单 #105、关闭了 #102 的 PR');
    expect(screen.queryByTestId(`owner-action-card-${EVENTS[0]}`)).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: /，展开$/ }));
    for (const eventId of EVENTS) expect(await screen.findByTestId(`owner-action-card-${eventId}`)).toBeTruthy();
    await vi.waitFor(() => expect(screen.getAllByText('撤销')).toHaveLength(3));
  });

  it('keeps actions apart when you said something in between', () => {
    const runtime = runtimeFor({ getOwnerAction: vi.fn(async (eventId: string) => leadAction(eventId)) }, 30);
    runtime.control.getState().replaceConversation('lead-session', [
      turnOf(EVENTS[0]!, '取消了工单 #104', '2026-10-27T04:42:01.000Z'),
      {
        id: 'turn-user', originBindingId: 30, originKind: 'paired:companion', ticketId: null, state: 'completed',
        userText: '#105 也取消', assistantText: '好。', error: null, createdAt: '2026-10-27T04:43:00.000Z', updatedAt: '2026-10-27T04:43:01.000Z',
      },
      turnOf(EVENTS[1]!, '取消了工单 #105', '2026-10-27T04:43:02.000Z'),
    ]);
    renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
    expect(screen.queryByTestId('owner-action-group')).toBeNull();
    expect(screen.getByTestId(`owner-action-card-${EVENTS[0]}`)).toBeTruthy();
    expect(screen.getByTestId(`owner-action-card-${EVENTS[1]}`)).toBeTruthy();
  });
});

// 2026-10-28 用户截图：三条「你刚刚把 X 的权限设置从…改成…」各占两行、居中。改版稿第 1 组：连着的几件合成一行，点开一件一行。
describe('the lines you made one after another on this device', () => {
  it('is one line with the first thing and how many more, and lists each in the panel', async () => {
    renderUI(<OwnOwnerActionGroup items={[
      { eventId: 'a', text: '把 GitHub 的写入从「先问我」改成「直接执行」', time: '10:46' },
      { eventId: 'b', text: '把 Notion 的写入从「先问我」改成「直接执行」', time: '10:46' },
      { eventId: 'c', text: '把 Jira & Confluence 的写入从「先问我」改成「直接执行」', time: '10:47' },
    ]} />);
    expect(screen.getByTestId('owner-action-own-group-text').textContent).toBe('你刚刚把 GitHub 的写入从「先问我」改成「直接执行」，还有 2 件');
    expect(screen.getByTestId('owner-action-own-group-time').textContent).toBe('· 10:46–10:47');
    fireEvent.click(screen.getByTestId('owner-action-own-group-expand'));
    const details = await screen.findByTestId('owner-action-own-group-details');
    expect(details.textContent).toContain('把 Jira & Confluence 的写入从「先问我」改成「直接执行」');
  });
});
