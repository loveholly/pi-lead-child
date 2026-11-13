// @vitest-environment happy-dom
// 会话输入框右下角的模型选择（2026-10-26）：写着 Lead 正在用的模型 id 和推理强度；点开是按来源分组的模型（as1、as4 各一组）
// 和推理强度；上面一个搜索框，左栏是 provider（PR #11，2026-11-06）。选一个就换（和 Lead 的 switch_lead_model 是同一个操作）；马上换好时浮层关上，模型名跟着变。
import type { LeadModelCatalog, LeadModelChoice, LeadModelOption, LeadStatus, Overview } from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { LeadConversation } from './LeadConversation';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
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

// prefix 是 daemon 给的账号：这个 vibeproxy 读到了详细目录，as1/、as4/ 是账号。
function option(model: string, source: string, efforts: string[], extra: Partial<LeadModelOption> = {}): LeadModelOption {
  const id = model.slice('vibeproxy/'.length);
  const slash = id.indexOf('/');
  return {
    model, provider: 'vibeproxy', id, prefix: slash > 0 ? id.slice(0, slash) : null, source, name: null,
    image: true, efforts, defaultEffort: null, blockedUntil: null, ...extra,
  };
}

const catalog: LeadModelCatalog = {
  current: { model: 'vibeproxy/as4/claude-sonnet-5', effort: 'high' },
  selected: { model: 'vibeproxy/as4/claude-sonnet-5', effort: 'high' },
  models: [
    option('vibeproxy/claude-sonnet-5', 'anthropic', ['low', 'high']),
    option('vibeproxy/gemini-3.8-flash-high', 'antigravity', [], { image: false }),
    option('vibeproxy/as1/claude-sonnet-5', 'anthropic', ['low', 'high'], { blockedUntil: '2026-10-26T13:30:00.000Z' }),
    option('vibeproxy/as4/claude-sonnet-5', 'anthropic', ['low', 'high']),
    option('vibeproxy/as4/claude-opus-5-5', 'anthropic', ['low', 'high', 'max']),
  ],
};

function setup(options: { applied?: 'now' | 'after_turn'; fail?: string; catalog?: LeadModelCatalog } = {}) {
  const switched: LeadModelChoice[] = [];
  const client = {
    getLeadModels: vi.fn(async () => options.catalog ?? catalog),
    switchLeadModel: vi.fn(async (choice: LeadModelChoice) => {
      if (options.fail) throw new Error(options.fail);
      switched.push(choice);
      return { previous: catalog.selected, selected: choice, applied: options.applied ?? 'now' };
    }),
  };
  const runtime = createCompanionStateRuntime({
    client: client as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  runtime.control.setState({ phase: 'ready', connectionState: 'connected', overview: overview('vibeproxy/as4/claude-sonnet-5(high)'), capabilities: [] });
  runtime.control.getState().replaceConversation(SESSION, []);
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return { client, switched };
}

async function open() {
  await act(async () => { fireEvent.click(screen.getByTestId('lead-model')); });
  await waitFor(() => expect(screen.getByTestId('lead-model-catalog')).toBeTruthy());
}

const groupTitles = () => Array.from(screen.getByTestId('lead-model-catalog').querySelectorAll('[data-testid^="lead-model-group-"]'))
  .map((element) => element.getAttribute('data-testid')!.slice('lead-model-group-'.length));

describe('the model picker in the composer', () => {
  it('shows only the model id and the effort', async () => {
    setup();
    // 读到目录、知道 as4 是账号以后，只写模型 id。
    await waitFor(() => expect(screen.getByTestId('composer-model').textContent).toBe('claude-sonnet-5'));
    expect(screen.getByTestId('composer-model-effort').textContent).toBe('high');
  });

  it('lists the models by account and source, marks the chosen one, and shows a blocked account', async () => {
    setup();
    await open();
    // 分组和设置页同一个规则（2026-11-05）：账号 · 通道，没有账号的按通道。
    expect(groupTitles()).toEqual(['as1 · anthropic', 'as4 · anthropic', 'anthropic', 'antigravity']);
    expect(screen.getByTestId('lead-model-option-vibeproxy/as4/claude-sonnet-5').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('lead-model-option-vibeproxy/as1/claude-sonnet-5').textContent).toContain('Quota used up');
    // 只标出不能看图的模型。
    expect(screen.getByTestId('lead-model-option-vibeproxy/gemini-3.8-flash-high').textContent).toContain('Cannot read images');
    expect(screen.getByTestId('lead-model-option-vibeproxy/as4/claude-sonnet-5').textContent).not.toContain('read images');
    expect(screen.getByTestId('lead-model-effort-high').getAttribute('aria-pressed')).toBe('true');
    // 最上面写着正在用的是哪个账号的哪个模型。
    expect(screen.getByTestId('lead-model-selected').textContent).toBe('In use: as4 · anthropic · claude-sonnet-5 high');
  });

  it('filters as you type without changing the section titles, and switches from a search result', async () => {
    const { switched } = setup();
    await open();
    await act(async () => { fireEvent.change(screen.getByTestId('lead-model-search'), { target: { value: 'OPUS' } }); });
    expect(groupTitles()).toEqual(['as4 · anthropic']);
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/as4/claude-opus-5-5')); });
    expect(switched).toEqual([{ model: 'vibeproxy/as4/claude-opus-5-5', effort: 'high' }]);
  });

  it('says so when nothing matches, and keeps the in-use line', async () => {
    setup();
    await open();
    await act(async () => { fireEvent.change(screen.getByTestId('lead-model-search'), { target: { value: 'zzz' } }); });
    expect(screen.getByTestId('lead-model-no-match')).toBeTruthy();
    expect(groupTitles()).toEqual([]);
    expect(screen.getByTestId('lead-model-selected').textContent).toBe('In use: as4 · anthropic · claude-sonnet-5 high');
  });

  it('lists the providers in the left rail and shows only the picked one', async () => {
    const magpie: LeadModelOption = {
      model: 'magpie/deepseek/deepseek-v4', provider: 'magpie', id: 'deepseek/deepseek-v4', prefix: null, source: 'deepseek', name: null,
      image: false, efforts: [], defaultEffort: null, blockedUntil: null,
    };
    setup({ catalog: { ...catalog, models: [...catalog.models, magpie] } });
    await open();
    const rail = Array.from(screen.getByTestId('lead-model-providers').querySelectorAll('[data-testid^="lead-model-provider-"]'))
      .map((element) => element.getAttribute('data-testid')!.slice('lead-model-provider-'.length));
    expect(rail).toEqual(['all', 'vibeproxy', 'deepseek']);
    expect(screen.getByTestId('lead-model-provider-all').getAttribute('aria-pressed')).toBe('true');
    // 全部模型：左栏是上游供应商（magpie 网关下的 deepseek），标题前面写供应商，后面写网关。
    expect(groupTitles()).toEqual(['vibeproxy · as1 · anthropic', 'vibeproxy · as4 · anthropic', 'vibeproxy · anthropic', 'vibeproxy · antigravity', 'deepseek · magpie']);
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-provider-deepseek')); });
    expect(screen.getByTestId('lead-model-provider-deepseek').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('lead-model-provider-deepseek').getAttribute('aria-label')).toBe('deepseek, 1 model');
    // 只画 deepseek：标题不再写供应商，只写来源网关。
    expect(groupTitles()).toEqual(['magpie']);
    expect(screen.getByTestId('lead-model-option-magpie/deepseek/deepseek-v4')).toBeTruthy();
    // 这个 provider 里搜不到：空状态，不跳回全部。
    await act(async () => { fireEvent.change(screen.getByTestId('lead-model-search'), { target: { value: 'sonnet' } }); });
    expect(screen.getByTestId('lead-model-no-match')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-provider-all')); });
    expect(groupTitles()).toEqual(['vibeproxy · as1 · anthropic', 'vibeproxy · as4 · anthropic', 'vibeproxy · anthropic']);
  });

  it('switches to another model, keeping the effort when it supports it, and closes', async () => {
    const { switched } = setup();
    await open();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/as4/claude-opus-5-5')); });
    expect(switched).toEqual([{ model: 'vibeproxy/as4/claude-opus-5-5', effort: 'high' }]);
    await waitFor(() => expect(screen.queryByTestId('lead-model-catalog')).toBeNull());
    expect(screen.getByTestId('composer-model').textContent).toBe('claude-opus-5-5');
  });

  it('drops the effort for a model that has none, and changes only the effort from the effort row', async () => {
    const { switched } = setup({ applied: 'after_turn' });
    await open();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-option-vibeproxy/gemini-3.8-flash-high')); });
    expect(switched).toEqual([{ model: 'vibeproxy/gemini-3.8-flash-high', effort: null }]);
    // Lead 正在回答：浮层留着，说这一轮结束后换。
    await waitFor(() => expect(screen.getByTestId('lead-model-notice').textContent).toContain('starts after this answer ends'));
    expect(screen.getByTestId('lead-model-pending')).toBeTruthy();
  });

  it('changes the effort of the chosen model', async () => {
    const { switched } = setup();
    await open();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-effort-low')); });
    expect(switched).toEqual([{ model: 'vibeproxy/as4/claude-sonnet-5', effort: 'low' }]);
  });

  it('says why a switch was refused and keeps the panel open', async () => {
    setup({ fail: '模型 vibeproxy/as4/claude-sonnet-5 不支持推理强度 max。可选：low、high' });
    await open();
    await act(async () => { fireEvent.click(screen.getByTestId('lead-model-effort-default')); });
    await waitFor(() => expect(screen.getByTestId('lead-model-notice').textContent).toContain('不支持推理强度'));
    expect(screen.getByTestId('lead-model-catalog')).toBeTruthy();
  });
});
