// 空闲车道的压缩子进程（lead-scheduler spec D8，P4）：从标准输入读一个 IdleCompactRequest，写摘要，把结果写到标准输出。
//
// 和 daemon 自己发起的压缩一样带长度预算（compaction-settings.ts 的 leadCompactionInstructions）：先按 8000 字写，
// 写到模型的输出上限时按 4000 字再写一次。历史一次放不进摘要请求时分段（compaction-chunks.ts 的 compactInChunks）。
// 这里不碰 Lead 的会话：摘要写好以后由 daemon 在 Lead 空闲时接上。
//
// 标准错误只写进度和错误的说明（daemon 只在失败时取最后一段），不写对话的原文和凭据。
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { compactInChunks } from "../compaction-chunks.js";
import { isSummaryTokenCapError, leadCompactionInstructions } from "../compaction-settings.js";
import { IDLE_COMPACT_REQUEST_VERSION, type IdleCompactRequest, type IdleCompactResponse } from "./idle-compaction.js";

export interface RunIdleCompactOptions {
  // 测试换掉真正的摘要调用。
  summarize?: Parameters<typeof compactInChunks>[2] extends infer O ? O extends { summarize?: infer S } ? S : never : never;
  // Tests replace the summary call on the session prefix.
  complete?: NonNullable<Parameters<typeof compactInChunks>[2]>["complete"];
  signal?: AbortSignal;
  log?: (line: string) => void;
}

/** 写一份摘要。失败时返回 ok=false 和原因（不抛错）。 */
export async function runIdleCompact(request: IdleCompactRequest, options: RunIdleCompactOptions = {}): Promise<IdleCompactResponse> {
  if (request?.version !== IDLE_COMPACT_REQUEST_VERSION || !request.preparation || !request.model) {
    return { ok: false, error: "bad request" };
  }
  const signal = options.signal ?? new AbortController().signal;
  const event = {
    type: "session_before_compact",
    preparation: request.preparation,
    branchEntries: [],
    // 不给 customInstructions：要求由下面的 instructions 给，compactInChunks 这时总是自己写（放得进一次请求也一样）。
    customInstructions: undefined,
    reason: "manual",
    willRetry: false,
    signal,
  } as unknown as SessionBeforeCompactEvent;
  const ctx = {
    model: request.model as unknown as ExtensionContext["model"],
    modelRegistry: { getApiKeyAndHeaders: async () => request.auth ?? {} },
  } as unknown as Parameters<typeof compactInChunks>[1];
  let failure = "";
  for (const level of ["normal", "strict"] as const) {
    try {
      const result = await compactInChunks(event, ctx, {
        instructions: leadCompactionInstructions(level),
        ...(request.prefix ? { prefix: () => request.prefix } : {}),
        ...(options.log ? { log: options.log } : {}),
        ...(options.summarize ? { summarize: options.summarize } : {}),
        ...(options.complete ? { complete: options.complete } : {}),
      });
      if (!result) return { ok: false, error: "nothing to summarize" };
      const { summary, details, usage } = result.compaction;
      const chunks = (details as { chunks?: unknown })?.chunks;
      return {
        ok: true, summary, details, ...(usage ? { usage } : {}),
        chunks: typeof chunks === "number" ? chunks : 1, level,
      };
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (!isSummaryTokenCapError(failure)) break;
    }
  }
  return { ok: false, error: failure || "summary failed" };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const controller = new AbortController();
  // daemon 停机或者不再要这份摘要：SIGTERM。停下正在等的模型调用。
  process.once("SIGTERM", () => controller.abort());
  let response: IdleCompactResponse;
  try {
    const request = JSON.parse(await readStdin()) as IdleCompactRequest;
    response = await runIdleCompact(request, { signal: controller.signal, log: (line) => process.stderr.write(`${line}\n`) });
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

// 作为进程入口运行时才读标准输入（测试 import 这个文件时不跑）。
const entry = process.argv[1] ?? "";
if (/idle-compact(-child)?\.(m?js|ts)$/u.test(entry)) {
  void main().then(() => process.exit(0), () => process.exit(1));
}
