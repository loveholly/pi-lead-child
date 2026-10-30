import { File, Paths } from 'expo-file-system';

import { createJsonOutboxStorage, type KeyValueStorage } from '@pi-lead-child/client';

// 用户消息的发件箱存在应用文档目录的一个文件里：应用被系统杀掉、重新打开以后，没发出去的消息还在。
// 不用 SecureStore：一条消息可能很长，SecureStore 的单个值有大小限制。只有一个键，所以键不进文件名。
const outboxFile = () => new File(Paths.document, 'chat-outbox.json');

const fileStorage: KeyValueStorage = {
  async getItem() {
    const file = outboxFile();
    return file.exists ? file.text() : null;
  },
  async setItem(_key, value) {
    const file = outboxFile();
    if (!file.exists) file.create();
    file.write(value);
  },
  async removeItem() {
    const file = outboxFile();
    if (file.exists) file.delete();
  },
};

export const platformOutboxStorage = createJsonOutboxStorage(fileStorage);
