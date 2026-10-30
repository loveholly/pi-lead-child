import { createJsonOutboxStorage, type KeyValueStorage } from '@pi-lead-child/client';

// 兜底实现：Metro 在 iOS/Android 上选 .native.ts，在 web 上选 .web.ts。
// 这个文件只给类型检查和 node 测试用，发件箱只存在内存里。
const values = new Map<string, string>();
const memoryStorage: KeyValueStorage = {
  async getItem(key) { return values.get(key) ?? null; },
  async setItem(key, value) { values.set(key, value); },
  async removeItem(key) { values.delete(key); },
};

export const platformOutboxStorage = createJsonOutboxStorage(memoryStorage);
