import type { ConnectionDto } from '@pi-lead-child/protocol';
import { act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import { CompanionRuntimeProvider } from '../src/state/CompanionStateProvider';
import { connectionAttention, createCompanionStateRuntime, type CompanionRuntimeDependencies } from '../src/state/runtime';
import { renderUI } from './render';

// 连接页和会话连接卡的测试数据。只能在 jsdom 环境的测试里用；测试文件自己 mock expo-crypto 和 expo-router。

export function connection(overrides: Partial<ConnectionDto> & Pick<ConnectionDto, 'key'>): ConnectionDto {
  return {
    provider: 'notion',
    label: 'Notion',
    capability: '搜索和读 Notion 页面，建页面和改页面',
    serverUrl: 'https://mcp.notion.com/mcp',
    state: 'not_connected',
    account: null,
    tokenSource: null,
    connectedAt: null,
    lastUsedAt: null,
    lastRefreshAt: null,
    accessExpiresAt: null,
    grantExpiresAt: null,
    problem: null,
    tools: null,
    roles: ['lead', 'executor', 'reviewer'],
    writePolicy: 'confirm',
    setupHint: null,
    ...overrides,
  };
}

export type FakeConnectionClient = {
  listConnections: ReturnType<typeof vi.fn>;
  startConnection: ReturnType<typeof vi.fn>;
  addCustomConnection: ReturnType<typeof vi.fn>;
  connectionFlow: ReturnType<typeof vi.fn>;
  updateConnectionSettings: ReturnType<typeof vi.fn>;
  testConnection: ReturnType<typeof vi.fn>;
  disconnectConnection: ReturnType<typeof vi.fn>;
  connectionTools: ReturnType<typeof vi.fn>;
  connectionConfirmation: ReturnType<typeof vi.fn>;
  resolveConnectionConfirmation: ReturnType<typeof vi.fn>;
};

// 一个已经配对、连接列表已经读好的运行时。client 里没给的方法是不会返回的 vi.fn。
export function connectionsRuntime(items: ConnectionDto[], client: Partial<FakeConnectionClient> = {}) {
  const fake: FakeConnectionClient = {
    listConnections: vi.fn(async () => ({ items, attention: connectionAttention(items) })),
    startConnection: vi.fn(() => new Promise(() => {})),
    addCustomConnection: vi.fn(() => new Promise(() => {})),
    connectionFlow: vi.fn(async (flowId: string) => ({ flowId, state: 'pending', message: null, connection: null })),
    updateConnectionSettings: vi.fn(async (key: string) => items.find((item) => item.key === key)),
    testConnection: vi.fn(() => new Promise(() => {})),
    disconnectConnection: vi.fn(async (key: string) => ({ ...items.find((item) => item.key === key)!, state: 'not_connected' })),
    connectionTools: vi.fn(async () => []),
    connectionConfirmation: vi.fn(() => new Promise(() => {})),
    resolveConnectionConfirmation: vi.fn(() => new Promise(() => {})),
    ...client,
  };
  const runtime = createCompanionStateRuntime({
    client: fake as unknown as CompanionRuntimeDependencies['client'],
    credentials: {} as CompanionRuntimeDependencies['credentials'],
    scheduler: { schedule: () => 0, cancel: () => {}, now: () => 0 },
  });
  // 配对凭证带的 scope。真实运行时来自 credentials.load()。
  (runtime as unknown as { scopes: Set<string> }).scopes = new Set(['chat', 'tickets:view', 'tickets:create', 'approvals:respond']);
  runtime.control.setState((state) => ({
    phase: 'ready',
    connectionState: 'connected',
    connections: { items, attention: connectionAttention(items) },
    resourceState: {
      ...state.resourceState,
      connections: { state: 'ready', generation: 0, observerCount: 0, lastSuccessAt: 0, error: null },
    },
  }));
  return { runtime, client: fake };
}

export function renderWithRuntime(element: ReactElement, runtime: ReturnType<typeof connectionsRuntime>['runtime']) {
  return renderUI(<CompanionRuntimeProvider runtime={runtime}>{element}</CompanionRuntimeProvider>);
}

export function setViewportWidth(width: number) {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 });
  act(() => { window.dispatchEvent(new Event('resize')); });
}

// 一个手动结束的 Promise：测试在请求发出、还没回来的那一刻检查界面。
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
