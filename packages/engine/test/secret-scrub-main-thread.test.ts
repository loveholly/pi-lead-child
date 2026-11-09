// 清扫会话文件里的密钥值不占住 daemon 的主线程（lead-scheduler P0b，2026-11-09 审计第 4 项）。
//
// 每个 child 的 Run 结束时，daemon 把这个 Run 写过的 pi 会话文件清一遍（scrubSessionFiles）。文件读写已经是异步的，
// 但解码成字符串、逐个密钥 split/join、再编码回去都在主线程上：一个 50 MB 的会话文件让主线程停 137–158 毫秒，
// 会话越续越长，停得越久。现在这几步在 worker 线程里做，主线程只收发 Buffer。
import { closeSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mainThreadBusyMonitor, tempDir } from "@pi-lead-child/core/testing";
import { REDACTED, redactKnownValues } from "@pi-lead-child/protocol";
import { scrubSessionFiles } from "../src/children/secret-scrub.js";

const SECRETS = [
  "dev-fake-value-9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  "test-only-Zx9Lw4Pr8Kt1Vb6Nc3Md5Fg0JsAbCdEfGh",
  // 需要 JSON 转义的值：会话文件里出现的是转义后的写法。
  "pa\"ss\\word-with-quotes-0123456789",
  "短的不算",
];

// 一行一行地写进文件：测试进程里不留几十 MB 的垃圾，免得垃圾回收落在测量的窗口里。
function writeSession(path: string, megabytes: number): void {
  const fd = openSync(path, "w");
  let size = 0;
  for (let n = 0; size < megabytes * 1024 * 1024; n++) {
    const secret = n % 4_000 === 0 ? SECRETS[(n / 4_000) % SECRETS.length]! : "";
    const line = `${JSON.stringify({ type: "message", id: `m${n}`, text: `line ${n} ${secret} ${"lorem ipsum dolor sit amet ".repeat(30)}` })}\n`;
    writeSync(fd, line);
    size += line.length;
  }
  closeSync(fd);
}

describe("scrubbing session files after a Run (lead-scheduler P0b item 4)", () => {
  it("does not hold the main thread while it redacts a large session file", async () => {
    const dir = tempDir("plc-scrub-main-thread-");
    writeSession(join(dir, "session.jsonl"), 60);
    writeSession(join(dir, "expected.txt"), 60);

    const monitor = mainThreadBusyMonitor();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const rewritten = await scrubSessionFiles(dir, SECRETS, Date.now() - 60_000);
    const busy = monitor.stop();

    expect(rewritten).toBe(1);
    const after = readFileSync(join(dir, "session.jsonl"), "utf8");
    expect(after === redactKnownValues(readFileSync(join(dir, "expected.txt"), "utf8"), SECRETS)).toBe(true);
    expect(after).toContain(REDACTED);
    // 旧代码：解码、替换、编码一个 60 MB 的文件，主线程连续忙 100 毫秒以上。
    expect(busy.maxBusyMs, JSON.stringify(busy)).toBeLessThan(50);
  }, 60_000);

  it("rewrites files exactly like the in-process redaction: escaped values, overlaps, bad UTF-8, untouched files", async () => {
    const values = [
      "outer-secret-value-1234567890",
      // 是上一个值的一部分：长的先换（secretEnvValues 按长度排好序交过来）。
      "secret-value-1234",
      "line\nbreak\tsecret-0123456789",
      "short",
    ];
    const files: Record<string, Buffer> = {
      "plain.jsonl": Buffer.from(`${JSON.stringify({ a: values[0], b: values[1], c: `x${values[0]}y` })}\n`),
      "escaped.jsonl": Buffer.from(`${JSON.stringify({ output: `${values[2]} and ${values[3]}` })}\n`),
      // 不合法的 UTF-8 字节：两种做法都按 utf8 解码（替换成 U+FFFD）。
      "invalid-utf8.jsonl": Buffer.concat([Buffer.from(`{"k":"${values[1]}"}`), Buffer.from([0xff, 0xfe, 0x0a])]),
      "clean.jsonl": Buffer.from("{\"nothing\":\"to redact\"}\n"),
    };
    const run = async (worker: boolean) => {
      const dir = tempDir("plc-scrub-parity-");
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      const rewritten = await scrubSessionFiles(dir, values, Date.now() - 60_000, { worker });
      return { rewritten, contents: Object.fromEntries(Object.keys(files).map((name) => [name, readFileSync(join(dir, name)).toString("base64")])) };
    };
    const inWorker = await run(true);
    const inProcess = await run(false);
    expect(inWorker).toEqual(inProcess);
    expect(inWorker.rewritten).toBe(3);
    expect(Buffer.from(inWorker.contents["clean.jsonl"]!, "base64")).toEqual(files["clean.jsonl"]);
    expect(Buffer.from(inWorker.contents["plain.jsonl"]!, "base64").toString()).not.toContain("secret-value");
  });
});
