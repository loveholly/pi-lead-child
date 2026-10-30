// config.json 的核对（2026-10-19 审查）。规则：config.json 只能经 daemon 改（设置页、Lead 换模型都经 writePlcConfig）；
// child 不能直接改它。文件权限挡不住同一个系统用户的进程，所以这里只做发现：
// 定时读一次内容的哈希，和上一次看到的、daemon 自己最后写下的比较。变了而且不是 daemon 写的，就报一次。
// 报警里只有变了的配置项的名字（例如 env.GH_TOKEN），没有值：env 段里是密钥。
import { existsSync, readFileSync } from "node:fs";
import { lastWrittenPlcConfigHash, plcConfigHash } from "@pi-lead-child/core";

interface Snapshot {
  hash: string | null;
  parsed: unknown;
}

function snapshot(path: string): Snapshot {
  if (!existsSync(path)) return { hash: null, parsed: null };
  const content = readFileSync(path, "utf8");
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = null;
  }
  return { hash: plcConfigHash(content), parsed };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 两份配置之间变了的项：顶层和第二层的名字，例如 env.GH_TOKEN、lead.models、memory。 */
export function changedConfigKeys(before: unknown, after: unknown): string[] {
  if (!isRecord(before) || !isRecord(after)) return before === after ? [] : ["（整个文件）"];
  const out: string[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const a = before[key];
    const b = after[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (isRecord(a) && isRecord(b)) {
      for (const inner of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        if (JSON.stringify(a[inner]) !== JSON.stringify(b[inner])) out.push(`${key}.${inner}`);
      }
    } else {
      out.push(key);
    }
  }
  return out;
}

export interface ConfigWatch {
  // 读一次文件。变了而且不是 daemon 写的时，调用 onChange。
  check(): void;
}

export function createConfigWatch(path: string, onChange: (change: { hash: string | null; changed: string[] }) => void): ConfigWatch {
  let seen = snapshot(path);
  return {
    check() {
      const current = snapshot(path);
      if (current.hash === seen.hash) return;
      const previous = seen;
      seen = current;
      if (current.hash !== null && current.hash === lastWrittenPlcConfigHash(path)) return;
      onChange({ hash: current.hash, changed: changedConfigKeys(previous.parsed, current.parsed) });
    },
  };
}
