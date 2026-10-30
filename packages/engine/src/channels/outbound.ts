// 通道的出站动作（Lead 事件主干 spec D14，工单 11）：回复、撤回、改写、回表情。必须幂等。
//
// 照 runtime-reliability 的「effect sandwich」：先提交意图，再做外部动作，最后提交结果。记账都是事件（来源 system）：
//   1. 同一个幂等键已经有 channel.outbound.completed：直接返回它的结果，不再调用适配器；
//   2. 记 channel.outbound.requested（同一个键只记一条，source_ref 去重）；
//   3. 调用适配器，带上幂等键。适配器保证同一个键在来源里只做一次：进程在第 3 步和第 4 步之间崩溃时，
//      下一次用同一个键重试，适配器认出它已经做过（返回 duplicate），来源里不会多一条；
//   4. 记 channel.outbound.completed（同一个键只有一条），或者 channel.outbound.failed（每次失败一条，带根因）。
// 同一个进程里同一个键同时调用两次（例如连点两下）：第二次等第一次的结果，不并发调用适配器。
// 错误信息先去掉凭据再记：适配器的报错可能带着请求的内容。
import { CHANNEL_EVENT_KINDS, redactSecretText } from "@pi-lead-child/protocol";
import { appendEvent, clipEventText, type Db } from "@pi-lead-child/store";
import { ChannelTargetGoneError, type ChannelAdapter, type ChannelAdapterContext, type ChannelOutboundRequest } from "./types.js";

export type ChannelOutboundPurpose = "user_reply" | "auto_reply" | "retract" | "handling_notice" | "reaction";

export interface ChannelOutboundOutcome {
  // sent：这一次做成了；already_sent：这个键以前做成过，这一次没有调用适配器；failed：这一次没做成。
  status: "sent" | "already_sent" | "failed";
  remoteRef: Record<string, string> | null;
  // 适配器说来源里已经有了（崩溃后的重试）。
  duplicate: boolean;
  error: string | null;
  // 这个键失败过几次（含这一次）。
  failures: number;
  // 失败是因为目标已经没了（ChannelTargetGoneError）：再试也一样，调用方要换一种做法。
  targetGone?: boolean;
}

const refBase = (adapterId: string, key: string) => `channel-outbound:${adapterId}:${key}`;

/** 去掉文字里的凭据：先把这个来源的令牌、签名密钥和别的密钥（例如传输用的令牌）原样换掉，再按通用的规则脱敏。 */
export function scrubCredential(text: string, context: Pick<ChannelAdapterContext, "credential"> | null): string {
  let result = text;
  const credential = context?.credential;
  const secrets = credential ? [credential.token, credential.signingSecret, ...Object.values(credential.secrets ?? {})] : [];
  for (const secret of secrets) {
    if (secret && secret.length >= 4) result = result.split(secret).join("[凭据]");
  }
  return redactSecretText(result);
}

export class ChannelOutbox {
  private readonly inFlight = new Map<string, Promise<ChannelOutboundOutcome>>();

  constructor(private readonly options: { db: Db; now: () => Date; log: (line: string) => void }) {}

  /** 这个键以前做成过的结果。没有时是 null。 */
  completed(adapterId: string, key: string): { remoteRef: Record<string, string>; duplicate: boolean } | null {
    const row = this.options.db.prepare("SELECT payload FROM events WHERE source = 'system' AND source_ref = ?")
      .get(`${refBase(adapterId, key)}:done`) as { payload: string } | undefined;
    if (!row) return null;
    const payload = JSON.parse(row.payload) as { remoteRef?: Record<string, string>; duplicate?: boolean };
    return { remoteRef: payload.remoteRef ?? {}, duplicate: Boolean(payload.duplicate) };
  }

  /** 这个键失败过几次。 */
  failures(adapterId: string, key: string): number {
    return (this.options.db.prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'system' AND source_ref LIKE ? ESCAPE '\\'")
      .get(`${escapeLike(refBase(adapterId, key))}:failed:%`) as { n: number }).n;
  }

  /** 做一个出站动作（幂等）。不抛错：失败记一条事件，返回 failed。 */
  perform(
    adapter: ChannelAdapter, context: ChannelAdapterContext,
    input: { key: string; purpose: ChannelOutboundPurpose; cardId: number | null; request: ChannelOutboundRequest },
  ): Promise<ChannelOutboundOutcome> {
    const lockKey = `${adapter.id}\u0000${input.key}`;
    const running = this.inFlight.get(lockKey);
    if (running) return running;
    const promise = this.run(adapter, context, input).finally(() => this.inFlight.delete(lockKey));
    this.inFlight.set(lockKey, promise);
    return promise;
  }

  private async run(
    adapter: ChannelAdapter, context: ChannelAdapterContext,
    input: { key: string; purpose: ChannelOutboundPurpose; cardId: number | null; request: ChannelOutboundRequest },
  ): Promise<ChannelOutboundOutcome> {
    const { db, now, log } = this.options;
    const base = refBase(adapter.id, input.key);
    const common = { channel: adapter.id, key: input.key, action: input.request.action, cardId: input.cardId };
    const done = this.completed(adapter.id, input.key);
    if (done) return { status: "already_sent", remoteRef: done.remoteRef, duplicate: done.duplicate, error: null, failures: 0 };
    db.transaction(() => {
      appendEvent(db, {
        source: "system", sourceRef: base, kind: CHANNEL_EVENT_KINDS.outboundRequested, entityKey: input.request.objectKey,
        correlationId: `channel:${input.request.objectKey}`, level: "record", occurredAt: now().toISOString(),
        payload: {
          ...common, purpose: input.purpose, target: input.request.target,
          ...(input.request.text !== undefined ? { text: clipEventText(input.request.text, 4_000) } : {}),
          ...(input.request.emoji !== undefined ? { emoji: input.request.emoji } : {}),
        },
      });
    })();
    try {
      const result = await adapter.send(input.request, { idempotencyKey: input.key }, context);
      db.transaction(() => {
        appendEvent(db, {
          source: "system", sourceRef: `${base}:done`, kind: CHANNEL_EVENT_KINDS.outboundCompleted,
          entityKey: input.request.objectKey, correlationId: `channel:${input.request.objectKey}`, level: "record",
          occurredAt: now().toISOString(),
          payload: { ...common, remoteRef: result.remoteRef, duplicate: result.duplicate },
        });
      })();
      return { status: "sent", remoteRef: result.remoteRef, duplicate: result.duplicate, error: null, failures: 0 };
    } catch (error) {
      const message = clipEventText(scrubCredential(error instanceof Error ? error.message : String(error), context), 500);
      const attempt = this.failures(adapter.id, input.key) + 1;
      db.transaction(() => {
        appendEvent(db, {
          source: "system", sourceRef: `${base}:failed:${attempt}`, kind: CHANNEL_EVENT_KINDS.outboundFailed,
          entityKey: input.request.objectKey, correlationId: `channel:${input.request.objectKey}`, level: "record",
          occurredAt: now().toISOString(),
          payload: { ...common, attempt, error: message },
          rootCause: {
            code: "channel_outbound_failed", scope: "channel", message,
            next_step: "系统会用同一个幂等键再试；来源里不会多发", retry: "backoff",
          },
        });
      })();
      log(`[channels] ${adapter.id} ${input.request.action} ${input.key} failed (attempt ${attempt}): ${message}`);
      const targetGone = error instanceof ChannelTargetGoneError || (error as { code?: unknown } | null)?.code === "target_gone";
      return { status: "failed", remoteRef: null, duplicate: false, error: message, failures: attempt, ...(targetGone ? { targetGone } : {}) };
    }
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}
