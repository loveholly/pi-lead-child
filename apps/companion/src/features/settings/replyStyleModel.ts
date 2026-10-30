// 设置 → 消息通道 → 代回复风格（2026-10-28）的纯函数：字数、追加以后的整段、依据的一句话、错误的说法。
// 追加以后的整段和长度检查用 protocol 的同一套函数（nextReplyStyleText、replyStyleProblem），和 daemon 算的一样。
import {
  REPLY_STYLE_EXTRACT_DAY_CHOICES, REPLY_STYLE_TEXT_MAX_LENGTH, nextReplyStyleText, normalizeReplyStyleText, replyStyleLength, replyStyleProblem,
  type ReplyStyleDto, type ReplyStyleExtractResult,
} from '@pi-lead-child/protocol';

export const REPLY_STYLE_DAY_OPTIONS = REPLY_STYLE_EXTRACT_DAY_CHOICES.map((days) => ({ value: String(days), label: `${days} 天` }));

export const REPLY_STYLE_PLACEHOLDER = '例如：极其精简，不寒暄；确认只说「好」「没问题」；对方回 ok 时回 :heart:。';

/** 框里的字数一行：「120 / 2000 字」。 */
export function replyStyleCountLine(text: string): string {
  return `${replyStyleLength(normalizeReplyStyleText(text))} / ${REPLY_STYLE_TEXT_MAX_LENGTH} 字`;
}

/** 框里的字有没有改过（按整理以后的文字比）。 */
export function replyStyleChanged(draft: string, saved: ReplyStyleDto): boolean {
  return normalizeReplyStyleText(draft) !== saved.text;
}

/** 追加以后的整段有什么问题（例如超了上限）。没有问题时返回 null。 */
export function replyStyleAppendProblem(saved: ReplyStyleDto, addition: string, label: string, now: Date): string | null {
  const request = { mode: 'append' as const, text: addition, label };
  return replyStyleProblem(request, nextReplyStyleText(saved.text, request, now));
}

/** 追加以后的总字数。 */
export function replyStyleAppendedLength(saved: ReplyStyleDto, addition: string, label: string, now: Date): number {
  return replyStyleLength(nextReplyStyleText(saved.text, { mode: 'append', text: addition, label }, now));
}

const day = (iso: string | null): string | null => {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};

/** 依据的一句话：「依据：你本人的 87 条消息，30 个对话，10-21 到 10-28。去掉了 2 行（抄了原文或者带着人名）。」 */
export function replyStyleBasisLine(result: ReplyStyleExtractResult): string {
  const { basis } = result;
  const from = day(basis.from);
  const to = day(basis.to);
  const span = from && to ? (from === to ? `，${from}` : `，${from} 到 ${to}`) : '';
  const dropped = result.dropped ? `去掉了 ${result.dropped} 行（抄了原文或者带着人名）。` : '';
  return `依据：最近 ${basis.days} 天你本人的 ${basis.messages} 条消息，${basis.conversations} 个对话${span}。${dropped}`;
}

/** 保存和提炼失败时给人看的一句话。 */
export function replyStyleErrorText(reason: unknown): string {
  const status = typeof reason === 'object' && reason !== null && 'status' in reason ? (reason as { status?: unknown }).status : undefined;
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  if (status === 403) return '这台设备不能改：要在主人的设备上改。';
  if (status === 400) return message || '内容不对，请检查以后再试。';
  if (status === 409) return `现在不能做：${message || '请再试一次'}`;
  if (message === 'this client cannot manage channel settings') return '这个版本的客户端不能改代回复风格。';
  return message || '请求没有完成，请再试一次。';
}
