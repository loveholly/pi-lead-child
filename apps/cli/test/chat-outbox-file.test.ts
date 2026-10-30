// plc chat 的发件箱文件：数据目录里的 chat-outbox.json，权限 0600，先写临时文件再改名。
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { OutboxEntry } from "@pi-lead-child/client";
import { tempDir } from "@pi-lead-child/core/testing";
import { chatOutboxPath, fileOutboxStorage } from "../src/chat-outbox-file.js";

let dir: string;
beforeEach(() => { dir = tempDir("plc-chat-outbox-"); });

function entry(clientMessageId: string, message: string): OutboxEntry {
  return {
    clientMessageId, message, ticketId: null, createdAt: "2026-10-16T05:00:00.000Z",
    state: "pending", attempts: 0, error: null, turnId: null,
  };
}

describe("the plc chat outbox file", () => {
  it("keeps unsent messages in chat-outbox.json with mode 0600, and leaves no temporary file", async () => {
    const path = chatOutboxPath(dir);
    const storage = fileOutboxStorage(path);
    await storage.save([entry("msg_1", "第一句")]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["chat-outbox.json"]);
    expect(await fileOutboxStorage(path).load()).toEqual([entry("msg_1", "第一句")]);
  });

  it("removes the file when nothing is left to send", async () => {
    const path = chatOutboxPath(dir);
    const storage = fileOutboxStorage(path);
    await storage.save([entry("msg_1", "第一句")]);
    await storage.save([]);
    expect(existsSync(path)).toBe(false);
    expect(await storage.load()).toEqual([]);
  });

  it("tightens a file that others can read", async () => {
    const path = chatOutboxPath(dir);
    writeFileSync(path, JSON.stringify([entry("msg_1", "第一句")]));
    chmodSync(path, 0o644);
    expect(await fileOutboxStorage(path).load()).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads a corrupt file as empty", async () => {
    const path = chatOutboxPath(dir);
    writeFileSync(path, "{ not json");
    expect(await fileOutboxStorage(path).load()).toEqual([]);
  });

  // 两个 plc chat 同时开着：一个写文件时，不能盖掉另一个还没送达的消息。不然那个进程被关掉时，消息就丢了。
  it("keeps the messages of another plc chat that shares the file", async () => {
    const path = chatOutboxPath(dir);
    const first = fileOutboxStorage(path);
    const second = fileOutboxStorage(path);
    await first.load();
    await second.load();
    await first.save([entry("msg_a", "终端 A")]);
    await second.save([entry("msg_b", "终端 B")]);
    await first.save([entry("msg_a", "终端 A"), entry("msg_a2", "终端 A 第二句")]);
    const ids = (await fileOutboxStorage(path).load()).map((stored) => stored.clientMessageId).sort();
    expect(ids).toEqual(["msg_a", "msg_a2", "msg_b"]);
    // 送达以后，各自只删自己的。
    await first.save([]);
    expect((await fileOutboxStorage(path).load()).map((stored) => stored.clientMessageId)).toEqual(["msg_b"]);
    expect(readFileSync(path, "utf8")).not.toContain("终端 A");
  });
});
