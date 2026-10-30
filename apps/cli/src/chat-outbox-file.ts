// plc chat 的发件箱文件：数据目录里的 chat-outbox.json，权限 0600。还没送达的消息都在这里，
// plc chat 重启以后照原来的 clientMessageId 重发。没有要发的消息时，文件删掉。
//
// 两个 plc chat 可能同时开着，共用这个文件。每个进程只管自己读到或写进来的消息：写文件时，
// 先读回文件里别的进程的消息，一起写回去。不然一个进程写文件会盖掉另一个进程还没送达的消息，
// 那个进程被关掉时，消息就丢了。读和写之间没有锁：两个进程恰好同时写时，后写的可能漏掉先写的一条。
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJsonOutboxStorage, type OutboxStorage } from "@pi-lead-child/client";
import { dataDir } from "@pi-lead-child/core";

export const chatOutboxPath = (dir: string = dataDir()) => join(dir, "chat-outbox.json");

export function fileOutboxStorage(path: string = chatOutboxPath()): OutboxStorage {
  // 只有一个键，所以键不进文件名。
  const json = createJsonOutboxStorage({
    async getItem() {
      if (!existsSync(path)) return null;
      // 消息可能有敏感内容：权限比 0600 宽时先收紧。
      if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
      return readFileSync(path, "utf8");
    },
    // 先写临时文件再改名：写到一半中断时，旧的发件箱还在。
    async setItem(_key, value) {
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    },
    async removeItem() {
      rmSync(path, { force: true });
    },
  });
  // 本进程读到过或写过的消息。文件里别的消息属于另一个 plc chat。
  const own = new Set<string>();
  return {
    async load() {
      const entries = await json.load();
      for (const entry of entries) own.add(entry.clientMessageId);
      return entries;
    },
    async save(entries) {
      for (const entry of entries) own.add(entry.clientMessageId);
      const others = (await json.load()).filter((entry) => !own.has(entry.clientMessageId));
      await json.save([...others, ...entries]);
    },
  };
}
