// @vitest-environment happy-dom
// 会话搜索面板（工单 #339）：输入即搜（防抖）、精确和模糊的参数、命中列表、上一条下一条循环、点击跳转、
// 让 agent 找，以及模型不能用时的说明。
import type { ConversationSearchResult } from '@pi-lead-child/protocol';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { ConversationSearchPanel } from './ConversationSearchPanel';
import type { ConversationSearchClient } from './useConversationSearch';

const hit = (turnId: string, matched: string, role: 'user' | 'assistant' = 'user') => ({
  turnId, role, originKind: 'paired:companion', createdAt: '2026-10-28T02:00:00.000Z',
  before: '…前面 ', matched, after: ' 后面…', score: 1,
});
const result = (hits: ReturnType<typeof hit>[], total = hits.length): ConversationSearchResult => ({
  hits, total, totalCapped: false, offset: 0,
});

function setup(overrides: Partial<ConversationSearchClient> = {}) {
  const client = {
    search: vi.fn(async () => result([hit('t1', 'daemon'), hit('t2', 'Daemon', 'assistant'), hit('t3', 'daemon')])),
    agent: vi.fn(async () => ({ candidates: [], source: 'model' as const })),
    ...overrides,
  } satisfies ConversationSearchClient;
  const onJump = vi.fn(async () => true);
  const onClose = vi.fn();
  renderUI(<ConversationSearchPanel client={client} leadName="Red Bull" onJump={onJump} onClose={onClose} />);
  return { client, onJump, onClose };
}

const type = (text: string) => fireEvent.change(screen.getByTestId('conversation-search-input'), { target: { value: text } });
const settle = async (ms = 250) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('conversation search panel', () => {
  it('searches as you type, after a 200 ms pause, and lists sender, time and snippet', async () => {
    const { client } = setup();
    type('dae');
    type('daemon');
    await settle(150);
    expect(client.search).not.toHaveBeenCalled();
    await settle(100);
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search).toHaveBeenCalledWith(
      { query: 'daemon', mode: 'fuzzy', wholeWord: false, offset: 0, limit: 20 }, expect.anything(),
    );
    expect(screen.getAllByTestId('conversation-search-hit')).toHaveLength(3);
    expect(screen.getByTestId('conversation-search-count').textContent).toBe('3 matches');
    expect(screen.getByText('Red Bull')).toBeTruthy();
    expect(screen.getAllByText('You').length).toBeGreaterThan(0);
  });

  it('sends exact mode and whole word to the daemon', async () => {
    const { client } = setup();
    fireEvent.click(screen.getByTestId('conversation-search-mode-exact'));
    fireEvent.click(screen.getByTestId('conversation-search-whole-word'));
    type('Daemon');
    await settle();
    expect(client.search).toHaveBeenLastCalledWith(
      { query: 'Daemon', mode: 'exact', wholeWord: true, offset: 0, limit: 20 }, expect.anything(),
    );
  });

  it('jumps on click, and steps with next and previous, wrapping at both ends', async () => {
    const { onJump } = setup();
    type('daemon');
    await settle();
    fireEvent.click(screen.getAllByTestId('conversation-search-hit')[1]!);
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: 't2' }));
    fireEvent.click(screen.getByTestId('conversation-search-next'));
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: 't3' }));
    fireEvent.click(screen.getByTestId('conversation-search-next'));
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: 't1' }));
    fireEvent.click(screen.getByTestId('conversation-search-prev'));
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: 't3' }));
    expect(screen.getByTestId('conversation-search-count').textContent).toBe('3 of 3');
  });

  it('uses Enter, Shift+Enter, the arrows and Escape on the web', async () => {
    const { onJump, onClose } = setup();
    type('daemon');
    await settle();
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: 't1' }));
    fireEvent.keyDown(document, { key: 'Enter', shiftKey: true });
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: 't3' }));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: 't1' }));
    fireEvent.keyDown(document, { key: 'ArrowUp' });
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: 't3' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('says so when nothing matches or the search fails', async () => {
    setup({ search: vi.fn(async () => result([])) });
    type('nothing');
    await settle();
    expect(screen.getByTestId('conversation-search-empty')).toBeTruthy();
  });

  it('shows an error instead of failing silently', async () => {
    setup({ search: vi.fn(async () => { throw new Error('down'); }) });
    type('x');
    await settle();
    expect(screen.getByTestId('conversation-search-error')).toBeTruthy();
  });

  it('tells the user when a message is not shown as its own line', async () => {
    const { onJump } = setup();
    onJump.mockResolvedValue(false);
    type('daemon');
    await settle();
    fireEvent.click(screen.getAllByTestId('conversation-search-hit')[0]!);
    await settle(10);
    expect(screen.getByTestId('conversation-search-jump-note')).toBeTruthy();
  });

  it('asks the agent only on request and lists the candidates with their reasons', async () => {
    const agent = vi.fn(async () => ({
      candidates: [{ turnId: 't9', role: 'user' as const, originKind: 'paired:companion', createdAt: '2026-10-28T02:00:00.000Z', excerpt: 'restart the daemon', reason: 'about the restart' }],
      source: 'model' as const,
    }));
    const { client, onJump } = setup({ agent });
    fireEvent.click(screen.getByTestId('conversation-search-agent'));
    type('上次说 daemon 重启的那条');
    await settle();
    expect(client.search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('conversation-search-agent-run'));
    await settle(10);
    expect(agent).toHaveBeenCalledWith('上次说 daemon 重启的那条', expect.anything());
    expect(screen.getByText('about the restart')).toBeTruthy();
    expect(screen.queryByTestId('conversation-search-model-unavailable')).toBeNull();
    fireEvent.click(screen.getByTestId('conversation-search-hit'));
    expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ turnId: 't9', reason: 'about the restart' }));
  });

  it('says the model is unavailable when the daemon already fell back to keywords', async () => {
    setup({ agent: vi.fn(async () => ({ candidates: [], source: 'keywords' as const })) });
    fireEvent.click(screen.getByTestId('conversation-search-agent'));
    type('daemon restart');
    fireEvent.click(screen.getByTestId('conversation-search-agent-run'));
    await settle(10);
    expect(screen.getByTestId('conversation-search-model-unavailable').textContent).toBe(
      'The model is unavailable now. Showing keyword results instead.',
    );
  });

  it('runs a fuzzy search itself and says so when the agent request fails', async () => {
    const { client } = setup({ agent: vi.fn(async () => { throw new Error('timeout'); }) });
    fireEvent.click(screen.getByTestId('conversation-search-agent'));
    type('daemon restart');
    fireEvent.click(screen.getByTestId('conversation-search-agent-run'));
    await settle(10);
    expect(client.search).toHaveBeenCalledWith({ query: 'daemon restart', mode: 'fuzzy', limit: 10 }, expect.anything());
    expect(screen.getByTestId('conversation-search-model-unavailable')).toBeTruthy();
    expect(screen.getAllByTestId('conversation-search-hit')).toHaveLength(3);
  });
});
