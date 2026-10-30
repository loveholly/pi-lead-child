// 本机 socket 和网关的 listen。两件事：
// - listenOwnerOnly：Unix socket 建在 0700 的目录里，listen 和 chmod 之间别的用户也连不上；
// - listenOnce：listen 用的临时 error 监听在成功之后移除，之后的错误交给调用方，不被吞掉。
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { listenOnce, listenOwnerOnly } from "../src/listen.js";

describe("listenOwnerOnly", () => {
  // 进程级的 umask 会影响同一时刻创建的其他文件，所以不用它。socket 所在的目录是 0700：
  // 别的用户进不了这个目录，socket 在 chmod 之前也连不上。
  it("binds inside a 0700 directory and leaves the socket 0600, without touching the umask", async () => {
    const dir = join(tempDir("plc-listen-"), "data");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const path = join(dir, "test.sock");
    const server = createServer();
    let dirModeAtBind = -1;
    // 先登记的 listening 监听先跑：这里看到的是 bind 时的状态，还没有 chmod socket。
    server.once("listening", () => { dirModeAtBind = statSync(dir).mode & 0o777; });
    const umask = vi.spyOn(process, "umask");
    try {
      await listenOwnerOnly(server, path);
      expect(dirModeAtBind).toBe(0o700);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(umask).not.toHaveBeenCalled();
    } finally {
      umask.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("creates a missing directory as 0700", async () => {
    const dir = join(tempDir("plc-listen-"), "new", "data");
    const server = createServer();
    try {
      await listenOwnerOnly(server, join(dir, "test.sock"));
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("listenOnce", () => {
  it("hands errors after a successful listen to the caller instead of swallowing them", async () => {
    const server = createHttpServer();
    const late: Error[] = [];
    await listenOnce(server, { port: 0, host: "127.0.0.1" }, (error) => late.push(error));
    try {
      expect(server.listenerCount("error")).toBe(1);
      server.emit("error", new Error("late failure"));
      expect(late.map((error) => error.message)).toEqual(["late failure"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects a listen error and leaves no listener behind", async () => {
    const first = createHttpServer();
    await listenOnce(first, { port: 0, host: "127.0.0.1" }, () => {});
    const port = (first.address() as { port: number }).port;
    const second = createHttpServer();
    try {
      await expect(listenOnce(second, { port, host: "127.0.0.1" }, () => {})).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(second.listenerCount("error")).toBe(0);
    } finally {
      await new Promise<void>((resolve) => first.close(() => resolve()));
    }
  });
});
