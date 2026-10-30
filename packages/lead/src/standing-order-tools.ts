// Lead 修改常设指令（Lead 事件主干 spec D4，工单 10）：propose_standing_order_change。
//
// 档位由系统判断（protocol 的 standing-order-tiers.ts），Lead 不能自己说是哪一档：
//   - 更保守：马上生效，作者 lead。系统写一条 standing_order.changed 事件，在「Lead 动态」里告诉用户。
//   - 更放开：生成审批（approvals 表），用户批准后才生效。Lead 发一张 StandingOrderChangeConfirm 卡，
//     只有用户能按（网关的 /v1/standing-order-proposals 路由，权限 approvals:respond）。Lead 用 perform_action 处理这条审批会被拒绝（user_direct）。
//   - 碰到硬性安全规则：拒绝，什么也不写。
// 回滚（op=rollback）也是写一个新版本，内容等于那一版，同样分档：回滚到更放开的版本也要批准。
// 常设指令就是投递规则：这一轮带着外部内容时（外部消息叫醒的、读过外部内容的），哪一档都不改，返回结构化的拒绝
// （turn-origin.ts 规则 4，spec D10），带着确认卡的 user_action。用户本人正在说话的那一轮不受这个限制。
// 用户在卡上确认以后，系统照存下的参数调同一个提议函数（engine 的 rule-change-confirmations.ts，工单 09），分档照旧。
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { standingOrderChangeRequestOf } from "@pi-lead-child/engine";
import { STANDING_ORDER_CHANGE_OPS, TRIAGE_LEVELS, type StandingOrderChangeOp, type TriageLevel } from "@pi-lead-child/protocol";
import {
  proposeStandingOrderChange, StandingOrderChangeError, STANDING_ORDER_PROPOSAL_TTL_MS,
  type Db, type StandingOrderProposeResult,
} from "@pi-lead-child/store";
import { ruleChangeRefusal, ruleChangeRefusedResult, type TurnOriginDeps } from "./turn-origin.js";

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: {} };
}

interface ProposeParams {
  op: StandingOrderChangeOp;
  id: string;
  reason: string;
  title?: string;
  priority?: number;
  condition?: Record<string, unknown>;
  action?: Record<string, unknown>;
  limits?: Record<string, unknown> | null;
  escalate_to?: TriageLevel | null;
  to_version?: number;
}

function report(result: Exclude<StandingOrderProposeResult, { outcome: "refused" | "unchanged" }>) {
  const findings = result.plan.classification.findings.map((item) => ({ tier: item.tier, detail: item.detail }));
  if (result.outcome === "applied") {
    return json({
      result: "applied",
      tier: "conservative",
      order: { id: result.written.order.id, version: result.written.order.version, status: result.written.order.status },
      findings,
      next: "已经生效。系统写了一条 standing_order.changed 事件，用户会在「Lead 动态」里看到。"
        + "不用另外告诉用户，除非他正在问这件事。",
    });
  }
  return json({
    result: "pending_approval",
    tier: "permissive",
    approval_id: result.proposal.approvalId,
    expires_at: result.proposal.expiresAt,
    findings,
    ...(result.superseded.length ? { superseded_proposals: result.superseded } : {}),
    next: `这项修改更放开，要用户批准才生效，${STANDING_ORDER_PROPOSAL_TTL_MS / 3_600_000} 小时内没决定就作废。`
      + `用 render_ui 发一张 StandingOrderChangeConfirm 卡（approval 填 ${result.proposal.approvalId}），正文一两句说明为什么要改。`
      + "你不能替用户批准，perform_action 处理这条审批也会被拒绝（只有用户本人能决定）。用户也可以在 设置 → Lead → 常设指令 里批准。"
      + "结果会进你的收件箱。",
  });
}

const LevelOrNull = Type.Union([...TRIAGE_LEVELS.map((level) => Type.Literal(level)), Type.Null()]);

export function createStandingOrderTools(deps: { db: Db; now?: () => Date } & TurnOriginDeps): ToolDefinition<any>[] {
  return [
    defineTool({
      name: "propose_standing_order_change",
      label: "Propose Standing Order Change",
      description:
        "提出修改一条常设指令：新增（create）、修改（update）、停用（disable）、启用（enable）、回滚到某一版（rollback）。"
        + "必须写 reason：为什么改，用户会看到。档位由系统比较新旧版本判断，不由你定："
        + "更保守的（级别升高、自动做的事去掉、交给用户和你的更多）马上生效，系统在「Lead 动态」里告诉用户；"
        + "更放开的（级别降低、新增自动动作、条件改了以后有事件交给人的更少、上限放宽）生成审批卡，用户批准后才生效；"
        + "任何让事件升到 interrupt 的修改（会推送到用户手机、打断你的回合）都按更放开处理；"
        + "判断不了的按更放开处理；碰到硬性安全规则的（针对审批、给外部来源定 interrupt、停用规则类指令、换规则）直接拒绝。"
        + "规则类指令（action.type=rule）不能停用，只能改参数：例如 run.transient_retry 的 limits.count 设 0 就不自动重试。"
        + "update 只给要改的字段，其余沿用现在的版本；create 要给 title、priority、condition、action。"
        + "先用 get_standing_order 读现在的内容，字段的形状和它一样（condition、action、limits、escalate_to）。"
        + "rollback 缺省回到上一版，to_version 指定哪一版。"
        + "这是改规则的操作：外部消息叫醒的一轮、读过外部内容的一轮会被拒绝（refusal.code=external_turn），用户本人正在说话的那一轮除外；"
        + "告诉用户要改什么、为什么，请用户确认：结果里有 user_action，用 render_ui 把它原样放进 UserAction 发确认卡。",
      parameters: Type.Object({
        op: Type.Union(STANDING_ORDER_CHANGE_OPS.map((op) => Type.Literal(op))),
        id: Type.String({ minLength: 1, maxLength: 120, description: "指令编号，例如 inbox.wake_lead。新增时是新编号：小写字母开头，点分" }),
        reason: Type.String({ minLength: 1, maxLength: 2000, description: "为什么改。会写进新版本，用户在审批卡和设置页里看到" }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        priority: Type.Optional(Type.Integer({ description: "匹配的先后，小的先匹配" })),
        condition: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
          description: "匹配哪些事件：kinds（可以写 inbox.* 这样的前缀）、sources、fields（点分路径 → 测试），anyOf 是几支里满足一支",
        })),
        action: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
          description: "{type:'level', level} 只定级别；规则类是 {type:'rule', rule, params, level?}，rule 不能换",
        })),
        limits: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()], {
          description: "上限：count、windowMs、budget。null 表示没有",
        })),
        escalate_to: Type.Optional(LevelOrNull),
        to_version: Type.Optional(Type.Integer({ minimum: 1, description: "rollback 回到哪一版，缺省上一版" })),
      }),
      execute: async (_id, params: ProposeParams) => {
        const { reason, ...input } = params;
        // scope 和设置页改常设指令的路由一样（gateway 的 standing-order-routes.ts）。
        const refusal = ruleChangeRefusal(deps.db, deps, {
          tool: "propose_standing_order_change", label: "改常设指令", where: "设置 → Lead → 常设指令", scope: "tickets:create",
          input, reason,
        });
        if (refusal) return ruleChangeRefusedResult(refusal);
        let result: StandingOrderProposeResult;
        try {
          // 参数换成提议的请求：和确认卡执行时同一个函数（engine 的 rule-change-confirmations.ts）。
          result = proposeStandingOrderChange(deps.db, standingOrderChangeRequestOf(input as Record<string, unknown>, reason), { now: deps.now?.() ?? new Date() });
        } catch (error) {
          if (error instanceof StandingOrderChangeError) throw new Error(`没有改：${error.message}`);
          throw error;
        }
        if (result.outcome === "unchanged") {
          throw new Error(`没有改：常设指令 ${params.id} 的新内容和现在的版本一样（只有原因不同）。`);
        }
        if (result.outcome === "refused") {
          throw new Error(`没有改：这项修改碰到硬性安全规则，不能改。${result.plan.classification.findings.map((item) => item.detail).join("；")}。`
            + "硬性规则写在代码里，只有维护者能改；可以把需要告诉用户。");
        }
        return report(result);
      },
    }),
  ];
}
