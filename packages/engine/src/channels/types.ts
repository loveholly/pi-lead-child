// 通道接口（Lead 事件主干 spec D2、D14，工单 11）。先例是 runtime adapter（.scratch/runtime-reliability/spec.md D8）：
// 每个外部来源写一个适配器，登记到 registry；内核（hub、闸门、投递、出站）只认这里的接口，不出现任何具体来源的名字。
//
// 一个适配器负责六件事：
//   1. 鉴权：用哪个连接（connections 表里的 provider），或者用哪几个 daemon 专用的密钥（auth.secrets，例如 Socket 连接的令牌）；
//      校验来源推来的请求（verify，例如签名）。进程内的传输（transport，例如一条 Socket 连接）送来的投递不经过 HTTP，不校验签名。
//   2. 身份和去重：每件事的投递编号（deliveryId）。同一次投递只记一次（事件日志的 UNIQUE(source, source_ref)）；
//      两次不同的投递哪怕内容一样也各记一条。
//   3. 对象键：这件事属于哪个对话（objectKey，以来源名开头，例如 <来源>:<频道>:<线程>）。一个对象键一条道、同一时间一张卡。
//   4. 事件类型：适配器自己的事件类型（eventKinds），登记时注册进事件日志。
//   5. 「别处已处理」：用户本人在来源里的动作（role 是 self_reply）。对应的卡自动结束，处置是 resolved_elsewhere。
//   6. 出站动作：回复、撤回。必须幂等：内核每次都带同一个幂等键重试，适配器要保证重复调用在来源里只做一次。
// 来源插件另外提供默认常设指令（打断阈值、投递、代你行动的参数）和回复模板的白名单，
// 还可以声明凭据设置（settings：要哪些密钥、怎么校验、建应用的清单），设置页按它保存密钥、热重连。
import type { ChannelCardState, ChannelSecretsTestResult, EventKindDefinition, SenderTrust } from "@pi-lead-child/protocol";
import type { SystemStandingOrderSeed } from "@pi-lead-child/store";

/** 来源推来的一次投递（例如一次 webhook 请求），原样交给适配器。头的名字都是小写。 */
export interface ChannelDelivery {
  headers: Readonly<Record<string, string>>;
  body: string;
  // 怎样送来的。缺省是推来的请求（要校验签名）。socket：适配器自己的进程内传输（transport）送来的，
  // 只能经 hub 的进程内入口（receiveFromTransport）进来，不校验签名。这个字段由 hub 的入口定，不由投递自己说了算。
  transport?: "socket";
}

/**
 * 来源的凭据：来自 connections 表里这个来源的连接（daemon 用保险库解密），或者来自适配器声明的 daemon 专用密钥
 * （auth.secrets，由适配器的 resolveCredential 换成凭据）。只交给适配器使用，
 * 不能出现在日志、事件、卡片和错误信息里（共享合约测试检查这一点）。
 */
export interface ChannelCredential {
  // 调来源接口用的令牌。
  token: string;
  // 校验来源推来的请求用的签名密钥。只走进程内传输的来源没有它。
  signingSecret?: string;
  // 用户本人在来源里的编号：认出「用户自己」的消息。
  account: string;
  // 用户本人在来源里的名字（例如 Slack 的 real_name）。不知道时没有。
  accountName?: string;
  // 用户本人所在的工作区（组织）：编号和名字。设置页显示「连上的是谁」用。不知道时没有。
  team?: { id: string; name: string };
  // 别的密钥，按适配器声明的名字（例如传输用的另一个令牌）。和 token 一样不能外泄：出站的报错、日志都按它们去掉。
  secrets?: Readonly<Record<string, string>>;
}

/** 按连接的 provider 取凭据。没有这个连接、连接不可用时返回 null。 */
export interface ChannelCredentialSource {
  credential(provider: string): Promise<ChannelCredential | null>;
}

/**
 * 一件事的角色。
 *   message：别人发给用户的消息（私信、提及），要投递给用户。
 *   self_reply：用户本人在来源里说的话。它所在的对话里没结束的卡「别处已处理」。
 *   echo：系统替用户发出去的消息，来源又推回来了。只记进道里，不算用户自己回复。
 *   owner：用户本人在只有自己的对话里写给 Lead 的话（例如 Slack 里发给自己的私信，用户 2026-10-30）。hub 不记成通道的事件，
 *     交给 ChannelHubOptions.owner：daemon 认出是用户本人以后，按用户本人的一轮交给 Lead，和 Companion 的消息一样。
 */
export type ChannelInboundRole = "message" | "self_reply" | "echo" | "owner";

export interface ChannelSender {
  id: string;
  name: string;
  trust: SenderTrust;
  // 发信人是机器人或者自动程序（来源自己的标记，例如消息上的 bot 编号）。机器人的消息内核不问紧急程度（urgency.ts）。
  bot?: boolean;
}

/** 适配器从一次投递里认出的一件事。 */
export interface ChannelInbound {
  // 身份（spec D2）：来源自己的投递编号；没有时用稳定的结构化字段拼出的编号；都没有时为 null（不去重）。
  deliveryId: string | null;
  // 适配器登记过的事件类型。
  kind: string;
  role: ChannelInboundRole;
  // 对话的对象键：以「来源名:」开头。
  objectKey: string;
  // 这个对话叫什么，例如「张三的私信」。
  laneLabel: string;
  occurredAt: string;
  sender: ChannelSender;
  text: string;
  // 回复要发到哪里（出站动作的目标）。
  replyTarget: Record<string, string>;
  // 这条消息自己在来源里的引用（回表情的目标）。来源没有这种引用时没有。
  messageRef?: Record<string, string>;
  // 这条消息在来源里的编号。replyTo.ref 和 history 返回的 ref 用的是同一种编号，hub 靠它在自己的事件里找被回复的那一条。
  messageId?: string;
  // 谁看得到回复：direct 1 对 1 私信；group 群聊；channel 频道（人更多）。授权表和代价分档按它，hub 不读来源自己的字段。
  audience?: "direct" | "group" | "channel";
  // 这条消息回复的是哪一条：被回复的那条在来源里的编号，和它所在的对话（对象键，在适配器自己的名字下）。
  // 不是回复时没有。hub 按它把被回复的那条和前面的回复拼进上下文（例如 Slack 的 thread、Jira 回复评论、邮件的 In-Reply-To）。
  replyTo?: { objectKey: string; ref: string };
  // 进事件 payload 的结构化字段（投递条件可以按它们写，例如频道类型）。只放事实，不放结论：
  // 紧急程度（payload 的 urgent、urgency）只由内核定（urgency.ts），这里有同名的字段也会被内核盖掉。
  fields: Record<string, string | number | boolean | null>;
  // 这件事改的是对话里已有的一条消息：edited 改了（text 是改后的话），deleted 删了。这个对话有没结束的卡时更新这张卡，
  // 不为它开新卡（没有这样的卡时只记录）；没有道时也只记录，不开道（例如订阅频道的线程里删了一条消息，记忆沉淀要知道）。
  // 交给 Lead 时，改了的消息按共用入站层的规则合并（inbound.ts 的 editMergeOf）：按 messageId 认出改的是哪一条。
  amends?: "edited" | "deleted";
  // 用户本人的话（role self_reply）：说了这句话，用户就关注了它所在的对象（照来源自己的规则，例如 Slack 里发起或者回复
  // 一个 thread 就会关注它）。没有道时 hub 照样只记录这条事件（不开道、不进 Lead 的上下文），以后 interest.followed 认它。
  follows?: boolean;
}

/**
 * 出站动作：reply 回复；retract 撤回；edit 改写一条已经发出去的消息（例如用最后的回复覆盖「正在处理」的状态消息）；
 * react 在一条消息上回表情；unreact 撤掉自己回的一个表情（2026-10-26，Lead 换掉回错的表情）。
 * 适配器在 capabilities 里声明能做哪些，做不到的由 hub 降级（不能改写就另发，不能回表情就不做）。capabilities.react 两个都管。
 */
export type ChannelOutboundAction = "reply" | "retract" | "edit" | "react" | "unreact";

/** 一个出站动作。 */
export interface ChannelOutboundRequest {
  action: ChannelOutboundAction;
  objectKey: string;
  // reply：发到哪里（ChannelInbound.replyTarget）。retract、edit：撤回、改写的那条（reply 返回的 remoteRef）。
  // react、unreact：回表情（撤表情）的那条消息（ChannelInbound.messageRef）。
  target: Record<string, string>;
  // 完整的一条消息。带署名时，署名是它的第一行（disclosure.ts）。
  text?: string;
  // 署名和正文分开（spec D8）：有自己样式的来源用它排版（例如署名排成小字、正文分段），
  // 并且照样把 text 作为退路（通知、不显示样式的客户端）。不认识它的来源只发 text，署名也在。
  parts?: { byline: string; body: string | null };
  // react、unreact：表情的名字，不带冒号。
  emoji?: string;
}

/** 一个可以发消息的对话（ChannelAdapter.findConversations）。id 交给 resolveConversation。 */
export interface ChannelConversationCandidate {
  id: string;
  // person：私信这个人；channel：频道；group：群聊。
  kind: "person" | "channel" | "group";
  // 给人看的名字，例如「Oliver Zhou」「#proj-x」。
  label: string;
  // 补充的一句，例如职位、「私有频道」。没有时是 null。
  detail: string | null;
}

/**
 * Lead 代你发出去的一条消息（ChannelHub.sendMessage）。card：这条消息结束了哪张卡（这个对话里等你的、或者 cardId 给的），
 * 现在的状态；没结束时 note 写原因（例如你这一轮开始以后对方又来了消息）。没有相关的卡时是 null。
 */
export interface ChannelSentMessage {
  conversation: string;
  label: string;
  objectKey: string;
  text: string;
  card: { id: number; state: ChannelCardState; note?: string } | null;
  // 出站扩展的结果（统一消息事件 spec D9，工单 05）：sent 照发了；auto_sent 是 Lead 自己的回复或者固定的拒绝，代你发了
  // （auto-reply 署名，留撤回窗口）。reasons：说明，例如这一次没发出去、系统会再试。
  // drafted：交接说明让这条消息先给用户看（做好给你看、交给你、只告诉你，或者婉拒以外的话），Lead 的回复放到卡上等用户点发送，
  // 没有发出去（自动代你处理方案 B，用户 2026-10-30 定 D2）。
  outcome: "sent" | "auto_sent" | "drafted";
  reasons?: string[];
}

/** Lead 代你回的一个表情（ChannelHub.react）：回在哪条消息上（事件编号），卡跟着怎样了（同 ChannelSentMessage.card）。 */
export interface ChannelReaction {
  conversation: string;
  label: string;
  objectKey: string;
  seq: number;
  emoji: string;
  card: { id: number; state: ChannelCardState; note?: string } | null;
}

/**
 * Lead 读的一个对话（ChannelHub.readConversation）：从来源里现取的最近消息，从旧到新。seq 是这条消息在事件日志里的编号
 * （收到过的才有，回表情时可以指定它）。原文是不可信的外部文字。
 */
export interface ChannelConversationRead {
  conversation: string;
  label: string;
  objectKey: string;
  messages: Array<{ at: string; seq: number | null; role: "them" | "me" | "assistant"; sender: string; text: string }>;
}

/** 最近有动静的一个对话（ChannelHub.recentConversations）：只有结构化的事实，没有原文。 */
export interface ChannelRecentConversation {
  id: string;
  label: string;
  updatedAt: string;
  // 道的一行摘要（几条消息、卡的状态）。
  summary: string;
}

/** 还在等你的一张卡（ChannelHub.openCards）：给 Lead 自查，只有结构化的事实。since 是卡上最新一条消息的时间。 */
export interface ChannelOpenCard {
  id: number;
  sender: string;
  conversation: string;
  state: ChannelCardState;
  since: string;
}

/** 发消息的目标（ChannelAdapter.resolveConversation）：对象键（和收到的消息同一个道）、reply 的 target、给人看的名字。 */
export interface ChannelConversationTarget {
  objectKey: string;
  target: Record<string, string>;
  label: string;
  // 适配器给的事实（和收到的消息事件的 audience、externalShared 同一个说法）：发出去会被谁看到、是不是和外部组织共享。
  // 出站检验给没有卡的对话打分时用它（spec D9、D16）。不知道时不给，或者 externalShared 是 null（按外部共享对待）。
  audience?: "direct" | "group" | "channel";
  externalShared?: boolean | null;
}

/** 取历史（ChannelAdapter.history）：按对话取前面的消息，拼上下文用。 */
export interface ChannelHistoryRequest {
  // 对话的对象键（在适配器自己的名字下）。
  objectKey: string;
  // 给了时取这一条和它的回复（例如 thread 的根消息和 thread 里的回复）；没给时取这个对话最近的消息。
  ref?: string;
  // 最多几条。
  limit: number;
}

/** 取回来的一条消息。只读，只当上下文用：不开卡，不触发判断。原文是不可信的。 */
export interface ChannelHistoryMessage {
  // 这条消息在来源里的编号。
  ref: string;
  at: string;
  // them：别人说的；me：用户本人说的；assistant：系统替用户发的。
  role: "them" | "me" | "assistant";
  sender: { id: string; name: string };
  text: string;
}

/**
 * 出站动作的目标已经没了（例如要改写的消息被删了、不能再改了）：再试也一样。hub 收到它时换一种做法（改写不了就另发一条），
 * 别的错误当作临时的，下一拍用同一个幂等键再试。
 */
export class ChannelTargetGoneError extends Error {
  readonly code = "target_gone";
}

export interface ChannelOutboundResult {
  // 来源里的引用（例如发出去的消息编号），撤回时用。
  remoteRef: Record<string, string>;
  // true：同一个幂等键以前已经做过，这一次没有在来源里再做一次。
  duplicate: boolean;
}

/**
 * hub 告诉适配器的、和来源无关的事实（通用地用 channel_lanes 实现）。适配器据此决定一条消息算不算和用户有关，
 * 例如线程里没有提到用户的后续消息：这个线程已经有道才收。
 */
export interface ChannelInterest {
  // 这个对象键（必须在适配器自己的名字下）有没有道。
  laneExists(objectKey: string): boolean;
  // 以 prefix（必须在适配器自己的名字下）开头的对象键里，sinceMs（毫秒时间戳）以后有没有更新过的道。
  recentLaneUnder(prefix: string, sinceMs: number): boolean;
  // 用户关注了这个对象（必须在适配器自己的名字下）：用户在里面说过话（记了用户本人的话）。没有道也算。
  // 适配器照来源自己的关注规则用它（例如 Slack：发起或者回复过的 thread，见 ChannelInbound.follows）。
  followed(objectKey: string): boolean;
}

export interface ChannelAdapterContext {
  credential: ChannelCredential;
  log(line: string): void;
  // hub 总是给。直接调用适配器的测试可以不给：当作没有任何道。
  interest?: ChannelInterest;
}

/** 一条还有没结束的卡的道（传输重连以后补拉用）。 */
export interface ChannelOpenLane {
  objectKey: string;
  // 这条道里这个来源最后一条事件的 payload（适配器自己的字段在里面，例如消息的时间戳）。没有时是 null。
  lastPayload: Record<string, unknown> | null;
}

/**
 * 传输的连接状态（设置页的通道状态用）。
 *   connecting：正在连（第一次连，或者断了以后重连）；
 *   connected：连上了；
 *   error：连不上，过一会儿再试。error 是给人看的一句话，不含凭据。
 */
export type ChannelTransportStatus =
  | { state: "connecting" }
  | { state: "connected" }
  | { state: "error"; error: string };

/** hub 给适配器的传输（transport）的东西。 */
export interface ChannelTransportContext {
  // 当前的凭据（每次连接之前取一次：密钥可能换了）。凭据不可用时是 null。
  context(): Promise<ChannelAdapterContext | null>;
  // 有没结束的卡的道，最近更新的在前，最多 limit 条。
  openLanes(limit: number): ChannelOpenLane[];
  // 日志：hub 加上来源名，去掉凭据。
  log(line: string): void;
  // 连接的状态变了。daemon 记下来给设置页看；hub 自己的 transportContext 不给。
  status?(update: ChannelTransportStatus): void;
}

/** 传输把一次投递交给 hub 的进程内入口。不抛错。 */
export type ChannelTransportDeliver = (delivery: ChannelDelivery) => Promise<unknown>;

/**
 * 适配器自己的进程内传输（例如一条 Socket 连接）：daemon 的 startChannels 启动，停机时停。
 * 设置页改了凭据以后，daemon 先 stop 再 start（热重连）：停了以后要能再开。
 * 投递交给 deliver（hub 的进程内入口，不校验签名）。
 */
export interface ChannelTransport {
  start(context: ChannelTransportContext, deliver: ChannelTransportDeliver): void;
  // 停下：关掉连接，等已经收下的投递交完。
  stop(): Promise<void>;
}

/** 来源要的一个密钥（设置页的一行输入框）。name 要在 auth.secrets 里。 */
export interface ChannelSecretSpec {
  // 密钥的名字（daemon 专用的环境变量名，也是 Keychain 里的名字）。
  name: string;
  // 给人看的名字。
  label: string;
  // 应该以什么开头（界面提示用；校验在 test 里做）。
  prefix: string;
  // 在哪里生成它（给人看的一句话）。
  hint: string;
}

/**
 * 来源的凭据设置（设置页「消息通道」，protocol 的 channel-settings.ts）。来源插件声明要哪些密钥、怎么校验、
 * 建应用用的清单；daemon 按这里的声明保存密钥、校验、热重连，内核不认识具体的来源。
 */
export interface ChannelSettingsSpec {
  // 要哪些密钥。名字要和 auth.secrets 一一对应。
  readonly secrets: readonly ChannelSecretSpec[];
  // 建应用用的清单（例如 YAML），给「复制」按钮。没有时是 null。
  readonly manifest: string | null;
  // 建应用的网页。没有时是 null。
  readonly setupUrl: string | null;
  /**
   * 用给的密钥（按名字）做一遍检查：格式、来源认不认、是不是用户本人的、权限够不够。不保存，不建长连接。
   * daemon 先把请求里没给的密钥用现在生效的值补上（保险库 → 环境变量 → Keychain），所以这里缺的就是哪里都没有：
   * 那一项不通过，说明「缺 <label>」。结果里的文字不含密钥。不抛错：连不上来源时那一项不通过，并说明原因。
   */
  test(secrets: Readonly<Record<string, string>>, context: { log(line: string): void }): Promise<ChannelSecretsTestResult>;
}

/**
 * 记忆沉淀（slack-takeover 工单 07，spec D12）：来源里哪些对话可以整理成事实笔记。内核（channels/memory.ts）按对象键
 * 把下面这些类型的事件分成对话，一个对话一条笔记；它只读事件日志，不再调来源的接口。来源的知识（哪种对话可以沉淀、
 * 排除名单、消息的编号在 payload 的哪个字段）都在这里，内核不认识具体的来源。
 */
export interface ChannelMemorySpec {
  // 算进记忆沉淀的事件类型（要是这个适配器登记过的）和它们的作用：message 是一条消息；edited 是改了一条消息
  // （text 是改后的文字）；deleted 是删了一条消息。改和删按 messageRef 认出是哪一条。
  readonly kinds: Readonly<Record<string, "message" | "edited" | "deleted">>;
  // 事件说的是来源里的哪一条消息（message 是它自己，edited、deleted 是被改、被删的那一条）。认不出时是 null，这条事件不用。
  messageRef(payload: Readonly<Record<string, unknown>>): string | null;
  // 这条事件所在的对话能不能沉淀（例如私信不沉淀、排除名单里的频道不沉淀）。一个对话里有一条不能沉淀，整个对话就不沉淀。
  accepts(payload: Readonly<Record<string, unknown>>): boolean;
  // 对话的名字（笔记的标题用），例如「#proj-x」。
  conversationName(payload: Readonly<Record<string, unknown>>): string;
}

export interface ChannelAdapter {
  // 来源名：事件日志的 source，也是对象键的前缀。
  readonly id: string;
  // 给人看的名字。
  readonly label: string;
  // conversation：对话型，代你行动的方式是回复；signal：信号型，代你行动的方式是执行操作（以后的工单）。
  readonly kind: "conversation" | "signal";
  readonly auth: {
    connectionProvider: string;
    // 这个来源要的 daemon 专用密钥的名字（环境变量或 Keychain）。声明了的来源不用 connections 表的连接：daemon 按名字取到全部密钥，
    // 交给 resolveCredential 换成凭据。名字要在 core 的 DAEMON_ONLY_ENV_NAMES 里（child 拿不到）。
    secrets?: readonly string[];
  };
  // 能做的出站动作和能不能取历史。edit、react、history 不写时当作不能。
  readonly capabilities: { reply: boolean; retract: boolean; edit?: boolean; react?: boolean; history?: boolean };
  readonly eventKinds: readonly EventKindDefinition[];
  readonly standingOrders: readonly SystemStandingOrderSeed[];
  /** 鉴权：这次投递是不是真的来自这个来源（例如签名对不对、时间戳新不新）。 */
  verify(delivery: ChannelDelivery, context: ChannelAdapterContext): boolean;
  /** 从一次投递里认出几件事。和用户无关的（例如别人之间的闲聊）不返回。 */
  parse(delivery: ChannelDelivery, context: ChannelAdapterContext): Promise<ChannelInbound[]>;
  /** 出站动作。同一个幂等键重复调用，在来源里只做一次。 */
  send(request: ChannelOutboundRequest, options: { idempotencyKey: string }, context: ChannelAdapterContext): Promise<ChannelOutboundResult>;
  /** 只读：取一个对话前面的消息，从旧到新。capabilities.history 为 true 时才有。取不到时抛错，hub 用已有的上下文。 */
  history?(request: ChannelHistoryRequest, context: ChannelAdapterContext): Promise<ChannelHistoryMessage[]>;
  /** 只读：按人名、对话名找可以发消息的对话（Lead 代用户直接发消息，2026-10-23）。不支持时没有。 */
  findConversations?(query: string, context: ChannelAdapterContext): Promise<ChannelConversationCandidate[]>;
  /**
   * 把一个对话编号（findConversations 给的，或者收到的消息的对象键）换成发消息的目标。编号不对、找不到时抛错，
   * 错误的话是给人看的原因。和 findConversations 一起有。
   */
  resolveConversation?(id: string, context: ChannelAdapterContext): Promise<ChannelConversationTarget>;
  /**
   * 回给用户本人的话（role owner 的那一轮的回复）换成来源自己的格式。Lead 按 Markdown 写；例如 Slack 的 mrkdwn 粗体是 *x*、
   * 链接是 <url|文字>。没有时原样发。
   */
  ownerReplyText?(markdown: string): string;
  /**
   * 把 auth.secrets 声明的密钥（按名字）换成凭据，例如问来源「这个令牌是谁的」。换不成（令牌不对、来源不可用）时返回 null。
   * 日志里不能写密钥。
   */
  resolveCredential?(secrets: Readonly<Record<string, string>>, log: (line: string) => void): Promise<ChannelCredential | null>;
  /** 进程内的传输。没有时，投递只能由别的地方推进来（hub.receive）。 */
  readonly transport?: ChannelTransport;
  /** 凭据设置（设置页）。声明了的来源，生产入口总是登记：没有密钥时传输不启动，用户在设置页存了密钥以后马上连上。 */
  readonly settings?: ChannelSettingsSpec;
  /** 记忆沉淀（channels/memory.ts）。没有时这个来源的对话不沉淀。 */
  readonly memory?: ChannelMemorySpec;
  /**
   * 署名里放在助手名前面的标记，用这个来源自己的写法（例如来源里的自定义 emoji 的短代码）。没有时不加。
   * 只用在发到这个来源的署名里（hub 的 disclosure.ts）；发到别处的（例如 PR 上的 review）不加。
   * 适配器可以用 getter 每次现算（设置页改了以后，下一条消息就用新的）：hub 每发一条消息读一次。
   */
  readonly disclosureMark?: string | null;
  /**
   * 只读：一个署名标记（disclosureMark 的写法）在来源里是什么样子，给设置页预览（Lead 的形象，2026-10-28）。
   * 不抛错：查不了时返回 unavailable，reason 是给人看的原因（不含凭据）。不支持时没有。
   */
  lookupDisclosureMark?(mark: string, context: ChannelAdapterContext): Promise<ChannelMarkLookup>;
}

/** 署名标记在来源里的样子：custom 是来源里的自定义图（imageUrl 只会是 https 地址）；not_found 是来源里没有这个自定义的标记。 */
export type ChannelMarkLookup =
  | { status: "custom"; imageUrl: string }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

/** 设置页的署名预览（hub 的 previewDisclosureMark）：标记的样子，加上自动回复的署名文字（不带标记，和真的发出去的一样）。 */
export type ChannelMarkPreview = ChannelMarkLookup & { byline: string };
