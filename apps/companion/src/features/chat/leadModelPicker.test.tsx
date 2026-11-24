// @vitest-environment happy-dom
// 会话里换模型（模型配置方案 C 的 S4、S5，画板 C-Picker-Desktop / C-Picker-Mobile，2026-11-16）：
// 输入框上不放模型；最新一条回答头上写着模型名，点开是浮层（输入 /model 也能打开）。
// 左栏按「订阅 / API key」列接入，订阅带 5 小时额度；右边是账号（缺省自动，可以固定）和模型；底部「只这一条」和「换成主用」。
import {
  CHAT_TURN_MODEL_CAPABILITY, type ConversationTurn, type LeadModelCatalog, type LeadModelChoice, type LeadModelOption,
  type LeadStatus, type ModelSettingsDto, type Overview,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }), useFocusEffect: () => {} }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});
// 桌面宽度（锚定浮层，左右两栏）或者手机宽度（底部面板，一段一段）。
const viewport = vi.hoisted(() => ({ wide: true }));
vi.mock('@pi-lead-child/components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pi-lead-child/components')>();
  return {
    ...actual,
    useBreakpoint: () => (viewport.wide
      ? { width: 1440, height: 900, tablet: true, desktop: true, wide: true }
      : { width: 390, height: 844, tablet: false, desktop: false, wide: false }),
  };
});

const SESSION = 'lead-session';
const online: LeadStatus = {
  state: 'online', since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null, lastSuccessAt: null,
};

function overview(model: string): Overview {
  return {
    model, sessionId: SESSION, busy: false, runningTicketIds: [],
    counts: { activeTickets: 0, reviewTickets: 0, blockedTickets: 0, pendingApprovals: 0, unreadNotices: 0 },
    aish: null, lead: online,
  };
}

function option(model: string, extra: Partial<LeadModelOption> = {}): LeadModelOption {
  const slash = model.indexOf('/');
  return {
    model, provider: model.slice(0, slash), id: model.slice(slash + 1), prefix: null, source: null, name: null,
    image: true, efforts: [], defaultEffort: null, blockedUntil: null, ...extra,
  };
}

// 分工：Codex 的 gpt-5.5 主用，vibeproxy 的 claude-opus-5-5 备用。会话此刻挂在 Codex 的第 2 个账号上（pi-multi-pass 换的）。
const catalog: LeadModelCatalog = {
  current: { model: 'openai-codex/gpt-5.5', effort: null },
  selected: { model: 'openai-codex/gpt-5.5', effort: null },
  inSession: 'openai-codex-2/gpt-5.5',
  models: [
    option('vibeproxy/claude-opus-5-5', { name: 'Claude Opus 5.5', efforts: ['low', 'high'] }),
    option('vibeproxy/claude-sonnet-5', { blockedUntil: '2026-11-16T13:30:00.000Z' }),
    option('openai-codex/gpt-5.5', { name: 'GPT-5.5' }),
    option('openai-codex/gpt-5.5-mini', { name: 'GPT-5.5 Mini', image: false }),
    option('github-copilot/claude-sonnet-5', { name: 'Claude Sonnet 5' }),
  ],
};

function account(provider: string, index: number, label: string, remaining: number | null) {
  return {
    provider, index, label, loggedIn: true, email: null, plan: null,
    quota: remaining === null ? null : { windows: [{ label: '5h', remainingPercent: remaining, resetAt: null }], checkedAt: '2026-11-16T10:00:00.000Z', problem: null },
    coolingUntil: null, role: 'default' as const, windows: [], inUse: true,
  };
}

const settings = {
  brain: {
    chain: [{ model: 'openai-codex/gpt-5.5', effort: null }, { model: 'vibeproxy/claude-opus-5-5', effort: 'high' }],
    current: { model: 'openai-codex/gpt-5.5', effort: null },
    providers: [],
  },
  fast: { models: [], chain: [], llmFallback: null, effectiveLlm: null },
  maxBackups: 3,
  subscriptions: {
    multiPass: true,
    logins: [],
    subscriptions: [
      {
        base: 'openai-codex', strategy: 'quota-first', quotaSupported: true,
        accounts: [account('openai-codex', 1, 'Work', 76), account('openai-codex-2', 2, 'Home', 9)],
        models: [{ model: 'openai-codex/gpt-5.5', id: 'gpt-5.5', name: 'GPT-5.5', image: true, contextWindow: 400_000, efforts: [] }],
      },
      { base: 'github-copilot', strategy: 'round-robin', quotaSupported: false, accounts: [account('github-copilot', 1, 'Me', null)], models: [] },
    ],
  },
} as unknown as ModelSettingsDto;

const replyTurn: ConversationTurn = {
  id: 'turn-1', originBindingId: 1, originKind: 'paired:companion', ticketId: null, state: 'completed',
  userText: 'Think harder', assistantText: 'Sure.', error: null,
  createdAt: '2026-11-16T10:00:00.000Z', updatedAt: '2026-11-16T10:00:05.000Z',
} as ConversationTurn;

function setup(options: { applied?: 'now' | 'after_turn'; capabilities?: string[]; busy?: boolean; compact?: boolean } = {}) {
  const switched: LeadModelChoice[] = [];
  const client = {
    getLeadModels: vi.fn(async () => catalog),
    switchLeadModel: vi.fn(async (choice: LeadModelChoice) => {
      switched.push(choice);
      return { previous: catalog.selected, selected: choice, applied: options.applied ?? 'now' };
    }),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({
    phase: 'ready', connectionState: 'connected', overview: { ...overview('openai-codex/gpt-5.5'), busy: options.busy ?? false },
    capabilities: options.capabilities ?? [CHAT_TURN_MODEL_CAPABILITY], modelSettings: settings,
  });
  runtime.control.getState().replaceConversation(SESSION, [replyTurn]);
  const sendChat = vi.spyOn(runtime, 'sendChat').mockResolvedValue({ clientMessageId: 'msg_1' });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation compact={options.compact ?? false} /></CompanionRuntimeProvider>);
  return { runtime, client, switched, sendChat };
}

async function openFromComposer() {
  await act(async () => { fireEvent.click(await screen.findByTestId('lead-model-button')); });
  await waitFor(() => expect(screen.getByTestId('lead-model-option-openai-codex/gpt-5.5')).toBeTruthy());
}

// 推理强度在底部操作条左边的菜单里（视觉稿方案 C）：先点开菜单，再点一档。选了菜单收起。
async function chooseEffort(effort: string) {
  await act(async () => { fireEvent.click(screen.getByTestId('lead-model-effort-menu')); });
  await act(async () => { fireEvent.click(screen.getByTestId(`lead-model-effort-${effort}`)); });
}

const connectionKeys = () => Array.from(screen.getByTestId('lead-model-connection-list').querySelectorAll('[data-testid^="lead-model-connection-"]'))
  .map((element) => element.getAttribute('data-testid')!.slice('lead-model-connection-'.length))
  .filter((key) => key !== 'list');

beforeEach(() => { viewport.wide = true; });

// 2026-11-16 用户：「我没说过要把模型选择放在 agent 这条系统信息旁边啊，desktop 你还是放在消息输入框原来的位置啊」。
describe('the model in the composer on a computer', () => {
  it('writes the model id and effort before the send button, not on the reply, and opens the picker anchored there', async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId('composer-model').textContent).toBe('gpt-5.5'));
    expect(screen.queryByTestId('lead-model-trigger')).toBeNull();
    await openFromComposer();
    expect(screen.getByTestId('lead-model-picker-panel')).toBeTruthy();
  });
});

describe('the model picker', () => {
  it('lists subscriptions before API keys, with the quota of the account in use, and the true account in the header', async () => {
    setup();
    await openFromComposer();
    expect(connectionKeys()).toEqual(['openai-codex', 'github-copilot', 'vibeproxy']);
    // 会话此刻挂在第 2 个账号（Home）上：额度条写它用了多少（100 - 9 = 91）。
    expect(screen.getByTestId('lead-model-connection-openai-codex').getAttribute('aria-label')).toBe('Codex, 91% of the 5-hour quota used');
    // Copilot 查不了额度：写模型数。
    expect(screen.getByTestId('lead-model-connection-github-copilot').textContent).toContain('1');
    expect(screen.getByTestId('lead-model-in-use').textContent).toBe('GPT-5.5');
    expect(screen.getByTestId('lead-model-in-use-source').textContent).toBe('Codex · Home · in use');
    // 打开时选着的是主用；它在分工的第一个，标「主用」。
    expect(screen.getByTestId('lead-model-option-openai-codex/gpt-5.5').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('lead-model-role-openai-codex/gpt-5.5').textContent).toBe('Primary');
    expect(screen.getByTestId('lead-model-option-openai-codex/gpt-5.5').textContent).toContain('400K');
    expect(screen.getByTestId('lead-model-account-menu-openai-codex').textContent).toBe('Automatic · now Home');
    expect(screen.getByTestId('lead-model-account-info-openai-codex').textContent).toBe('Most quota first · Work 5h 24% · Home 5h 91%');
  });

  it('shows the models of the connection you pick, with backup tags and a blocked model', async () => {
    setup();
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-connection-vibeproxy')); });
    expect(screen.getByTestId('lead-model-connection-vibeproxy').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('lead-model-role-vibeproxy/claude-opus-5-5').textContent).toBe('Backup');
    expect(screen.getByTestId('lead-model-option-vibeproxy/claude-sonnet-5').textContent).toContain('Quota used up');
    expect(screen.queryByTestId('lead-model-option-openai-codex/gpt-5.5')).toBeNull();
  });

  it('searches all models across connections', async () => {
    setup();
    await openFromComposer();
    await act(async () => { fireEvent.change(screen.getByTestId('lead-model-search'), { target: { value: 'SONNET' } }); });
    expect(screen.getByTestId('lead-model-option-vibeproxy/claude-sonnet-5')).toBeTruthy();
    expect(screen.getByTestId('lead-model-option-github-copilot/claude-sonnet-5')).toBeTruthy();
    expect(screen.queryByTestId('lead-model-option-openai-codex/gpt-5.5')).toBeNull();
    await act(async () => { fireEvent.change(screen.getByTestId('lead-model-search'), { target: { value: 'zzz' } }); });
    expect(screen.getByTestId('lead-model-no-match')).toBeTruthy();
  });

  it('makes the chosen model and effort the primary', async () => {
    const { switched } = setup();
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-connection-vibeproxy')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/claude-opus-5-5')); });
    await chooseEffort('high');
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-make-primary')); });
    expect(switched).toEqual([{ model: 'vibeproxy/claude-opus-5-5', effort: 'high' }]);
    await waitFor(() => expect(screen.queryByTestId('lead-model-in-use')).toBeNull());
  });

  it('keeps the panel open and says when the switch starts after this answer', async () => {
    setup({ applied: 'after_turn' });
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-openai-codex/gpt-5.5-mini')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-make-primary')); });
    await waitFor(() => expect(screen.getByTestId('lead-model-notice').textContent).toBe('GPT-5.5 Mini starts after this answer ends.'));
  });

  it('pins a subscription account by switching to <base>-<n>/<id>, and goes back to automatic', async () => {
    const { switched } = setup();
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-account-menu-openai-codex')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-account-openai-codex-2')); });
    expect(screen.getByTestId('lead-model-account-menu-openai-codex').textContent).toBe('Home');
    // 换模型时留在固定的账号上。
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-openai-codex/gpt-5.5-mini')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-make-primary')); });
    expect(switched).toEqual([{ model: 'openai-codex-2/gpt-5.5-mini', effort: null }]);
  });
});

// magpie 把同一个模型放在几条通道下（auto/、claude/、codex/），显示名相同（用户 2026-11-24）：名字后面的灰色小字写通道（route），
// 头上的「正在用」一行也写它；搜索能搜到通道；两个都留着，选它交回去的还是原来的 id。
describe('magpie routes', () => {
  const fable = (id: string, route: string) => option(`magpie/${id}`, { name: 'Claude Fable 5.2', route, efforts: ['low', 'high'] });
  const routed: LeadModelCatalog = {
    current: { model: 'magpie/claude/claude-fable-5-2', effort: null },
    selected: { model: 'magpie/claude/claude-fable-5-2', effort: null },
    inSession: 'magpie/claude/claude-fable-5-2',
    models: [fable('auto/claude-fable-5-2', 'routing group'), fable('claude/claude-fable-5-2', 'Claude Code'), option('magpie/codex/gpt-6-sol', { name: 'GPT-6 Sol', route: 'Codex' })],
  };

  it('writes the route after the name in each row and in the in-use line, keeps both same-name models, and searches it', async () => {
    const { client, switched } = setup();
    client.getLeadModels.mockResolvedValue(routed);
    await act(async () => { fireEvent.click(await screen.findByTestId('lead-model-button')); });
    await waitFor(() => expect(screen.getByTestId('lead-model-option-magpie/auto/claude-fable-5-2')).toBeTruthy());
    expect(screen.getByTestId('lead-model-route-magpie/auto/claude-fable-5-2').textContent).toBe('routing group');
    expect(screen.getByTestId('lead-model-route-magpie/claude/claude-fable-5-2').textContent).toBe('Claude Code');
    expect(screen.getByTestId('lead-model-option-magpie/claude/claude-fable-5-2').getAttribute('aria-label')).toBe('Claude Fable 5.2 · Claude Code, selected');
    expect(screen.getByTestId('lead-model-in-use-source').textContent).toBe('magpie · Claude Code · in use');

    await act(async () => { fireEvent.change(screen.getByTestId('lead-model-search'), { target: { value: 'routing' } }); });
    expect(screen.getByTestId('lead-model-option-magpie/auto/claude-fable-5-2')).toBeTruthy();
    expect(screen.queryByTestId('lead-model-option-magpie/claude/claude-fable-5-2')).toBeNull();
    await act(async () => { fireEvent.change(screen.getByTestId('lead-model-search'), { target: { value: '' } }); });

    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-magpie/auto/claude-fable-5-2')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-make-primary')); });
    expect(switched).toEqual([{ model: 'magpie/auto/claude-fable-5-2', effort: null }]);
  });

  it('writes no route for a model without one', async () => {
    setup();
    await openFromComposer();
    expect(screen.queryByTestId('lead-model-route-openai-codex/gpt-5.5')).toBeNull();
    expect(screen.getByTestId('lead-model-in-use-source').textContent).toBe('Codex · Home · in use');
  });
});

// 视觉稿方案 C（用户 2026-11-24 定）：推理强度不在头上，在底部操作条左边，和两种用法同一区。
describe('the reasoning effort menu', () => {
  it('sits in the action bar, shows the current effort, lists Default and the efforts the model can send, and closes after a pick', async () => {
    setup();
    await openFromComposer();
    // 主用 GPT-5.5 不能选强度：没有菜单，头上也没有强度。
    expect(screen.queryByTestId('lead-model-effort')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-connection-vibeproxy')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/claude-opus-5-5')); });
    const menu = screen.getByTestId('lead-model-effort-menu');
    expect(menu.textContent).toBe('Reasoning · Default');
    expect(screen.getByTestId('lead-model-footer').contains(menu)).toBe(true);
    expect(screen.queryByTestId('lead-model-effort-options')).toBeNull();

    await act(async () => { fireEvent.click(menu); });
    const options = Array.from(screen.getByTestId('lead-model-effort-options').querySelectorAll('[data-testid^="lead-model-effort-"]'))
      .map((element) => element.textContent);
    expect(options).toEqual(['Default', 'Low', 'High']);
    expect(screen.getByTestId('lead-model-effort-default').getAttribute('aria-label')).toBe('Default, selected');

    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-effort-high')); });
    expect(screen.queryByTestId('lead-model-effort-options')).toBeNull();
    expect(screen.getByTestId('lead-model-effort-menu').textContent).toBe('Reasoning · High');

    // 换到不能选强度的模型：菜单消失。
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/claude-sonnet-5')); });
    expect(screen.queryByTestId('lead-model-effort')).toBeNull();
  });

  // 用户 2026-11-24 验收：菜单展开时把操作条撑高了，两颗按钮被挤到底下；触发块也比两颗按钮矮、字小。
  // 现在选项是绝对定位的浮层（不占操作条的高度），触发块和两颗按钮是同一个 Button、同一个尺寸。
  // happy-dom 不排版（高度都是 0），真实像素高度在 Dev Mode 的浏览器里量（EVIDENCE.md）；这里断言做到这一点的结构和样式。
  it('opens the options as a floating layer that leaves the action bar alone, with a trigger styled like the two buttons', async () => {
    setup();
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-connection-vibeproxy')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/claude-opus-5-5')); });
    const footer = screen.getByTestId('lead-model-footer');
    const children = Array.from(footer.children).length;
    const footerHeight = footer.getBoundingClientRect().height;
    const trigger = screen.getByTestId('lead-model-effort-menu');
    const only = screen.getByTestId('lead-model-only-this');
    const primary = screen.getByTestId('lead-model-make-primary');
    // 同一个 Button：同一种元素、同一份尺寸样式（高度、内边距、字号、字重、圆角）。桌面是 sm，高 32。
    expect(getComputedStyle(only).height).toBe('32px');
    for (const property of ['height', 'padding-left', 'padding-right', 'border-top-left-radius'] as const) {
      expect(getComputedStyle(trigger).getPropertyValue(property)).toBe(getComputedStyle(only).getPropertyValue(property));
      expect(getComputedStyle(trigger).getPropertyValue(property)).toBe(getComputedStyle(primary).getPropertyValue(property));
    }
    expect(trigger.tagName).toBe(only.tagName);
    const label = (button: HTMLElement) => button.querySelector('[dir], span, div[class*="font_"]') ?? button;
    expect(getComputedStyle(label(trigger)).fontSize).toBe(getComputedStyle(label(only)).fontSize);
    expect(getComputedStyle(label(trigger)).fontWeight).toBe(getComputedStyle(label(only)).fontWeight);

    await act(async () => { fireEvent.click(trigger); });
    const layer = screen.getByTestId('lead-model-effort-options');
    expect(getComputedStyle(layer).position).toBe('absolute');
    // 浮层挂在触发块的容器里，操作条的直接子元素不变：打开不会多出一行。
    expect(Array.from(footer.children).length).toBe(children);
    expect(footer.getBoundingClientRect().height).toBe(footerHeight);
  });

  it('works from the keyboard and closes on Escape or a click outside, leaving the picker open', async () => {
    setup();
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-connection-vibeproxy')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/claude-opus-5-5')); });
    // 触发块和选项都是 <button>：Tab 走得到，Enter 和空格由浏览器按下。
    expect(screen.getByTestId('lead-model-effort-menu').tagName).toBe('BUTTON');
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-effort-menu')); });
    expect(screen.getByTestId('lead-model-effort-high').tagName).toBe('BUTTON');

    // Esc：只收起菜单，选择器还开着。
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('lead-model-effort-high'), { key: 'Escape' });
      fireEvent.keyUp(screen.getByTestId('lead-model-effort-high'), { key: 'Escape' });
    });
    expect(screen.queryByTestId('lead-model-effort-options')).toBeNull();
    expect(screen.getByTestId('lead-model-picker-panel')).toBeTruthy();

    // 点菜单外面：收起菜单，选择器还开着。
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-effort-menu')); });
    expect(screen.getByTestId('lead-model-effort-options')).toBeTruthy();
    await act(async () => { fireEvent.pointerDown(screen.getByTestId('lead-model-search')); });
    expect(screen.queryByTestId('lead-model-effort-options')).toBeNull();
    expect(screen.getByTestId('lead-model-picker-panel')).toBeTruthy();
  });

  it('goes back to Default, which sends no effort', async () => {
    const { switched } = setup();
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-connection-vibeproxy')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/claude-opus-5-5')); });
    await chooseEffort('high');
    await chooseEffort('default');
    expect(screen.getByTestId('lead-model-effort-menu').textContent).toBe('Reasoning · Default');
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-make-primary')); });
    expect(switched).toEqual([{ model: 'vibeproxy/claude-opus-5-5', effort: null }]);
  });

  it('is in the action bar of the phone sheet too', async () => {
    viewport.wide = false;
    setup();
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-section-vibeproxy')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/claude-opus-5-5')); });
    expect(screen.getByTestId('lead-model-effort-menu')).toBeTruthy();
    expect(screen.getByTestId('lead-model-only-this')).toBeTruthy();
  });
});

describe('only this message', () => {
  it('puts a removable chip above the composer and sends the next message once with that model', async () => {
    const { sendChat, switched } = setup();
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-connection-vibeproxy')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/claude-opus-5-5')); });
    await chooseEffort('high');
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-only-this')); });
    expect(switched).toEqual([]);
    expect(screen.getByTestId('turn-model-chip').textContent).toContain('Only this message: claude-opus-5-5 · High · vibeproxy');
    await act(async () => { fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Think harder' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('send-message')); });
    expect(sendChat).toHaveBeenCalledWith('Think harder', undefined, undefined, undefined, { model: 'vibeproxy/claude-opus-5-5', effort: 'high' });
    // 只这一条：发出以后小标签消失，下一条照常。
    expect(screen.queryByTestId('turn-model-chip')).toBeNull();
    await act(async () => { fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'Next' } }); });
    await act(async () => { fireEvent.click(screen.getByTestId('send-message')); });
    expect(sendChat).toHaveBeenLastCalledWith('Next', undefined, undefined);
  });

  it('removes the chip with its ×', async () => {
    setup();
    await openFromComposer();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-openai-codex/gpt-5.5-mini')); });
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-only-this')); });
    await act(async () => { fireEvent.click(screen.getByTestId('turn-model-chip-remove')); });
    expect(screen.queryByTestId('turn-model-chip')).toBeNull();
  });

  it('is not offered by an old daemon', async () => {
    setup({ capabilities: [] });
    await openFromComposer();
    expect(screen.queryByTestId('lead-model-only-this')).toBeNull();
    expect(screen.getByTestId('lead-model-make-primary')).toBeTruthy();
  });

  it('cannot be the model already in use', async () => {
    setup();
    await openFromComposer();
    // 打开时选着的就是正在用的模型：「只这一条」没有意义。
    const button = screen.getByTestId('lead-model-only-this');
    expect(button.getAttribute('aria-disabled') === 'true' || button.hasAttribute('disabled')).toBe(true);
  });
});

describe('the model picker on a phone', () => {
  it('opens from the model row in the plus sheet as a bottom sheet with collapsible connections', async () => {
    viewport.wide = false;
    setup({ compact: true });
    await act(async () => { fireEvent.click(screen.getByTestId('composer-plus')); });
    const row = await screen.findByTestId('lead-plus-model');
    // 加号面板里「模型」一行写着正在用的模型和接入。
    expect(row.textContent).toContain('gpt-5.5');
    expect(row.textContent).toContain('Codex');
    await act(async () => { fireEvent.click(row); });
    // 加号面板收起，换模型的面板升起：同一时间只开一个。
    await waitFor(() => expect(screen.queryByTestId('lead-plus-model')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('lead-model-option-openai-codex/gpt-5.5')).toBeTruthy());
    expect(screen.getByTestId('lead-model-picker-content')).toBeTruthy();
    // 主用所在的接入先展开。
    expect(screen.getByTestId('lead-model-section-openai-codex').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('lead-model-option-openai-codex/gpt-5.5')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-section-vibeproxy')); });
    expect(screen.queryByTestId('lead-model-option-openai-codex/gpt-5.5')).toBeNull();
    expect(screen.getByTestId('lead-model-option-vibeproxy/claude-opus-5-5')).toBeTruthy();
    expect(screen.getByTestId('lead-model-only-this')).toBeTruthy();
  });

  // 2026-11-16 用户：「模型选择在移动端的入口保持之前移动端输入框的 plus icon button 里面」。
  it('writes no model on the phone composer', async () => {
    viewport.wide = false;
    setup({ compact: true });
    await screen.findByTestId('composer-plus');
    expect(screen.queryByTestId('lead-model-button')).toBeNull();
    expect(screen.queryByTestId('composer-model')).toBeNull();
  });

  it('writes no model in the top bar', async () => {
    viewport.wide = false;
    setup({ compact: true });
    // 顶栏正常时什么字都不写（主题 H-2，用户 2026-11-16「不要放顶栏」）。
    await screen.findByTestId('composer-plus');
    expect(screen.queryByTestId('home-model')).toBeNull();
  });
});
