// child 的事件和会话记录里的密钥值（2026-10-19 审查）。
//
// 一个 child 执行了 `env | grep`，AM_API_KEY 的明文进了 runtime-events/run-109.jsonl，也进了 pi 自己写的
// sessions/item-96/*.jsonl。child 继承 daemon 的全部环境（executor 和独立 CLI 一致，这个决定不变），
// 所以这里不改 child 的环境，只在记录时把已知密钥的值盖掉：
//   - runtime 事件：进 ingest、落库、写 runtime-events 之前（redactRuntimeEvent）。
//   - pi 的会话文件（在数据目录的 sessions/item-N 下）：Run 结束后清一遍这个 Run 写过的文件（scrubSessionFiles）。
//     Codex、Claude Code 的会话记录在它们自己的目录（~/.codex、~/.claude），和独立运行时一样，这里不动。
import { chmodSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactKnownValues } from "@pi-lead-child/protocol";
import type { RuntimeEvent } from "@pi-lead-child/runtime";

/** 盖掉事件里已知密钥的值。没有要盖的时返回原来的对象。 */
export function redactRuntimeEvent<T extends RuntimeEvent>(event: T, values: readonly string[]): T {
  if (!values.length) return event;
  const json = JSON.stringify(event);
  const clean = redactKnownValues(json, values);
  return clean === json ? event : JSON.parse(clean) as T;
}

/**
 * 清一遍一个目录里的会话文件（*.jsonl，不递归）：只看 sinceMs 之后改过的。
 * 写回之前再看一次文件的大小和修改时间：变了说明另一个进程正在往里写（例如同一个会话被续接），这次跳过，不冒丢行的险。
 * 返回改写了几个文件。
 */
export function scrubSessionFiles(dir: string, values: readonly string[], sinceMs: number): number {
  if (!values.length) return 0;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return 0;
  }
  let rewritten = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const before = statSync(path);
      if (!before.isFile() || before.mtimeMs < sinceMs - 1_000) continue;
      const text = readFileSync(path, "utf8");
      const clean = redactKnownValues(text, values);
      if (clean === text) continue;
      const temporary = `${path}.scrub-${process.pid}`;
      writeFileSync(temporary, clean, { mode: before.mode & 0o777 });
      chmodSync(temporary, before.mode & 0o777);
      const now = statSync(path);
      if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
        unlinkSync(temporary);
        continue;
      }
      renameSync(temporary, path);
      rewritten += 1;
    } catch {
      // 读不到、写不了的文件跳过：清理是尽力而为，不影响 Run 的收尾。
    }
  }
  return rewritten;
}
