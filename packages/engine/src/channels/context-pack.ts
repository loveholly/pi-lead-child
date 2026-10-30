// 外部消息的上下文包（unified-message-events spec D5，工单 04）。外部消息事件交给 Lead 以前，代码按统一的规则拼好上下文，
// Lead 不用先读卡、再读对话（10-26：Ethan 的 PR 链接在三天前的消息里，李雷问的答案在用户和 Ivy 的私信里，Lead 都没看到）。
// 一共五项：
//   1. 这个对话最近的消息：事件日志里这个对话的消息（别人的、用户本人的、替用户发的，按消息编号应用改和删），加上道的起点
//      （thread 的根消息和它之前的几条，开道时补的）。最多 20 条或 4000 字（fitConversation），更早的交给记忆沉淀的整理器
//      写成对话摘要（memory.ts 的 summarizeChannelMessages）。摘要按对话缓存在 kv 里，更早的那一段没变时不再问模型。
//   2. 同一件事在别的对话里的消息，三个条件：同一个人（7 天内）；用户最近 30 分钟说的；提到同一个对象（7 天内）。
//      满足的条件多的、新的在前。时间按来源给的消息时间（occurred_at），和这条消息的时间比：两边是同一个时钟。
//      在事件日志里找，不限于有道的对话：例如用户在频道的 thread 里说的话，没有道也记在日志里（hub 的 followOnly）。
//   3. 提到的对象：PR（hub 的 pullRequestOf，只认明确的语法）、Jira（浏览链接）、仓库（请求 A 的候选仓库的名字、
//      GitHub 的仓库链接）。每个附一行现在的状态（daemon 给的 objectStatus）。查不到时 status 是 null（给 Lead 写「没查到」）。
//   4. 这个对话以前的卡：开头的那条消息、结局、发出去的回复、Lead 的决定和备注、代查（子 agent 工单）的结果。
//   5. 记忆里和发信人、话题有关的笔记：这个对话的事实笔记；按话题（提到的对象、原话里的英文词）和按发信人分开查全文，
//      再合并；加上 daemon 给的语义召回（recallNotes，只给原话）。常驻的画像和偏好不放：Lead 本来就有。
// 消息改了（编辑并进排着的消息事件，或者拼的时候又改了）：按改后的话同步重拼和话有关的几项（repackForText）。
// 拼的时间有上限（timeoutMs）：要等的几项（对话摘要、对象的状态、召回）和上限赛跑，到了上限先交给 Lead，missing 写明缺了
// 哪几项；对话摘要在后台接着写完、存进缓存，下一次用。读库的几项是同步的，出错时也记成缺了。buildContextPack 不抛错。
// 内容都是外部的：交给 Lead 时每一段都包在外部标签里（lead 的 envelope.ts）。这个文件不写任何具体来源的名字。
import {
  CHANNEL_EVENT_KINDS, MESSAGE_CONTEXT_LIMITS, MESSAGE_CONTEXT_PARTS, MESSAGE_CONTEXT_VERSION,
  type MessageContext, type MessageContextCard, type MessageContextMessage, type MessageContextNote, type MessageContextObject,
  type MessageContextObjectKind, type MessageContextPart, type MessageContextRelated, type MessageContextRelatedReason,
} from "@pi-lead-child/protocol";
import {
  CORE_KINDS, getChannelLane, getEvent, getLatestLookupForCard, listChannelCardsForObject, notesWithTag, searchNotes,
  type ChannelCard, type ChannelLane, type Db, type EventRecord, type Note,
} from "@pi-lead-child/store";
import { deadline, errorText } from "../smart-model/deadline.js";
import type { SmartTextComplete } from "../smart-model/types.js";
import { summarizeChannelMessages } from "./memory.js";

/** 对话摘要问模型时的用途（decision_model.called 和 get_system_usage 按它统计）。 */
export const MESSAGE_CONTEXT_SUMMARY_PURPOSE = "message_context";
/** 拼上下文包的时间上限（缺省）。到了先交给 Lead，标明缺了哪几项。 */
export const CONTEXT_PACK_TIMEOUT_MS = 5_000;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// 第 1 项：每条消息最多多少字；一个对话最多读最近的多少条事件。
const MESSAGE_TEXT_MAX = 1_000;
const CONVERSATION_EVENTS_MAX = 500;
// 对话摘要：最多多少字；在后台最多等多久（不受拼包时间上限的限制）；每天最多问模型几次（UTC 日期）。
const SUMMARY_MAX = 1_500;
const SUMMARY_TIMEOUT_MS = 60_000;
const SUMMARY_DAILY_MAX = 200;
const SUMMARY_PREFIX = "message_context.summary:";
const SUMMARY_BUDGET_KEY = "message_context.summary_budget";
// 第 2 项：在这个来源最近的多少条消息里找；最多几条、多少字；每条最多多少字；三个条件的时间窗。
const RELATED_SCAN = 2_000;
const RELATED_MAX = 8;
const RELATED_CHARS = 1_500;
const RELATED_TEXT_MAX = 300;
const SAME_SENDER_MS = 7 * DAY;
const USER_RECENT_MS = 30 * MINUTE;
const SAME_OBJECT_MS = 7 * DAY;
// 第 3 项：最多几个对象；状态最多多少字；仓库名至少几个字（太短的名字在原话里认不准）。
const OBJECTS_MAX = 6;
const STATUS_MAX = 200;
const REPO_NAME_MIN = 3;
// 第 4 项：最多几张卡；每张卡最多几句、每句（和开头那条消息）多少字。
const HISTORY_MAX = 3;
const HISTORY_NOTES_MAX = 4;
const NOTE_TEXT_MAX = 200;
// 第 5 项：最多几条笔记；每条最多多少字；召回的查询最多多少字；按话题查全文用几个词、每个词至少几个字母；
// 一个词命中的笔记超过多少条就算太常见，不用它（例如 today、please）。
const MEMORY_MAX = 4;
const MEMORY_TEXT_MAX = 400;
const RECALL_QUERY_MAX = 300;
const TOPIC_WORDS_MAX = 6;
const TOPIC_WORD_MIN = 4;
const TOPIC_COMMON = 20;

/** daemon 给的、拼上下文包要用的东西（hub 的 contextPack 选项）。都可以不给：不给的那一项按「没查到」或者跳过。 */
export interface ContextPackOptions {
  // 便宜模型的自由文本补全（对话摘要，记忆沉淀的整理器用的同一个）。每次取一次；null：现在没有模型。
  complete?: () => SmartTextComplete | null;
  // 一个对象现在的状态（一行）。查不到时返回 null。要在 signal 以后尽快放弃。
  objectStatus?: (object: { kind: MessageContextObjectKind; ref: string }, options: { signal: AbortSignal }) => Promise<string | null>;
  // 按查询召回笔记（例如记忆后端的语义召回）。
  recallNotes?: (
    query: string, options: { signal: AbortSignal; limit: number },
  ) => Promise<ReadonlyArray<{ id: number; title: string; content: string; kind?: string }>>;
  // 拼的时间上限。缺省 CONTEXT_PACK_TIMEOUT_MS。
  timeoutMs?: number;
}

export interface ContextPackDeps extends ContextPackOptions {
  db: Db;
  now: () => Date;
  log: (line: string) => void;
  // 认 PR（hub 的 pullRequestOf）和已知的仓库（请求 A 的候选仓库：本地的位置写成仓库的状态，不用等）。
  pullRequestOf?: (text: string) => { owner: string; repo: string; number: number } | null;
  repos?: () => ReadonlyArray<{ repo: string; root?: string; github?: { owner: string; repo: string } | null }>;
  // 卡的状态说成一句话（hub 的 cardStateLabel）。
  describeCard: (card: ChannelCard) => string;
  // 在后台接着做的事（对话摘要写完存缓存）：hub 的 later，idle() 等它。
  later: (work: () => Promise<unknown>, what: string) => void;
}

/** 一条消息事件要的上下文包：来源、对话、这条消息（入站事件）、发信人、卡、道。 */
export interface ContextPackInput {
  source: string;
  sourceLabel: string;
  // 这个来源登记的事件类型（第 2 项按它找别的对话里的消息）。
  kinds: readonly string[];
  conversation: { key: string; label: string };
  event: EventRecord;
  // 这条消息的话：并进编辑以后的（hub 的 mergedMessage）。提到的对象、相关消息、笔记都按它找。
  text: string;
  sender: { id: string; name: string };
  cardId: number;
  lane: ChannelLane | undefined;
}

export interface BuiltContextPack {
  context: MessageContext;
  // 每一项各有几条（message.context_packed 的 parts）。
  parts: Record<MessageContextPart, number>;
  ms: number;
  // 按哪一版的话拼的。消息又改了（编辑并进来）时，按新的话重拼（repackForText）。
  text: string;
}

// ── 第 1 项的上限（决策边界）──────────────────────────────────────────────────────────

/**
 * 这个对话最近的消息里，哪些原样放、哪些更早的交给对话摘要（spec D5）：根消息总在最前面、不删；别的从新到旧放，
 * 放满 limits.messages 条或 limits.chars 字为止（根消息也算在里面）。放不下的（更早的）在 older 里，从旧到新。
 */
export function fitConversation<T extends { text: string; root?: boolean }>(
  messages: readonly T[], limits: { messages: number; chars: number } = MESSAGE_CONTEXT_LIMITS,
): { kept: T[]; older: T[] } {
  const roots = messages.filter((message) => message.root);
  const rest = messages.filter((message) => !message.root);
  let count = roots.length;
  let chars = roots.reduce((sum, message) => sum + message.text.length, 0);
  let start = rest.length;
  while (start > 0) {
    const next = rest[start - 1]!;
    if (count + 1 > limits.messages || chars + next.text.length > limits.chars) break;
    count += 1;
    chars += next.text.length;
    start -= 1;
  }
  return { kept: [...roots, ...rest.slice(start)], older: rest.slice(0, start) };
}

/** 第 1 项：放得下的原样放，更早的换成对话摘要（summarize 写；写不成时是 null，omitted 照样写明换掉了几条）。 */
export async function packConversation<T extends { text: string; root?: boolean }>(
  messages: readonly T[], summarize: (older: T[]) => Promise<string | null>,
  limits: { messages: number; chars: number } = MESSAGE_CONTEXT_LIMITS,
): Promise<{ messages: T[]; omitted: number; summary: string | null }> {
  const { kept, older } = fitConversation(messages, limits);
  if (!older.length) return { messages: kept, omitted: 0, summary: null };
  return { messages: kept, omitted: older.length, summary: await summarize(older) };
}

// ── 拼上下文包 ────────────────────────────────────────────────────────────────────────

const LATE = Symbol("late");

/** 拼一条外部消息事件的上下文包。不抛错：哪一项出错、超时，就在 missing 里写明缺了它。 */
export async function buildContextPack(deps: ContextPackDeps, input: ContextPackInput): Promise<BuiltContextPack> {
  const started = Date.now();
  const missing = new Set<MessageContextPart>();
  const safely = <T>(part: MessageContextPart, fallback: T, work: () => T): T => {
    try {
      return work();
    } catch (error) {
      deps.log(`[channels] context pack for event #${input.event.seq}: ${part} failed: ${errorText(error)}`);
      missing.add(part);
      return fallback;
    }
  };
  // 要等的几项和同一个上限赛跑：到了上限，没回来的算缺了（对象的状态、召回收到 abort；对话摘要在后台接着写）。
  // closed 以后回来的结果不再用：上下文包已经定了。
  const abort = new AbortController();
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => {
      closed = true;
      abort.abort(new Error("the context pack ran out of time"));
      resolve(LATE);
    }, Math.max(deps.timeoutMs ?? CONTEXT_PACK_TIMEOUT_MS, 1));
  });
  const within = <T>(promise: Promise<T>): Promise<T | typeof LATE> => Promise.race([promise, expired]);
  try {
    return await packWithin(deps, input, { missing, safely, within, isClosed: () => closed, signal: abort.signal, started });
  } finally {
    closed = true;
    clearTimeout(timer);
  }
}

interface PackClock {
  missing: Set<MessageContextPart>;
  safely: <T>(part: MessageContextPart, fallback: T, work: () => T) => T;
  within: <T>(promise: Promise<T>) => Promise<T | typeof LATE>;
  isClosed: () => boolean;
  signal: AbortSignal;
  started: number;
}

async function packWithin(deps: ContextPackDeps, input: ContextPackInput, clock: PackClock): Promise<BuiltContextPack> {
  const { missing, safely, within } = clock;
  const at = timeOf(input.event.occurredAt) ?? deps.now().getTime();
  const text = input.text;
  const messageId = typeof input.event.payload.messageId === "string" ? input.event.payload.messageId : null;

  // 1. 这个对话最近的消息。
  const all = safely("conversation", [] as MessageContextMessage[], () => conversationMessages(deps.db, input, messageId));
  // 3. 提到的对象（先认这条消息里的，再认这个对话里的），第 2 项按它们找别的对话。
  const objects = safely("objects", [] as MessageContextObject[], () => mentionedObjects(deps, [text, ...[...all].reverse().map((message) => message.text)]));
  // 2. 同一件事在别的对话里的消息。别的对话里提到的对象也认上（还有位置时）。
  const related = safely("related", [] as MessageContextRelated[], () => relatedMessages(deps.db, input, at, objects));
  if (objects.length < OBJECTS_MAX) {
    safely("objects", undefined, () => {
      for (const found of mentionedObjects(deps, related.map((message) => message.text))) {
        if (objects.length < OBJECTS_MAX && !objects.some((object) => object.kind === found.kind && object.ref === found.ref)) objects.push(found);
      }
    });
  }
  // 4. 这个对话以前的卡。5. 记忆里的笔记（读库的部分）。
  const history = safely("history", [] as MessageContextCard[], () => conversationHistory(deps, input));
  const notes = safely("memory", NO_NOTES, () => storedNotes(deps.db, input, objects));

  // 要等的几项一起开始。对象的状态先收在这里，到了上限以后回来的不再用。
  const statuses = new Map<number, string>();
  const asked = deps.objectStatus ? objects.map((object, index) => deps.objectStatus!({ kind: object.kind, ref: object.ref }, { signal: clock.signal })
    .then((status) => { if (!clock.isClosed() && status?.trim()) statuses.set(index, clip(oneLine(status), STATUS_MAX)); })
    .catch((error: unknown) => { deps.log(`[channels] status of ${object.kind} ${object.ref} not found: ${errorText(error)}`); })) : [];
  const statusesDone = within(Promise.all(asked));
  // 语义召回按话题问：只给原话。发信人的名字另外按全文查（storedNotes），加在查询里会让全文搜索要求两样都有。
  const recallDone = deps.recallNotes && text.trim()
    ? within(deps.recallNotes(clip(oneLine(text), RECALL_QUERY_MAX), { signal: clock.signal, limit: MEMORY_MAX }))
      .catch((error: unknown) => {
        deps.log(`[channels] notes for event #${input.event.seq} not recalled: ${errorText(error)}`);
        missing.add("memory");
        return [] as const;
      })
    : Promise.resolve([] as const);
  const conversation = await packConversation(all, async (older) => {
    const written = conversationSummary(deps, input, older);
    deps.later(() => written, `conversation summary for ${input.conversation.key}`);
    const summary = await within(written).catch(() => null);
    if (summary === LATE || summary === null) missing.add("summary");
    return summary === LATE ? null : summary;
  });
  if ((await statusesDone) === LATE) missing.add("objects");
  const recalled = await recallDone;
  if (recalled === LATE) missing.add("memory");
  for (const [index, status] of statuses) objects[index]!.status = status;

  const memory = memoryNotes(notes, recalled === LATE ? [] : recalled);
  const context: MessageContext = {
    version: MESSAGE_CONTEXT_VERSION,
    external: true,
    source: input.source,
    sourceLabel: input.sourceLabel,
    sender: { id: input.sender.id, name: input.sender.name },
    conversation: { key: input.conversation.key, label: input.conversation.label, ...conversation },
    related,
    objects,
    history,
    memory,
    missing: MESSAGE_CONTEXT_PARTS.filter((part) => missing.has(part)),
    size: { items: 0, chars: 0 },
  };
  const parts = contextParts(context);
  context.size = { items: Object.values(parts).reduce((sum, count) => sum + count, 0), chars: contextChars(context) };
  return { context, parts, ms: Date.now() - clock.started, text };
}

/** 上下文包每一项各有几条（message.context_packed 的 parts）。 */
export function contextParts(context: MessageContext): Record<MessageContextPart, number> {
  return {
    conversation: context.conversation.messages.length, summary: context.conversation.summary ? 1 : 0, related: context.related.length,
    objects: context.objects.length, history: context.history.length, memory: context.memory.length,
  };
}

/**
 * 消息改了以后按新的话重拼（工单 11 回放的问题 B）：编辑并进排着的消息事件，或者拼包时对方又改了消息。同步的，在 hub 的事务里做：
 * 只重拼和这条消息的话有关的几项。提到的对象：先认新的话里的，再接着以前的（以前的状态照用；已知的仓库马上有状态；
 * 别的新对象没来得及查，missing 写上 objects）。相关消息、读库的笔记：按新的对象和新的话重找；以前召回的笔记照用。
 * 这个对话的消息和以前的卡不看这条消息的话，照用。不抛错：哪一项出错就照用以前的。
 */
export function repackForText(deps: ContextPackDeps, input: ContextPackInput, previous: MessageContext): BuiltContextPack {
  const started = Date.now();
  const missing = new Set<MessageContextPart>(previous.missing);
  const attempt = <T>(part: MessageContextPart, fallback: T, work: () => T): T => {
    try {
      return work();
    } catch (error) {
      deps.log(`[channels] context pack for event #${input.event.seq}: rebuilding ${part} failed: ${errorText(error)}`);
      return fallback;
    }
  };
  const at = timeOf(input.event.occurredAt) ?? deps.now().getTime();
  const known = new Map(previous.objects.map((object) => [`${object.kind}:${object.ref.toLowerCase()}`, object.status]));
  const objects = attempt("objects", previous.objects.map((object) => ({ ...object })), () => {
    const found = mentionedObjects(deps, [input.text]);
    for (const object of previous.objects) {
      if (found.length < OBJECTS_MAX && !found.some((candidate) => candidate.kind === object.kind && candidate.ref.toLowerCase() === object.ref.toLowerCase())) {
        found.push({ ...object });
      }
    }
    for (const object of found) {
      const key = `${object.kind}:${object.ref.toLowerCase()}`;
      if (known.has(key)) object.status = known.get(key) ?? object.status;
      // 新认出的对象没有现成的状态，又有状态查询：这一项没查全。
      else if (object.status === null && deps.objectStatus) missing.add("objects");
    }
    return found;
  });
  const related = attempt("related", previous.related, () => relatedMessages(deps.db, input, at, objects));
  attempt("objects", undefined, () => {
    for (const found of mentionedObjects(deps, related.map((message) => message.text))) {
      if (objects.length < OBJECTS_MAX && !objects.some((object) => object.kind === found.kind && object.ref === found.ref)) objects.push(found);
    }
  });
  const memory = attempt("memory", previous.memory, () => memoryNotes(
    storedNotes(deps.db, input, objects),
    previous.memory.map((note) => ({ id: note.noteId, title: note.title, content: note.text })),
  ));
  const context: MessageContext = {
    ...previous, related, objects, memory, missing: MESSAGE_CONTEXT_PARTS.filter((part) => missing.has(part)), size: { items: 0, chars: 0 },
  };
  const parts = contextParts(context);
  context.size = { items: Object.values(parts).reduce((sum, count) => sum + count, 0), chars: contextChars(context) };
  return { context, parts, ms: Date.now() - started, text: input.text };
}

// 上下文包有多少字：Lead 要读的内容（消息、摘要、对象和状态、卡、笔记），不含标签和结构。
function contextChars(context: MessageContext): number {
  const texts = [
    ...context.conversation.messages.map((message) => message.text), context.conversation.summary ?? "",
    ...context.related.map((message) => message.text),
    ...context.objects.map((object) => `${object.ref}${object.status ?? ""}`),
    ...context.history.flatMap((card) => [card.excerpt, ...card.notes]),
    ...context.memory.map((note) => `${note.title}${note.text}`),
  ];
  return texts.reduce((sum, value) => sum + value.length, 0);
}

// ── 1. 这个对话最近的消息 ─────────────────────────────────────────────────────────────

type Role = MessageContextMessage["role"];

const roleOf = (role: unknown): Role | null =>
  (role === "message" ? "them" : role === "self_reply" ? "me" : role === "echo" ? "assistant" : null);

// 一条入站事件说的消息。ref 是来源里的消息编号；amends 说它改了、删了哪一条（按 ref 认）。
interface InboundMessage {
  seq: number;
  at: string;
  role: Role;
  senderId: string;
  sender: string;
  text: string;
  ref: string | null;
  amends: "edited" | "deleted" | null;
}

// 一条入站事件说的消息：角色、发信人、原话、消息编号。不是消息（例如别的种类的事件）时是 null。
function messageOf(event: { seq: number; occurredAt: string; payload: Record<string, unknown> }): InboundMessage | null {
  const role = roleOf(event.payload.role);
  if (!role) return null;
  const sender = event.payload.sender as { id?: unknown; name?: unknown } | undefined;
  return {
    seq: event.seq, at: event.occurredAt, role,
    senderId: typeof sender?.id === "string" ? sender.id : "",
    sender: typeof sender?.name === "string" && sender.name.trim() ? sender.name : "某人",
    text: typeof event.payload.text === "string" ? event.payload.text : "",
    ref: typeof event.payload.messageId === "string" ? event.payload.messageId : null,
    amends: event.payload.amends === "edited" || event.payload.amends === "deleted" ? event.payload.amends : null,
  };
}

// 按消息编号应用改和删，留下的消息按先后。没有编号的消息各算一条。
function applyAmends<T extends InboundMessage>(entries: readonly T[]): T[] {
  const messages = new Map<string, T>();
  for (const entry of entries) {
    const key = entry.ref ?? `seq:${entry.seq}`;
    if (entry.amends === "deleted") {
      messages.delete(key);
      continue;
    }
    const existing = messages.get(key);
    if (entry.amends === "edited") {
      if (existing) messages.set(key, { ...existing, text: entry.text });
      continue;
    }
    messages.set(key, entry);
  }
  return [...messages.values()];
}

function conversationMessages(db: Db, input: ContextPackInput, messageId: string | null): MessageContextMessage[] {
  const rows = (db.prepare(
    `SELECT seq, occurred_at, payload FROM events WHERE entity_key = ? AND source = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
  ).all(input.conversation.key, input.source, input.event.seq, CONVERSATION_EVENTS_MAX) as Array<{ seq: number; occurred_at: string; payload: string }>)
    .reverse();
  const entries = rows.flatMap((row) => {
    const payload = parsePayload(row.payload);
    const message = payload ? messageOf({ seq: row.seq, occurredAt: row.occurred_at, payload }) : null;
    return message ? [message] : [];
  });
  const messages = applyAmends(entries)
    .filter((message) => message.text.trim() && (messageId === null || message.ref !== messageId))
    .map((message) => ({ ...message, root: false }));
  // 道的起点（thread 的根消息和它之前的几条）：事件里有的标成根消息，没有的（开道时从来源的历史里补的）加上。
  // 道里没有编号的消息（系统替用户发的、推回来以前记下的）在事件里找不到同样的话时也加上。
  const lane = input.lane?.context ?? [];
  const extra: Array<(typeof messages)[number]> = [];
  for (const origin of lane.filter((message) => message.origin)) {
    const same = messages.find((message) => (origin.seq !== null && message.seq === origin.seq) || (origin.ref !== undefined && message.ref === origin.ref));
    if (same) same.root = true;
    else if (origin.ref !== messageId && origin.text.trim()) {
      extra.push({ seq: origin.seq ?? 0, at: origin.at, role: origin.role, senderId: "", sender: origin.sender, text: origin.text, ref: origin.ref ?? null, amends: null, root: true });
    }
  }
  for (const sent of lane.filter((message) => !message.origin && message.seq === null && message.text.trim())) {
    if (!messages.some((message) => message.text.trim() === sent.text.trim())) {
      extra.push({ seq: 0, at: sent.at, role: sent.role, senderId: "", sender: sent.sender, text: sent.text, ref: null, amends: null, root: false });
    }
  }
  const ordered = [...messages, ...extra].sort((a, b) => (Number(b.root) - Number(a.root)) || (timeOf(a.at) ?? 0) - (timeOf(b.at) ?? 0));
  return ordered.map((message) => ({
    at: message.at, role: message.role, sender: message.sender, text: clip(message.text, MESSAGE_TEXT_MAX), ...(message.root ? { root: true } : {}),
  }));
}

// 对话摘要：记忆沉淀的整理器写，按对话缓存（更早的那一段没变时不再问模型）。没有模型、到了每天的上限、写不成时是 null。
async function conversationSummary(deps: ContextPackDeps, input: ContextPackInput, older: readonly MessageContextMessage[]): Promise<string | null> {
  const last = older.at(-1);
  const fingerprint = `${older.length}:${last?.at ?? ""}:${last?.text.slice(0, 80) ?? ""}`;
  const cacheKey = `${SUMMARY_PREFIX}${input.conversation.key}`;
  const cached = readKv(deps.db, cacheKey) as { fingerprint?: unknown; text?: unknown } | null;
  if (cached?.fingerprint === fingerprint && typeof cached.text === "string") return cached.text;
  let complete: SmartTextComplete | null = null;
  try {
    complete = deps.complete?.() ?? null;
  } catch (error) {
    deps.log(`[channels] the model for conversation summaries is not available: ${errorText(error)}`);
  }
  if (!complete || !takeSummaryBudget(deps)) return null;
  const timing = deadline(undefined, SUMMARY_TIMEOUT_MS);
  try {
    const facts = await summarizeChannelMessages(
      complete, input.conversation.label,
      older.map((message) => ({ speaker: message.role === "me" ? "用户本人" : message.role === "assistant" ? "用户的助手" : message.sender, text: message.text })),
      { purpose: MESSAGE_CONTEXT_SUMMARY_PURPOSE, signal: timing.signal },
    );
    if (!facts) {
      deps.log(`[channels] conversation summary for ${input.conversation.key}: the answer is not the JSON that was asked for`);
      return null;
    }
    const text = clip(facts.facts.length ? `${facts.topic}：${facts.facts.join("；")}` : `${facts.topic}（没有要记的事实）`, SUMMARY_MAX);
    writeKv(deps.db, cacheKey, { fingerprint, text, at: deps.now().toISOString() });
    return text;
  } catch (error) {
    deps.log(`[channels] conversation summary for ${input.conversation.key} failed: ${timing.cause() === "timeout" ? "timed out" : errorText(error)}`);
    return null;
  }
}

// 今天还能为对话摘要问模型吗？能的话记上一次。
function takeSummaryBudget(deps: ContextPackDeps): boolean {
  const day = deps.now().toISOString().slice(0, 10);
  const stored = readKv(deps.db, SUMMARY_BUDGET_KEY) as { day?: unknown; used?: unknown } | null;
  const used = stored?.day === day && typeof stored.used === "number" ? stored.used : 0;
  if (used >= SUMMARY_DAILY_MAX) {
    deps.log(`[channels] the daily limit of ${SUMMARY_DAILY_MAX} conversation summaries is reached`);
    return false;
  }
  writeKv(deps.db, SUMMARY_BUDGET_KEY, { day, used: used + 1 });
  return true;
}

// ── 2. 同一件事在别的对话里的消息 ─────────────────────────────────────────────────────

function relatedMessages(db: Db, input: ContextPackInput, at: number, objects: readonly MessageContextObject[]): MessageContextRelated[] {
  if (!input.kinds.length) return [];
  const kinds = input.kinds.map(() => "?").join(", ");
  const rows = (db.prepare(
    `SELECT seq, entity_key, occurred_at, payload FROM events
     WHERE source = ? AND kind IN (${kinds}) AND entity_key <> ? ORDER BY seq DESC LIMIT ?`,
  ).all(input.source, ...input.kinds, input.conversation.key, RELATED_SCAN) as Array<{ seq: number; entity_key: string; occurred_at: string; payload: string }>)
    .reverse();
  // 按对话分开应用改和删。
  const byConversation = new Map<string, Array<InboundMessage & { label: string }>>();
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const message = payload ? messageOf({ seq: row.seq, occurredAt: row.occurred_at, payload }) : null;
    if (!message) continue;
    const label = typeof payload!.laneLabel === "string" ? payload!.laneLabel : row.entity_key;
    const list = byConversation.get(row.entity_key) ?? [];
    list.push({ ...message, label });
    byConversation.set(row.entity_key, list);
  }
  const tokens = objects.flatMap((object) => objectTokens(object));
  const candidates: Array<MessageContextRelated & { time: number }> = [];
  for (const [key, entries] of byConversation) {
    // 对话的名字：道的名字（开道时按对方起的）；没有道时用第一条别人的消息带的名字。
    const label = getChannelLane(db, key)?.label ?? entries.find((entry) => entry.role === "them")?.label ?? entries[0]?.label ?? key;
    for (const message of applyAmends(entries)) {
      const time = timeOf(message.at);
      if (time === null || !message.text.trim()) continue;
      const why: MessageContextRelatedReason[] = [];
      if (message.role === "them" && message.senderId === input.sender.id && time >= at - SAME_SENDER_MS) why.push("same_sender");
      if (message.role !== "them" && time >= at - USER_RECENT_MS) why.push("user_recent");
      if (time >= at - SAME_OBJECT_MS && tokens.some((token) => mentions(message.text, token))) why.push("same_object");
      if (!why.length) continue;
      candidates.push({
        at: message.at, role: message.role, sender: message.sender, text: clip(message.text, RELATED_TEXT_MAX),
        conversation: { key, label }, why, time,
      });
    }
  }
  // 满足的条件多的、新的先放，放满为止；放进去的按时间从旧到新。
  candidates.sort((a, b) => b.why.length - a.why.length || b.time - a.time);
  const picked: typeof candidates = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (picked.length >= RELATED_MAX || chars + candidate.text.length > RELATED_CHARS) break;
    picked.push(candidate);
    chars += candidate.text.length;
  }
  return picked.sort((a, b) => a.time - b.time).map(({ time: _time, ...message }) => message);
}

// ── 3. 提到的对象 ─────────────────────────────────────────────────────────────────────

// Jira 的浏览链接（https://<站点>/browse/<KEY>-<n>）、GitHub 的仓库链接（后面跟着 /pull/<n> 的是 PR，由 pullRequestOf 认）。
// 只认链接的语法，不从原话里猜。
const JIRA_LINK = /https?:\/\/[\w.-]+\/browse\/([A-Z][A-Z0-9_]+-\d+)/gu;
const REPO_LINK = /github\.com\/([\w-]+)\/([\w.-]+)(\/pull\/\d+)?/gu;

/**
 * 一组文字里提到的对象，先出现的在前，最多 OBJECTS_MAX 个。PR 所在的仓库不再单列。已知的仓库（候选仓库）马上写上本地的位置当状态，
 * 不用等状态查询（编辑以后同步重拼时也有）；状态查询有回答时用它的。
 */
function mentionedObjects(deps: ContextPackDeps, texts: readonly string[]): MessageContextObject[] {
  const found: MessageContextObject[] = [];
  const add = (kind: MessageContextObjectKind, ref: string, status: string | null = null) => {
    if (found.length < OBJECTS_MAX && !found.some((object) => object.kind === kind && object.ref.toLowerCase() === ref.toLowerCase())) {
      found.push({ kind, ref, status });
    }
  };
  const repos = deps.repos?.() ?? [];
  for (const text of texts) {
    if (!text) continue;
    const pr = deps.pullRequestOf?.(text) ?? null;
    if (pr) add("pull_request", `${pr.owner}/${pr.repo}#${pr.number}`);
    for (const match of text.matchAll(JIRA_LINK)) add("jira", match[1]!);
    for (const match of text.matchAll(REPO_LINK)) {
      const repo = match[2]!.replace(/\.git$/u, "").replace(/\.+$/u, "");
      if (!match[3] && repo) add("repo", `${match[1]}/${repo}`);
    }
    for (const candidate of repos) {
      const full = candidate.github ? `${candidate.github.owner}/${candidate.github.repo}` : candidate.repo;
      const names = [candidate.repo, full, candidate.repo.split("/").at(-1) ?? candidate.repo]
        .filter((name, index, all) => name.length >= REPO_NAME_MIN && all.indexOf(name) === index);
      if (!names.some((name) => mentions(text, name))) continue;
      const where = candidate.root ? `本地有 checkout（${candidate.root}）` : null;
      const status = where && candidate.github ? `${where}，GitHub 上是 ${candidate.github.owner}/${candidate.github.repo}` : where;
      add("repo", full, status);
    }
  }
  // PR 所在的仓库不再单列：PR 的状态已经说明了。
  const prRepos = new Set(found.filter((object) => object.kind === "pull_request").map((object) => object.ref.split("#")[0]!.toLowerCase()));
  return found.filter((object) => object.kind !== "repo" || !prRepos.has(object.ref.toLowerCase()));
}

// 在别的对话里认同一个对象用的写法。
function objectTokens(object: MessageContextObject): string[] {
  if (object.kind === "pull_request") {
    const [repo, number] = object.ref.split("#");
    return [object.ref, `${repo}/pull/${number}`];
  }
  if (object.kind === "repo") {
    const name = object.ref.split("/").at(-1) ?? object.ref;
    return name.length >= REPO_NAME_MIN ? [object.ref, name] : [object.ref];
  }
  return [object.ref];
}

// 文字里有没有这个名字（不分大小写，前后不是字母、数字、-、_：orders 不算 preorders 里的）。
function mentions(text: string, name: string): boolean {
  const haystack = text.toLowerCase();
  const needle = name.toLowerCase();
  const word = /[a-z0-9_-]/u;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    const before = haystack[index - 1];
    const after = haystack[index + needle.length];
    if ((before === undefined || !word.test(before)) && (after === undefined || !word.test(after))) return true;
  }
  return false;
}

// ── 4. 这个对话以前的卡 ─────────────────────────────────────────────────────────────

function conversationHistory(deps: ContextPackDeps, input: ContextPackInput): MessageContextCard[] {
  const db = deps.db;
  // 这张卡本身也算，只要它在这条消息以前就有别的消息（并进来的）。
  const cards = listChannelCardsForObject(db, input.conversation.key)
    .filter((card) => card.id !== input.cardId || card.firstSeq < input.event.seq)
    .slice(-HISTORY_MAX);
  const decisions = db.prepare(
    `SELECT kind, payload FROM events WHERE source = 'system' AND entity_key = ? AND kind IN (?, ?) AND json_valid(payload)
       AND json_extract(payload, '$.cardId') = ? ORDER BY seq DESC LIMIT 6`,
  );
  return cards.map((card) => {
    const first = getEvent(db, card.firstSeq);
    const opening = typeof first?.payload.text === "string" ? first.payload.text : card.excerpt;
    const notes = [deps.describeCard(card)];
    if (card.sent?.status === "sent") notes.push(`发出去的回复：${clip(oneLine(card.sent.text), NOTE_TEXT_MAX)}`);
    const note = card.resolution?.detail?.note;
    if (typeof note === "string" && note.trim()) notes.push(`备注：${clip(oneLine(note), NOTE_TEXT_MAX)}`);
    const rows = (decisions.all(input.conversation.key, CHANNEL_EVENT_KINDS.leadDecided, CHANNEL_EVENT_KINDS.taskFinished, card.id) as Array<{ kind: string; payload: string }>)
      .reverse();
    for (const row of rows) {
      const payload = parsePayload(row.payload);
      if (!payload || payload.decision === "superseded" || payload.decision === "closed") continue;
      if (typeof payload.summary === "string") notes.push(clip(oneLine(payload.summary), NOTE_TEXT_MAX));
    }
    const answer = getLatestLookupForCard(db, card.id)?.result?.answer;
    if (typeof answer === "string" && answer.trim()) notes.push(`代查的结果：${clip(oneLine(answer), NOTE_TEXT_MAX)}`);
    return {
      cardId: card.id, at: card.createdAt, state: card.state, sender: card.sender.name,
      excerpt: clip(oneLine(opening), NOTE_TEXT_MAX), notes: notes.slice(0, HISTORY_NOTES_MAX),
    };
  });
}

// ── 5. 记忆里的笔记 ─────────────────────────────────────────────────────────────────

interface StoredNotes {
  // 这个对话的事实笔记（记忆沉淀写的）。
  own: readonly Note[];
  // 按话题：提到这条消息里的对象或者词的笔记，命中的词多的在前。
  topic: readonly Note[];
  // 按发信人：提到发信人名字的笔记。
  about: readonly Note[];
}

const NO_NOTES: StoredNotes = { own: [], topic: [], about: [] };

// 读库的部分（工单 11 回放的问题 C）：话题和发信人分开查，再合并。全文搜索要求查询里的词都出现，所以不把名字和原话拼在一起查。
function storedNotes(db: Db, input: ContextPackInput, objects: readonly MessageContextObject[]): StoredNotes {
  const name = input.sender.name.trim();
  const hits = new Map<number, { note: Note; count: number }>();
  for (const word of topicWords(input.text, objects)) {
    const found = searchNotes(db, word, { limit: TOPIC_COMMON + 1 });
    if (found.length > TOPIC_COMMON) continue;
    for (const note of found) hits.set(note.id, { note, count: (hits.get(note.id)?.count ?? 0) + 1 });
  }
  const topic = [...hits.values()].sort((a, b) => b.count - a.count || b.note.id - a.note.id).map((hit) => hit.note);
  return { own: notesWithTag(db, input.conversation.key), topic, about: name ? searchNotes(db, name, { limit: MEMORY_MAX }) : [] };
}

// 按话题查全文用的词：提到的对象的名字（PR、工单号、仓库和它的短名），加上原话里 TOPIC_WORD_MIN 个字母以上的英文词
// （例如 fairy、ledger）。链接先去掉（链接里的对象已经认成对象了，https、github.com 这些词不算话题）。
// 中文的话题靠语义召回（recallNotes），这里不切词。最多 TOPIC_WORDS_MAX 个，不分大小写去重。
function topicWords(text: string, objects: readonly MessageContextObject[]): string[] {
  const names = objects.flatMap((object) => (object.kind === "repo" ? [object.ref, object.ref.split("/").at(-1) ?? object.ref] : [object.ref]));
  const words = [...text.replace(/https?:\/\/\S+/gu, " ").matchAll(/[A-Za-z][A-Za-z0-9_.-]*/gu)].map((match) => match[0].replace(/[._-]+$/u, ""))
    .filter((word) => word.length >= TOPIC_WORD_MIN);
  const seen = new Set<string>();
  return [...names, ...words].filter((word) => {
    const key = word.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, TOPIC_WORDS_MAX);
}

// 这个对话的笔记在前，召回的其次，然后按话题和按发信人的轮流放。常驻的画像和偏好不放：Lead 本来就有。
function memoryNotes(
  stored: StoredNotes, recalled: ReadonlyArray<{ id: number; title: string; content: string; kind?: string }>,
): MessageContextNote[] {
  const alternated = Array.from({ length: Math.max(stored.topic.length, stored.about.length) }, (_, index) => [stored.topic[index], stored.about[index]])
    .flat().filter((note): note is Note => note !== undefined);
  const ordered = [...stored.own, ...recalled, ...alternated];
  const notes: MessageContextNote[] = [];
  for (const note of ordered) {
    if (notes.length >= MEMORY_MAX) break;
    if (!Number.isSafeInteger(note.id) || note.id < 1 || notes.some((existing) => existing.noteId === note.id)) continue;
    if (note.kind && (CORE_KINDS as readonly string[]).includes(note.kind)) continue;
    notes.push({ noteId: note.id, title: clip(oneLine(note.title), 120), text: clip(oneLine(note.content), MEMORY_TEXT_MAX) });
  }
  return notes;
}

// ── 小工具 ───────────────────────────────────────────────────────────────────────────

function parsePayload(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function timeOf(iso: string): number | null {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

const oneLine = (text: string) => text.replace(/\s+/gu, " ").trim();

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function readKv(db: Db, key: string): unknown {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
}

function writeKv(db: Db, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run(key, JSON.stringify(value));
}
