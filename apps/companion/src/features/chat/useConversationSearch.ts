// 会话搜索的状态（工单 #339）：输入即搜（防抖 200ms）、精确和模糊、命中列表、上一条下一条、「让 agent 找」和它的回退。
// 只读：只调 daemon 的搜索接口，不写任何东西。过期的请求用 AbortController 取消，慢的回答不会盖住新的。
import type { ConversationAgentSearchResult, ConversationSearchMode, ConversationSearchResult } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cycleIndex } from './conversationSearch';

export const SEARCH_DEBOUNCE_MS = 200;
const PAGE_SIZE = 20;

/** 列表里的一条：关键词命中，或 agent 挑的候选。 */
export type SearchEntry = {
  turnId: string;
  role: 'user' | 'assistant';
  originKind: string;
  createdAt: string;
  /** 命中片段：前、命中的文字、后。agent 候选只有 matched（消息开头的一段）。 */
  before: string;
  matched: string;
  after: string;
  /** agent 给的一句理由。关键词命中没有。 */
  reason?: string;
};

export type ConversationSearchClient = {
  search: (
    input: { query: string; mode: ConversationSearchMode; wholeWord?: boolean; offset?: number; limit?: number },
    signal?: AbortSignal,
  ) => Promise<ConversationSearchResult>;
  agent: (description: string, signal?: AbortSignal) => Promise<ConversationAgentSearchResult>;
};

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

export function useConversationSearch(client: ConversationSearchClient, debounceMs = SEARCH_DEBOUNCE_MS) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ConversationSearchMode>('fuzzy');
  const [wholeWord, setWholeWord] = useState(false);
  const [agentMode, setAgentMode] = useState(false);
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [entries, setEntries] = useState<SearchEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [capped, setCapped] = useState(false);
  const [modelUnavailable, setModelUnavailable] = useState(false);
  const [active, setActive] = useState(-1);
  const abort = useRef<AbortController | null>(null);
  // 列表里现在这些命中是用哪组参数搜出来的。参数变了（输入还在防抖）而列表还是旧的时，不能接着旧偏移往下翻。
  const loadedKey = useRef<string | null>(null);
  const clientRef = useRef(client);
  clientRef.current = client;

  const begin = useCallback(() => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    return controller;
  }, []);

  const run = useCallback(async (offset: number, append: boolean) => {
    const text = query.trim();
    const key = JSON.stringify([text, mode, mode === 'exact' && wholeWord]);
    const controller = begin();
    setStatus('loading');
    try {
      const result = await clientRef.current.search(
        { query: text, mode, wholeWord: mode === 'exact' && wholeWord, offset, limit: PAGE_SIZE }, controller.signal,
      );
      if (controller.signal.aborted) return;
      loadedKey.current = key;
      // 翻页之间来了新消息，下一页会和上一页重一条：按「轮 + 哪一侧」去重。
      setEntries((current) => {
        if (!append) return result.hits;
        const seen = new Set(current.map((entry) => `${entry.turnId}:${entry.role}`));
        return [...current, ...result.hits.filter((hit) => !seen.has(`${hit.turnId}:${hit.role}`))];
      });
      setTotal(result.total);
      setCapped(result.totalCapped);
      setStatus('ready');
    } catch {
      if (controller.signal.aborted) return;
      setStatus('error');
    }
  }, [begin, mode, query, wholeWord]);

  // 输入即搜：停下 200ms 以后搜。agent 模式不自动搜（每次都问模型太贵），要按「开始找」。
  useEffect(() => {
    if (agentMode) return undefined;
    setActive(-1);
    setModelUnavailable(false);
    if (!query.trim()) {
      abort.current?.abort();
      setEntries([]);
      setTotal(0);
      setCapped(false);
      setStatus('idle');
      return undefined;
    }
    const timer = setTimeout(() => { void run(0, false); }, debounceMs);
    return () => clearTimeout(timer);
  }, [agentMode, debounceMs, run, query]);

  useEffect(() => () => abort.current?.abort(), []);

  const loadMore = useCallback(() => {
    if (status === 'loading' || agentMode || entries.length >= total) return;
    if (loadedKey.current !== JSON.stringify([query.trim(), mode, mode === 'exact' && wholeWord])) return;
    void run(entries.length, true);
  }, [agentMode, entries.length, mode, query, run, status, total, wholeWord]);

  // 让 agent 找：模型不能用、超时、出错时，用模糊搜索的结果代替，并告诉用户（modelUnavailable）。
  const askAgent = useCallback(async () => {
    const text = query.trim();
    if (!text) return;
    const controller = begin();
    setStatus('loading');
    setActive(-1);
    setModelUnavailable(false);
    try {
      const result = await clientRef.current.agent(text, controller.signal);
      if (controller.signal.aborted) return;
      setEntries(result.candidates.map((candidate) => ({
        turnId: candidate.turnId, role: candidate.role, originKind: candidate.originKind, createdAt: candidate.createdAt,
        before: '', matched: candidate.excerpt, after: '', ...(candidate.reason ? { reason: candidate.reason } : {}),
      })));
      setTotal(result.candidates.length);
      setCapped(false);
      setModelUnavailable(result.source === 'keywords');
      setStatus('ready');
    } catch {
      if (controller.signal.aborted) return;
      try {
        const fallback = await clientRef.current.search({ query: text, mode: 'fuzzy', limit: 10 }, controller.signal);
        if (controller.signal.aborted) return;
        setEntries(fallback.hits);
        setTotal(fallback.hits.length);
        setCapped(false);
        setModelUnavailable(true);
        setStatus('ready');
      } catch {
        if (controller.signal.aborted) return;
        setStatus('error');
      }
    }
  }, [begin, query]);

  const startAgent = useCallback(() => {
    abort.current?.abort();
    setAgentMode(true);
    setEntries([]);
    setTotal(0);
    setCapped(false);
    setStatus('idle');
    setActive(-1);
  }, []);
  const stopAgent = useCallback(() => {
    // 还在找的那次不能在回到关键词以后把候选写进列表。
    abort.current?.abort();
    setAgentMode(false);
    setModelUnavailable(false);
  }, []);

  const step = useCallback((direction: 1 | -1) => {
    const next = cycleIndex(active, entries.length, direction);
    setActive(next);
    return next >= 0 ? entries[next]! : null;
  }, [active, entries]);

  return useMemo(() => ({
    query, setQuery, mode, setMode, wholeWord, setWholeWord, agentMode, startAgent, stopAgent, askAgent,
    status, entries, total, totalCapped: capped, modelUnavailable, active, setActive, step, loadMore,
  }), [active, agentMode, askAgent, capped, entries, loadMore, mode, modelUnavailable, query, startAgent, status, step, stopAgent, total, wholeWord]);
}
