import type { ChannelCardDto } from '@pi-lead-child/protocol';

// 外部来源的会话卡（工单 11）。服务端每次改卡都把版本加 1（spec D16）：客户端只接受更高的版本，旧版本忽略。
// 快照决定有哪些卡；同一张卡快照里的版本比手上的旧时（例如刚做完动作、旧的快照晚到了），留手上的。
export function mergeChannelCardSnapshot(current: readonly ChannelCardDto[], snapshot: readonly ChannelCardDto[]): ChannelCardDto[] {
  const byId = new Map(current.map((card) => [card.id, card]));
  return snapshot.map((card) => {
    const held = byId.get(card.id);
    return held && held.version > card.version ? held : card;
  });
}

// 一张卡的新版本（动作的回应）。版本不比手上的高时不变。新卡排在最后。
export function upsertChannelCard(current: readonly ChannelCardDto[], card: ChannelCardDto): ChannelCardDto[] {
  const index = current.findIndex((candidate) => candidate.id === card.id);
  if (index < 0) return [...current, card];
  if (current[index]!.version >= card.version) return [...current];
  return current.map((candidate, position) => (position === index ? card : candidate));
}

export function sameChannelCards(a: readonly ChannelCardDto[], b: readonly ChannelCardDto[]): boolean {
  return a.length === b.length && a.every((card, index) => card.id === b[index]!.id && card.version === b[index]!.version);
}
