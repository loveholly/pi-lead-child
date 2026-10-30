// @vitest-environment jsdom
// 设置 → Lead → 记忆：现状怎样说、待确认的切换、Hindsight 的摘要模型和写入、embedding 和重排的保存。模型页（大脑和直觉）在 modelSettings.test.tsx。
// 契约在 packages/protocol/src/memory.ts 和 memory-hindsight.ts；客户端方法是假的，断言的是界面发出的请求和操作。
import { ControlPlaneClientError } from '@pi-lead-child/client';
import {
  PROTOCOL_VERSION, SERVICE_URL_MESSAGES,
  type BrainModel, type CoreMemoryEntryDto, type DecisionModelDto, type GatewayEvent, type MemoryHindsightDto, type MemoryInvalidatedFactDto,
  type MemoryPreferencesDto, type MemorySettingsDto, type MemorySwitch, type ModelSettingsDto,
} from '@pi-lead-child/protocol';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithRuntime, setViewportWidth } from '../../../test/connections';
import { createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../../state/runtime';
import { MemorySection } from './MemorySection';
import {
  bankStatsLabel, dataFlowNote, decisionFormProblem, decisionRerankDescription, downloadLabel, embeddingInUse, endpointProblem, keyHostChange, keyHostMismatchNote,
  changeIdOf, invalidatedFactSource, localEmbeddingHint, memoryErrorText, memoryNeedsUser, memoryOffReason, memoryStatus, plaintextNote, preferenceChangeLine,
  preferenceFormProblem, preferenceReasonLine, preferencesUsageLabel, preferenceUpdateInput, remoteFormProblem, remotePrivacyNote, remoteRequest, rerankerFallbackNote,
  summarySlotNote, summarySourceLabel, writesFailedNote, writesLabel,
} from './memoryModel';
import { rebase } from './useServerForm';

const nav = vi.hoisted(() => ({ router: { push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), back: vi.fn() } }));
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => nav.router, usePathname: () => '/settings/memory', Slot: () => null, Stack: () => null }));

const E5 = 'intfloat/multilingual-e5-large';
const idle = (model: string) => ({ model, state: 'idle' as const, bytes: 0, total: 0, error: null });

function memory(overrides: Partial<MemorySettingsDto> = {}): MemorySettingsDto {
  return {
    embedding: {
      mode: 'unset',
      local: { model: E5, download: idle(E5) },
      remote: { baseUrl: null, model: null, dimensions: null, apiKeySet: false, apiKeyHost: null },
    },
    reranker: {
      mode: 'decision', effective: 'decision', local: { model: 'BAAI/bge-reranker-v2-m3', download: idle('BAAI/bge-reranker-v2-m3') },
      external: { host: 'api.typesafe.ai', maxCandidates: 50 },
    },
    service: { state: 'off', backend: 'hindsight', embedding: null, reranker: null, index: { notes: 0, indexed: 0 }, message: null },
    pendingSwitch: null,
    ...overrides,
  };
}

const remoteInUse = memory({
  embedding: {
    mode: 'remote',
    local: { model: E5, download: { model: E5, state: 'ready', bytes: 2_200_000_000, total: 2_200_000_000, error: null } },
    remote: { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimensions: null, apiKeySet: true, apiKeyHost: 'api.openai.com' },
  },
  service: { state: 'healthy', backend: 'hindsight', embedding: 'text-embedding-3-small', reranker: 'jev-latest', index: { notes: 1204, indexed: 1180 }, message: null },
  pendingSwitch: {
    id: 'msw_abcdefgh12', summary: `embedding 换成本地 ${E5}`,
    reason: '要为 1204 条笔记重建索引：每条一次 LLM 调用，重建完之前按意思召回不完整', needsConfirmation: true, dataFlows: [], parts: ['embedding'], state: 'pending',
    createdAt: '2026-10-16T09:00:00.000Z',
  },
});

// daemon 出的「开始外部重排」切换。maxCandidates 用 30，证明界面不写死 50。
function rerankSwitch(host = 'api.typesafe.ai', id = 'msw_rerank00001'): MemorySwitch {
  return {
    id, summary: 'reranker 改用决策模型 jev-latest',
    reason: `每次召回会把查询和最多 30 条记忆片段发给 ${host}。要停止：在设置页把 reranker 设为「不用」或「本地」`,
    needsConfirmation: true, dataFlows: [{ kind: 'rerank', host, maxCandidates: 30 }], parts: ['reranker'], state: 'pending', createdAt: '2026-10-16T09:00:00.000Z',
  };
}

const waitingForConsent = (host?: string) => memory({
  reranker: { ...memory().reranker, effective: 'none', external: { host: host ?? 'api.typesafe.ai', maxCandidates: 30 } },
  pendingSwitch: rerankSwitch(host),
});

const healthy: MemorySettingsDto['service'] = {
  state: 'healthy', embedding: `本地 ${E5}`, reranker: null, index: { notes: 12, indexed: 12 }, message: null, backend: 'hindsight',
};
const withKey = { host: 'api.typesafe.ai', apiKeySet: true };
const noKeyYet = { host: 'api.typesafe.ai', apiKeySet: false };

const decision: DecisionModelDto = {
  baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKeySet: true, apiKeySource: 'settings', apiKeyHost: 'api.typesafe.ai', problem: null,
};

type Scheduler = CompanionRuntimeDependencies['scheduler'];

function memoryRuntime(
  initial: MemorySettingsDto,
  client: Record<string, ReturnType<typeof vi.fn>> = {},
  scheduler: Scheduler = { schedule: () => 0, cancel: () => {}, now: () => 0 },
) {
  const fake = {
    getMemory: vi.fn(async () => initial),
    updateMemorySettings: vi.fn(async () => initial),
    testMemoryEmbedding: vi.fn(async () => ({ ok: true, message: 'ok', latencyMs: 230 })),
    memorySwitch: vi.fn(async () => initial.pendingSwitch),
    confirmMemorySwitch: vi.fn(async () => ({ memory: { ...initial, pendingSwitch: null }, switch: { ...initial.pendingSwitch!, state: 'applied' } })),
    getDecisionModel: vi.fn(async () => decision),
    updateDecisionModel: vi.fn(async () => decision),
    testDecisionModel: vi.fn(async () => ({ ok: true, message: 'ok', latencyMs: 410 })),
    ...client,
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler,
  });
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create', 'approvals:respond']);
  runtime.control.setState((state) => ({
    phase: 'ready',
    connectionState: 'connected',
    memory: initial,
    decisionModel: decision,
    resourceState: {
      ...state.resourceState,
      memory: { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
      'decision-model': { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
    },
  }));
  return { runtime, client: fake };
}

beforeEach(() => vi.clearAllMocks());

describe('the memory rules', () => {
  it('says plainly when only full-text search is on, and shows how many notes Hindsight has written when semantic search runs', () => {
    expect(memoryStatus(memory())).toMatchObject({ title: '语义检索没有开', tone: 'muted', detail: expect.stringContaining('全文检索') });
    expect(memoryStatus(remoteInUse)).toEqual({
      title: '语义检索已开 · text-embedding-3-small', detail: '已写入 1,180 / 1,204 条笔记', tone: 'success',
    });
    // 写入失败的原因由 daemon 写在 service.message 里，跟在条数后面。
    const failing = { ...remoteInUse, service: { ...remoteInUse.service, message: '24 条笔记没写进 Hindsight（invalid api key），按意思召回不到它们' } };
    expect(memoryStatus(failing).detail).toBe('已写入 1,180 / 1,204 条笔记 · 24 条笔记没写进 Hindsight（invalid api key），按意思召回不到它们');
  });

  it('counts a pending switch as needing the user only when it needs confirmation', () => {
    expect(memoryNeedsUser(remoteInUse)).toBe(true);
    expect(memoryNeedsUser({ ...remoteInUse, pendingSwitch: { ...remoteInUse.pendingSwitch!, needsConfirmation: false } })).toBe(false);
    expect(memoryNeedsUser(memory())).toBe(false);
  });

  it('writes the download progress, the size of the default local model, and the host that receives every note', () => {
    expect(downloadLabel({ model: E5, state: 'downloading', bytes: 1_010_000_000, total: 2_470_000_000, error: null }))
      .toBe('已下载 963 MB / 2.3 GB · 断网后会接着下');
    expect(downloadLabel(idle('x/y'))).toBeNull();
    expect(localEmbeddingHint(E5)).toBe('下载约 2.2 GB。笔记不离开这台 Mac。');
    expect(remotePrivacyNote('https://api.openai.com/v1')).toContain('api.openai.com');
  });

  it('checks the remote form like the contract does, and keeps the stored key when none is pasted', () => {
    const form = { baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimensions: '', apiKey: '' };
    expect(remoteFormProblem(form, false)).toBe('请粘贴 API key。');
    expect(remoteFormProblem(form, true)).toBeNull();
    expect(remoteFormProblem({ ...form, dimensions: '9000' }, true)).toContain('8192');
    expect(remoteRequest(form)).toEqual({ mode: 'remote', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimensions: null });
  });

  it('checks addresses with the rules and words the daemon uses', () => {
    const said = (problem: keyof typeof SERVICE_URL_MESSAGES) => `${SERVICE_URL_MESSAGES[problem]}。`;
    expect(endpointProblem('https://api.openai.com/v1')).toBeNull();
    expect(endpointProblem('https://api.openai.com/v1?version=2')).toBeNull();
    expect(endpointProblem('http://127.0.0.1:8080/v1')).toBeNull();
    expect(endpointProblem('http://localhost:11434/v1')).toBeNull();
    expect(endpointProblem('http://[::1]:8080')).toBeNull();
    // 2026-10-26：任何主机都可以用 http（公司内网的 LLM gateway），明文传输另有提示（plaintextNote）。
    expect(endpointProblem('http://llm-gateway.corp.example.com/v1')).toBeNull();
    expect(endpointProblem('http://10.1.2.3:8000/v1')).toBeNull();
    expect(endpointProblem('http://0.0.0.0:8080/v1')).toBe(said('invalid_url'));
    expect(endpointProblem('http://localhost./v1')).toBe(said('invalid_url'));
    expect(endpointProblem('https://me:pw@api.openai.com/v1')).toBe(said('userinfo'));
    expect(endpointProblem('https://:pw@api.openai.com/v1')).toBe(said('userinfo'));
    expect(endpointProblem('https://api.openai.com/v1?api_key=x')).toBe(said('secret_query'));
    expect(endpointProblem('https://api.openai.com/v1?token=x')).toBe(said('secret_query'));
    expect(endpointProblem('http://[')).toBe(said('invalid_url'));
    expect(endpointProblem('not-a-url')).toBe(said('invalid_url'));
    expect(endpointProblem('https://api.openai.com./v1')).toBe(said('invalid_url'));
    expect(endpointProblem('https://0.0.0.0/v1')).toBe(said('invalid_url'));
    expect(endpointProblem('https://[::]/v1')).toBe(said('invalid_url'));
    expect(endpointProblem('https://api.example.com/v1?subscription-key=x')).toBe(said('secret_query'));
    expect(endpointProblem('')).toBe('请填写地址。');
    expect(endpointProblem('https://api.openai.com/ v1')).toBe('地址里不能有空格。');
    expect(endpointProblem(`https://api.openai.com/${'a'.repeat(500)}`)).toBe('地址太长了，最多 500 个字符。');
  });

  it('says what external rerank sends only from the daemon numbers, and only while it really runs', () => {
    expect(decisionRerankDescription(memory(), withKey))
      .toBe('用决策模型给找到的记忆排序。每次召回会把查询和最多 50 条记忆片段发给 api.typesafe.ai。要停止，把重排改成「本地」或「不用」。');
    const running30 = memory({ reranker: { ...memory().reranker, external: { host: 'api.typesafe.ai', maxCandidates: 30 } } });
    expect(decisionRerankDescription(running30, withKey)).toContain('最多 30 条');
    expect(decisionRerankDescription(waitingForConsent(), withKey))
      .toBe('用决策模型给找到的记忆排序。等你确认后才开始：每次召回会把查询和最多 30 条记忆片段发给 api.typesafe.ai。');
    const noKey = memory({ service: healthy, reranker: { ...memory().reranker, effective: 'none', external: null } });
    expect(decisionRerankDescription(noKey, noKeyYet)).toContain('现在不往外发：决策模型没有能用的 key。');
    const notChosen = memory({ reranker: { ...memory().reranker, mode: 'none', effective: 'none', external: null } });
    expect(decisionRerankDescription(notChosen, withKey)).toBe('用决策模型给找到的记忆排序。选它以后，会把查询和记忆片段发给 api.typesafe.ai，开始之前会先问你。');
    expect(decisionRerankDescription(notChosen, null)).toBe('用决策模型给找到的记忆排序。选它以后，开始之前会先问你。');
    expect(dataFlowNote({ kind: 'embedding', host: 'proxy.example.com', maxCandidates: null })).toBe('每一条笔记会发给 proxy.example.com 生成向量，包括以后新写的笔记。');
  });

  it('says why memory is not running from the embedding settings, so no text on the page contradicts another', () => {
    const notRunning = { ...memory().reranker, effective: 'none' as const, external: null };
    const downloading = memory({
      embedding: { ...memory().embedding, mode: 'local', local: { model: E5, download: { model: E5, state: 'downloading', bytes: 10, total: 100, error: null } } },
      reranker: notRunning,
    });
    expect(memoryStatus(downloading).detail).toBe('现在记忆只用全文检索。本地模型下载好以后，开始按意思找。');
    expect(decisionRerankDescription(downloading, withKey)).toBe('用决策模型给找到的记忆排序。记忆还没开始工作：等本地模型下载好。之后要往外发时，会先问你。');
    expect(rerankerFallbackNote(downloading, withKey)).toEqual({ text: '本地模型下载好以后，记忆才开始工作。重排也从那时开始。', setUpKey: false });
    const failed = memory({
      embedding: { ...downloading.embedding, local: { model: E5, download: { model: E5, state: 'failed', bytes: 10, total: 100, error: '断网' } } },
      reranker: notRunning,
    });
    expect(rerankerFallbackNote(failed, withKey)?.text).toBe('本地模型下载失败，记忆还没开始工作。重试下载，或者改用远程。');
    const remoteWaiting = memory({ embedding: { ...remoteInUse.embedding, mode: 'remote' }, reranker: notRunning });
    expect(memoryStatus(remoteWaiting).detail).toBe('现在记忆只用全文检索。embedding 就绪以后，开始按意思找。');
    expect(decisionRerankDescription(remoteWaiting, withKey)).toContain('等 embedding 就绪');
    for (const text of [memoryStatus(downloading).detail, decisionRerankDescription(downloading, withKey), rerankerFallbackNote(downloading, withKey)?.text ?? '']) {
      expect(text).not.toContain('先选');
    }
  });

  it('says memory is turned off on this Mac when the daemon runs the sqlite backend, whatever the embedding settings say', () => {
    const turnedOff = memory({
      embedding: { ...memory().embedding, mode: 'local', local: { model: E5, download: { model: E5, state: 'downloading', bytes: 10, total: 100, error: null } } },
      reranker: { ...memory().reranker, effective: 'none', external: null },
      service: { ...memory().service, backend: 'sqlite' },
    });
    expect(memoryOffReason(turnedOff)).toBe('sqlite');
    expect(memoryStatus(turnedOff).detail).toBe('这台 Mac 上关掉了语义检索（daemon 的环境里设了 PLC_MEMORY_BACKEND=sqlite），记忆只用全文检索。');
    expect(decisionRerankDescription(turnedOff, withKey)).toBe('用决策模型给找到的记忆排序。这台 Mac 上关掉了记忆（PLC_MEMORY_BACKEND=sqlite），现在不重排，也不往外发。');
    expect(rerankerFallbackNote(turnedOff, withKey)).toEqual({
      text: '这台 Mac 上关掉了记忆（PLC_MEMORY_BACKEND=sqlite），重排不用。要打开，去掉这个环境变量，再重启 daemon。', setUpKey: false,
    });
    for (const text of [memoryStatus(turnedOff).detail, decisionRerankDescription(turnedOff, withKey)]) {
      expect(text).not.toContain('先选');
      expect(text).not.toContain('下载');
    }
  });

  it('says a fresh install needs an embedding first, not a key', () => {
    const fresh = memory({ reranker: { ...memory().reranker, effective: 'none', external: null } });
    for (const decisionState of [withKey, noKeyYet, null]) {
      const text = decisionRerankDescription(fresh, decisionState);
      expect(text).toBe('用决策模型给找到的记忆排序。记忆还没开始工作：先选 embedding。之后要往外发时，会先问你。');
      expect(rerankerFallbackNote(fresh, decisionState)).toEqual({ text: '先选 embedding，记忆才会开始工作。重排也从那时开始。', setUpKey: false });
    }
    const starting = memory({ service: { ...healthy, state: 'starting' }, reranker: fresh.reranker });
    expect(decisionRerankDescription(starting, withKey)).toContain('记忆服务正在启动，现在不往外发。');
    expect(rerankerFallbackNote(starting, withKey)).toBeNull();
    const down = memory({ service: { ...healthy, state: 'down' }, reranker: fresh.reranker });
    expect(decisionRerankDescription(down, withKey)).toContain('记忆服务停了，现在不往外发。');
  });

  it('says the gateway checks and the client errors in Chinese, and passes the daemon Chinese through', () => {
    expect(memoryErrorText(new ControlPlaneClientError('device is not paired', 'not_paired'))).toBe('这台设备还没有配对。');
    expect(memoryErrorText(new Error('this client cannot manage Lead memory'))).toBe('这个版本的客户端不能管理 Paimon 的记忆。');
    expect(memoryErrorText(new ControlPlaneClientError('baseUrl, model or apiKey is invalid', 'invalid_request', 400))).toBe('地址、模型名或 API key 的格式不对。');
    expect(memoryErrorText(new ControlPlaneClientError('the embedding or reranker settings are invalid', 'invalid_request', 400))).toBe('embedding 或重排的设置格式不对。');
    expect(memoryErrorText(new ControlPlaneClientError('switch id is malformed', 'invalid_request', 400))).toBe('这个切换的编号不对。');
    expect(memoryErrorText(new ControlPlaneClientError('approve must be a boolean', 'invalid_request', 400))).toBe('确认切换的请求格式不对。');
    expect(memoryErrorText(new ControlPlaneClientError('还没有决策模型的 key', 'invalid_request', 400))).toBe('还没有决策模型的 key');
  });

  it('follows the server for fields the user did not touch, and keeps the ones the user is editing', () => {
    const baseline = { baseUrl: 'https://api.typesafe.ai', model: 'jev-latest', apiKey: '' };
    const form = { ...baseline, baseUrl: 'https://jev.example.com' };
    expect(rebase(form, baseline, { ...baseline, model: 'jev-2' })).toEqual({ baseUrl: 'https://jev.example.com', model: 'jev-2', apiKey: '' });
  });

  it('warns about plaintext only for http to a host other than this Mac', () => {
    expect(plaintextNote('http://llm-gateway.corp.example.com/v1')).toBe(
      '这个地址用 http://：key 和发给 llm-gateway.corp.example.com 的内容会明文经过网络。只在可信的内网里这样用。',
    );
    expect(plaintextNote(' http://10.1.2.3:8000 ')).toContain('10.1.2.3:8000');
    for (const url of ['https://api.openai.com/v1', 'http://127.0.0.1:8080/v1', 'http://localhost:11434/v1', 'http://[', '']) {
      expect(plaintextNote(url), url).toBeNull();
    }
  });

  it('compares the address with the host the saved key belongs to', () => {
    expect(keyHostChange('api.openai.com', 'https://api.openai.com/v2', true)).toBeNull();
    expect(keyHostChange('api.openai.com', 'https://proxy.example.com/v1', false)).toBeNull();
    expect(keyHostChange('api.openai.com', 'https://proxy.example.com/v1', true)).toEqual({ from: 'api.openai.com', to: 'proxy.example.com' });
    expect(keyHostChange('localhost:11434', 'http://localhost:11435/v1', true)).toEqual({ from: 'localhost:11434', to: 'localhost:11435' });
    // daemon 换主机时删掉旧 key、照样保存：本机端点可能不要 key，所以界面不比 daemon 更严。
    const moved = { baseUrl: 'https://proxy.example.com/v1', model: 'text-embedding-3-small', dimensions: '', apiKey: '' };
    expect(remoteFormProblem(moved, true)).toBeNull();
    expect(decisionFormProblem({ baseUrl: 'https://jev.example.com', model: 'jev-latest', apiKey: '' })).toBeNull();
    expect(keyHostMismatchNote('api.openai.com', 'https://proxy.example.com/v1', false))
      .toBe('存的 key 属于 api.openai.com，不会发给 proxy.example.com。请粘贴 proxy.example.com 的 key。');
    expect(keyHostMismatchNote('api.openai.com', 'https://proxy.example.com/v1', true)).toBeNull();
    expect(keyHostMismatchNote('api.openai.com', 'https://api.openai.com/v1', false)).toBeNull();
  });

  it('says which embedding actually runs: a chosen local model waits for its download and for the confirmation', () => {
    const local = (state: 'downloading' | 'ready') => ({
      ...remoteInUse.embedding, mode: 'local' as const,
      local: { model: E5, download: { model: E5, state, bytes: 1, total: 1, error: null } },
    });
    expect(embeddingInUse({ ...remoteInUse, embedding: local('downloading'), pendingSwitch: null })).toBe('remote');
    expect(embeddingInUse({ ...remoteInUse, embedding: local('ready') })).toBe('remote');
    expect(embeddingInUse({ ...remoteInUse, embedding: local('ready'), pendingSwitch: null })).toBe('local');
    // 只差外部重排的切换不压着 embedding：选的本地模型已经在用。
    expect(embeddingInUse({ ...remoteInUse, embedding: local('ready'), pendingSwitch: rerankSwitch() })).toBe('local');
    expect(embeddingInUse(memory())).toBeNull();
  });

  it('explains a reranker fallback, but leaves a pending consent to the switch card', () => {
    const noKey = memory({ service: healthy, reranker: { ...memory().reranker, effective: 'none', external: null } });
    expect(rerankerFallbackNote(noKey, noKeyYet)).toEqual({
      text: '决策模型没有能用的 key，现在按「不用」处理。在「模型」里设置 key 以后，开始之前会先问你。', setUpKey: true,
    });
    expect(rerankerFallbackNote(noKey, withKey)).toBeNull();
    expect(rerankerFallbackNote({ ...waitingForConsent(), service: healthy }, withKey)).toBeNull();
    expect(rerankerFallbackNote(memory(), withKey)).toBeNull();
    const localWaits = memory({
      service: healthy,
      reranker: { ...memory().reranker, mode: 'local', effective: 'none', external: null, local: { model: 'BAAI/bge-reranker-v2-m3', download: { ...idle('BAAI/bge-reranker-v2-m3'), state: 'downloading' } } },
    });
    expect(rerankerFallbackNote(localWaits, withKey)?.text).toBe('本地模型还没下载好，现在用「不用」。下载好后自动切换。');
  });
});

describe('the memory section', () => {
  it('shows the pending switch first, and only the user click confirms it', async () => {
    const { runtime, client } = memoryRuntime(remoteInUse);
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-pending-switch').textContent).toContain(`embedding 换成本地 ${E5}`);
    expect(screen.queryByTestId('memory-switch-hosts')).toBeNull();
    expect(screen.getByTestId('memory-switch-approve').textContent).toBe('切换');
    await act(async () => { fireEvent.click(screen.getByTestId('memory-switch-approve')); });
    expect(client.confirmMemorySwitch).toHaveBeenCalledWith('msw_abcdefgh12', true);
    await waitFor(() => expect(screen.queryByTestId('memory-pending-switch')).toBeNull());
  });

  it('asks for consent to send data on the switch card, naming the host from the daemon', async () => {
    const { runtime, client } = memoryRuntime(waitingForConsent());
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-switch-hosts').textContent).toBe('数据会离开这台 Mac，发给 api.typesafe.ai');
    expect(screen.getByTestId('memory-switch-reason').textContent).toContain('最多 30 条记忆片段发给 api.typesafe.ai');
    expect(screen.getByTestId('memory-switch-approve').textContent).toBe('同意并切换');
    await act(async () => { fireEvent.click(screen.getByTestId('memory-switch-reject')); });
    expect(client.confirmMemorySwitch).toHaveBeenCalledWith('msw_rerank00001', false);
  });

  it('says so when the settings changed after the card was shown', async () => {
    const { runtime } = memoryRuntime(waitingForConsent(), {
      confirmMemorySwitch: vi.fn(async () => { throw new ControlPlaneClientError('设置已经变了，这个切换作废', 'conflict', 409); }),
    });
    renderWithRuntime(<MemorySection />, runtime);
    await act(async () => { fireEvent.click(screen.getByTestId('memory-switch-approve')); });
    expect(screen.getByTestId('memory-switch-error').textContent).toBe('设置已经变了，这个切换作废');
  });

  it('moves focus to a switch card that appears while the page is open, not to one that was there before', async () => {
    const { runtime } = memoryRuntime(memory({ reranker: { ...memory().reranker, mode: 'none', effective: 'none', external: null } }));
    renderWithRuntime(<MemorySection />, runtime);
    await act(async () => { runtime.control.setState({ memory: waitingForConsent() }); });
    expect(document.activeElement).toBe(screen.getByTestId('memory-pending-switch'));
  });

  it('does not take focus from a field the user is typing in', async () => {
    const { runtime } = memoryRuntime(remoteInUse);
    runtime.control.setState({ memory: { ...remoteInUse, pendingSwitch: null } });
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    const key = screen.getByTestId('memory-remote-api-key') as HTMLInputElement;
    key.focus();
    await act(async () => { runtime.control.setState({ memory: waitingForConsent() }); });
    expect(document.activeElement).toBe(screen.getByTestId('memory-remote-api-key'));
    expect(screen.getByTestId('memory-pending-switch').getAttribute('role')).toBe('region');
  });

  it('keeps showing the local embedding as in use while only the external rerank waits', () => {
    const localInUse = memory({
      embedding: {
        mode: 'local',
        local: { model: E5, download: { model: E5, state: 'ready', bytes: 2_200_000_000, total: 2_200_000_000, error: null } },
        remote: { baseUrl: null, model: null, dimensions: null, apiKeySet: false, apiKeyHost: null },
      },
      service: healthy,
      reranker: { ...memory().reranker, effective: 'none', external: { host: 'api.typesafe.ai', maxCandidates: 30 } },
      pendingSwitch: rerankSwitch(),
    });
    const { runtime } = memoryRuntime(localInUse);
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-pending-switch')).toBeTruthy();
    expect(screen.getByTestId('memory-in-use').textContent).toBe('正在用');
    expect(screen.queryByTestId('memory-chosen')).toBeNull();
  });

  it('does not promise a download or a switch while this Mac has memory turned off', () => {
    const turnedOff = memory({
      embedding: { ...memory().embedding, mode: 'local', local: { model: E5, download: { model: E5, state: 'downloading', bytes: 10, total: 100, error: null } } },
      reranker: { ...memory().reranker, effective: 'none', external: null },
      service: { ...memory().service, backend: 'sqlite' },
    });
    const { runtime } = memoryRuntime(turnedOff);
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-chosen').textContent).toBe('已选 · 这台 Mac 上关掉了记忆');
    expect(screen.getByTestId('memory-embedding-local').textContent).not.toContain('模型在后台下载');
    expect(screen.getByTestId('memory-status').textContent).toContain('PLC_MEMORY_BACKEND=sqlite');
    expect(screen.getByTestId('memory-reranker-fallback').textContent).toContain('去掉这个环境变量');
  });

  it('shows the chosen local model as waiting while both parts of a switch wait for the user', () => {
    const bothWait = memory({
      embedding: {
        mode: 'local',
        local: { model: E5, download: { model: E5, state: 'ready', bytes: 2_200_000_000, total: 2_200_000_000, error: null } },
        remote: remoteInUse.embedding.remote,
      },
      service: { ...healthy, embedding: '远程 text-embedding-3-small（api.openai.com）' },
      reranker: { ...memory().reranker, effective: 'none', external: { host: 'api.typesafe.ai', maxCandidates: 30 } },
      pendingSwitch: { ...rerankSwitch(), summary: `embedding 换成本地 ${E5}，reranker 换成决策模型 jev-latest`, parts: ['embedding', 'reranker'] },
    });
    const { runtime } = memoryRuntime(bothWait);
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-chosen').textContent).toBe('已选 · 等你确认切换');
    expect(screen.queryByTestId('memory-in-use')).toBeNull();
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    expect(screen.getByTestId('memory-in-use').textContent).toBe('正在用');
    expect(screen.getByTestId('memory-reranker-decision-description').textContent).toContain('等你确认后才开始');
  });

  it('gives focus to the card that a button press caused', async () => {
    const noSwitch = { ...remoteInUse, pendingSwitch: null };
    const { runtime } = memoryRuntime(noSwitch, { updateMemorySettings: vi.fn(async () => waitingForConsent()) });
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    const save = screen.getByTestId('memory-remote-save') as HTMLButtonElement;
    save.focus();
    expect(document.activeElement).toBe(save);
    await act(async () => { fireEvent.click(save); });
    expect(document.activeElement).toBe(screen.getByTestId('memory-pending-switch'));
  });

  it('tells a fresh install to choose an embedding first, without sending the user to set a key', () => {
    const fresh = memory({ reranker: { ...memory().reranker, effective: 'none', external: null } });
    const { runtime } = memoryRuntime(fresh);
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-reranker-fallback').textContent).toBe('先选 embedding，记忆才会开始工作。重排也从那时开始。');
    expect(screen.queryByText('去设置决策模型')).toBeNull();
    expect(screen.getByTestId('memory-reranker-decision-description').textContent).toContain('先选 embedding');
    expect(screen.getByTestId('memory-reranker-decision-description').textContent).not.toContain('key');
  });

  it('does not take focus for a switch card that was there when the page opened', () => {
    const { runtime } = memoryRuntime(waitingForConsent());
    renderWithRuntime(<MemorySection />, runtime);
    expect(document.activeElement).not.toBe(screen.getByTestId('memory-pending-switch'));
  });

  it('saves local mode and says the model downloads in the background', async () => {
    const downloading = memory({
      embedding: { ...memory().embedding, mode: 'local', local: { model: E5, download: { model: E5, state: 'downloading', bytes: 500_000_000, total: 2_300_000_000, error: null } } },
    });
    const { runtime, client } = memoryRuntime(memory(), { updateMemorySettings: vi.fn(async () => downloading) });
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-status').textContent).toContain('语义检索没有开');
    await act(async () => { fireEvent.click(screen.getByTestId('memory-use-local')); });
    expect(client.updateMemorySettings).toHaveBeenCalledWith({ embedding: { mode: 'local' } });
    expect(screen.getByTestId('memory-embedding-download').textContent).toContain('已下载 477 MB / 2.1 GB');
    expect(screen.getByTestId('memory-embedding-local').textContent).toContain('模型在后台下载');
  });

  it('saves the remote settings with a pasted key, clears the key field, and tests the saved config', async () => {
    const { runtime, client } = memoryRuntime(remoteInUse);
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    expect(screen.getByTestId('memory-remote-privacy').textContent).toContain('api.openai.com');
    const key = screen.getByTestId('memory-remote-api-key') as HTMLInputElement;
    expect(key.placeholder).toBe('已设置 · 要更换就粘贴新的');
    fireEvent.change(key, { target: { value: 'sk-test-not-a-real-key' } });
    await act(async () => { fireEvent.click(screen.getByTestId('memory-remote-save')); });
    expect(client.updateMemorySettings).toHaveBeenCalledWith({
      embedding: { mode: 'remote', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', dimensions: null, apiKey: 'sk-test-not-a-real-key' },
    });
    expect((screen.getByTestId('memory-remote-api-key') as HTMLInputElement).value).toBe('');
    await act(async () => { fireEvent.click(screen.getByTestId('memory-remote-test')); });
    expect(client.testMemoryEmbedding).toHaveBeenCalled();
    expect(screen.getByTestId('memory-embedding-remote').textContent).toContain('可用 · 230 ms');
  });

  it('says the saved key stays with its host when the address moves, and lets the daemon drop it on save', async () => {
    const { runtime, client } = memoryRuntime(remoteInUse);
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    fireEvent.change(screen.getByTestId('memory-remote-base-url'), { target: { value: 'https://proxy.example.com/v1' } });
    expect(screen.getByTestId('memory-remote-host-change').textContent).toBe(
      '地址换到了 proxy.example.com。已保存的 key 属于 api.openai.com，不会发给新地址，保存后会被删掉。proxy.example.com 要 key 的话，请粘贴它的 key。',
    );
    expect((screen.getByTestId('memory-remote-api-key') as HTMLInputElement).placeholder).toBe('粘贴 proxy.example.com 的 API key');
    await act(async () => { fireEvent.click(screen.getByTestId('memory-remote-save')); });
    expect(client.updateMemorySettings).toHaveBeenCalledWith({
      embedding: { mode: 'remote', baseUrl: 'https://proxy.example.com/v1', model: 'text-embedding-3-small', dimensions: null },
    });
  });

  it('warns under the address when the remote embedding uses plain http on the network', async () => {
    const { runtime, client } = memoryRuntime(remoteInUse);
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    expect(screen.queryByTestId('memory-remote-plaintext')).toBeNull();
    fireEvent.change(screen.getByTestId('memory-remote-base-url'), { target: { value: 'http://llm-gateway.corp.example.com/v1' } });
    expect(screen.getByTestId('memory-remote-plaintext').textContent).toContain('明文');
    await act(async () => { fireEvent.click(screen.getByTestId('memory-remote-save')); });
    expect(client.updateMemorySettings).toHaveBeenCalledWith({
      embedding: { mode: 'remote', baseUrl: 'http://llm-gateway.corp.example.com/v1', model: 'text-embedding-3-small', dimensions: null },
    });
  });

  it('says the old key was deleted after the address moved without a new key', async () => {
    const moved = memory({
      ...remoteInUse,
      pendingSwitch: null,
      embedding: { ...remoteInUse.embedding, remote: { ...remoteInUse.embedding.remote, baseUrl: 'https://proxy.example.com/v1', apiKeySet: false, apiKeyHost: null } },
    });
    const { runtime } = memoryRuntime({ ...remoteInUse, pendingSwitch: null }, { updateMemorySettings: vi.fn(async () => moved) });
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    fireEvent.change(screen.getByTestId('memory-remote-base-url'), { target: { value: 'https://proxy.example.com/v1' } });
    await act(async () => { fireEvent.click(screen.getByTestId('memory-remote-save')); });
    expect(screen.getByTestId('memory-embedding-remote').textContent).toContain(
      '已保存，记忆服务重启了。旧的 key 属于 api.openai.com，已经删掉。proxy.example.com 要 key 的话，请粘贴它的 key。',
    );
  });

  it('says when the stored key belongs to another host and is not sent', () => {
    const mismatched = memory({
      embedding: { ...remoteInUse.embedding, remote: { ...remoteInUse.embedding.remote, baseUrl: 'https://proxy.example.com/v1', apiKeySet: false } },
    });
    const { runtime } = memoryRuntime(mismatched);
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    expect(screen.getByTestId('memory-remote-key-mismatch').textContent).toBe('存的 key 属于 api.openai.com，不会发给 proxy.example.com。请粘贴 proxy.example.com 的 key。');
  });

  it('shows the daemon reason when a test refuses to send the key to another host', async () => {
    const { runtime } = memoryRuntime(remoteInUse, {
      testMemoryEmbedding: vi.fn(async () => {
        throw new ControlPlaneClientError('存的 key 属于 api.openai.com，不会发给 proxy.example.com。先保存，或者重新粘贴 key。', 'invalid_request', 400);
      }),
    });
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    await act(async () => { fireEvent.click(screen.getByTestId('memory-remote-test')); });
    expect(screen.getByTestId('memory-embedding-remote').textContent).toContain('不会发给 proxy.example.com。先保存，或者重新粘贴 key。');
  });

  it('keeps a pasted key when the save fails, so the user does not paste it again', async () => {
    const { runtime } = memoryRuntime(remoteInUse, {
      updateMemorySettings: vi.fn(async () => { throw new ControlPlaneClientError('the embedding or reranker settings are invalid', 'invalid_request', 400); }),
    });
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    fireEvent.change(screen.getByTestId('memory-remote-api-key'), { target: { value: 'sk-test-kept' } });
    await act(async () => { fireEvent.click(screen.getByTestId('memory-remote-save')); });
    expect((screen.getByTestId('memory-remote-api-key') as HTMLInputElement).value).toBe('sk-test-kept');
    expect(screen.getByTestId('memory-embedding-remote').textContent).toContain('embedding 或重排的设置格式不对。');
  });

  it('marks the key field as a secret that the browser must not fill with a saved password', () => {
    const { runtime } = memoryRuntime(remoteInUse);
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    const key = screen.getByTestId('memory-remote-api-key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.getAttribute('autocomplete')).toBe('new-password');
    expect(screen.getByTestId('memory-remote-base-url').getAttribute('autocomplete')).toBe('off');
  });

  it('cannot test a remote config that was never saved', () => {
    const { runtime } = memoryRuntime(memory());
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-embedding-tab-remote'));
    expect((screen.getByTestId('memory-remote-test') as HTMLButtonElement).disabled).toBe(true);
  });

  it('switches the reranker at once, and explains a fallback', async () => {
    const fallback = memory({ service: healthy, reranker: { ...memory().reranker, effective: 'none', external: null } });
    const { runtime, client } = memoryRuntime(fallback);
    runtime.control.setState({ decisionModel: { ...decision, apiKeySet: false, apiKeySource: null } });
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-reranker-fallback').textContent).toContain('没有能用的 key');
    expect(screen.getByText('去设置决策模型')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('memory-reranker-none')); });
    expect(client.updateMemorySettings).toHaveBeenCalledWith({ reranker: { mode: 'none' } });
  });

  it('saves the decision reranker as a choice, and leaves the consent to the switch card the daemon sends back', async () => {
    const off = memory({ reranker: { ...memory().reranker, mode: 'none', effective: 'none', external: null } });
    const { runtime, client } = memoryRuntime(off, { updateMemorySettings: vi.fn(async () => waitingForConsent()) });
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-reranker-decision-description').textContent).toContain('开始之前会先问你');
    await act(async () => { fireEvent.click(screen.getByTestId('memory-reranker-decision')); });
    expect(client.updateMemorySettings).toHaveBeenCalledWith({ reranker: { mode: 'decision' } });
    expect(screen.getByTestId('memory-reranker-message').textContent).toBe('要你确认这个切换，见上面。');
    expect(screen.getByTestId('memory-switch-hosts').textContent).toBe('数据会离开这台 Mac，发给 api.typesafe.ai');
    expect(screen.getByTestId('memory-reranker-decision-description').textContent).toContain('等你确认后才开始');
    expect(client.confirmMemorySwitch).not.toHaveBeenCalled();
  });

  it('does not name a host it has not read', async () => {
    const off = memory({ reranker: { ...memory().reranker, mode: 'none', effective: 'none', external: null } });
    const { runtime, client } = memoryRuntime(off, {
      getDecisionModel: vi.fn(async () => { throw new ControlPlaneClientError('记忆设置还没有启动', 'internal_error', 503); }),
    });
    runtime.control.setState((state) => ({
      decisionModel: null,
      resourceState: { ...state.resourceState, 'decision-model': { state: 'idle', generation: 0, observerCount: 0, lastSuccessAt: null, error: null } },
    }));
    renderWithRuntime(<MemorySection />, runtime);
    await waitFor(() => expect(client.getDecisionModel).toHaveBeenCalled());
    expect(screen.getByTestId('memory-reranker-decision-description').textContent).toBe('用决策模型给找到的记忆排序。选它以后，开始之前会先问你。');
  });

  it('offers the rerankers as a radio group', () => {
    const { runtime } = memoryRuntime(memory());
    renderWithRuntime(<MemorySection />, runtime);
    const decisionOption = screen.getByTestId('memory-reranker-decision');
    expect(decisionOption.getAttribute('role')).toBe('radio');
    expect(decisionOption.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('memory-reranker-none').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('radiogroup', { name: '重排' })).toBeTruthy();
  });

  it('tells the user how to stop external rerank while it runs', () => {
    const { runtime } = memoryRuntime(memory());
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-reranker-decision-description').textContent).toContain('要停止，把重排改成「本地」或「不用」。');
  });

  it('says in Chinese why the settings cannot be read', async () => {
    const { runtime } = memoryRuntime(memory(), { getMemory: vi.fn(async () => { throw new Error('this client cannot manage Lead memory'); }) });
    runtime.control.setState((state) => ({
      memory: null,
      resourceState: { ...state.resourceState, memory: { state: 'idle', generation: 0, observerCount: 0, lastSuccessAt: null, error: null } },
    }));
    renderWithRuntime(<MemorySection />, runtime);
    await waitFor(() => expect(screen.getByTestId('memory-loading').textContent).toBe('读不到记忆设置：这个版本的客户端不能管理 Paimon 的记忆。'));
  });

  it('says what went wrong when the daemon has no memory controller (503)', async () => {
    const { runtime } = memoryRuntime(memory(), {
      getMemory: vi.fn(async () => { throw new ControlPlaneClientError('记忆设置还没有启动', 'internal_error', 503); }),
    });
    runtime.control.setState((state) => ({
      memory: null,
      resourceState: { ...state.resourceState, memory: { state: 'idle', generation: 0, observerCount: 0, lastSuccessAt: null, error: null } },
    }));
    renderWithRuntime(<MemorySection />, runtime);
    await waitFor(() => expect(screen.getByTestId('memory-loading').textContent).toContain('记忆设置还没有启动'));
  });
});

// 设置 → 记忆的 Hindsight 部分（2026-10-29，.scratch/hindsight-primary-memory/spec.md D3、D13、D16）：
// 摘要模型的两个槽、写入情况。改动是操作层的 memory_settings 操作（performUiAction）。
const HAIKU = 'vibeproxy/claude-haiku-5-5';
const SONNET = 'vibeproxy/claude-sonnet-5-5';

function hindsight(overrides: Partial<MemoryHindsightDto> = {}): MemoryHindsightDto {
  return {
    enabled: true,
    summaryModels: [
      { slot: 'default', model: HAIKU, source: 'auto', setting: null, problem: null },
      { slot: 'consolidation', model: HAIKU, source: 'inherit', setting: null, problem: null },
    ],
    writes: { notes: 12, completed: 10, pending: 2, failed: 0, lastError: null },
    stats: { documents: 10, facts: 48, observations: 9, pendingConsolidation: 3 },
    ...overrides,
  };
}

function brainModel(id: string, name: string, day: number): BrainModel {
  return {
    model: `vibeproxy/${id}`, id, name, image: true, contextWindow: 200_000, efforts: [], defaultEffort: null,
    released: { at: new Date(Date.UTC(2026, 9, day)).toISOString(), source: 'provider' }, blockedUntil: null,
  };
}

// 设置 → 模型的目录：摘要模型的下拉用同一份。
const catalog: ModelSettingsDto = {
  brain: {
    chain: [{ model: SONNET, effort: null }],
    current: { model: SONNET, effort: null },
    providers: [{
      name: 'vibeproxy', baseUrl: 'http://127.0.0.1:8317/v1', api: 'openai-completions', keySet: true, keySource: 'settings', keyHost: '127.0.0.1', problem: null,
      models: [brainModel('claude-sonnet-5-5', 'Claude Sonnet 5.5', 14), brainModel('claude-haiku-5-5', 'Claude Haiku 5.5', 13)],
    }],
  },
  fast: { models: [], chain: [], llmFallback: null, effectiveLlm: null },
  maxBackups: 3,
};

function actionResult(action: string): unknown {
  if (action === 'test_summary_model') return { ok: true, message: `${HAIKU} 可用`, latencyMs: 230 };
  if (action === 'retry_failed_writes') return { summary: '2 条写入失败的笔记重新排队', note: 'Hindsight 会重新处理它们；原因没修好时还会失败' };
  return { summary: `整理观察改成 ${SONNET}`, note: '记忆服务正在重启，几秒里召回只用全文检索' };
}

function hindsightRuntime(dto: MemoryHindsightDto, client: Record<string, ReturnType<typeof vi.fn>> = {}, scheduler?: Scheduler) {
  const fake = {
    getMemoryHindsight: client.getMemoryHindsight ?? vi.fn(async () => dto),
    getModelSettings: client.getModelSettings ?? vi.fn(async () => catalog),
    performUiAction: client.performUiAction ?? vi.fn(async (_type: string, _id: string, action: string) => ({
      target: { type: 'memory_settings', id: 'memory' }, action, result: actionResult(action),
    })),
  };
  const made = memoryRuntime(memory({ service: healthy }), { ...client, ...fake }, scheduler);
  const ready = { state: 'ready' as const, generation: 0, observerCount: 0, lastSuccessAt: 0, error: null };
  made.runtime.control.setState((state) => ({
    memoryHindsight: dto,
    modelSettings: catalog,
    resourceState: { ...state.resourceState, 'memory-hindsight': ready, 'model-settings': ready },
  }));
  return { runtime: made.runtime, client: { ...made.client, ...fake } };
}

const text = (testID: string) => screen.getByTestId(testID).textContent;

describe('the Hindsight rules', () => {
  it('says how each summary model was chosen, and why a choice does not apply', () => {
    const [auto, inherit] = hindsight().summaryModels;
    expect(summarySourceLabel(auto!)).toBe('自动：最新的 haiku');
    expect(summarySourceLabel(inherit!)).toBe('跟缺省一样');
    expect(summarySourceLabel({ ...auto!, source: 'settings', setting: HAIKU })).toBe('你选的');
    expect(summarySourceLabel({ ...auto!, model: null, source: 'none' })).toBe('Hindsight 只召回，不提取新事实');
    expect(summarySlotNote(auto!)).toBeNull();
    // 环境变量盖住设置时说一次：daemon 的原因里已经说了，就只用它的。
    expect(summarySlotNote({ ...auto!, source: 'env' })).toContain('环境变量 PLC_HINDSIGHT_LLM 盖住了这里的选择');
    const covered = `环境变量 PLC_HINDSIGHT_LLM 盖住了这里的选择（${SONNET}）`;
    expect(summarySlotNote({ ...auto!, source: 'env', setting: SONNET, problem: covered })).toBe(covered);
  });

  it('counts the writes, names the last failure, and leaves out the bank numbers when the service does not run', () => {
    const writes = { notes: 1300, completed: 1204, pending: 3, failed: 2, lastError: 'invalid api key' };
    expect(writesLabel(writes)).toBe('写入：完成 1,204、处理中 3、失败 2');
    expect(writesFailedNote(writes)).toBe('2 条笔记没有写进 Hindsight。最近一次的原因：invalid api key');
    expect(writesFailedNote({ ...writes, failed: 0 })).toBeNull();
    expect(bankStatsLabel(hindsight().stats)).toBe('记忆库：事实 48 条 · 观察 9 条 · 3 条事实还没整理');
    expect(bankStatsLabel(null)).toBeNull();
  });
});

describe('the Hindsight part of the memory section', () => {
  beforeEach(() => setViewportWidth(1280));

  it('shows both summary model slots with the model in use and how it was chosen', () => {
    const { runtime } = hindsightRuntime(hindsight());
    renderWithRuntime(<MemorySection />, runtime);
    expect(text('memory-summary-slot-default')).toContain('Claude Haiku 5.5');
    expect(text('memory-summary-slot-default')).toContain('vibeproxy · 自动：最新的 haiku');
    expect(text('memory-summary-slot-consolidation')).toContain('Claude Haiku 5.5');
    expect(text('memory-summary-slot-consolidation')).toContain('vibeproxy · 跟缺省一样');
    expect(text('memory-writes-counts')).toBe('写入：完成 10、处理中 2、失败 0');
    expect(text('memory-bank-stats')).toBe('记忆库：事实 48 条 · 观察 9 条 · 3 条事实还没整理');
    expect(screen.queryByTestId('memory-writes-retry')).toBeNull();
    expect(screen.queryByTestId('memory-hindsight-off')).toBeNull();
  });

  it('says when the environment variable covers the choice, and when no model can summarize', () => {
    const { runtime } = hindsightRuntime(hindsight({
      summaryModels: [
        { slot: 'default', model: null, source: 'none', setting: 'gone/model-x', problem: '服务商 gone 不在设置 → 模型的服务商里（config.json 的 lead.providers）' },
        { slot: 'consolidation', model: null, source: 'none', setting: null, problem: null },
      ],
    }));
    renderWithRuntime(<MemorySection />, runtime);
    expect(text('memory-summary-slot-default')).toContain('没有可用的模型');
    expect(text('memory-summary-slot-default')).toContain('Hindsight 只召回，不提取新事实');
    expect(text('memory-summary-note-default')).toContain('服务商 gone 不在设置 → 模型的服务商里');
    expect(screen.queryByTestId('memory-summary-note-consolidation')).toBeNull();

    const env = hindsightRuntime(hindsight({
      summaryModels: [
        { slot: 'default', model: HAIKU, source: 'env', setting: null, problem: null },
        { slot: 'consolidation', model: HAIKU, source: 'inherit', setting: null, problem: null },
      ],
    }));
    renderWithRuntime(<MemorySection />, env.runtime);
    expect(screen.getAllByTestId('memory-summary-slot-default')[1]!.textContent).toContain('环境变量 PLC_HINDSIGHT_LLM');
    expect(screen.getAllByTestId('memory-summary-note-default')[1]!.textContent).toContain('盖住了这里的选择');
  });

  it('saves a model picked from the Lead catalog with set_summary_model, and says the memory service restarts', async () => {
    const { runtime, client } = hindsightRuntime(hindsight());
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-summary-picker-consolidation-open'));
    expect((await screen.findByTestId('memory-summary-restart-consolidation')).textContent)
      .toBe('改了以后记忆服务会重启，约几秒，期间召回只用全文检索。');
    expect(text('memory-summary-picker-consolidation-option-system')).toContain('跟缺省一样');
    expect(screen.getByTestId('memory-summary-picker-consolidation-option-system').getAttribute('aria-selected')).toBe('true');
    await act(async () => { fireEvent.click(screen.getByTestId(`memory-summary-picker-consolidation-option-${SONNET}`)); });
    expect(client.performUiAction).toHaveBeenCalledWith('memory_settings', 'memory', 'set_summary_model', { input: { slot: 'consolidation', model: SONNET } });
    await waitFor(() => expect(text('memory-summary-message-consolidation')).toBe('已保存。记忆服务正在重启，几秒里召回只用全文检索。'));
    // 改完重取这一份（记忆服务在重启）。
    expect(client.getMemoryHindsight).toHaveBeenCalled();
  });

  it('puts the default slot back to automatic with a null model', async () => {
    const chosen = hindsight({
      summaryModels: [
        { slot: 'default', model: SONNET, source: 'settings', setting: SONNET, problem: null },
        { slot: 'consolidation', model: SONNET, source: 'inherit', setting: null, problem: null },
      ],
    });
    const { runtime, client } = hindsightRuntime(chosen);
    renderWithRuntime(<MemorySection />, runtime);
    expect(text('memory-summary-slot-default')).toContain('你选的');
    fireEvent.click(screen.getByTestId('memory-summary-picker-default-open'));
    const automatic = await screen.findByTestId('memory-summary-picker-default-option-system');
    expect(automatic.textContent).toContain('自动');
    expect(screen.getByTestId(`memory-summary-picker-default-option-${SONNET}`).getAttribute('aria-selected')).toBe('true');
    await act(async () => { fireEvent.click(automatic); });
    expect(client.performUiAction).toHaveBeenCalledWith('memory_settings', 'memory', 'set_summary_model', { input: { slot: 'default', model: null } });
  });

  it('tests the model a slot uses now, and cannot test a slot without a model', async () => {
    const { runtime, client } = hindsightRuntime(hindsight());
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-summary-picker-default-open'));
    const testButton = await screen.findByTestId('memory-summary-test-default');
    await act(async () => { fireEvent.click(testButton); });
    expect(client.performUiAction).toHaveBeenCalledWith('memory_settings', 'memory', 'test_summary_model', { input: { slot: 'default' } });
    await waitFor(() => expect(text('memory-summary-message-default')).toBe('可用 · 230 ms'));
    // 测试只读：不重取。
    expect(client.getMemoryHindsight).not.toHaveBeenCalled();

    const none = hindsightRuntime(hindsight({
      summaryModels: [
        { slot: 'default', model: null, source: 'none', setting: null, problem: null },
        { slot: 'consolidation', model: null, source: 'none', setting: null, problem: null },
      ],
    }));
    renderWithRuntime(<MemorySection />, none.runtime);
    fireEvent.click(screen.getAllByTestId('memory-summary-picker-consolidation-open')[1]!);
    expect(((await screen.findByTestId('memory-summary-test-consolidation')) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows failed writes with the last error, and retries them with retry_failed_writes', async () => {
    const failing = hindsight({ writes: { notes: 12, completed: 10, pending: 0, failed: 2, lastError: 'invalid api key' } });
    const { runtime, client } = hindsightRuntime(failing);
    renderWithRuntime(<MemorySection />, runtime);
    expect(text('memory-writes-counts')).toBe('写入：完成 10、处理中 0、失败 2');
    expect(text('memory-writes-failed')).toBe('2 条笔记没有写进 Hindsight。最近一次的原因：invalid api key');
    await act(async () => { fireEvent.click(screen.getByTestId('memory-writes-retry')); });
    expect(client.performUiAction).toHaveBeenCalledWith('memory_settings', 'memory', 'retry_failed_writes', { input: {} });
    await waitFor(() => expect(text('memory-writes-message')).toBe('2 条写入失败的笔记重新排队。Hindsight 会重新处理它们；原因没修好时还会失败。'));
  });

  it('says the choice waits when the memory backend is not Hindsight, and hides the writes', () => {
    const { runtime } = hindsightRuntime(hindsight({ enabled: false, stats: null }));
    renderWithRuntime(<MemorySection />, runtime);
    expect(text('memory-hindsight-off')).toBe('记忆后端现在不是 Hindsight。这里的选择会存下，启用 Hindsight 以后生效。');
    expect(screen.getByTestId('memory-summary-slot-default')).toBeTruthy();
    expect(screen.queryByTestId('memory-writes')).toBeNull();
  });

  it('hides the Hindsight part while the daemon has no route for it', () => {
    const { runtime } = memoryRuntime(memory());
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-section')).toBeTruthy();
    expect(screen.queryByTestId('memory-hindsight')).toBeNull();
  });

  // daemon 改了摘要模型或写入情况时只推 resource 是 memory 的快照：Hindsight 这一份也要跟着重取。
  it('refetches the Hindsight part when the gateway says memory changed', async () => {
    const timers: Array<() => void> = [];
    const scheduler: Scheduler = { schedule: (callback) => { timers.push(callback); return timers.length; }, cancel: () => {}, now: () => 0 };
    const later = hindsight({ writes: { notes: 12, completed: 11, pending: 0, failed: 1, lastError: 'timeout' } });
    const { runtime, client } = hindsightRuntime(hindsight(), { getMemoryHindsight: vi.fn(async () => later) }, scheduler);
    renderWithRuntime(<MemorySection />, runtime);
    expect(text('memory-writes-counts')).toBe('写入：完成 10、处理中 2、失败 0');
    (runtime as unknown as { activeSessionId: string }).activeSessionId = 'session-1';
    const event: GatewayEvent = {
      protocolVersion: PROTOCOL_VERSION, eventId: 'event-1', seq: 1, type: 'snapshot.required', occurredAt: '2026-10-29T09:00:00.000Z',
      requiredScope: 'tickets:view', audienceBindingId: null, turnId: null, ticketId: null, payload: { resource: 'memory' },
    };
    runtime.handleEvent(event);
    await runtime.whenIdle();
    await act(async () => { timers.splice(0).forEach((run) => run()); });
    await waitFor(() => expect(text('memory-writes-counts')).toBe('写入：完成 11、处理中 0、失败 1'));
    expect(client.getMemoryHindsight).toHaveBeenCalledTimes(1);
    expect(client.getMemory).toHaveBeenCalledTimes(1);
  });
});

// —— 常驻偏好和失效的事实（2026-10-29，.scratch/hindsight-primary-memory/spec.md D5、D15）——
// 用户：「这里不要给用户有什么普通笔记的概念了，这里就是记忆偏好」；「hindsight 的 invalidate 机制要有啊」；不要确认弹窗。

const TIME = /\d{2}-\d{2} \d{2}:\d{2}/;

function preference(id: number, overrides: Partial<CoreMemoryEntryDto> = {}): CoreMemoryEntryDto {
  return {
    id, kind: 'preference', title: `偏好 ${id}`, content: `内容 ${id}`, updatedAt: '2026-10-29T06:00:00.000Z', lastChange: null,
    ...overrides,
  };
}

const leadEdit = (changeId: number, overrides: Partial<NonNullable<CoreMemoryEntryDto['lastChange']>> = {}): NonNullable<CoreMemoryEntryDto['lastChange']> => ({
  changeId, action: 'update', actor: 'lead', reason: '你 10-28 说过以后周报用英文', at: '2026-10-29T06:10:00.000Z',
  undoOf: null, canUndo: true, undoBlocked: null, ...overrides,
});

function preferences(overrides: Partial<MemoryPreferencesDto> = {}): MemoryPreferencesDto {
  return {
    entries: [
      preference(3, { kind: 'profile', title: '住址', content: '住在杭州，西湖区。' }),
      preference(12, { title: '周报语言', content: '周报用英文写。', lastChange: leadEdit(30) }),
    ],
    used: 312,
    cap: 4000,
    ...overrides,
  };
}

function fact(memoryId: string, overrides: Partial<MemoryInvalidatedFactDto> = {}): MemoryInvalidatedFactDto {
  return {
    memoryId, text: '用户住在上海', note: { id: 3, title: '住址' }, external: false, reason: '你 10-29 说搬到了杭州',
    actor: 'lead', at: '2026-10-29T07:00:00.000Z', ...overrides,
  };
}

const LEAD_PROFILE = { name: 'Fairy', persona: '', interactionStyle: '', updatedAt: null, updatedBy: null };

// 已经读好常驻偏好和 Hindsight 那一份的运行时。performUiAction 缺省成功，结果照 daemon 的样子。
function preferencesRuntime(
  dto: MemoryPreferencesDto | null,
  client: Record<string, ReturnType<typeof vi.fn>> = {},
  hindsightDto: MemoryHindsightDto = hindsight(),
  scheduler?: Scheduler,
) {
  const fake = {
    ...(dto ? { getMemoryPreferences: client.getMemoryPreferences ?? vi.fn(async () => dto) } : {}),
    performUiAction: client.performUiAction ?? vi.fn(async (type: string, id: string, action: string) => ({
      target: { type, id }, action,
      result: type === 'core_memory' ? { id: Number(id), change: { id: 31 }, eventSeq: null } : { ok: true },
    })),
  };
  const made = hindsightRuntime(hindsightDto, { ...client, ...fake }, scheduler);
  const ready = { state: 'ready' as const, generation: 0, observerCount: 0, lastSuccessAt: 0, error: null };
  made.runtime.control.setState((state) => ({
    leadProfile: LEAD_PROFILE,
    ...(dto ? { memoryPreferences: dto, resourceState: { ...state.resourceState, 'memory-preferences': ready } } : {}),
  }));
  return { runtime: made.runtime, client: { ...made.client, ...fake } };
}

async function openMenu(id: number) {
  fireEvent.click(screen.getByTestId(`memory-preference-more-${id}`));
  return screen.findByTestId(`memory-preference-more-${id}-panel`);
}

describe('the standing preference rules', () => {
  it('says who changed an entry, when, and why, with the Lead name', () => {
    const entry = preference(12, { lastChange: leadEdit(30) });
    expect(preferenceChangeLine(entry, 'Fairy')).toMatch(new RegExp(`^Fairy 改的 · ${TIME.source}$`));
    expect(preferenceReasonLine(entry)).toBe('依据：你 10-28 说过以后周报用英文');
    const mine = preference(12, { lastChange: leadEdit(30, { actor: 'user', reason: '在设置页改了常驻偏好' }) });
    expect(preferenceChangeLine(mine, 'Fairy')).toMatch(/^你改的 · /);
    // 你自己改的依据是系统的默认说法，不写。
    expect(preferenceReasonLine(mine)).toBeNull();
    expect(preferenceChangeLine(preference(12, { lastChange: leadEdit(31, { action: 'create', undoOf: 30 }) }), 'Fairy')).toMatch(/^Fairy 撤销了上一次改动 · /);
    expect(preferenceChangeLine(preference(3), 'Fairy')).toMatch(/^最后修改 · /);
  });

  it('counts the characters, and says so in words when the space is full', () => {
    expect(preferencesUsageLabel({ used: 312, cap: 4000 })).toBe('已用 312 / 4,000 字');
    expect(preferencesUsageLabel({ used: 4000, cap: 4000 })).toBe('已用 4,000 / 4,000 字 · 写满了');
  });

  it('checks the form like the operation does, and sends only the fields that changed', () => {
    expect(preferenceFormProblem({ title: '  ', content: 'x' })).toBe('标题不能是空的。');
    expect(preferenceFormProblem({ title: 'x', content: '\n' })).toBe('内容不能是空的。');
    expect(preferenceFormProblem({ title: 'x'.repeat(201), content: 'x' })).toBe('标题最多 200 个字。');
    expect(preferenceFormProblem({ title: 'x', content: 'x'.repeat(4001) })).toBe('内容最多 4,000 个字。');
    const entry = preference(12, { title: '周报语言', content: '周报用英文写。' });
    expect(preferenceUpdateInput(entry, { title: '周报语言 ', content: '周报用中文写。' })).toEqual({ content: '周报用中文写。' });
    expect(preferenceUpdateInput(entry, { title: '周报', content: '周报用英文写。' })).toEqual({ title: '周报' });
    expect(preferenceUpdateInput(entry, { title: '周报语言', content: ' 周报用英文写。' })).toBeNull();
    expect(changeIdOf({ id: 12, change: { id: 31 }, eventSeq: null })).toBe(31);
    expect(changeIdOf({ id: 12, change: null, eventSeq: null })).toBeNull();
  });

  it('names where an invalidated fact came from, without calling it a note', () => {
    expect(invalidatedFactSource(fact('m1'))).toBe('来自：住址');
    expect(invalidatedFactSource(fact('m1', { external: true }))).toBe('来自外部对话：住址');
    expect(invalidatedFactSource(fact('m1', { note: null, external: true }))).toBe('来自外部对话');
    expect(invalidatedFactSource(fact('m1', { note: null }))).toBeNull();
  });
});

describe('the standing preferences card', () => {
  beforeEach(() => setViewportWidth(1280));

  it('lists each preference with who changed it last, when and why, and the characters used', () => {
    const { runtime } = preferencesRuntime(preferences());
    renderWithRuntime(<MemorySection />, runtime);
    const card = screen.getByTestId('memory-preferences');
    expect(text('memory-preference-title-3')).toBe('住址');
    expect(text('memory-preference-content-3')).toBe('住在杭州，西湖区。');
    expect(text('memory-preference-change-3')).toMatch(/^最后修改 · /);
    expect(screen.queryByTestId('memory-preference-reason-3')).toBeNull();
    expect(text('memory-preference-title-12')).toBe('周报语言');
    expect(text('memory-preference-change-12')).toMatch(new RegExp(`^Fairy 改的 · ${TIME.source}$`));
    expect(text('memory-preference-reason-12')).toBe('依据：你 10-28 说过以后周报用英文');
    expect(text('memory-preferences-usage')).toBe('已用 312 / 4,000 字');
    expect(text('memory-preferences-effect')).toBe('改动从 Fairy 下一次开新会话或压缩上下文时起生效。');
    expect(screen.getByText('Fairy 做每件事时都参考这些偏好。它发现和你最近说的话有出入时，会自己改，并在会话里告诉你。你可以撤销。')).toBeTruthy();
    // 用户：这里就是记忆偏好，不出现笔记的概念。
    expect(card.textContent).not.toMatch(/笔记|note|kind|fact/i);
    // 偏好在 Hindsight 前面。
    expect(card.compareDocumentPosition(screen.getByTestId('memory-hindsight')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the actions in the more menu, and never asks for a confirmation', async () => {
    const { runtime } = preferencesRuntime(preferences());
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.queryByTestId('memory-preference-edit-12')).toBeNull();
    const menu = await openMenu(12);
    expect(within(menu).getByTestId('memory-preference-edit-12').textContent).toContain('改');
    expect(within(menu).getByTestId('memory-preference-delete-12').textContent).toContain('删掉');
    expect(within(menu).getByTestId('memory-preference-undo-12').textContent).toContain('撤销上一次改动');
    expect(menu.textContent).not.toMatch(/笔记/);
  });

  it('edits a preference in place and saves only the changed field with core_memory update', async () => {
    const after = preferences({
      entries: [preferences().entries[0]!, preference(12, { title: '周报语言', content: '周报用中文写。', lastChange: leadEdit(32, { actor: 'user', reason: '在设置页改了常驻偏好' }) })],
    });
    const getMemoryPreferences = vi.fn(async () => after);
    const { runtime, client } = preferencesRuntime(preferences(), { getMemoryPreferences });
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(within(await openMenu(12)).getByTestId('memory-preference-edit-12'));
    const content = await screen.findByTestId('memory-preference-content-input-12');
    fireEvent.change(content, { target: { value: '周报用中文写。' } });
    await act(async () => { fireEvent.click(screen.getByTestId('memory-preference-save-12')); });
    expect(client.performUiAction).toHaveBeenCalledWith('core_memory', '12', 'update', { input: { content: '周报用中文写。' } });
    // 改完重取常驻偏好。
    await waitFor(() => expect(text('memory-preference-content-12')).toBe('周报用中文写。'));
    expect(getMemoryPreferences).toHaveBeenCalled();
    expect(text('memory-preference-message-12')).toBe('已保存。');
    expect(text('memory-preference-change-12')).toMatch(/^你改的 · /);
  });

  it('shows why a save failed, word for word, and keeps the form open', async () => {
    const tooLong = new ControlPlaneClientError('常驻偏好一共最多 4000 字，改完是 4120 字。请先删短一些。', 'invalid_input', 400);
    const { runtime } = preferencesRuntime(preferences(), { performUiAction: vi.fn(async () => { throw tooLong; }) });
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(within(await openMenu(12)).getByTestId('memory-preference-edit-12'));
    fireEvent.change(await screen.findByTestId('memory-preference-content-input-12'), { target: { value: '很长的内容' } });
    await act(async () => { fireEvent.click(screen.getByTestId('memory-preference-save-12')); });
    await waitFor(() => expect(text('memory-preference-message-12')).toBe('常驻偏好一共最多 4000 字，改完是 4120 字。请先删短一些。'));
    expect(screen.getByTestId('memory-preference-content-input-12')).toBeTruthy();
  });

  it('checks an empty title before it calls the operation', async () => {
    const { runtime, client } = preferencesRuntime(preferences());
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(within(await openMenu(3)).getByTestId('memory-preference-edit-3'));
    fireEvent.change(await screen.findByTestId('memory-preference-title-input-3'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('memory-preference-save-3'));
    expect(text('memory-preference-message-3')).toBe('标题不能是空的。');
    expect(client.performUiAction).not.toHaveBeenCalled();
  });

  it('deletes right away with core_memory delete, then offers to undo it in place', async () => {
    const without = preferences({ entries: [preferences().entries[1]!], used: 200 });
    const getMemoryPreferences = vi.fn(async () => without);
    const { runtime, client } = preferencesRuntime(preferences(), { getMemoryPreferences });
    renderWithRuntime(<MemorySection />, runtime);
    const menu = await openMenu(3);
    await act(async () => { fireEvent.click(within(menu).getByTestId('memory-preference-delete-3')); });
    expect(client.performUiAction).toHaveBeenCalledWith('core_memory', '3', 'delete', { input: {} });
    const removed = await screen.findByTestId('memory-preference-removed-3');
    expect(removed.textContent).toContain('住址');
    expect(removed.textContent).toContain('已删掉');
    // 删掉的那一行留在原来的位置（第一行）。
    expect(removed.compareDocumentPosition(screen.getByTestId('memory-preference-12')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByTestId('memory-preference-restore-3')); });
    // 撤销用删除那次改动的编号。
    expect(client.performUiAction).toHaveBeenLastCalledWith('core_memory_change', '31', 'undo', { input: {} });
    await waitFor(() => expect(screen.queryByTestId('memory-preference-removed-3')).toBeNull());
  });

  it('undoes the last change with core_memory_change undo, and shows the 409 reason word for word', async () => {
    const performUiAction = vi.fn(async (type: string, id: string, action: string) => ({ target: { type, id }, action, result: { ok: true } }));
    const { runtime, client } = preferencesRuntime(preferences(), { performUiAction });
    renderWithRuntime(<MemorySection />, runtime);
    const menu = await openMenu(12);
    await act(async () => { fireEvent.click(within(menu).getByTestId('memory-preference-undo-12')); });
    expect(client.performUiAction).toHaveBeenCalledWith('core_memory_change', '30', 'undo', { input: {} });
    await waitFor(() => expect(text('memory-preference-message-12')).toBe('已撤销上一次改动。'));

    performUiAction.mockRejectedValueOnce(new ControlPlaneClientError('这次改动之后这一条又改过，不能撤销这一次。', 'unavailable', 409));
    const again = await openMenu(12);
    await act(async () => { fireEvent.click(within(again).getByTestId('memory-preference-undo-12')); });
    await waitFor(() => expect(text('memory-preference-message-12')).toBe('这次改动之后这一条又改过，不能撤销这一次。'));
  });

  it('shows why the last change cannot be undone, and does not let you press it', async () => {
    const blocked = preferences({
      entries: [preference(12, { lastChange: leadEdit(30, { canUndo: false, undoBlocked: '这次改动已经撤销过了' }) })],
    });
    const { runtime, client } = preferencesRuntime(blocked);
    renderWithRuntime(<MemorySection />, runtime);
    const undo = within(await openMenu(12)).getByTestId('memory-preference-undo-12');
    expect(undo.textContent).toContain('这次改动已经撤销过了');
    expect(undo.getAttribute('role')).not.toBe('button');
    fireEvent.click(undo);
    expect(client.performUiAction).not.toHaveBeenCalled();
  });

  it('says what goes here when there is nothing yet, and when the space is full', () => {
    const { runtime } = preferencesRuntime(preferences({ entries: [], used: 0 }));
    renderWithRuntime(<MemorySection />, runtime);
    expect(text('memory-preferences-empty')).toBe('还没有常驻偏好。Fairy 发现你长期的习惯和偏好时，会记在这里。');

    const full = preferencesRuntime(preferences({ used: 4000 }));
    renderWithRuntime(<MemorySection />, full.runtime);
    expect(screen.getAllByTestId('memory-preferences-usage')[1]!.textContent).toBe('已用 4,000 / 4,000 字 · 写满了');
  });

  it('hides the card while the daemon has no preferences route', async () => {
    const { runtime } = preferencesRuntime(null);
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.getByTestId('memory-hindsight')).toBeTruthy();
    expect(screen.queryByTestId('memory-preferences')).toBeNull();

    // daemon 比网页旧：路由回 404，记成不支持，这一块不显示，也不写报错。
    const missing = new ControlPlaneClientError('not found', 'not_found', 404);
    const getMemoryPreferences = vi.fn(async () => { throw missing; });
    const old = hindsightRuntime(hindsight(), { getMemoryPreferences });
    renderWithRuntime(<MemorySection />, old.runtime);
    await waitFor(() => expect(getMemoryPreferences).toHaveBeenCalled());
    await act(async () => { await old.runtime.whenIdle(); });
    expect(screen.queryByTestId('memory-preferences')).toBeNull();
    expect(screen.queryByTestId('memory-preferences-error')).toBeNull();
  });

  // Lead 改了常驻偏好时 daemon 只推 resource 是 memory 的快照：常驻偏好这一份也要跟着重取。
  it('refetches the preferences when the gateway says memory changed', async () => {
    const timers: Array<() => void> = [];
    const scheduler: Scheduler = { schedule: (callback) => { timers.push(callback); return timers.length; }, cancel: () => {}, now: () => 0 };
    const later = preferences({ entries: [preference(12, { title: '周报语言', content: '周报用中文写。', lastChange: leadEdit(33) })] });
    const getMemoryPreferences = vi.fn(async () => later);
    const { runtime } = preferencesRuntime(preferences(), { getMemoryPreferences }, hindsight(), scheduler);
    renderWithRuntime(<MemorySection />, runtime);
    expect(text('memory-preference-content-12')).toBe('周报用英文写。');
    (runtime as unknown as { activeSessionId: string }).activeSessionId = 'session-1';
    const event: GatewayEvent = {
      protocolVersion: PROTOCOL_VERSION, eventId: 'event-2', seq: 2, type: 'snapshot.required', occurredAt: '2026-10-29T09:00:00.000Z',
      requiredScope: 'tickets:view', audienceBindingId: null, turnId: null, ticketId: null, payload: { resource: 'memory' },
    };
    runtime.handleEvent(event);
    await runtime.whenIdle();
    await act(async () => { timers.splice(0).forEach((run) => run()); });
    await waitFor(() => expect(text('memory-preference-content-12')).toBe('周报用中文写。'));
    expect(getMemoryPreferences).toHaveBeenCalledTimes(1);
  });
});

describe('the invalidated facts in the Hindsight part', () => {
  beforeEach(() => setViewportWidth(1280));

  const invalidated = [
    fact('mem-1'),
    fact('mem-2', { text: 'Bob 说下周三开会', note: { id: 40, title: 'Slack #proj 记下的事' }, external: true, actor: 'user', reason: '会议取消了' }),
  ];

  it('stays folded with a count, and lists the text, source, reason, who and when when opened', () => {
    const { runtime } = preferencesRuntime(preferences(), {}, hindsight({ invalidated }));
    renderWithRuntime(<MemorySection />, runtime);
    expect(text('memory-invalidated-count')).toBe('2 条');
    expect(screen.queryByTestId('memory-fact-mem-1')).toBeNull();
    fireEvent.click(screen.getByTestId('memory-invalidated-toggle'));
    expect(text('memory-fact-text-mem-1')).toBe('「用户住在上海」');
    expect(text('memory-fact-meta-mem-1')).toMatch(new RegExp(`^Fairy 让它失效 · ${TIME.source} · 来自：住址$`));
    expect(text('memory-fact-reason-mem-1')).toBe('依据：你 10-29 说搬到了杭州');
    expect(text('memory-fact-meta-mem-2')).toMatch(/^你让它失效 · .* · 来自外部对话：Slack #proj 记下的事$/);
    expect(screen.getByTestId('memory-invalidated').textContent).not.toMatch(/笔记/);
  });

  it('restores a fact with memory_fact restore, and shows why it failed', async () => {
    const restored = hindsight({ invalidated: [invalidated[1]!] });
    const getMemoryHindsight = vi.fn(async () => restored);
    const { runtime, client } = preferencesRuntime(preferences(), { getMemoryHindsight }, hindsight({ invalidated }));
    renderWithRuntime(<MemorySection />, runtime);
    fireEvent.click(screen.getByTestId('memory-invalidated-toggle'));
    await act(async () => { fireEvent.click(screen.getByTestId('memory-fact-restore-mem-1')); });
    expect(client.performUiAction).toHaveBeenCalledWith('memory_fact', 'mem-1', 'restore', { input: {} });
    await waitFor(() => expect(screen.queryByTestId('memory-fact-mem-1')).toBeNull());
    expect(text('memory-invalidated-count')).toBe('1 条');

    (client.performUiAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ControlPlaneClientError('Hindsight 没有在运行，现在不能恢复。', 'unavailable', 409));
    await act(async () => { fireEvent.click(screen.getByTestId('memory-fact-restore-mem-2')); });
    await waitFor(() => expect(text('memory-fact-error-mem-2')).toBe('Hindsight 没有在运行，现在不能恢复。'));
  });

  it('draws nothing when no fact is invalidated', () => {
    const { runtime } = preferencesRuntime(preferences(), {}, hindsight({ invalidated: [] }));
    renderWithRuntime(<MemorySection />, runtime);
    expect(screen.queryByTestId('memory-invalidated')).toBeNull();
  });
});
