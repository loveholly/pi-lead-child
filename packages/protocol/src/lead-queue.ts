// Lead 忙时排着的外部消息（统一消息事件 spec D6、D12，工单 10）。
// Lead 只有一个会话。它正在一轮里时，外部通道的消息事件（message.received）只排队，不插进这一轮（2026-10-17 定的）。
// 这一轮结束以后，Lead 按顺序处理排着的消息：同一个对话里排着的几条合成一次处理，取 Lead 开始处理时排着的全部，不额外等。
// 用户在主对话输入框上方的状态栏里看到排着几条、是谁发的；点开在原地展开一个固定的面板，每个对话可以：
//   打开卡自己处理（只是在界面上打开那张卡）；排到下一个（操作层的 lead_queue / move_next）；
//   移出队列（lead_queue / remove：用户自己处理，卡结束，Lead 不再处理）。
// 排队的信息从 daemon 经网关推给 Companion：网关发 snapshot.required（resource 是 lead-queue，只发给声明了
// include=lead_queue 的连接），客户端再 GET /v1/lead/queue。Web 和 iOS 用同一个接口。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

/** 网关的选收事件名：连接时声明 include=lead_queue 才会收到排队变化的推送（protocol 的 gatewayEventOptIn）。 */
export const LEAD_QUEUE_OPT_IN = "lead_queue";
/** snapshot.required 的 resource：排队变了（Lead 开始或结束一轮，消息进来、交给 Lead、移出队列、换了顺序）。 */
export const LEAD_QUEUE_RESOURCE = "lead-queue";
/** 面板上露出的对方的话最多这么多字（超出的截断，加「…」）。 */
export const LEAD_QUEUE_EXCERPT_MAX = 200;

// 排着的一个对话：Lead 会一次处理的那几条消息。
export const LeadQueueEntrySchema = StrictObject({
  // 对话的对象键，例如 slack:@U123。也是操作层 lead_queue 的目标编号。
  key: Type.String({ minLength: 1 }),
  // 对话的名字，例如「李雷的私信」。
  conversation: Type.String(),
  // 来源和它给人看的名字（slack、Slack）。
  source: Type.String({ minLength: 1 }),
  sourceLabel: Type.String(),
  // 发信人，按先后去重。
  senders: Type.Array(Type.String()),
  // 排着几条消息。改过的消息并进原来那条，算一条。
  count: Type.Integer({ minimum: 1 }),
  // 最新一条的原话（外部的文字，只给人看），截到 LEAD_QUEUE_EXCERPT_MAX 字。
  excerpt: Type.String(),
  // 这几条消息所在的会话卡（打开卡自己处理用）。
  cardIds: Type.Array(Type.Integer({ minimum: 1 })),
  // 最早一条和最新一条进来的时间（ISO）。
  firstAt: Type.String(),
  lastAt: Type.String(),
  // Lead 下一轮就处理它（排在所有要处理的事的最前面）。
  next: Type.Boolean(),
  // 现在能做的操作（操作层 lead_queue 的动作，和 available 是同一个判断）。
  actions: Type.Array(Type.Union([Type.Literal("move_next"), Type.Literal("remove")])),
});
export type LeadQueueEntry = Static<typeof LeadQueueEntrySchema>;
export type LeadQueueAction = LeadQueueEntry["actions"][number];

// GET /v1/lead/queue 的回答。
export const LeadQueueSchema = StrictObject({
  // Lead 正在一轮里。
  busy: Type.Boolean(),
  // 排着的对话，按 Lead 处理的顺序。
  entries: Type.Array(LeadQueueEntrySchema),
});
export type LeadQueue = Static<typeof LeadQueueSchema>;

// POST /v1/lead/queue/move_next、/v1/lead/queue/remove 的请求体：哪个对话。
export const LeadQueueActionRequestSchema = StrictObject({ key: Type.String({ minLength: 1, maxLength: 300 }) });
export type LeadQueueActionRequest = Static<typeof LeadQueueActionRequestSchema>;

/** 状态栏显示不显示：Lead 正在一轮里，而且有外部消息排着。 */
export function leadQueueVisible(queue: LeadQueue | null | undefined): boolean {
  return Boolean(queue?.busy && queue.entries.length > 0);
}

/** 状态栏上的那一句：排着几条，是谁发的（按排队的顺序去重）。例如「排队 2 条：李雷、Kent」。 */
export function leadQueueSummary(queue: Pick<LeadQueue, "entries">): string {
  const count = queue.entries.reduce((sum, entry) => sum + entry.count, 0);
  const senders = [...new Set(queue.entries.flatMap((entry) => entry.senders))];
  return `排队 ${count} 条：${senders.join("、")}`;
}
