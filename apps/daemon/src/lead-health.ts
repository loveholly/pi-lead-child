// Lead 自己的模型调用健康。以前没有这份状态：模型每次都返回 503，顶栏照样亮绿点，
// 会话里每次心跳巡检多一个红框。现在 daemon 记下：
//   · 在线：最近一次模型调用成功（启动后还没调用过时也算在线）；
//   · 降级：模型调用失败，系统会自己再试，并给出下一次自动调用的时间；
//     或者上下文压缩失败（2026-10-17，spec D9），到下一次成功的模型调用为止。
// 离线（daemon 本身连不上）由客户端按连接状态判断，这里不管。
import {
  classifyLeadModelError, DEFAULT_LEAD_NAME, leadModelFailureReason, redactSecretText, type LeadStatus,
} from "@pi-lead-child/protocol";

export interface LeadHealthTracker {
  status(): LeadStatus;
  // 一次模型调用失败（message_end 的 stopReason 是 error）。
  failed(rawError: string): void;
  // SDK 自己排了一次重试：delayMs 之后再调模型。
  retrying(delayMs: number, rawError: string): void;
  // 一次模型调用成功。
  succeeded(): void;
  // 一次心跳巡检完成（没有要消化的，或者 Lead 消化完了）。
  patrolled(): void;
  // 网络断了（daemon 的网络探测不通）：显示离线，等网络恢复。已经因为断网记着失败时不重复记。
  networkDown(detail: string): void;
  // 换掉最近一次失败的原文（daemon 确认网络是通的以后，把"连接被拒"改记成模型服务连不上）。不改次数和开始时间。
  reclassify(detail: string): void;
  // 上下文压缩失败或超时（compactionEndOutcome）。显示降级，原因写成压缩失败，到下一次成功的模型调用为止。
  // 不算进 failures：Lead 的模型调用可能还是好的，停摆兜底（server.ts 的 leadIncapacity）只看模型调用的失败。
  compactionFailed(detail: string): void;
}

// 上下文压缩失败时顶栏的原因。name 是 Lead 的名字（设置 → 身份与风格）。
export function leadCompactionFailedReason(name: string): string {
  return `${name} 的上下文压缩失败`;
}

// 回答被截成空的：stopReason 是 length，没有文字，也没有调工具。上下文满了时 pi 只给回答留 1 个 token（pi-ai 的
// clampMaxTokensToContext），回答就是这样。它不是一次成功的模型调用（2026-10-28：以前这样的回答把顶栏清回绿点，
// 这一轮也算成功，交给它的事件不再交回来）。
export function isEmptyLengthStop(message: { stopReason?: unknown; content?: unknown }): boolean {
  if (message.stopReason !== "length") return false;
  const parts = Array.isArray(message.content) ? message.content as Array<{ type?: unknown; text?: unknown }> : [];
  return !parts.some((part) => part?.type === "toolCall" || (part?.type === "text" && typeof part.text === "string" && part.text.trim() !== ""));
}

// Lead 的上下文满了的一轮的错误。开头的「Context overflow」让模型切换算它是一次上下文溢出（lead 的 model-failover.ts），
// 「上下文满了」让顶栏、停摆通知和会话的失败分类认出它（protocol 的 classifyLeadModelError，kind=context）。
// detail：压缩失败的原文（compactionEndOutcome 的 detail）。没有时说回答被截成空的。
export function leadContextFullError(detail?: string): string {
  return detail
    ? `Context overflow: 上下文满了，压缩没有成功（${detail}）`
    : "Context overflow: 上下文满了，回答被截成空的";
}

// pi 的 compaction_end（AgentSessionEvent）怎样收尾。字段名照 pi 的类型：result、aborted、errorMessage。
//   · 成功：有 result，没有中止，没有 errorMessage；
//   · 失败：有 errorMessage，或者没有 result；
//   · 超时：daemon 计时到点后用 abortCompaction 中止了它（timedOut），算失败；
//   · 被别的原因中止（daemon 停机、用户停止）：不是模型的问题，不算失败。
export type CompactionEndOutcome =
  | { kind: "succeeded" }
  | { kind: "failed"; detail: string }
  | { kind: "aborted" };

export function compactionEndOutcome(
  event: { result?: unknown; aborted?: boolean; errorMessage?: string },
  context: { timedOut: boolean; timeoutMs: number },
): CompactionEndOutcome {
  if (event.aborted) {
    if (!context.timedOut) return { kind: "aborted" };
    return { kind: "failed", detail: `上下文压缩超时：${formatMinutes(context.timeoutMs)}没有完成，daemon 中止了它。` };
  }
  const error = event.errorMessage?.trim();
  if (error) return { kind: "failed", detail: `上下文压缩失败：${error}` };
  if (event.result === undefined || event.result === null) return { kind: "failed", detail: "上下文压缩失败：没有得到压缩结果。" };
  return { kind: "succeeded" };
}

function formatMinutes(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes >= 1 && Number.isInteger(minutes)) return `${minutes} 分钟`;
  return `${Math.max(1, Math.round(ms / 1_000))} 秒`;
}

export function createLeadHealthTracker(options: {
  // 系统接下来自己会调模型的最早时间（通知重播、心跳巡检）。没有排好的就返回 null。
  nextScheduledAttempt: () => Date | null;
  onChange: (status: LeadStatus) => void;
  // 上一次巡检的时间（daemon 重启前存下的），以及存下新的巡检时间。
  lastPatrolAt?: Date | null;
  savePatrol?: (at: Date) => void;
  // 原因里称呼 Lead 用的名字（设置 → 身份与风格）。不给时用缺省的名字。
  leadName?: () => string;
  now?: () => Date;
}): LeadHealthTracker {
  const now = options.now ?? (() => new Date());
  const name = options.leadName ?? (() => DEFAULT_LEAD_NAME);
  // 模型调用连续失败：从什么时候开始、几次、最近一次的原文。
  let since: Date | null = null;
  let failures = 0;
  let lastError: string | null = null;
  // 上下文压缩失败：从什么时候开始、最近一次的说明。下一次成功的模型调用清掉它。
  let compaction: { since: Date; detail: string } | null = null;
  // 最近一次失败是哪一种：顶栏写最近的那一种。
  let latest: "model" | "compaction" = "model";
  let retryAt: Date | null = null;
  let lastSuccessAt: Date | null = null;
  let lastPatrolAt: Date | null = options.lastPatrolAt ?? null;

  const status = (): LeadStatus => {
    if (failures === 0 && !compaction) {
      return {
        state: "online", since: null, failures: 0, reason: null, detail: null, nextAttemptAt: null,
        lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
        lastPatrolAt: lastPatrolAt?.toISOString() ?? null,
      };
    }
    const at = now();
    const pendingRetry = retryAt && retryAt.getTime() > at.getTime() ? retryAt : null;
    const next = pendingRetry ?? options.nextScheduledAttempt();
    const showCompaction = compaction !== null && (failures === 0 || latest === "compaction");
    return {
      state: "degraded",
      since: (failures > 0 ? since : compaction?.since)?.toISOString() ?? null,
      failures,
      reason: showCompaction
        ? leadCompactionFailedReason(name())
        : leadModelFailureReason(classifyLeadModelError(lastError ?? ""), name()),
      detail: showCompaction ? compaction!.detail : lastError,
      nextAttemptAt: next?.toISOString() ?? null,
      lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
      lastPatrolAt: lastPatrolAt?.toISOString() ?? null,
    };
  };

  const fail = (rawError: string) => {
    if (failures === 0) since = now();
    failures += 1;
    // 原文经 overview 和 daemon.status.changed 发给所有客户端：先遮住里面的密钥。
    lastError = redactSecretText(rawError.trim()) || null;
    latest = "model";
  };

  return {
    status,
    failed(rawError) {
      fail(rawError);
      retryAt = null;
      options.onChange(status());
    },
    retrying(delayMs, rawError) {
      // SDK 在这之前已经为同一次失败发过 message_end（或者马上会发）。这里只记下次重试的时间，
      // 不重复计数；还没记过失败时（SDK 先发重试事件）才计一次。
      if (failures === 0) fail(rawError);
      retryAt = new Date(now().getTime() + Math.max(0, delayMs));
      options.onChange(status());
    },
    networkDown(detail) {
      if (failures > 0 && classifyLeadModelError(lastError ?? "") === "network") return;
      fail(detail);
      retryAt = null;
      options.onChange(status());
    },
    // 探测通过不清掉失败：Lead 不能工作，从最后一次成功的模型调用算起（发布评审 f796c1c 的 B1）。只有 succeeded 清。
    reclassify(detail) {
      if (failures === 0) return;
      lastError = redactSecretText(detail.trim()) || null;
      options.onChange(status());
    },
    compactionFailed(detail) {
      compaction = { since: compaction?.since ?? now(), detail: redactSecretText(detail.trim()) || detail };
      latest = "compaction";
      options.onChange(status());
    },
    patrolled() {
      lastPatrolAt = now();
      options.savePatrol?.(lastPatrolAt);
      options.onChange(status());
    },
    succeeded() {
      lastSuccessAt = now();
      retryAt = null;
      if (failures === 0 && !compaction) return;
      failures = 0;
      since = null;
      lastError = null;
      compaction = null;
      options.onChange(status());
    },
  };
}
