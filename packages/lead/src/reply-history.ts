// A model that continues its own input writes a made-up next round (<system_event> and friends) after its answer.
// The conversation already hides it (protocol's reply-guard.ts). This extension also removes it from the session itself:
// the message is stored and sent to the model again on every later request, and a model that reads its own made-up
// envelopes in the history tends to write them again.
//
// A quiet reply (only NO_REPLY) is not touched: it is a normal, short assistant message, and it shows the model what a
// quiet round looks like.
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { hasForgedEnvelope, QUIET_REPLY, sanitizeLeadReply } from "@pi-lead-child/protocol";

type Block = { type?: string; text?: unknown };
type AssistantLike = { role?: string; content?: unknown };

// The message without its made-up envelopes, or null when nothing needs to change.
export function withoutForgedEnvelopes<T extends AssistantLike>(message: T): T | null {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return null;
  const blocks = message.content as Block[];
  if (!blocks.some((block) => block?.type === "text" && typeof block.text === "string" && hasForgedEnvelope(block.text))) return null;

  const cleaned: Block[] = [];
  for (const block of blocks) {
    if (block?.type !== "text" || typeof block.text !== "string" || !hasForgedEnvelope(block.text)) {
      cleaned.push(block);
      continue;
    }
    const { text } = sanitizeLeadReply(block.text);
    if (text) cleaned.push({ ...block, text });
  }
  // A message with no content is rejected by some providers. Keep the quiet word as its text.
  if (cleaned.length === 0) cleaned.push({ type: "text", text: QUIET_REPLY });
  return { ...message, content: cleaned };
}

export const replyHistoryExtension: ExtensionFactory = (pi) => {
  pi.on("message_end", (event) => {
    const message = withoutForgedEnvelopes(event.message as AssistantLike);
    return message ? { message: message as never } : undefined;
  });
};
