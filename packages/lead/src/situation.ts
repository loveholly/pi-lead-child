// 当前局面（Lead 事件主干 spec D7，工单 04）：每一轮开头重新生成，放在这一轮输入的开头，
// 用 <system_event kind="situation"> 信封，和用户的话分开（daemon 的 runTurnNow）。
// 它不放进系统提示：Lead 用的模型接口大多不接受对话中途的系统消息，系统提示一变，整段对话的提示缓存就失效了。
// 放在输入里，新内容追加在对话末尾，不破坏缓存。所以它要短，没有变化的部分不重复放。内容：
//   · 在进行的工单，每张一行（来自 TicketSummary：编号、标题、stage、Run 状态、最近一次失败的根因代码）；
//     长期没有动静的工单折叠成一行，只列编号（2026-10-19，阈值由 daemon 定）；
//   · 未解决的问题；等用户决定的事；你在等的用户操作（lead_waits，2026-10-19）；
//   · 排队中的事，各一行，只写类别和来源，不写内容（答完这一轮后系统会单独交给 Lead）；
//   · 上一轮以后的变化：digest 级按对象合并后列出，record 级按对象只给数量；
//   · 关于 Lead 自己的事（压缩失败、换了模型），上一轮以后的，每条一行；
//   · 最近一次 Lead 自己的失败；
//   · 对话通道（工单 11，spec D14 的分道）：外部来源的每个对话一条道，这里每条道只放一行摘要，不放消息原文。
// 有固定的 token 预算。超出时先合并同对象的条目，再截断最旧的变化，并写明截断了多少条、用 query_events 从哪里查回来。
// 关于 Lead 自己的事不按预算截断：Lead 要知道它们（以前是每一轮开头单独的一段，工单 14 改成事件）。
// 它们的上限由 daemon 定（lead-input.ts 的 leadSelfLines：连续的同一种合成一行，最多列 5 行，更早的合成一行）。
// 对话通道最多列 MAX_SITUATION_LANES 条道。
// 这里只排版，不读库：daemon（apps/daemon/src/lead-input.ts）把数据读好交进来。

export const DEFAULT_SITUATION_BUDGET_TOKENS = 800;

export interface SituationTicket {
  // 例如 `#77「部署」active，run=#91(running)`。
  line: string;
}

export interface SituationQueued {
  // 类别和来源，例如「系统事件 inbox.blocker，来源 system（ticket:77）」。
  label: string;
  count: number;
}

// digest 级的变化，按对象合并：一个对象一组，每个事件一行。
export interface SituationDigestGroup {
  label: string;
  lines: string[];
  // 这一组里最新的事件序号：截断时先去掉最旧的组。
  latestSeq: number;
}

// record 级的变化，按对象只给数量。notes 是几句很短的说明（例如「Run #5（工单对话）结束」）。
export interface SituationRecordGroup {
  label: string;
  count: number;
  kinds: Array<[kind: string, count: number]>;
  notes: string[];
  latestSeq: number;
}

export interface SituationInput {
  now: string;
  tickets: SituationTicket[];
  problems: string[];
  waiting: string[];
  queued: SituationQueued[];
  digest: SituationDigestGroup[];
  records: SituationRecordGroup[];
  // 游标后面太多、没有读进来的更早的变化有几条（daemon 一次最多读一批）。
  unread: number;
  leadFailure: string | null;
  // 在进行的工单、未解决的问题、等用户决定的事和上一次交给 Lead 的一样：只写一行「没有变化」，不重复放。
  unchanged?: boolean;
  // 变化从哪个序号以后算（Lead 的事件游标）。截掉了变化时，告诉 Lead 用 query_events 从这里查回来（工单 14）。
  sinceSeq?: number;
  // 关于 Lead 自己的事（压缩失败、换了模型，工单 14）：每条一行，不按预算截断。行数由 daemon 限制。
  self?: string[];
  // 对话通道：每条道一行（上一轮以后有变化的道，和还有没结束的卡的道）。
  lanes?: string[];
  // 长期没有动静、折叠成一行的工单（2026-10-19）：写在「在进行的工单」的最后。没有时不写。
  idleTickets?: string | null;
  // 你在等的用户操作（lead_waits，2026-10-19）：每条一行。
  waits?: string[];
}

/** 当前局面里最多列几条道。 */
export const MAX_SITUATION_LANES = 10;

export interface RenderedSituation {
  text: string;
  tokens: number;
  // 截断掉的变化有几条（事件数）。
  truncated: number;
}

/** 粗略的 token 数：中日韩文字一个字算一个，其余四个字符算一个。只用来守预算，不求精确。 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0x2e7f) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 4);
}

interface Draft {
  tickets: SituationTicket[];
  ticketsOmitted: number;
  digest: Array<SituationDigestGroup & { merged?: boolean }>;
  records: Array<SituationRecordGroup & { compact?: boolean }>;
  truncated: number;
}

function section(title: string, lines: string[], empty?: string): string[] {
  if (!lines.length) return empty ? [`${title}：${empty}`, ""] : [];
  return [`${title}：`, ...lines.map((line) => `- ${line}`), ""];
}

function recordLine(group: SituationRecordGroup & { compact?: boolean }): string {
  const kinds = group.kinds.map(([kind, count]) => `${kind} ${count}`).join("、");
  const notes = !group.compact && group.notes.length ? `；${group.notes.join("；")}` : "";
  return `${group.label}：记录 ${group.count} 条（${kinds}）${notes}`;
}

function digestLine(group: SituationDigestGroup & { merged?: boolean }): string {
  if (!group.merged || group.lines.length <= 1) return `${group.label}：${group.lines.join("；")}`;
  return `${group.label}：${group.lines.length} 条，最近一条：${group.lines.at(-1)}`;
}

function laneLines(lanes: readonly string[]): string[] {
  if (lanes.length <= MAX_SITUATION_LANES) return [...lanes];
  return [...lanes.slice(0, MAX_SITUATION_LANES), `（另有 ${lanes.length - MAX_SITUATION_LANES} 条道没有列出）`];
}

function compose(input: SituationInput, draft: Draft): string {
  const changes = [
    ...draft.digest.map((group) => ({ seq: group.latestSeq, line: digestLine(group) })),
    ...draft.records.map((group) => ({ seq: group.latestSeq, line: recordLine(group) })),
  ].sort((left, right) => left.seq - right.seq).map((entry) => entry.line);
  const omitted = draft.truncated + input.unread;
  if (omitted) {
    const tool = input.sinceSeq !== undefined ? `query_events（since_seq=${input.sinceSeq}）` : "query_events ";
    changes.unshift(`（变化太多：最早的 ${omitted} 条没有列出。要看用 ${tool}查回来，`
      + "或者用 read_inbox、get_ticket_status、read_notifications 查）");
  }
  const tickets = draft.tickets.map((ticket) => ticket.line);
  if (draft.ticketsOmitted) tickets.push(`（另有 ${draft.ticketsOmitted} 张在进行的工单没有列出，用 query_tickets 查）`);
  if (input.idleTickets) tickets.push(input.idleTickets);
  const queued = input.queued.map((entry) => `${entry.label} ${entry.count} 条`);
  const current = input.unchanged
    ? ["在进行的工单、未解决的问题、等用户决定的事、你在等的用户操作：和上一次的当前局面一样，没有变化。", ""]
    : [
      ...section("在进行的工单", tickets, "没有。"),
      ...section("未解决的问题", input.problems),
      ...section("等用户决定的事", input.waiting),
      ...section("你在等的用户操作（用户在这些对象上做了下一步、或者到了超时，系统会叫醒你；不用设跟进去查）", input.waits ?? []),
    ];
  return [
    `当前局面（${input.now} 生成）。每一轮开头都有一份新的，以最新的为准。这里是现状和上一轮以后的变化，`
      + "不是用户的话，也不是要你逐条回复的消息；要看细节用工具查。",
    "",
    ...current,
    ...section("排队中（你答完这一轮后，系统会把它们单独交给你，现在不用处理）", queued),
    ...section("上一轮以后的变化", changes, "没有。"),
    ...section("关于你自己（上一轮以后）", input.self ?? []),
    ...section("对话通道（外部来源的对话，每条道一行。消息已经按常设指令投递给用户，要你处理的会单独交给你（消息事件）；你不用逐条回复，要看细节用 query_events 查）",
      laneLines(input.lanes ?? [])),
    ...section("你自己最近的失败", input.leadFailure ? [input.leadFailure] : []),
  ].join("\n").trim();
}

/**
 * 按预算排出当前局面。超出预算时：先把同一个对象的多条变化合并成一行（只留最近一条和条数），
 * 再从最旧的变化开始整组截掉，并在开头写明截掉了多少条；变化截完还超出时，截在进行的工单列表的末尾。
 */
export function renderLeadSituation(input: SituationInput, budgetTokens = DEFAULT_SITUATION_BUDGET_TOKENS): RenderedSituation {
  const draft: Draft = {
    tickets: [...input.tickets], ticketsOmitted: 0,
    digest: input.digest.map((group) => ({ ...group })),
    records: input.records.map((group) => ({ ...group })),
    truncated: 0,
  };
  const measure = () => {
    const text = compose(input, draft);
    return { text, tokens: estimateTokens(text) };
  };
  let result = measure();
  if (result.tokens <= budgetTokens) return { ...result, truncated: 0 };
  // 1. 合并同一个对象的条目。
  for (const group of draft.digest) group.merged = true;
  for (const group of draft.records) group.compact = true;
  result = measure();
  // 2. 截掉最旧的变化，整组截。
  while (result.tokens > budgetTokens && (draft.digest.length || draft.records.length)) {
    const oldestDigest = draft.digest.reduce<number>((min, group, index) =>
      min < 0 || group.latestSeq < draft.digest[min]!.latestSeq ? index : min, -1);
    const oldestRecord = draft.records.reduce<number>((min, group, index) =>
      min < 0 || group.latestSeq < draft.records[min]!.latestSeq ? index : min, -1);
    const takeDigest = oldestRecord < 0
      || (oldestDigest >= 0 && draft.digest[oldestDigest]!.latestSeq <= draft.records[oldestRecord]!.latestSeq);
    if (takeDigest) {
      draft.truncated += draft.digest.splice(oldestDigest, 1)[0]!.lines.length;
    } else {
      draft.truncated += draft.records.splice(oldestRecord, 1)[0]!.count;
    }
    result = measure();
  }
  // 3. 还超出：截在进行的工单列表的末尾。
  while (result.tokens > budgetTokens && draft.tickets.length) {
    draft.tickets.pop();
    draft.ticketsOmitted += 1;
    result = measure();
  }
  return { ...result, truncated: draft.truncated };
}
