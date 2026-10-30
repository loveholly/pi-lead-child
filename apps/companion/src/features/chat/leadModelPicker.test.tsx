// @vitest-environment jsdom
// 会话输入框右下角的模型选择（2026-10-26）：写着 Lead 正在用的模型 id 和推理强度；点开是按来源分组的模型（as1、as4 各一组）
// 和推理强度。选一个就换（和 Lead 的 switch_lead_model 是同一个操作）；马上换好时浮层关上，模型名跟着变。
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

function setup(options: { applied?: 'now' | 'after_turn'; fail?: string } = {}) {
  const switched: LeadModelChoice[] = [];
  const client = {
    getLeadModels: vi.fn(async () => catalog),
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
  it('shows only the model id and the effort', () => {
    setup();
    expect(screen.getByTestId('composer-model').textContent).toBe('claude-sonnet-5');
    expect(screen.getByTestId('composer-model-effort').textContent).toBe('high');
  });

  it('lists the models by account and source, marks the chosen one, and shows a blocked account', async () => {
    setup();
    await open();
    expect(groupTitles()).toEqual(['as1 · Anthropic', 'as4 · Anthropic', 'Anthropic · 不指定账号', 'Antigravity']);
    expect(screen.getByTestId('lead-model-option-vibeproxy/as4/claude-sonnet-5').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('lead-model-option-vibeproxy/as1/claude-sonnet-5').textContent).toContain('额度用完');
    // 只标出不能看图的模型。
    expect(screen.getByTestId('lead-model-option-vibeproxy/gemini-3.8-flash-high').textContent).toContain('不能看图');
    expect(screen.getByTestId('lead-model-option-vibeproxy/as4/claude-sonnet-5').textContent).not.toContain('看图');
    expect(screen.getByTestId('lead-model-effort-high').getAttribute('aria-pressed')).toBe('true');
    // 最上面写着正在用的是哪个账号的哪个模型。
    expect(screen.getByTestId('lead-model-selected').textContent).toBe('正在用：as4 · Anthropic · claude-sonnet-5 high');
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
    await waitFor(() => expect(screen.getByTestId('lead-model-notice').textContent).toContain('这一轮回答结束后换上'));
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
