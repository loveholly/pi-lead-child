// Lead 的可信度检查（2026-10-19，.scratch/lead-credibility/spec.md 的 D1、D2）。一个 pi 扩展，挂在 Lead 会话上。
//
// 1. 代码引用核对。Lead 写出去的文字里有 `路径:行号` 或带目录的文件路径时，发出前在相关的目录里核对。
//    - 工具带出去的文字（批注、决定、验收理由、通知、卡片、GitHub 评论……）：pi 的 tool_call 钩子在工具执行之前跑，
//      核对失败就拦下这次调用，Lead 收到出错的工具结果，里面列出每个失败的引用。文字没有发出去。
//      PR 新增的文件、要新建的文件，本地可能确实没有：Lead 原样再调一次（同一个工具、同样的参数）就放行，并记一条活动。
//    - 会话回复：daemon 一边收一边把文字推给用户，收不回来。pi 的 agent_before_settle 是这一轮最后一个能追加条目、
//      再要一次回答的边界：核对失败时追加一条不显示的系统说明，让 Lead 在同一轮里写更正。每轮最多一次。
// 2. 验收证据。记下这一轮 Lead 成功调用过的取证工具（TurnEvidence），record_decision 和 ticket_action 的验收（complete）读它。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { addActivity, type Db } from "@pi-lead-child/store";
import {
  describeFailures, extractCodeRefs, failedChecks, verifyCodeRefs, type CodeRef, type CodeRefCheck,
} from "./code-refs.js";
import { githubRepoRoots, knownRoots, ticketIdsInText, ticketRoots } from "./roots.js";
import type { TurnEvidence } from "./evidence.js";

export const CODE_REFS_MESSAGE_TYPE = "plc-code-refs";

// 文字会发给用户或写进账本的工具，以及要核对的参数。call_connection_tool 另算（只核对写入外部账号的调用）。
const OUTGOING_TEXT_FIELDS: Readonly<Record<string, readonly string[] | "all">> = {
  add_comment: ["content"],
  record_decision: ["decision", "reason"],
  // 验收、返工的理由写进账本（2026-10-28 删掉 accept_review、request_rework 以后由 ticket_action 承担）。
  ticket_action: ["reason"],
  complete_delivery: ["reason"],
  notify_user: ["title", "body"],
  record_disposition: ["reason", "cause", "action", "follow_up"],
  render_ui: "all",
};

export interface CredibilityOptions {
  db: Db;
  evidence: TurnEvidence;
  // 哪些工具的结果算证据（读文件、查账本、读外部账号）。笔记不算。
  isEvidenceTool: (name: string) => boolean;
  // 外部账号的工具是不是只读：只读的调用不核对（它不发出文字）。不知道时按会写入处理。
  connectionToolReadOnly?: (connection: string, tool: string) => boolean | null;
  log?: (line: string) => void;
}

function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, out, depth + 1);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) strings(entry, out, depth + 1);
  return out;
}

const int = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);

// GitHub 行内评论的结构化位置：{ path, line, start_line? }，可能在 comments 数组里。
function structuredRefs(value: unknown, out: CodeRef[] = [], depth = 0): CodeRef[] {
  if (depth > 6 || !value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const entry of value) structuredRefs(entry, out, depth + 1);
    return out;
  }
  const record = value as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  const line = int(record.line);
  if (path && line !== null && !path.includes("://")) {
    const start = int(record.start_line) ?? int(record.startLine);
    const ref = start !== null && start <= line
      ? { raw: `${path}:${start}-${line}`, path, line: start, endLine: line }
      : { raw: `${path}:${line}`, path, line, endLine: null };
    out.push(ref);
  }
  for (const entry of Object.values(record)) structuredRefs(entry, out, depth + 1);
  return out;
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

// render_ui 的 SourceQuote 只给位置：heading、contains 是原文里的话，text 由服务端从账本换掉。
// 原文里提到的文件（例如 PR 新增的文件）本地可能没有，这些不是 Lead 写的引用，不核对。
function withoutQuoteLocators(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.nodes)) return input;
  return {
    ...input,
    nodes: input.nodes.filter((node) => !(node && typeof node === "object" && (node as { type?: unknown }).type === "SourceQuote")),
  };
}

interface OutgoingCheck {
  refs: CodeRef[];
  roots: string[];
  // roots 里只有「所有登记的仓库」这种兜底：找不到文件时算核对不了（code-refs.ts 的 fallbackOnly）。
  fallbackOnly: boolean;
  commit: string | null;
  ticketId: number | null;
}

export function outgoingCheckFor(
  db: Db,
  toolName: string,
  input: Record<string, unknown>,
  connectionToolReadOnly?: CredibilityOptions["connectionToolReadOnly"],
): OutgoingCheck | null {
  const ticketId = int(input.ticket_id);
  let texts: string[];
  let structured: CodeRef[] = [];
  let repoRoots: string[] | null = null;
  let commit: string | null = null;
  if (toolName === "call_connection_tool") {
    const connection = stringField(input, "connection");
    const tool = stringField(input, "tool");
    if (!connection || !tool || connectionToolReadOnly?.(connection, tool) === true) return null;
    const args = (input.arguments && typeof input.arguments === "object" ? input.arguments : {}) as Record<string, unknown>;
    texts = strings(args);
    if (typeof input.summary === "string") texts.push(input.summary);
    structured = structuredRefs(args);
    commit = stringField(args, "commit_id", "commitId", "commitID", "commit_sha", "sha");
    const owner = stringField(args, "owner");
    const repo = stringField(args, "repo");
    const full = stringField(args, "repository", "repo_full_name");
    const [fullOwner, fullRepo] = full?.split("/") ?? [];
    if (owner && repo) repoRoots = githubRepoRoots(db, owner, repo);
    else if (fullOwner && fullRepo) repoRoots = githubRepoRoots(db, fullOwner, fullRepo);
  } else {
    const fields = OUTGOING_TEXT_FIELDS[toolName];
    if (!fields) return null;
    texts = fields === "all" ? strings(withoutQuoteLocators(input)) : fields.map((field) => input[field]).filter((value): value is string => typeof value === "string");
  }
  const joined = texts.join("\n");
  const seen = new Set<string>();
  const refs = [...structured, ...extractCodeRefs(joined)].filter((ref) => !seen.has(ref.raw) && seen.add(ref.raw));
  if (refs.length === 0) return null;
  // 认出了 GitHub 仓库：只在那个仓库里核对（行内评论的路径相对它）。本地没有那个仓库时核对不了。
  if (repoRoots) return { refs, roots: repoRoots, fallbackOnly: false, commit, ticketId };
  const related = [
    ...(ticketId !== null ? ticketRoots(db, ticketId) : []),
    ...ticketIdsInText(joined).flatMap((id) => ticketRoots(db, id)),
  ];
  return { refs, roots: [...related, ...knownRoots(db)], fallbackOnly: related.length === 0, commit, ticketId };
}

export function checkOutgoing(check: OutgoingCheck): CodeRefCheck[] {
  return failedChecks(verifyCodeRefs(check.refs, check.roots, { commit: check.commit, fallbackOnly: check.fallbackOnly }));
}

function blockReason(toolName: string, failures: readonly CodeRefCheck[]): string {
  return [
    `${toolName} 没有执行：文字里的代码引用核对失败（系统在相关的工作目录和仓库里查过）。`,
    describeFailures(failures),
    "先用 read、grep、find 查到正确的路径和行号，改好再调用；查不到的，写明不确定，不要写路径。"
      + "如果你确认这些引用没错（例如 PR 新增的文件、要新建的文件，本地还没有），原样再调用一次，系统会放行并记下来。",
  ].join("\n");
}

function assistantText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text"
    ? String((part as { text?: unknown }).text ?? "") : "")).join("");
}

export function correctionMessage(failures: readonly CodeRefCheck[]): string {
  return [
    "（系统核对，不是用户说的话。）你刚才的回复里，下面这些代码引用核对失败：",
    describeFailures(failures),
    "用户已经看到了那段回复。接着写一两句更正：哪几处写错了，正确的路径和行号是什么（先用 read、grep、find 查到再写）；"
      + "查不到的，说明不确定。不要重复整段回复。如果引用其实没错（例如 PR 新增的文件，本地还没有），说明这一点。",
  ].join("\n");
}

export function createCredibilityExtension(options: CredibilityOptions): ExtensionFactory {
  return (pi) => {
    let texts: string[] = [];
    // 这一轮的输入（用户的话、系统事件）。用户自己写的路径（例如「看看 src/x.ts 还在不在」）不要求 Lead 更正。
    let prompts: string[] = [];
    // 这一轮工具调用碰过的工单（参数里的 ticket_id、item_id）。会话回复的引用也在它们的工作目录里核对。
    let touched = new Set<number>();
    let corrected = false;
    let blocked = new Set<string>();
    const pendingArgs = new Map<string, { tool: string; args: unknown }>();

    // 一轮结束时清空。不在 agent_start 清：续写更正（continue: true）和排队的消息都会再起一次 agent_start，
    // 那样更正的次数和这一轮的证据都会被清掉。agent_settled 在一轮彻底结束时只发一次（agent-session.js 的 finally）。
    pi.on("before_agent_start", (event) => {
      prompts.push(event.prompt ?? "");
    });

    pi.on("agent_settled", () => {
      options.evidence.reset();
      texts = [];
      prompts = [];
      touched = new Set();
      corrected = false;
      blocked = new Set();
      pendingArgs.clear();
    });

    pi.on("tool_execution_start", (event) => {
      const args = (event.args && typeof event.args === "object" ? event.args : {}) as Record<string, unknown>;
      for (const id of [int(args.ticket_id), int(args.item_id)]) if (id !== null) touched.add(id);
      if (options.isEvidenceTool(event.toolName)) pendingArgs.set(event.toolCallId, { tool: event.toolName, args: event.args });
    });

    pi.on("tool_execution_end", (event) => {
      const started = pendingArgs.get(event.toolCallId);
      pendingArgs.delete(event.toolCallId);
      if (started && !event.isError && !(event.result as { isError?: boolean } | null)?.isError) {
        options.evidence.record(started.tool, started.args);
      }
    });

    pi.on("message_end", (event) => {
      if (event.message.role === "assistant") texts.push(assistantText(event.message));
    });

    pi.on("tool_call", (event) => {
      let check: OutgoingCheck | null;
      try {
        check = outgoingCheckFor(options.db, event.toolName, event.input as Record<string, unknown>, options.connectionToolReadOnly);
      } catch (error) {
        options.log?.(`code refs: not checked for ${event.toolName}: ${(error as Error).message}`);
        return undefined;
      }
      if (!check) return undefined;
      const failures = checkOutgoing(check);
      if (failures.length === 0) return undefined;
      const signature = `${event.toolName}\u0000${JSON.stringify(event.input)}`;
      const refs = failures.map((failure) => failure.ref.raw);
      const recordUnverified = () => {
        options.log?.(`code refs: ${event.toolName} sent with unverified refs: ${refs.join(", ")}`);
        if (check.ticketId === null) return;
        try {
          addActivity(options.db, {
            itemId: check.ticketId, actor: "lead", kind: "decision",
            payload: { decision: "code_refs_sent_unverified", tool: event.toolName, refs },
          });
        } catch { /* 工单不在时只记日志 */ }
      };
      // 只拦写到外部账号的（例如 GitHub 上的评审意见）：发出去就收不回。工单批注、记录、通知这些内部的不拦，记下没核对上
      // （2026-10-29：一个上午拦了 7 次 add_comment，引用的是要新建的文件或别的仓库里的文件，每次原样重发都放行，只多花轮次）。
      if (event.toolName !== "call_connection_tool" || blocked.has(signature)) {
        recordUnverified();
        return undefined;
      }
      blocked.add(signature);
      return { block: true, reason: blockReason(event.toolName, failures) };
    });

    pi.on("agent_before_settle", (event) => {
      // 不看 event.context.canContinue：它是追加条目之前的预览，最后一条还是 Lead 的回答，所以总是 false。
      // pi 提交了这里追加的说明以后再判断一次能不能续写（agent-session.js 的 _runBeforeSettleBoundary）。
      if (corrected || event.outcome !== "completed") return undefined;
      const text = texts.join("\n").trim();
      if (!text || text === "NO_REPLY") return undefined;
      let failures: CodeRefCheck[];
      try {
        const asked = prompts.join("\n");
        const refs = extractCodeRefs(text).filter((ref) => !asked.includes(ref.path));
        if (refs.length === 0) return undefined;
        // 相关的工单：回复和这一轮输入里写到的 #编号，以及这一轮工具碰过的工单。一张都没有时只有登记的仓库兜底，
        // 找不到的文件算核对不了（用户可能在说一个没有登记的仓库）。
        const tickets = new Set([...ticketIdsInText(`${text}\n${asked}`), ...touched]);
        const related = [...tickets].flatMap((id) => ticketRoots(options.db, id));
        failures = failedChecks(verifyCodeRefs(refs, [...related, ...knownRoots(options.db)], { fallbackOnly: related.length === 0 }));
      } catch (error) {
        options.log?.(`code refs: reply not checked: ${(error as Error).message}`);
        return undefined;
      }
      if (failures.length === 0) return undefined;
      corrected = true;
      options.log?.(`code refs: asked Lead to correct its reply: ${failures.map((failure) => failure.ref.raw).join(", ")}`);
      return {
        entries: [{ type: "custom_message", customType: CODE_REFS_MESSAGE_TYPE, content: correctionMessage(failures), display: false }],
        continue: true,
      };
    });
  };
}
