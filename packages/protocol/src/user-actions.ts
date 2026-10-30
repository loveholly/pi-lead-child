// 「需要用户做什么」的结构化数据（2026-10-19）。
//
// 以前「要用户做事」只是一句话：连接工具返回 needs_reauth 时，JSON 里写着「发一张 ConnectionConnect 卡」。
// 2026-10-19 工单 #98，Lead 第一次用 render_ui 拼了一张没有授权按钮的文字卡，第二次才用对组件。
// 用户的要求：不按服务（GitHub、Jira……）写特例卡片，而是把「需要用户授权」这类场景做成数据，由 Lead 用 genui 组合卡片。
//
// 现在系统产出一份 UserActionRequest：工具的返回和错误、事件、当前局面里都带着它。
//   · kind：做什么。authorize（第一次连接）、reauthorize（授权失效，重新授权）、confirm_write（允许一次写入）、
//     choose（在几个选项里选一个）、approve（处理一条审批）、accept（验收一张工单）、
//     confirm_rule_change（放行一次被拦下的改规则操作，rule-change-confirmations.ts）。
//     confirm_timer（外部的人要求设的定时器，代价不够低，请用户决定设不设，timer-origins.ts）。
//   · target：在哪个对象上做。写法和事件日志的 entity_key 一样（connection:github、decision:12、ticket:98）。
//   · title：按钮上的字。reason：为什么要做，给用户看的一句话。
// 它有两个用处：
//   1. Lead 把它原样放进组件目录里的 UserAction 组件（ui-surfaces.ts）。客户端按 kind 画出能点的控件，
//      控件只走这个对象自己的路由（只有用户能按到）。Lead 不给 URL、不给接口，所以卡片做不了别的事。
//   2. 系统按 target 自动登记一条等待（lead-waits.ts）：用户在这个对象上做了下一步时，叫醒 Lead。
// 这个文件只依赖 typebox，companion 也读它。
import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const USER_ACTION_KINDS = [
  "authorize", "reauthorize", "confirm_write", "choose", "approve", "accept", "confirm_rule_change", "confirm_timer",
] as const;
export type UserActionKind = typeof USER_ACTION_KINDS[number];

// 每种动作能用在哪种对象上。客户端按这张表找到控件和路由；服务端校验 Lead 给的数据。
// 连接的 key 和 ConnectionConnect 的 connection 同一个写法；写入确认的编号和 ConnectionConfirm 的 confirmation 同一个写法。
export const USER_ACTION_TARGETS: Readonly<Record<UserActionKind, { prefix: string; id: RegExp }>> = {
  authorize: { prefix: "connection", id: /^[a-z][a-z0-9-]{0,39}$/ },
  reauthorize: { prefix: "connection", id: /^[a-z][a-z0-9-]{0,39}$/ },
  confirm_write: { prefix: "connection_confirmation", id: /^cfm_[A-Za-z0-9_-]{8,40}$/ },
  choose: { prefix: "decision", id: /^[1-9]\d{0,9}$/ },
  approve: { prefix: "approval", id: /^[1-9]\d{0,9}$/ },
  accept: { prefix: "ticket", id: /^[1-9]\d{0,9}$/ },
  confirm_rule_change: { prefix: "rule_change", id: /^rcc_[A-Za-z0-9_-]{8,40}$/ },
  confirm_timer: { prefix: "timer_request", id: /^tmr_[A-Za-z0-9_-]{8,40}$/ },
};

export const USER_ACTION_LIMITS = { title: 40, reason: 300 } as const;

export const UserActionRequestSchema = StrictObject({
  kind: Type.Union([
    Type.Literal("authorize"), Type.Literal("reauthorize"), Type.Literal("confirm_write"),
    Type.Literal("choose"), Type.Literal("approve"), Type.Literal("accept"), Type.Literal("confirm_rule_change"),
    Type.Literal("confirm_timer"),
  ]),
  target: Type.String({ minLength: 3, maxLength: 80 }),
  title: Type.String({ minLength: 1, maxLength: USER_ACTION_LIMITS.title }),
  reason: Type.String({ minLength: 1, maxLength: USER_ACTION_LIMITS.reason }),
});
export type UserActionRequest = Static<typeof UserActionRequestSchema>;

/** target 拆成对象的类型和编号。写法不对时返回 null。 */
export function userActionTargetParts(target: string): { prefix: string; id: string } | null {
  const at = target.indexOf(":");
  if (at <= 0) return null;
  return { prefix: target.slice(0, at), id: target.slice(at + 1) };
}

/** 校验一份「需要用户做什么」。返回问题列表；空数组表示可以用。 */
export function userActionProblems(input: unknown): string[] {
  if (!Value.Check(UserActionRequestSchema, input)) {
    const first = [...Value.Errors(UserActionRequestSchema, input)][0];
    return [`结构不对${first ? `：${first.instancePath || "/"} ${first.message}` : ""}`
      + `（要有 kind、target、title、reason；kind 是 ${USER_ACTION_KINDS.join("、")} 之一）`];
  }
  const rule = USER_ACTION_TARGETS[input.kind];
  const parts = userActionTargetParts(input.target);
  if (!parts || parts.prefix !== rule.prefix || !rule.id.test(parts.id)) {
    return [`kind=${input.kind} 的 target 要写成 ${rule.prefix}:<编号>，现在是 ${input.target}`];
  }
  return [];
}

export function isUserActionRequest(input: unknown): input is UserActionRequest {
  return userActionProblems(input).length === 0;
}

// 截到上限，给系统自己生成的数据用（原因可能是一段很长的错误原文）。
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** 系统生成一份「需要用户做什么」：按上限截好 title、reason。数据不合格时抛错（这是代码的错，不是用户的）。 */
export function userActionRequest(input: { kind: UserActionKind; target: string; title: string; reason: string }): UserActionRequest {
  const request: UserActionRequest = {
    kind: input.kind,
    target: input.target,
    title: clip(input.title, USER_ACTION_LIMITS.title),
    reason: clip(input.reason, USER_ACTION_LIMITS.reason),
  };
  const problems = userActionProblems(request);
  if (problems.length) throw new Error(`user action: ${problems.join("；")}`);
  return request;
}

/**
 * 工具结果里带着的「需要用户做什么」：只认工具自己写的 details.userAction。没有、或者数据不合格时返回 null。
 * 结果正文一律不解析（2026-10-19 审查）：call_connection_tool 的正文是外部 MCP 的原文，自定义的 MCP 可以在里面写一段
 * user_action，借系统的身份登记等待、给出带它自己的标题和原因的按钮。
 */
export function userActionOfToolResult(result: unknown): UserActionRequest | null {
  if (!result || typeof result !== "object") return null;
  const { details } = result as { details?: unknown };
  const fromDetails = details && typeof details === "object" ? (details as { userAction?: unknown }).userAction : undefined;
  return isUserActionRequest(fromDetails) ? fromDetails : null;
}
