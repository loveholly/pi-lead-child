// @vitest-environment jsdom
// 用户发的消息不能悄悄丢掉（2026-10-16：Mac 合盖睡眠时发的 3 条消息从来没到 daemon，重新加载以后就没了）。
// 每条消息先进本地发件箱（web 是 localStorage，原生应用是文件），再上网络。断线时输入框照样能用，
// 消息显示「待发送 · 连接恢复后发送」；连上以后按顺序发出，显示「已送达」。服务端拒收的显示「没有发出去」，
// 带「重试」和「删除」。重新加载以后，没发出去的还在，连上就发。
import { PROTOCOL_VERSION, type ConversationTurn, type HelloV2 } from '@pi-lead-child/protocol';
import {
  ControlPlaneClientError, createJsonOutboxStorage, type ConnectionHandlers, type ConnectionState,
  type ControlPlaneCredentials, type KeyValueStorage,
} from '@pi-lead-child/client';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import { CompanionRuntimeProvider } from '../../state/CompanionStateProvider';
import { createCompanionStateRuntime, type CompanionTransport } from '../../state/runtime';
import { LeadConversation, latestSentMessageKey } from './LeadConversation';

// 顶栏的状态点、「正在回复」的转圈是 Reanimated 的循环动画。jsdom 里它们在组件卸载以后还在按帧更新，
// 报未处理的错误。这些测试不看动画：在任何模块加载之前让动画帧不再触发。
vi.hoisted(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});
vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const binding = { id: 7, kind: 'companion', name: 'web', scopes: ['chat'] } as ControlPlaneCredentials['binding'];
const credentials: ControlPlaneCredentials = { baseUrl: 'http://daemon.test', accessToken: 'secret', binding, lastSeq: 0 };

const hello: HelloV2 = {
  type: 'hello.v2', protocolVersion: PROTOCOL_VERSION, serverTime: '2026-10-16T01:00:00.000Z', timezone: 'Asia/Shanghai',
  latestSeq: 0, capabilities: ['chat.client-message-id.v1'], binding,
  daemon: { model: 'stub', sessionId: 'lead-session', busy: false },
};

function memoryKeyValue(): KeyValueStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
  };
}

// 网关替身：只有 chat scope。connect 以后先连上，再按 setState 改连接状态。
// 送达的消息像真的 daemon 一样成为会话里的一轮：之后取会话快照时它还在。
function gateway(send: CompanionTransport['sendChatCommand']) {
  let handlers: ConnectionHandlers = {};
  const turns: ConversationTurn[] = [];
  const client = {
    getConversationTurns: vi.fn(async () => turns.map((turn) => ({ ...turn }))),
    connect: vi.fn(async (next: ConnectionHandlers = {}) => {
      handlers = next;
      handlers.onHello?.(hello);
      handlers.onStateChange?.('connected');
    }),
    disconnect: vi.fn(),
    setPresence: vi.fn(),
    forget: vi.fn(async () => {}),
    sendChatCommand: vi.fn(async (input: Parameters<CompanionTransport['sendChatCommand']>[0], signal?: AbortSignal) => {
      const result = await send(input, signal);
      const at = '2026-10-16T01:10:00.000Z';
      turns.push({
        id: result.turnId, originBindingId: binding.id, originKind: 'paired:companion', ticketId: null, state: 'completed',
        userText: input.message, assistantText: '', error: null, createdAt: at, updatedAt: at,
      });
      return result;
    }),
  } as unknown as CompanionTransport & { sendChatCommand: ReturnType<typeof vi.fn> };
  return {
    client,
    setState: (state: ConnectionState) => act(() => { handlers.onStateChange?.(state); }),
  };
}

async function mount(storage: KeyValueStorage, send: CompanionTransport['sendChatCommand']) {
  const { client, setState } = gateway(send);
  const runtime = createCompanionStateRuntime({
    client,
    credentials: { load: async () => credentials, save: async () => {}, clear: async () => {} },
    scheduler: { schedule: (callback, delayMs) => setTimeout(callback, delayMs), cancel: (handle) => clearTimeout(handle as never), now: () => Date.now() },
    outboxStorage: createJsonOutboxStorage(storage),
  });
  await act(async () => { await runtime.start(); });
  renderUI(<CompanionRuntimeProvider runtime={runtime}><LeadConversation /></CompanionRuntimeProvider>);
  return { runtime, client, setState };
}

async function type(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } });
  });
  await act(async () => { fireEvent.click(screen.getByTestId('send-message')); });
}

// 这条用户消息气泡下面的发送状态。消息文字由 Markdown 渲染，会拆成几个元素，所以按整条消息的文字找。
function userMessage(text: string): HTMLElement | null {
  return screen.queryAllByTestId('user-message').find((element) => element.textContent?.includes(text)) ?? null;
}

function bubbleStatus(text: string): string | null {
  const bubble = userMessage(text);
  return bubble ? within(bubble).queryByTestId('outbox-status')?.textContent ?? null : null;
}

describe('the outbox in the Lead conversation', () => {
  it('keeps the composer usable while reconnecting, and sends the message once the link is back', async () => {
    const storage = memoryKeyValue();
    const { client, setState } = await mount(storage, async () => ({ turnId: 'turn-1' }));
    setState('reconnecting');

    expect(screen.getByTestId('composer-input').hasAttribute('disabled')).toBe(false);
    await type('合盖前最后一条');
    expect(bubbleStatus('合盖前最后一条')).toBe('待发送 · 连接恢复后发送');
    expect(client.sendChatCommand).not.toHaveBeenCalled();
    // 它已经写进本地存储了。
    expect(storage.values.get('pi-lead-child.chat-outbox.v1')).toContain('合盖前最后一条');

    setState('connected');
    await vi.waitFor(() => expect(client.sendChatCommand).toHaveBeenCalledTimes(1));
    expect(client.sendChatCommand.mock.calls[0]![0]).toMatchObject({ message: '合盖前最后一条', clientMessageId: expect.any(String) });
    await vi.waitFor(() => expect(bubbleStatus('合盖前最后一条')).toBe('已送达'));
    expect(storage.values.has('pi-lead-child.chat-outbox.v1')).toBe(false);
  });

  // 2026-10-25：带图片的消息。发件箱里的消息马上连图片一起画出来；送达以后图片还是本机的那份，不用再向 daemon 取。
  it('shows a message with its images while it waits, and keeps the images once it is delivered', async () => {
    const storage = memoryKeyValue();
    const { client, runtime, setState } = await mount(storage, async () => ({ turnId: 'turn-1' }));
    setState('reconnecting');
    const image = { mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' };
    await act(async () => { await runtime.sendChat('看这张图', undefined, undefined, [image]); });
    const src = () => userMessage('看这张图')?.querySelector('img')?.getAttribute('src');
    expect(src()).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(storage.values.get('pi-lead-child.chat-outbox.v1')).toContain('iVBORw0KGgo=');

    setState('connected');
    await vi.waitFor(() => expect(client.sendChatCommand).toHaveBeenCalledTimes(1));
    expect(client.sendChatCommand.mock.calls[0]![0]).toMatchObject({ message: '看这张图', images: [image] });
    await vi.waitFor(() => expect(bubbleStatus('看这张图')).toBe('已送达'));
    expect(src()).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('shows a refused message as failed, with retry and delete', async () => {
    const storage = memoryKeyValue();
    const send = vi.fn(async () => { throw new ControlPlaneClientError('missing scope: chat', 'forbidden'); });
    const { client, runtime } = await mount(storage, send);

    await type('发不出去的');
    expect(userMessage('发不出去的')).not.toBeNull();
    await vi.waitFor(() => expect(screen.getByText(/没有发出去/)).toBeTruthy());
    const card = screen.getByTestId('failure-card');
    expect(within(card).getByRole('button', { name: '重试' })).toBeTruthy();
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: '重试' })); });
    await vi.waitFor(() => expect(client.sendChatCommand).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(within(screen.getByTestId('failure-card')).getByRole('button', { name: '删除' })).toBeTruthy());
    await act(async () => { fireEvent.click(within(screen.getByTestId('failure-card')).getByRole('button', { name: '删除' })); });
    await act(async () => { await runtime.whenIdle(); });
    expect(userMessage('发不出去的')).toBeNull();
    expect(storage.values.has('pi-lead-child.chat-outbox.v1')).toBe(false);
  });

  it('keeps an unsent message across a reload and sends it once the link is back', async () => {
    const storage = memoryKeyValue();
    const first = await mount(storage, async () => ({ turnId: 'turn-1' }));
    first.setState('reconnecting');
    await type('睡眠时写的');
    const stored = JSON.parse(storage.values.get('pi-lead-child.chat-outbox.v1')!) as Array<{ clientMessageId: string }>;
    act(() => first.runtime.stop());

    // 重新加载：内存里的都没了，本地存储里的还在。这次一连上就发。
    cleanup();
    const second = await mount(storage, async () => ({ turnId: 'turn-9' }));
    await vi.waitFor(() => expect(second.client.sendChatCommand).toHaveBeenCalledTimes(1));
    expect(second.client.sendChatCommand.mock.calls[0]![0]).toMatchObject({
      message: '睡眠时写的', clientMessageId: stored[0]!.clientMessageId,
    });
    await vi.waitFor(() => expect(bubbleStatus('睡眠时写的')).toBe('已送达'));
  });
});

// 会话列表的 ChatScroll 在「你刚发了消息」时回到底部（followKey）。断线时发的消息也算；
// 它后来送达、本地消息换成那一轮的消息时，不算又发了一条：你往上翻了就不把你拽回来。
describe('the follow key of the conversation list', () => {
  it('changes when you send, also offline, and stays when the message is delivered', async () => {
    const storage = memoryKeyValue();
    const { runtime, setState } = await mount(storage, async () => ({ turnId: 'turn-1' }));
    const key = () => {
      const state = runtime.control.getState();
      const ids = state.messageIdsBySession['lead-session'] ?? [];
      return latestSentMessageKey(ids.flatMap((id) => state.messagesById[id] ? [state.messagesById[id]!] : []));
    };
    const before = key();
    setState('reconnecting');
    await type('断线时发的');
    const sent = key();
    expect(sent).not.toBe(before);
    expect(sent).not.toBeNull();

    setState('connected');
    await vi.waitFor(() => expect(bubbleStatus('断线时发的')).toBe('已送达'));
    expect(key()).toBe(sent);
  });
});
