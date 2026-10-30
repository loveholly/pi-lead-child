import { createJsonOutboxStorage, type KeyValueStorage, type OutboxStorage } from '@pi-lead-child/client';

// 用户消息的发件箱存在 localStorage 里：重新加载页面以后，没发出去的消息还在，连上就发。
// 没有 localStorage 的环境（隐私模式拒绝访问等）退回内存。
const fallback = new Map<string, string>();

function local(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const webStorage: KeyValueStorage = {
  async getItem(key) {
    return local()?.getItem(key) ?? fallback.get(key) ?? null;
  },
  async setItem(key, value) {
    const storage = local();
    if (storage) storage.setItem(key, value);
    else fallback.set(key, value);
  },
  async removeItem(key) {
    local()?.removeItem(key);
    fallback.delete(key);
  },
};

const OUTBOX_KEY = 'pi-lead-child.chat-outbox.v1';

// 另一个标签页改了发件箱（storage 事件只发给别的标签页）：通知 runtime 读回来，不然它下次写时会盖掉对方的消息。
export const platformOutboxStorage: OutboxStorage = {
  ...createJsonOutboxStorage(webStorage, OUTBOX_KEY),
  subscribe(listener) {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
    const onStorage = (event: StorageEvent) => { if (event.key === OUTBOX_KEY || event.key === null) listener(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  },
};
