// Lead 的等待（2026-10-19，protocol 的 lead-waits.ts）：Lead 在等用户的下一步时，用户做了，系统叫醒它。
//
// 两条路登记等待：
//   · Lead 自己声明：wait_for_user_action（对象 + 备注 + 超时），cancel_wait 取消。
//   · 系统自动登记（withUserActionWaits）：Lead 的任何一个工具返回了「需要用户做什么」（user-actions.ts，
//     details.userAction 或者 JSON 正文里的 user_action），或者声明了要等的事（details.leadWait，例如请求重启以后等重启完成），
//     系统就按它登记一条等待。不靠 Lead 记得，也不按工具、按服务写特例。
// 这一轮里工具返回的「需要用户做什么」还记在 TurnUserActions 里：render_ui 用它检查卡片有没有给用户能点的控件（tools.ts）。
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  LEAD_WAIT_LIMITS, leadWaitKeyProblem, userActionOfToolResult, type UserActionRequest,
} from "@pi-lead-child/protocol";
import { localIso } from "@pi-lead-child/core";
import { cancelLeadWait, getItem, getLeadWait, registerLeadWait, type Db, type LeadWait } from "@pi-lead-child/store";

/** 这一轮里出现过的「需要用户做什么」：工具返回的，和交给这一轮的事件里带的。daemon 每一轮开始时清空。 */
export interface TurnUserActions {
  add(action: UserActionRequest): void;
  list(): UserActionRequest[];
  reset(): void;
}

export function createTurnUserActions(): TurnUserActions {
  let actions: UserActionRequest[] = [];
  return {
    add(action) {
      if (!actions.some((known) => known.kind === action.kind && known.target === action.target)) actions = [...actions, action];
    },
    list: () => actions,
    reset() {
      actions = [];
    },
  };
}

/**
 * 工具声明要等的一件事（details.leadWait）：不是用户的一次操作，而是一件会自己发生的事，
 * 例如请求重启以后等 daemon 重新启动（daemon:main）。mustTell：等到以后必须告诉用户。
 */
export interface ToolLeadWait {
  entityKey: string;
  note: string;
  mustTell?: boolean;
  timeoutMs?: number;
}

function toolLeadWaitOf(result: unknown): ToolLeadWait | null {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  const wait = details && typeof details === "object" ? (details as { leadWait?: unknown }).leadWait : undefined;
  if (!wait || typeof wait !== "object") return null;
  const { entityKey, note, mustTell, timeoutMs } = wait as Record<string, unknown>;
  if (typeof entityKey !== "string" || leadWaitKeyProblem(entityKey) || typeof note !== "string" || !note.trim()) return null;
  return {
    entityKey, note,
    ...(mustTell === true ? { mustTell: true } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

const ACTION_LABELS: Record<UserActionRequest["kind"], string> = {
  authorize: "连接", reauthorize: "重新授权", confirm_write: "确认这次写入", choose: "做出选择", approve: "处理审批", accept: "验收",
  confirm_rule_change: "确认改规则",
  confirm_timer: "确认定时器",
};

function waitLine(wait: LeadWait, created: boolean): string {
  return `[系统已${created ? "登记" : "更新"}等待 #${wait.id}：用户在 ${wait.entityKey} 上做了下一步（或者状态变了）时叫醒你，`
    + `带着备注「${wait.note}」；${localIso(new Date(wait.expiresAt))} 还没等到也会叫醒你。不用另外设跟进。]`;
}

type AnyResult = { content: Array<{ type: string; text?: string }>; details?: unknown };

function withNote(result: AnyResult, note: string): AnyResult {
  return { ...result, content: [...result.content, { type: "text", text: note }] };
}

/**
 * 包一层所有 Lead 工具：工具的结果带着「需要用户做什么」或者要等的事时，系统登记等待，并在结果后面告诉 Lead 登记了。
 * 登记失败不影响工具的结果（写进日志）：工具本身已经做完了。
 */
export function withUserActionWaits(
  deps: { db: Db; turnUserActions?: TurnUserActions; log?: (line: string) => void },
  tools: ToolDefinition<any>[],
): ToolDefinition<any>[] {
  return tools.map((tool) => ({
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      const result = await tool.execute(...args) as AnyResult;
      const notes: string[] = [];
      try {
        const action = userActionOfToolResult(result);
        if (action) {
          deps.turnUserActions?.add(action);
          const registered = registerLeadWait(deps.db, {
            entityKey: action.target,
            note: `等用户${ACTION_LABELS[action.kind]}（${action.title}）：${action.reason}。等到以后接着做因此停下的事。`,
            origin: `tool:${tool.name}`,
            userAction: action,
          });
          notes.push(waitLine(registered.wait, registered.created));
        }
        const awaited = toolLeadWaitOf(result);
        if (awaited) {
          const registered = registerLeadWait(deps.db, {
            entityKey: awaited.entityKey, note: awaited.note, origin: `tool:${tool.name}`,
            ...(awaited.mustTell ? { mustTell: true } : {}),
            ...(awaited.timeoutMs !== undefined ? { timeoutMs: awaited.timeoutMs } : {}),
          });
          notes.push(waitLine(registered.wait, registered.created));
        }
      } catch (error) {
        (deps.log ?? console.error)(`[lead] registering a wait for ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return notes.length ? withNote(result, notes.join("\n")) : result;
    },
  })) as ToolDefinition<any>[];
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }], details: {} };
}

export function createWaitTools(deps: { db: Db }): ToolDefinition<any>[] {
  const { db } = deps;
  return [
    defineTool({
      name: "wait_for_user_action",
      label: "Wait For User Action",
      description:
        "声明你在等用户在某个对象上的下一步：用户在这个对象上做了任何操作（点了按钮、验收、委托、授权、回答、发消息），"
        + "或者它的状态变了，系统叫醒你，带着你现在写的备注和发生了什么；到了超时还没等到，也叫醒你。"
        + "对象写成「类型:编号」：ticket:98（工单）、connection:github（连接）、decision:12（决定请求）、"
        + "connection_confirmation:cfm_xxx（写入确认）、approval:5（审批）、reminder:83（提醒）、rule_change:rcc_xxx（改规则的确认卡）。"
        + "工具返回了「需要用户做什么」（user_action）时系统已经自动登记，不用再调这个工具；"
        + "这个工具用于系统看不出来的等待，例如你在会话里请用户去点「验收」。"
        + "同一个对象只有一条等待，再声明时换成新的备注。不要用 follow_up 轮询用户有没有做。",
      parameters: Type.Object({
        entity: Type.String({ minLength: 3, maxLength: 80, description: "对象，例如 ticket:98、connection:github" }),
        note: Type.String({ minLength: 1, maxLength: LEAD_WAIT_LIMITS.noteMaxChars, description: "在等什么，等到以后做什么" }),
        timeout_minutes: Type.Optional(Type.Integer({
          minimum: LEAD_WAIT_LIMITS.minMs / 60_000, maximum: LEAD_WAIT_LIMITS.maxMs / 60_000,
          description: `最多等多久（分钟），缺省 ${LEAD_WAIT_LIMITS.defaultMs / 60_000}`,
        })),
      }),
      execute: async (_id, params: { entity: string; note: string; timeout_minutes?: number }) => {
        const entity = params.entity.trim();
        const problem = leadWaitKeyProblem(entity);
        if (problem) throw new Error(problem);
        const [prefix, id] = entity.split(":") as [string, string];
        if ((prefix === "ticket" || prefix === "reminder") && !getItem(db, Number(id))) throw new Error(`${entity} 不存在`);
        const registered = registerLeadWait(db, {
          entityKey: entity,
          note: params.note,
          origin: "lead",
          ...(params.timeout_minutes !== undefined ? { timeoutMs: params.timeout_minutes * 60_000 } : {}),
        });
        return text(waitLine(registered.wait, registered.created).replace(/^\[|\]$/gu, ""));
      },
    }),
    defineTool({
      name: "cancel_wait",
      label: "Cancel Wait",
      description: "取消一条等待（不用再等了，例如用户在会话里说不做了）。wait_id 在当前局面的「你在等的用户操作」里。",
      parameters: Type.Object({
        wait_id: Type.Integer({ minimum: 1 }),
        reason: Type.String({ minLength: 1, maxLength: 300 }),
      }),
      execute: async (_id, params: { wait_id: number; reason: string }) => {
        const wait = getLeadWait(db, params.wait_id);
        if (!wait) throw new Error(`等待 #${params.wait_id} 不存在`);
        if (!cancelLeadWait(db, params.wait_id, { reason: params.reason })) {
          return text(`等待 #${params.wait_id} 已经不在等了（${wait.state}），不用取消`);
        }
        return text(`已取消等待 #${params.wait_id}（${wait.entityKey}）`);
      },
    }),
  ];
}
