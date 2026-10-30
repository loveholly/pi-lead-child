// 用户发的每条消息先进本地发件箱，再上网络（2026-10-16：3 条消息只活在内存里，重新加载就没了）。
// 发件箱按顺序一条一条发；断线时等连上，临时错误退避重试；重启以后还没发出的照样在，连上就发。
import { describe, expect, it, vi } from 'vitest';

import { ChatOutbox, createJsonOutboxStorage, type OutboxEntry, type OutboxStorage } from '../src/chatOutbox.ts';
import { ControlPlaneClientError } from '../src/controlPlaneClient.ts';

class MemoryStorage implements OutboxStorage {
  saved: OutboxEntry[] = [];
  saves = 0;
  async load() { return this.saved.map((entry) => ({ ...entry })); }
  async save(entries: OutboxEntry[]) { this.saves += 1; this.saved = entries.map((entry) => ({ ...entry })); }
}

function harness(options: { connected?: boolean; storage?: MemoryStorage } = {}) {
  const storage = options.storage ?? new MemoryStorage();
  const timers: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  let connected = options.connected ?? true;
  let counter = 0;
  const sends: OutboxEntry[] = [];
  const results: Array<(outcome: { turnId: string } | Error) => void> = [];
  const delivered: OutboxEntry[] = [];
  const outbox = new ChatOutbox({
    storage,
    isConnected: () => connected,
    createId: () => `msg_${++counter}`,
    now: () => new Date('2026-10-16T01:00:00.000Z'),
    setTimer: (callback, delayMs) => { timers.push({ callback, delayMs, cleared: false }); return timers.length - 1; },
    clearTimer: (handle) => { const timer = timers[handle as number]; if (timer) timer.cleared = true; },
    send: (entry) => new Promise((resolve, reject) => {
      sends.push({ ...entry });
      results.push((outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)));
    }),
    onDelivered: (entry) => delivered.push({ ...entry }),
  });
  return {
    outbox, storage, timers, sends, delivered,
    answer: async (outcome: { turnId: string } | Error) => { results.shift()!(outcome); await flushPromises(); },
    setConnected: (value: boolean) => { connected = value; },
    states: () => outbox.entries().map((entry) => `${entry.message}:${entry.state}`),
  };
}

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ChatOutbox', () => {
  it('saves a message before it goes to the network', async () => {
    const h = harness();
    await h.outbox.load();
    const entry = await h.outbox.enqueue('在吗');
    expect(entry).toMatchObject({ clientMessageId: 'msg_1', message: '在吗', ticketId: null });
    expect(h.storage.saved.map((saved) => saved.message)).toEqual(['在吗']);
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    expect(h.sends[0]!.clientMessageId).toBe('msg_1');
  });

  // 工单 04：Lead 正忙时选了排队的消息，重发、重新加载以后照样按排队发；旧版本存下的条目没有它，照旧按插话发。
  it('keeps the placement the user chose across a reload, and reads entries saved without one', async () => {
    const storage = new MemoryStorage();
    const first = harness({ storage, connected: false });
    await first.outbox.load();
    await first.outbox.enqueue('排队问一句', undefined, 'followUp');
    expect(storage.saved[0]).toMatchObject({ message: '排队问一句', mode: 'followUp' });
    storage.saved.push({
      clientMessageId: 'old_1', message: '旧条目', ticketId: null, createdAt: '2026-10-16T00:59:00.000Z',
      state: 'pending', attempts: 0, error: null, turnId: null,
    });

    const reloaded = harness({ storage });
    await reloaded.outbox.load();
    await vi.waitFor(() => expect(reloaded.sends).toHaveLength(1));
    const sent = [reloaded.sends[0]!];
    await reloaded.answer({ turnId: 'turn-1' });
    await vi.waitFor(() => expect(reloaded.sends).toHaveLength(2));
    sent.push(reloaded.sends[1]!);
    expect(sent.map((entry) => [entry.message, entry.mode])).toEqual(
      expect.arrayContaining([['排队问一句', 'followUp'], ['旧条目', undefined]]),
    );
  });

  // 2026-10-25：发给 Lead 的图片和文字存在同一条里，重新加载以后连图片一起发。
  it('keeps the images of a message across a reload and sends them with it', async () => {
    const images = [{ mimeType: 'image/png' as const, data: 'iVBORw0KGgo=' }];
    const storage = new MemoryStorage();
    const first = harness({ storage, connected: false });
    await first.outbox.load();
    await first.outbox.enqueue('', undefined, undefined, images);
    expect(storage.saved[0]).toMatchObject({ message: '', images });

    const reloaded = harness({ storage });
    await reloaded.outbox.load();
    await vi.waitFor(() => expect(reloaded.sends).toHaveLength(1));
    expect(reloaded.sends[0]).toMatchObject({ message: '', images });
  });

  // 工单 08 第一版存下的工单消息带着 answerer（2026-10-19 起不再用）。重新加载以后照样发出去，不能丢。
  it('still sends a ticket message that an older version stored with an answerer', async () => {
    const storage = new MemoryStorage();
    storage.saved = [{
      clientMessageId: 'msg_old', message: '现在进展怎么样', ticketId: 77, createdAt: '2026-10-18T01:00:00.000Z',
      state: 'pending', attempts: 0, error: null, turnId: null, answerer: 'lead',
    } as OutboxEntry];
    const reloaded = harness({ storage });
    await reloaded.outbox.load();
    await vi.waitFor(() => expect(reloaded.sends).toHaveLength(1));
    expect(reloaded.sends[0]).toMatchObject({ clientMessageId: 'msg_old', message: '现在进展怎么样', ticketId: 77 });
  });

  it('sends in order, one at a time, and forgets a message once it is delivered', async () => {
    const h = harness();
    await h.outbox.load();
    await h.outbox.enqueue('一');
    await h.outbox.enqueue('二');
    await h.outbox.enqueue('三', 42);
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    expect(h.states()).toEqual(['一:sending', '二:pending', '三:pending']);
    await h.answer({ turnId: 'turn-1' });
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    await h.answer({ turnId: 'turn-2' });
    await vi.waitFor(() => expect(h.sends).toHaveLength(3));
    expect(h.sends.map((sent) => [sent.message, sent.ticketId])).toEqual([['一', null], ['二', null], ['三', 42]]);
    await h.answer({ turnId: 'turn-3' });
    expect(h.delivered.map((entry) => [entry.message, entry.turnId])).toEqual([['一', 'turn-1'], ['二', 'turn-2'], ['三', 'turn-3']]);
    expect(h.outbox.entries()).toEqual([]);
    expect(h.storage.saved).toEqual([]);
  });

  it('reports a delivery before the change that drops the message', async () => {
    const order: string[] = [];
    const outbox = new ChatOutbox({
      storage: new MemoryStorage(),
      createId: () => 'msg_1',
      send: async () => ({ turnId: 'turn-1' }),
      onChange: (entries) => order.push(`change:${entries.map((entry) => entry.state).join(',')}`),
      onDelivered: (entry) => order.push(`delivered:${entry.turnId}`),
    });
    await outbox.load();
    await outbox.enqueue('在吗');
    await vi.waitFor(() => expect(order).toContain('delivered:turn-1'));
    await flushPromises();
    // 调用方据此把本地消息换成那一轮的消息；之后的 change 里这条已经不在了。
    expect(order.slice(order.indexOf('delivered:turn-1'))).toEqual(['delivered:turn-1', 'change:']);
  });

  it('waits while the link is down and sends when it comes back', async () => {
    const h = harness({ connected: false });
    await h.outbox.load();
    await h.outbox.enqueue('断网时写的');
    await flushPromises();
    expect(h.sends).toEqual([]);
    expect(h.states()).toEqual(['断网时写的:pending']);
    h.setConnected(true);
    h.outbox.connected();
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
  });

  it('retries a transient failure with backoff and the same client message id', async () => {
    const h = harness();
    await h.outbox.load();
    await h.outbox.enqueue('在吗');
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    await h.answer(new ControlPlaneClientError('command timed out', 'timeout'));
    expect(h.outbox.entries()[0]).toMatchObject({ state: 'pending', attempts: 1, error: 'command timed out' });
    const retry = h.timers.filter((timer) => !timer.cleared).at(-1)!;
    expect(retry.delayMs).toBe(1_000);
    retry.callback();
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    await h.answer(new TypeError('Failed to fetch'));
    expect(h.timers.filter((timer) => !timer.cleared).at(-1)!.delayMs).toBe(2_000);
    expect(new Set(h.sends.map((sent) => sent.clientMessageId))).toEqual(new Set(['msg_1']));
  });

  // 2026-10-20 live：一条工单消息 daemon 一直答 internal_error，重发了 177 次；后面发给 Lead 的消息一次都没发出去。
  // 一个对话（Lead，或者一张工单）在等重试时，只挡住它自己后面的消息。
  it('keeps one conversation waiting on a retry from holding back another conversation', async () => {
    const h = harness();
    await h.outbox.load();
    await h.outbox.enqueue('你提个 PR', 102);
    await h.outbox.enqueue('工单的第二句', 102);
    await h.outbox.enqueue('周五提醒我');
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    await h.answer(new ControlPlaneClientError('runtime unavailable', 'internal_error'));
    // 发给 Lead 的不等工单那边；工单的第二句也不越过第一句。
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    expect(h.sends[1]).toMatchObject({ message: '周五提醒我', ticketId: null });
    await h.answer({ turnId: 'turn-lead' });
    expect(h.states()).toEqual(['你提个 PR:pending', '工单的第二句:pending']);
    expect(h.sends).toHaveLength(2);

    // 别的对话送达了，等重试的那个对话照样退避，不从头算。
    const retry = h.timers.filter((timer) => !timer.cleared).at(-1)!;
    expect(retry.delayMs).toBe(1_000);
    retry.callback();
    await vi.waitFor(() => expect(h.sends).toHaveLength(3));
    expect(h.sends[2]).toMatchObject({ message: '你提个 PR', ticketId: 102 });
    await h.answer(new ControlPlaneClientError('runtime unavailable', 'internal_error'));
    expect(h.timers.filter((timer) => !timer.cleared).at(-1)!.delayMs).toBe(2_000);
    expect(h.sends).toHaveLength(3);
  });

  it('marks a refused message failed, keeps the rest moving, and lets the user retry or remove it', async () => {
    const h = harness();
    await h.outbox.load();
    await h.outbox.enqueue('坏的');
    await h.outbox.enqueue('好的');
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    await h.answer(new ControlPlaneClientError('missing scope: chat', 'forbidden'));
    expect(h.outbox.entries()[0]).toMatchObject({ message: '坏的', state: 'failed', error: 'missing scope: chat' });
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    await h.answer({ turnId: 'turn-2' });
    expect(h.states()).toEqual(['坏的:failed']);

    h.outbox.retry('msg_1');
    await vi.waitFor(() => expect(h.sends).toHaveLength(3));
    await h.answer(new ControlPlaneClientError('missing scope: chat', 'forbidden'));
    await h.outbox.remove('msg_1');
    expect(h.outbox.entries()).toEqual([]);
    expect(h.storage.saved).toEqual([]);
  });

  it('keeps unsent messages across a restart, including one cut off mid-send', async () => {
    const storage = new MemoryStorage();
    const first = harness({ storage });
    await first.outbox.load();
    await first.outbox.enqueue('发送中断了');
    await first.outbox.enqueue('还没轮到');
    await vi.waitFor(() => expect(first.sends).toHaveLength(1));
    expect(storage.saved.map((entry) => entry.state)).toEqual(['sending', 'pending']);

    // 应用重新加载：内存里的都没了，存储里的还在。
    const second = harness({ storage, connected: false });
    await second.outbox.load();
    expect(second.states()).toEqual(['发送中断了:pending', '还没轮到:pending']);
    second.setConnected(true);
    second.outbox.connected();
    await vi.waitFor(() => expect(second.sends).toHaveLength(1));
    // 中断的那条用原来的 id 重发：daemon 收到过就按 id 去重。
    expect(second.sends[0]!.clientMessageId).toBe(first.sends[0]!.clientMessageId);
  });
});

// 发布评审 f796c1c：两个标签页共用 localStorage 里的同一个键，每个标签页写的时候都整份覆盖，
// 另一个标签页还没发出去的消息就没了。现在按 clientMessageId 合并着写，另一个标签页变了时（storage 事件）读回来。
describe('two tabs sharing one outbox store', () => {
  function tab(storage: MemoryStorage, ids: string[], connected = false) {
    const sends: string[] = [];
    let online = connected;
    const outbox = new ChatOutbox({
      storage,
      isConnected: () => online,
      createId: () => ids.shift()!,
      setTimer: () => 0,
      clearTimer: () => {},
      send: async (entry) => { sends.push(entry.clientMessageId); return { turnId: `turn-${entry.clientMessageId}` }; },
    });
    return { outbox, sends, connect: () => { online = true; outbox.connected(); } };
  }

  it('keeps the other tab\'s unsent message when one tab writes', async () => {
    const storage = new MemoryStorage();
    const a = tab(storage, ['msg_a']);
    const b = tab(storage, ['msg_b']);
    await a.outbox.load();
    await b.outbox.load();
    await a.outbox.enqueue('A 标签页写的');
    await b.outbox.enqueue('B 标签页写的');
    expect(storage.saved.map((entry) => entry.clientMessageId).sort()).toEqual(['msg_a', 'msg_b']);

    // A 读回别的标签页的变化：看得到 B 的消息。B 发出去以后，A 读回来时它就不在了。
    await a.outbox.reload();
    expect(a.outbox.entries().map((entry) => entry.clientMessageId).sort()).toEqual(['msg_a', 'msg_b']);
    b.connect();
    await vi.waitFor(() => expect(b.sends).toEqual(expect.arrayContaining(['msg_b'])));
    await vi.waitFor(() => expect(storage.saved.map((entry) => entry.clientMessageId)).toEqual(['msg_a']), { timeout: 2_000 });
    await a.outbox.reload();
    expect(a.outbox.entries().map((entry) => entry.clientMessageId)).toEqual(['msg_a']);
  });
});

describe('createJsonOutboxStorage', () => {
  it('round-trips the entries and drops what it cannot read', async () => {
    const values = new Map<string, string>();
    const kv = {
      async getItem(key: string) { return values.get(key) ?? null; },
      async setItem(key: string, value: string) { values.set(key, value); },
      async removeItem(key: string) { values.delete(key); },
    };
    const storage = createJsonOutboxStorage(kv);
    const entry: OutboxEntry = {
      clientMessageId: 'msg_1', message: '在吗', ticketId: null, createdAt: '2026-10-16T01:00:00.000Z',
      state: 'pending', attempts: 0, error: null, turnId: null,
    };
    await storage.save([entry]);
    expect(await storage.load()).toEqual([entry]);
    values.set('pi-lead-child.chat-outbox.v1', JSON.stringify([entry, { message: 'no id' }, 'junk']));
    expect(await storage.load()).toEqual([entry]);
    // 工单 08 第一版存下的条目带着 answerer：照样读回来（2026-10-19 起不再用它，但不能因此丢掉消息）。
    const ticketEntry = { ...entry, clientMessageId: 'msg_2', ticketId: 77, answerer: 'lead' };
    values.set('pi-lead-child.chat-outbox.v1', JSON.stringify([ticketEntry]));
    expect((await storage.load()).map((loaded) => loaded.clientMessageId)).toEqual(['msg_2']);
    // 带图片的条目：图片的形状不对时整条读不懂（发出去 daemon 也会拒收）。
    const withImages = { ...entry, clientMessageId: 'msg_3', images: [{ mimeType: 'image/png', data: 'iVBORw0KGgo=' }] };
    const badImages = { ...entry, clientMessageId: 'msg_4', images: [{ mimeType: 'image/bmp', data: 'Qk0=' }] };
    values.set('pi-lead-child.chat-outbox.v1', JSON.stringify([withImages, badImages]));
    expect(await storage.load()).toEqual([withImages]);
    values.set('pi-lead-child.chat-outbox.v1', '{not json');
    expect(await storage.load()).toEqual([]);
    await storage.save([]);
    expect(values.size).toBe(0);
  });
});
