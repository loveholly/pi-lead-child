// 测试用：一次投递的那条消息现在在哪张卡上。要开新卡的消息先判断要不要用户回，再开卡（hub 的 settlePendingCard），
// 所以 receive 返回时 cardId 可能还是 null：等 hub.idle() 以后找包着这条消息的卡（first_seq ≤ seq ≤ last_seq）。
// 同一个对话里以前结束的卡不算。
import { listChannelCardsForObject, type Db } from "@pi-lead-child/store";

export function cardIdOf(db: Db, item: { cardId: number | null; objectKey: string; seq: number | null }): number | null {
  if (item.cardId !== null) return item.cardId;
  if (item.seq === null) return null;
  const seq = item.seq;
  return listChannelCardsForObject(db, item.objectKey).filter((card) => card.firstSeq <= seq && card.lastSeq >= seq).at(-1)?.id ?? null;
}
