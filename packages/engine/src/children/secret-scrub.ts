// child 的事件和会话记录里的密钥值（2026-10-19 审查）。
//
// 一个 child 执行了 `env | grep`，AM_API_KEY 的明文进了 runtime-events/run-109.jsonl，也进了 pi 自己写的
// sessions/item-96/*.jsonl。child 继承 daemon 的全部环境（executor 和独立 CLI 一致，这个决定不变），
// 所以这里不改 child 的环境，只在记录时把已知密钥的值盖掉：
//   - runtime 事件：进 ingest、落库、写 runtime-events 之前（redactRuntimeEvent）。
//   - pi 的会话文件（在数据目录的 sessions/item-N 下）：Run 结束后清一遍这个 Run 写过的文件（scrubSessionFiles）。
//     Codex、Claude Code 的会话记录在它们自己的目录（~/.codex、~/.claude），和独立运行时一样，这里不动。
import { chmod, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { trackHostJob } from "@pi-lead-child/core";
import { knownValueNeedles, REDACTED, redactKnownValues } from "@pi-lead-child/protocol";
import type { RuntimeEvent } from "@pi-lead-child/runtime";

/** 盖掉事件里已知密钥的值。没有要盖的时返回原来的对象。 */
export function redactRuntimeEvent<T extends RuntimeEvent>(event: T, values: readonly string[]): T {
  if (!values.length) return event;
  const json = JSON.stringify(event);
  const clean = redactKnownValues(json, values);
  return clean === json ? event : JSON.parse(clean) as T;
}

// ── 在 worker 线程里替换（lead-scheduler P0b，2026-11-09 审计第 4 项）──────────────────────────────
//
// 把一个会话文件解码成字符串、逐个密钥 split/join、再编码回去，都是 CPU 活：一个 50 MB 的文件让 daemon 的主线程
// 停 137–158 毫秒，会话越续越长，停得越久。现在这三步在 worker 线程里做：主线程把读到的 Buffer 交过去（转移，不复制），
// 收回替换后的 Buffer（没有要换的就收回 null）。要换的字符串由 knownValueNeedles 算好再交给 worker，
// 替换的顺序和写法与 redactKnownValues 一样。worker 的代码是字符串（eval），打包以后照样能用。
const REDACT_WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", ({ id, bytes, needles, redacted }) => {
  try {
    const text = Buffer.from(bytes).toString("utf8");
    let out = text;
    for (const needle of needles) {
      if (out.includes(needle)) out = out.split(needle).join(redacted);
    }
    if (out === text) {
      parentPort.postMessage({ id, changed: false });
      return;
    }
    const encoded = Buffer.from(out, "utf8");
    const result = encoded.buffer.byteLength === encoded.byteLength
      ? encoded.buffer
      : encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
    parentPort.postMessage({ id, changed: true, bytes: result }, [result]);
  } catch (error) {
    parentPort.postMessage({ id, error: String((error && error.message) || error) });
  }
});
`;

interface Redactor {
  /** 替换后的内容；没有要换的时为 null。content 的内存会转移给 worker，之后不能再用。 */
  redact(content: Buffer): Promise<Buffer | null>;
  close(): void;
}

function workerRedactor(needles: readonly string[]): Redactor {
  const worker = new Worker(REDACT_WORKER_SOURCE, { eval: true, stdout: false, stderr: false });
  worker.unref();
  const pending = new Map<number, { resolve: (value: Buffer | null) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let failed: Error | null = null;
  const failAll = (error: Error) => {
    failed ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker.on("message", (message: { id: number; changed?: boolean; bytes?: ArrayBuffer; error?: string }) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error !== undefined) request.reject(new Error(message.error));
    else request.resolve(message.changed ? Buffer.from(message.bytes!) : null);
  });
  worker.on("error", failAll);
  worker.on("exit", (code) => failAll(new Error(`redaction worker exited with code ${code}`)));
  return {
    redact(content) {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        // 整块内存独占时直接转移；否则（共用的小块内存）先复制出来。
        const bytes = content.byteOffset === 0 && content.byteLength === content.buffer.byteLength
          ? content.buffer as ArrayBuffer
          : content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
        worker.postMessage({ id, bytes, needles, redacted: REDACTED }, [bytes]);
      });
    },
    close() {
      void worker.terminate();
    },
  };
}

// 主线程上替换（以前的做法）。小文件用它：1 MB 在主线程上约 3 毫秒，比起一个 worker 便宜；
// 起 worker 要几十毫秒，Run 的收尾会跟着变长。worker 起不来或者中途坏了时也用它，不让密钥因此留在文件里。
function redactInProcess(content: Buffer, values: readonly string[]): Buffer | null {
  const text = content.toString("utf8");
  const clean = redactKnownValues(text, values);
  return clean === text ? null : Buffer.from(clean, "utf8");
}

// 这么大以上的文件交给 worker。
export const SCRUB_WORKER_MIN_BYTES = 1024 * 1024;

export interface ScrubSessionFilesOptions {
  // 缺省：1 MB 以上的文件交给 worker。true：都交给 worker；false：都在主线程上替换。只给测试核对两种做法一样。
  worker?: boolean;
}

/**
 * 清一遍一个目录里的会话文件（*.jsonl，不递归）：只看 sinceMs 之后改过的。
 * 写回之前再看一次文件的大小和修改时间：变了说明另一个进程正在往里写（例如同一个会话被续接），这次跳过，不冒丢行的险。
 * 返回改写了几个文件。读写都是异步的：会话文件有几十 MB，以前同步读写，每个 Run 结束时占住 daemon 的主线程（2026-11-03）。
 * 解码和替换在 worker 线程里做（lead-scheduler P0b）。
 */
export async function scrubSessionFiles(
  dir: string, values: readonly string[], sinceMs: number, options: ScrubSessionFilesOptions = {},
): Promise<number> {
  if (!values.length) return 0;
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return 0;
  }
  if (!names.length) return 0;
  const needles = knownValueNeedles(values);
  if (!needles.length) return 0;
  return trackHostJob("session-scrub", `sessions ${basename(dir)}`, async () => {
    let redactor: Redactor | null = null;
    let rewritten = 0;
    try {
      for (const name of names) {
        const path = join(dir, name);
        try {
          const before = await stat(path);
          if (!before.isFile() || before.mtimeMs < sinceMs - 1_000) continue;
          const content = await readFile(path);
          let clean: Buffer | null;
          if (options.worker === false || (options.worker === undefined && content.length < SCRUB_WORKER_MIN_BYTES)) {
            clean = redactInProcess(content, values);
          } else {
            try {
              redactor ??= workerRedactor(needles);
              // content 的内存交给 worker 以后不能再用：失败时重新读一遍。
              clean = await redactor.redact(content);
            } catch {
              clean = redactInProcess(await readFile(path), values);
            }
          }
          if (!clean) continue;
          const temporary = `${path}.scrub-${process.pid}`;
          await writeFile(temporary, clean, { mode: before.mode & 0o777 });
          await chmod(temporary, before.mode & 0o777);
          const now = await stat(path);
          if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
            await unlink(temporary);
            continue;
          }
          await rename(temporary, path);
          rewritten += 1;
        } catch {
          // 读不到、写不了的文件跳过：清理是尽力而为，不影响 Run 的收尾。
        }
      }
    } finally {
      redactor?.close();
    }
    return rewritten;
  });
}
