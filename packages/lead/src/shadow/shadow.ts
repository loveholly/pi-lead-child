// shadow（用户 2026-11-19，.scratch/lead-background-shadow/spec.md）：后台事件先在一个不带主会话历史的小会话里处理。
//
// 这个文件是 shadow 的规则，不调模型、不碰会话：
//   - 工具清单（SHADOW_TOOL_NAMES）：处理事件用的读和动作工具，加上收尾的 finish_shadow。没有 bash、read、render_ui、hand_off。
//     工具是 Lead 的同一份定义（session.ts 的 shadowTools），权限判断不变。
//   - 系统提示词：Lead 的系统提示词、常设指令、核心记忆、身份和代回复风格，后面加「你在 shadow」一节。
//   - 固定的开头（SHADOW_OPENING）：一轮固定的用户和助手消息。magpie 按对话的开头（系统提示词加第一轮）认缓存
//     （2026-11-19 实测），开头一样，每个shadow 会话都能命中缓存。事件放在这一轮后面。
//   - 包装工具（wrapShadowTools）：代码规则，不靠提示词。
//       · 用户正在看会话：notify_user 和 told_user 拒绝，要说的话交给主会话。
//       · 用户不在：收件箱的事记 told_user 之前必须先 notify_user（外部消息带草稿，卡留给用户，不用推）。
//       · 工具结果要用户做什么（授权卡、确认卡）：这一批交给主会话，卡要主会话给用户看。
//       · 试运行：改东西的工具不执行，只记下来。
//   - 结论（resolveShadowOutcome，纯函数）：每个编号要么做完、要么交给主会话。没给结论的、说做完却没记处置的、出错的，都交给主会话。
//     拿不准就交：交错一件只多花一次主会话的钱，漏掉一件是用户觉得 Lead 不知情。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { userActionOfToolResult } from "@pi-lead-child/protocol";

/**
 * 常驻的工具（用户 2026-11-19 定的分法）：每一批都可能用到的读和处理事件的基本动作。它们的说明在固定的开头里，每个会话都一样，
 * 所以缓存照样命中。按事件动态加工具会让开头每批都不一样，每批都要冷启动。
 * call_connection_tool 在这里只能调只读的工具（shadowRefusal）：GitHub 的 PR、CI、Release 这类查询走它；要写外部账号的交给主会话。
 */
export const SHADOW_CORE_TOOLS = [
  "get_ticket_status", "query_events", "read_inbox", "read_run_events", "search_notes",
  "read_channel_conversation", "read_channel_file", "read_agenda_entries", "search_connection_tools", "call_connection_tool",
  "record_disposition", "notify_user", "follow_up", "react_channel_message", "reply_to_source", "send_channel_message",
] as const;

/**
 * 放在 more_tools 入口后面的工具：少用，说明长。它们不声明给模型，用的时候经 more_tools 拿说明、再调用，
 * 走的是同一个工具、同样的规则。perform_action 只开白名单（SHADOW_ACTION_ALLOWLIST）。
 * 没有的：create_task（开不开新工作交给主会话）、save_note（看不到对话，写进长期记忆的东西容易缺上下文）、
 * get_ticket 和 query_tickets（get_ticket_status 一个就够）。
 */
export const SHADOW_EXTRA_TOOLS = [
  "dispatch_agent_task", "recover_ticket_run", "ticket_action", "watch", "find_channel_conversations", "get_runtime_health",
  "read_notifications", "list_ticket_actions", "read_connection_result", "list_actions", "perform_action", "agenda",
] as const;

/** 改东西的工具：试运行时不执行，只记下来。call_connection_tool 只放行只读的调用，所以不在这里。 */
export const SHADOW_WRITE_TOOLS = [
  "record_disposition", "notify_user", "follow_up", "react_channel_message", "reply_to_source", "send_channel_message",
  "ticket_action", "recover_ticket_run", "perform_action", "dispatch_agent_task", "watch",
] as const;

/** shadow 能用的 perform_action：低风险、处理后台事件时常用的几个。别的设置页操作交给主会话。 */
export const SHADOW_ACTION_ALLOWLIST: readonly string[] = [
  "runtime.disable", "runtime.enable", "model_settings.test_fast_model", "memory_settings.test_summary_model",
  "memory_settings.retry_failed_writes", "widget.refresh", "follow_up.cancel",
];

export const SHADOW_MORE_TOOL = "more_tools";

export const SHADOW_FINISH_TOOL = "finish_shadow";
/** 读 Lead 自带的 skill（事件里写着「先读 skill channel-replies」，shadow 会话没有 read）。 */
export const SHADOW_SKILL_TOOL = "read_skill";

/** 从 Lead 的工具里取的那些（常驻的和入口后面的，不含 shadow 自己的三个）。 */
export const SHADOW_LEAD_TOOL_NAMES: readonly string[] = [...SHADOW_CORE_TOOLS, ...SHADOW_EXTRA_TOOLS];
const SHADOW_WRITES: ReadonlySet<string> = new Set(SHADOW_WRITE_TOOLS);

export const SHADOW_SECTION = `## 你现在是 shadow（你的分身）
这是 shadow 的会话，不是和用户的主会话。你还是你：同一个系统提示词、常设指令、核心记忆和权限规则。不同的是：
- 你看不到和用户聊过的内容。每一批后台事件开一个新会话，处理完就结束。
- 你直接有这些工具：${[...SHADOW_CORE_TOOLS, SHADOW_SKILL_TOOL, SHADOW_MORE_TOOL, SHADOW_FINISH_TOOL].join("、")}。
- 这些在 more_tools 后面，用的时候先 more_tools(name) 看说明，再 more_tools(name, arguments) 调：${SHADOW_EXTRA_TOOLS.join("、")}。
  perform_action 只能做这几个：${SHADOW_ACTION_ALLOWLIST.join("、")}。
- call_connection_tool 只能调只读的工具（例如查 GitHub 的 PR、CI、Release）；要写外部账号的事交给主会话。
- 上面提到的别的工具（bash、read、render_ui、hand_off、codemode、save_note、create_task 等）这里都没有。
- 事件或规则让你先读某个 skill 时，用 read_skill 读它。
- 这里写的文字没有人看。要对用户说的话，用 notify_user 推给他，或者交给主会话。

处理每件事：
1. 能判断、能做完的，自己做完，再用 record_disposition 记下处置：不用管记 no_action；修好了（例如用 recover_ticket_run 换模型重跑）记 handled；以后再看的用 follow_up 设跟进，记 deferred。
2. 有下面任何一种情况，交给主会话（finish_shadow 的 escalate），不要自己做：
   - 判断要用到和用户聊过的内容：用户最近说过的话、正在讨论的事、之前的安排。常设指令和核心记忆你看得到；看不到的，不要猜。
   - 要用户做决定或者动手（合并还是放弃、确认、授权、审批），而且用户正在看会话，或者要给他一张选择卡。
   - 要用户本人确认、授权、审批，或者要给用户看一张卡。
   - 要用这里没有的工具。
   - 拿不准。
   要交给主会话的事，先交，不要先动手：交上去以后，主会话会从头处理它。
3. 交给主会话时写清：为什么交（why）、已经查到了什么（findings）、建议怎么做（suggestion）。主会话据此接着做，不用再查一遍。交给主会话的事不要记处置。
4. 告诉用户。用户说过：除非要他介入，否则只要弱反馈。
   - 只是让用户知道、不用他做什么的事（工单做完了、检查通过了、升级好了、调查有了结果、别人的消息不是找他的）：不用单独告诉他，也不交给主会话。
     用 record_disposition 记 handled 或 no_action，reason 写清楚结果；finish_shadow 的那一句也写清楚。界面的「后台处理了」一栏会显示给用户，主会话下一次开口时也会看到。用户在不在看会话都一样。
   - 用户不在看会话，又必须马上知道、而且要他做什么（登录、授权、付费、审批、你处理不了的失败）：先用 notify_user 推给他，再记 told_user。
   - 要用户做决定、但不急的事：交给主会话，由它在会话里给他选择卡。
   - 外部消息要用户自己决定或回复的：记 told_user，带你写的给对方的回复草稿，卡留给用户，不用推送，也不用交给主会话。
5. 对外说话（reply_to_source、send_channel_message、react_channel_message）：和主会话一样，按每条消息的入站评估和交接说明来。
   说可以直接回的，能答准就直接回；说先给用户看的，回复会留在卡上等用户点发送；说不回的，不回。私信和频道一样。

省着用：每次调用模型都要读一遍上面的全部说明。
- 一次回复里可以同时调多个工具：要查的几样东西一起查；最后的 record_disposition 和 finish_shadow 在同一条回复里一起调。
- 工单的状态用 get_ticket_status 一次就够，它有工单、Run、blocker 和下一步；不用再调 query_tickets 和 get_ticket。
- 事件里已经写清楚的，不用再查。

最后调用一次 finish_shadow：这一批的每个编号都要出现在 done 或 escalate 里。done 的每一项写一句话：什么事、你怎么处理的、为什么。主会话下一次开口时会看到这句话。调用 finish_shadow 以后就结束，不要再写别的。`;

/** shadow 的系统提示词：Lead 的系统提示词（含常设指令和核心记忆），身份、代回复风格，再加 shadow 一节。 */
export function renderShadowSystemPrompt(parts: { lead: string; identity?: string | null; replyStyle?: string | null }): string {
  return [parts.lead, parts.identity, parts.replyStyle, SHADOW_SECTION].filter((part): part is string => Boolean(part && part.trim())).join("\n\n");
}

/** 每个shadow 会话固定的第一轮（用户、助手）。改它就是改缓存的键：只在规则变了时改。 */
export const SHADOW_OPENING = {
  user: "（shadow 开始。后面每条消息是一批后台事件。）",
  assistant: "好。我按 shadow 的规则处理每一批：能做完的做完并记下处置，该交给主会话的交上去，最后用 finish_shadow 交结论。",
} as const;

/**
 * 前面几批 shadow 刚处理过同一个对象（工单 #584）：每批是新会话，上一批看过的文件和它的判断这一批看不到。
 * 11-27：shadow-56 看了对方的第 1 张截图，shadow-57 接着处理对方的那句话时，只从卡的备注里看到 200 字的结论，没看到图。
 * at 是那一批结束的时间（本地时间的字），lines 是它给的结论，files 是它用 read_channel_file 看过的文件编号。
 */
export interface ShadowHandoff { object: string; batch: string; at: string; lines: string[]; files: string[] }

/** 交接的一段（放在这一批的事件后面）。没有时是空字符串。 */
export function shadowHandoffText(handoffs: readonly ShadowHandoff[]): string {
  const rows = handoffs.filter((handoff) => handoff.lines.length || handoff.files.length).map((handoff) => {
    const lines = handoff.lines.length ? `结论：${handoff.lines.join("；")}` : "没有留下结论";
    const files = handoff.files.length
      ? `；它看过的文件：${handoff.files.join("、")}（你这个会话看不到它们的内容，回复要用到时先用 read_channel_file 再看一次）`
      : "";
    return `- ${handoff.object}：${handoff.at} ${handoff.batch} ${lines}${files}`;
  });
  if (!rows.length) return "";
  return `<system_event kind="system" source="daemon">\n这一批里的对象，前面几批 shadow 刚处理过。每批是新会话，下面是它们交接给你的：\n${rows.join("\n")}\n</system_event>`;
}

/** 这一批用 read_channel_file 看过的文件编号（经 more_tools 调的也记在 recorder 里，名字是里面的工具）。被拒的不算。 */
export function shadowFilesRead(recorder: Pick<ShadowRecorder, "calls">): string[] {
  const files: string[] = [];
  for (const call of recorder.calls) {
    if (call.name !== "read_channel_file" || call.refused || call.dry) continue;
    const file = (call.args && typeof call.args === "object" ? call.args : {}) as { file?: unknown };
    if (typeof file.file === "string" && file.file && !files.includes(file.file)) files.push(file.file);
  }
  return files;
}

/** 一批事件交给 shadow 的那条消息。ids 是这一批要给结论的编号（事件块里写的 # 编号）。handoff 是 shadowHandoffText 的一段。 */
export function shadowBatchText(input: { clock: string; presence: string; events: string; ids: readonly number[]; handoff?: string }): string {
  const ids = input.ids.map((id) => `#${id}`).join("、");
  return [
    input.clock, input.presence, input.events, input.handoff ?? "",
    `<system_event kind="system" source="daemon">\n这一批要你给结论的编号：${ids}。每个编号都要出现在 finish_shadow 的 done 或 escalate 里。\n</system_event>`,
  ].filter(Boolean).join("\n\n");
}

export interface ShadowDone { ids: number[]; line: string }
export interface ShadowEscalation { ids: number[]; why: string; findings?: string; suggestion?: string }
export interface ShadowReport { done: ShadowDone[]; escalate: ShadowEscalation[] }

export interface ShadowToolCall { name: string; args: unknown; dry: boolean; refused?: string }

/** 一次shadow 会话里记下的事（包装工具写，结论用）。 */
export class ShadowRecorder {
  report: ShadowReport | null = null;
  readonly calls: ShadowToolCall[] = [];
  // record_disposition 记过处置的编号（试运行时是它「会」记的），和处置。
  readonly disposed = new Map<number, string>();
  // notify_user 推过几次。
  notified = 0;
  // 工具要用户做什么（授权卡、确认卡）：这一批要交给主会话。
  readonly userActions: string[] = [];
}

export interface ShadowWrapOptions {
  recorder: ShadowRecorder;
  /** 试运行：改东西的工具不执行。 */
  dryRun: boolean;
  /** 用户此刻在看会话。 */
  userWatching: () => boolean;
  /** 这一批里外部消息事件的编号（它们记 told_user 时卡留给用户，不用推）。 */
  messageIds: ReadonlySet<number>;
  /** 这个连接的这个工具是不是只读（ConnectionHub.isReadOnlyTool）。不给时连接工具一律不放行。 */
  connectionReadOnly?: (connection: string, tool: string) => boolean;
  /** 经 more_tools 调的工具开始时（daemon 据此把读了外部内容的一批标成外部的，和会话里直接调的工具一样）。 */
  onInnerToolStart?: (name: string) => void;
}

type AnyResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
const textResult = (text: string, details: Record<string, unknown> = {}): AnyResult => ({ content: [{ type: "text", text }], details });

/** 在执行之前就拒绝的情况（代码规则）。可以做时为 null。 */
export function shadowRefusal(
  name: string, params: unknown,
  options: Pick<ShadowWrapOptions, "userWatching" | "messageIds" | "connectionReadOnly"> & { notified: number },
): string | null {
  const args = (params && typeof params === "object" ? params : {}) as {
    disposition?: unknown; event_ids?: unknown; target_type?: unknown; action?: unknown; connection?: unknown; tool?: unknown;
  };
  const watching = options.userWatching();
  if (name === "perform_action" && !SHADOW_ACTION_ALLOWLIST.includes(`${String(args.target_type)}.${String(args.action)}`)) {
    return `shadow 只能做这几个操作：${SHADOW_ACTION_ALLOWLIST.join("、")}。这一件交给主会话（finish_shadow 的 escalate）。`;
  }
  if (name === "call_connection_tool"
    && !(options.connectionReadOnly?.(String(args.connection ?? ""), String(args.tool ?? "")) ?? false)) {
    return "shadow 只能调只读的连接工具。要写外部账号的事交给主会话（finish_shadow 的 escalate）。";
  }
  if (name === "notify_user" && watching) {
    return "用户正在看会话：要对他说的事交给主会话（finish_shadow 的 escalate），不要推送。";
  }
  if (name === "record_disposition" && args.disposition === "told_user") {
    if (watching) return "用户正在看会话：要对他说的事交给主会话（finish_shadow 的 escalate），不要记 told_user。";
    const ids = Array.isArray(args.event_ids) ? args.event_ids.filter((id): id is number => typeof id === "number") : [];
    const inboxOnes = ids.filter((id) => !options.messageIds.has(id));
    if (inboxOnes.length && options.notified === 0) {
      return "你还没有告诉用户：先用 notify_user 推给他，再记 told_user；不急的事交给主会话（finish_shadow 的 escalate）。";
    }
  }
  return null;
}

/** 给 Lead 的工具套上 shadow 的规则。只留清单里的工具，去掉 codemode 的 exposure（shadow 会话没有 codemode）。 */
export function wrapShadowTools(tools: readonly ToolDefinition<any>[], options: ShadowWrapOptions): ToolDefinition<any>[] {
  const wanted = new Set(SHADOW_LEAD_TOOL_NAMES);
  const { recorder } = options;
  return tools.filter((tool) => wanted.has(tool.name)).map((tool) => {
    const { exposure: _exposure, ...rest } = tool as ToolDefinition<any> & { exposure?: unknown };
    return {
      ...rest,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        const params = args[1];
        const refused = shadowRefusal(tool.name, params, { ...options, notified: recorder.notified });
        if (refused) {
          recorder.calls.push({ name: tool.name, args: params, dry: options.dryRun, refused });
          return textResult(refused, { shadowRefused: true });
        }
        if (options.dryRun && SHADOW_WRITES.has(tool.name)) {
          recorder.calls.push({ name: tool.name, args: params, dry: true });
          noteWrite(recorder, tool.name, params);
          return textResult("（试运行：这一步没有执行。按已经成功继续。）", { shadowDryRun: true });
        }
        recorder.calls.push({ name: tool.name, args: params, dry: false });
        const result = await tool.execute(...args) as AnyResult;
        const failed = (result as { isError?: boolean }).isError === true;
        if (!failed) noteWrite(recorder, tool.name, params);
        const action = userActionOfToolResult(result);
        if (action) recorder.userActions.push(`${tool.name}：${action.title}`);
        return result;
      },
    } as ToolDefinition<any>;
  });
}

/**
 * shadow 的整套工具：常驻的直接声明；入口后面的经 more_tools 调；加上 read_skill 和 finish_shadow。
 * 两份都套着 wrapShadowTools 的规则（拒绝、试运行、记账）。
 */
export function createShadowToolset(
  leadTools: readonly ToolDefinition<any>[], options: ShadowWrapOptions & { skillsDir: string },
): ToolDefinition<any>[] {
  const wrapped = wrapShadowTools(leadTools, options);
  const core = new Set<string>(SHADOW_CORE_TOOLS);
  const direct = wrapped.filter((tool) => core.has(tool.name));
  const extra = wrapped.filter((tool) => !core.has(tool.name));
  return [...direct, createShadowSkillTool(options.skillsDir), createShadowMoreTool(extra, options), createShadowFinishTool(options.recorder)];
}

/** more_tools：不常用的工具的入口。只给 name 时返回它的说明和参数；带 arguments 时调用它。 */
export function createShadowMoreTool(extra: readonly ToolDefinition<any>[], options: Pick<ShadowWrapOptions, "onInnerToolStart"> = {}): ToolDefinition<any> {
  const byName = new Map(extra.map((tool) => [tool.name, tool] as const));
  return defineTool({
    name: SHADOW_MORE_TOOL,
    label: "More Tools",
    description: `不常用的工具的入口：${[...byName.keys()].join("、")}。先只给 name 看它的说明和参数，再带 arguments 调用。`,
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 60 }),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "按这个工具的参数填" })),
    }),
    execute: async (id, params: { name: string; arguments?: Record<string, unknown> }, signal, onUpdate, ctx) => {
      const tool = byName.get(params.name);
      if (!tool) return textResult(`没有这个工具：${params.name}。有这些：${[...byName.keys()].join("、")}`);
      if (params.arguments === undefined) {
        return textResult(`${tool.name}：${tool.description}\n参数（JSON Schema）：${JSON.stringify(tool.parameters)}`);
      }
      options.onInnerToolStart?.(tool.name);
      return await tool.execute(id, params.arguments as never, signal, onUpdate, ctx) as AnyResult;
    },
  });
}

function noteWrite(recorder: ShadowRecorder, name: string, params: unknown): void {
  const args = (params && typeof params === "object" ? params : {}) as { disposition?: unknown; event_ids?: unknown };
  if (name === "notify_user") recorder.notified += 1;
  if (name === "record_disposition" && Array.isArray(args.event_ids) && typeof args.disposition === "string") {
    for (const id of args.event_ids) if (typeof id === "number") recorder.disposed.set(id, args.disposition);
  }
}

const IdList = Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: 50 });

/** 收尾的工具：这一批每个编号的结论。 */
export function createShadowFinishTool(recorder: ShadowRecorder): ToolDefinition<any> {
  return defineTool({
    name: SHADOW_FINISH_TOOL,
    label: "Finish Shadow",
    description: "shadow 的收尾：这一批的每个编号放进 done（你做完了，已经记下处置）或 escalate（交给主会话）。只调用一次，调用以后就结束。",
    parameters: Type.Object({
      done: Type.Array(Type.Object({
        ids: IdList,
        line: Type.String({ minLength: 1, maxLength: 300, description: "一句话：什么事、你怎么处理的、为什么。主会话会看到它。" }),
      }), { maxItems: 50 }),
      escalate: Type.Array(Type.Object({
        ids: IdList,
        why: Type.String({ minLength: 1, maxLength: 500, description: "为什么交给主会话" }),
        findings: Type.Optional(Type.String({ maxLength: 2_000, description: "已经查到了什么" })),
        suggestion: Type.Optional(Type.String({ maxLength: 1_000, description: "建议主会话怎么做" })),
      }), { maxItems: 50 }),
    }),
    execute: async (_id, params: ShadowReport) => {
      recorder.report = { done: params.done ?? [], escalate: params.escalate ?? [] };
      recorder.calls.push({ name: SHADOW_FINISH_TOOL, args: params, dry: false });
      return textResult("收到。这一批结束了。");
    },
  });
}

/** 读 Lead 自带的 skill：只认 skillsDir 下面的目录名，读它的 SKILL.md。 */
export function createShadowSkillTool(skillsDir: string): ToolDefinition<any> {
  const names = (() => {
    try {
      return readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()
        && existsSync(join(skillsDir, entry.name, "SKILL.md"))).map((entry) => entry.name).sort();
    } catch {
      return [];
    }
  })();
  return defineTool({
    name: SHADOW_SKILL_TOOL,
    label: "Read Skill",
    description: `读你自带的一个 skill 的全文。有这些：${names.join("、") || "（没有）"}。`,
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 80, pattern: "^[a-z0-9-]+$" }) }),
    execute: async (_id, params: { name: string }) => {
      if (!names.includes(params.name)) return textResult(`没有这个 skill：${params.name}。有这些：${names.join("、")}`);
      return textResult(readFileSync(join(skillsDir, params.name, "SKILL.md"), "utf8"));
    },
  });
}

export interface ShadowOutcome {
  done: Array<{ ids: number[]; line: string }>;
  escalated: Array<{ ids: number[]; note: string }>;
}

/**
 * 这一批的结论（决策边界，纯函数）。ids 是这一批要给结论的编号。needsDisposition(id)：这件事要有处置才算做完
 * （收件箱的事、外部消息事件）。disposed(id)：它有处置了（真的记下了，或者试运行时「会」记）。
 * 规则：出错或没有 finish_shadow，全部交给主会话；工具要用户做什么，全部交给主会话；
 * 同时在 done 和 escalate 里的，交；说做完却没有处置的，交；没给结论的，交。
 */
export function resolveShadowOutcome(input: {
  ids: readonly number[];
  report: ShadowReport | null;
  error?: string | null;
  userActions?: readonly string[];
  needsDisposition: (id: number) => boolean;
  disposed: (id: number) => boolean;
}): ShadowOutcome {
  const all = [...new Set(input.ids)];
  if (input.error || !input.report) {
    return { done: [], escalated: [{ ids: all, note: `shadow 没有交结论${input.error ? `（${input.error}）` : ""}，这一批由你处理。` }] };
  }
  if (input.userActions?.length) {
    const findings = escalationNotes(input.report, new Set(all));
    return {
      done: [],
      escalated: [{ ids: all, note: `shadow 的工具要用户做什么（${input.userActions.join("；")}），卡要你给用户看，这一批由你处理。${findings}` }],
    };
  }
  const wanted = new Set(all);
  const escalated = new Map<number, string>();
  for (const item of input.report.escalate) {
    const note = [`shadow 交给你：${item.why}`, item.findings ? `查到的：${item.findings}` : "", item.suggestion ? `建议：${item.suggestion}` : ""]
      .filter(Boolean).join("；");
    for (const id of item.ids) if (wanted.has(id)) escalated.set(id, note);
  }
  const done: ShadowOutcome["done"] = [];
  for (const item of input.report.done) {
    const ids: number[] = [];
    for (const id of item.ids) {
      if (!wanted.has(id) || escalated.has(id)) continue;
      if (input.needsDisposition(id) && !input.disposed(id)) {
        escalated.set(id, `shadow 说做完了（${item.line}），但没有记下处置，这件事由你处理。`);
        continue;
      }
      if (!ids.includes(id) && !done.some((entry) => entry.ids.includes(id))) ids.push(id);
    }
    if (ids.length) done.push({ ids, line: item.line });
  }
  const finished = new Set(done.flatMap((entry) => entry.ids));
  for (const id of all) {
    if (!finished.has(id) && !escalated.has(id)) escalated.set(id, "shadow 没有给这件事结论，由你处理。");
  }
  const byNote = new Map<string, number[]>();
  for (const [id, note] of escalated) byNote.set(note, [...(byNote.get(note) ?? []), id]);
  return { done, escalated: [...byNote].map(([note, ids]) => ({ ids, note })) };
}

function escalationNotes(report: ShadowReport, wanted: ReadonlySet<number>): string {
  const lines = report.escalate.filter((item) => item.ids.some((id) => wanted.has(id)))
    .map((item) => [item.why, item.findings, item.suggestion].filter(Boolean).join("；"));
  return lines.length ? `shadow 查到的：${lines.join(" / ")}` : "";
}
