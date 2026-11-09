// 空闲车道的压缩：在子进程里写摘要（lead-scheduler spec D8，P4）。
//
// 以前压缩是 pi 在 Lead 的会话里就地做的：把要摘要的对话序列化、发给模型、等它写完（43–103 秒），这期间 Lead 不能回应。
// 现在 daemon 只做两件碰会话的小事，各几毫秒：
//   1. 取要摘要的对话：pi 的 session_before_compact 给出 preparation（pi 不导出 prepareCompaction，所以用它自己的钩子拿）；
//   2. 接上：摘要写好以后，在 Lead 空闲时让 pi 把它记成一条压缩（session_before_compact 返回 compaction）。
// 中间最重的一段（序列化、估算 token、分段、调模型、解析回答）在子进程里做。子进程经 core 的 runHostChild 起
// （和 P0 的删除同一套：登记成后台作业，起止各一行 [sched] job.*，探针的卡顿说明里能看到它）。
//
// 子进程拿到的东西都经标准输入：要摘要的对话、模型和它的凭据。凭据不进命令行、环境变量、日志和文件。
// 子进程只写标准输出（一段 JSON）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { distDir, packageSource, projectRoot, runHostChild } from "@pi-lead-child/core";

export const IDLE_COMPACT_REQUEST_VERSION = 1;

/** 子进程要的 preparation：pi 的 CompactionPreparation，fileOps 的集合换成数组（JSON 写不了 Set）。 */
export interface IdleCompactPreparation {
  firstKeptEntryId: string;
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  isSplitTurn: boolean;
  tokensBefore: number;
  previousSummary?: string;
  fileOps: { read: string[]; written: string[]; edited: string[] };
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}

export interface IdleCompactRequest {
  version: typeof IDLE_COMPACT_REQUEST_VERSION;
  // pi 的模型（纯数据）。
  model: Record<string, unknown> & { id: string; provider: string; api: string; contextWindow: number };
  // daemon 按会话的模型解析好的凭据（modelRegistry.getApiKeyAndHeaders）。
  auth: { apiKey?: string; headers?: Record<string, string>; baseUrl?: string };
  preparation: IdleCompactPreparation;
}

export type IdleCompactResponse =
  | { ok: true; summary: string; details: unknown; usage?: unknown; chunks: number; level: "normal" | "strict" }
  | { ok: false; error: string };

/** pi 的 preparation 转成能写进 JSON 的样子。 */
export function serializablePreparation(preparation: {
  firstKeptEntryId: string; messagesToSummarize: unknown[]; turnPrefixMessages: unknown[]; isSplitTurn: boolean;
  tokensBefore: number; previousSummary?: string; fileOps: { read: Iterable<string>; written: Iterable<string>; edited: Iterable<string> };
  settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}): IdleCompactPreparation {
  return {
    firstKeptEntryId: preparation.firstKeptEntryId,
    messagesToSummarize: preparation.messagesToSummarize,
    turnPrefixMessages: preparation.turnPrefixMessages,
    isSplitTurn: preparation.isSplitTurn,
    tokensBefore: preparation.tokensBefore,
    ...(preparation.previousSummary !== undefined ? { previousSummary: preparation.previousSummary } : {}),
    fileOps: { read: [...preparation.fileOps.read], written: [...preparation.fileOps.written], edited: [...preparation.fileOps.edited] },
    settings: { enabled: preparation.settings.enabled, reserveTokens: preparation.settings.reserveTokens, keepRecentTokens: preparation.settings.keepRecentTokens },
  };
}

/**
 * 子进程的命令：构建产物 dist/idle-compact.mjs；没有构建产物或者 PLC_DEV=1 时经 tsx 跑源码
 * （和 hindsight-main 一样，daemon 的 memory-backend.ts）。
 */
export function idleCompactProgram(env: Record<string, string | undefined> = process.env, execPath = process.execPath): { command: string; args: string[] } {
  const dist = join(distDir(), "idle-compact.mjs");
  if (existsSync(dist) && !env.PLC_DEV) return { command: execPath, args: [dist] };
  return {
    command: execPath,
    args: [join(projectRoot(), "node_modules", "tsx", "dist", "cli.mjs"), packageSource("lead", "scheduler", "idle-compact-child.ts")],
  };
}

export interface SummarizeInChildOptions {
  id: string;
  timeoutMs: number;
  signal?: AbortSignal;
  // 测试换掉命令。
  program?: { command: string; args: string[] };
  // 子进程起来以后（pid）。
  onStart?: (pid: number | null) => void;
}

export interface SummarizeInChildResult {
  response: IdleCompactResponse;
  ms: number;
}

/** 在子进程里写摘要，等它写完。子进程失败、超时、被中止、输出不是合法的回答时 response.ok 为 false。 */
export async function summarizeInChild(request: IdleCompactRequest, options: SummarizeInChildOptions): Promise<SummarizeInChildResult> {
  const program = options.program ?? idleCompactProgram();
  const result = await runHostChild({
    kind: "idle-compact", label: options.id,
    command: program.command, args: program.args,
    // 子进程大多在等模型：用 utility，不用 background（background 也压低网络，摘要会慢很多）。
    priority: "utility",
    stdin: JSON.stringify(request),
    captureStdout: true,
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onStart ? { onSpawn: options.onStart } : {}),
  });
  if (result.aborted) return { response: { ok: false, error: "cancelled" }, ms: result.ms };
  if (result.timedOut) return { response: { ok: false, error: `timed out after ${options.timeoutMs}ms` }, ms: result.ms };
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
  } catch { /* 下面按失败处理 */ }
  if (parsed && typeof parsed === "object" && "ok" in parsed) {
    const response = parsed as IdleCompactResponse;
    if (response.ok && typeof response.summary === "string" && response.summary.trim()) return { response, ms: result.ms };
    if (!response.ok && typeof response.error === "string") return { response, ms: result.ms };
  }
  const why = result.code === 0 ? "no answer on stdout" : `exited ${result.code ?? result.signal}`;
  return { response: { ok: false, error: `${why}: ${result.stderr.trim().slice(-300)}` }, ms: result.ms };
}
