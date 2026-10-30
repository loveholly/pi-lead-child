// render_ui 的 Message：引用别人在外部通道里说的话（genui v3 积木 7，2026-10-27）。
//
// 别人的话只能引用，不能手写：Lead 只给外部消息卡的编号，这里从这张卡的对话（channel_lanes.context）里取
// 对方说的那几条（seq 在卡的 first_seq 到 last_seq 之间），写进 sender、messages 和 total。Lead 写不出一条假的「同事说的话」。
// 取不到（卡不在、对话里没有对方的消息）时报错，Lead 收到原因。原文先脱敏，再按上限截断。
import { redactSecretText, UI_COMPONENT_LIMITS } from "@pi-lead-child/protocol";
import { getChannelCard, getChannelLaneById, type Db } from "@pi-lead-child/store";

export const CHANNEL_MESSAGE_TEXT_MAX = 500;
// stack 不给 show 时叠几条。
const DEFAULT_STACK = 3;

export interface ChannelMessageReference {
  ref: { type: "channel_card"; id: number };
  mode: "latest" | "stack";
  show?: number;
}

export interface ResolvedChannelMessages {
  sender: string;
  messages: Array<{ at: string; text: string }>;
  total: number;
}

export function resolveChannelMessages(db: Db, reference: ChannelMessageReference): ResolvedChannelMessages {
  const card = getChannelCard(db, reference.ref.id);
  if (!card) throw new Error(`Message 指向的外部消息卡 #${reference.ref.id} 不存在`);
  const lane = getChannelLaneById(db, card.laneId);
  const theirs = (lane?.context ?? []).filter((message) =>
    message.role === "them" && message.seq !== null && message.seq >= card.firstSeq && message.seq <= card.lastSeq);
  // 对话里只留最近的 20 条：卡的消息都被挤出去时，退回卡上的摘录（最新一条）。
  const found = theirs.length ? theirs : [{ at: card.updatedAt, text: card.excerpt }];
  const count = reference.mode === "latest" ? 1 : Math.min(reference.show ?? DEFAULT_STACK, UI_COMPONENT_LIMITS.messageShow);
  const messages = found.slice(-count).map((message) => {
    const clean = redactSecretText(message.text.trim()) || "（空消息）";
    return { at: message.at, text: clean.length > CHANNEL_MESSAGE_TEXT_MAX ? `${clean.slice(0, CHANNEL_MESSAGE_TEXT_MAX - 1)}…` : clean };
  });
  return { sender: card.sender.name || "对方", messages, total: Math.max(card.messageCount, found.length) };
}

/** 不能显示卡片的地方看到的文字：Lead 写的 fallback 后面加上「发信人：最新一条」，不超过 max。 */
export function fallbackWithMessages(fallback: string, resolved: readonly ResolvedChannelMessages[], max: number): string {
  let out = fallback.trim();
  for (const entry of resolved) {
    const latest = entry.messages.at(-1);
    if (!latest) continue;
    const block = `\n\n${entry.sender}：${latest.text}`;
    const room = max - out.length;
    if (room <= 20) break;
    out += block.length <= room ? block : `${block.slice(0, room - 1)}…`;
  }
  return out;
}
