import type { Db } from "@pi-lead-child/store";
import type { Run, TypedFailure } from "@pi-lead-child/core";
import { getItem, transition, updateOrchestrationState } from "@pi-lead-child/store";
import { getRun, updateRun } from "@pi-lead-child/store";
import { executorRetryBudget } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { addInbox, itemEntityKey } from "@pi-lead-child/store";
import { createRunUsageLedger } from "@pi-lead-child/store";
import { raiseBlocker } from "@pi-lead-child/store";
import { criticalHandoffToolName, type CriticalToolFailure } from "./terminal-handoff.js";
import { classifyFailure } from "@pi-lead-child/runtime";
import {
  failureNextStep, kernelHandlesFailure, leadDecides, runtimeFailureTitle,
} from "@pi-lead-child/runtime";


// 一张工单累计 token 超过它时，给 Lead 一条预算告警。PLC_BUDGET_TOKENS 可以改它。
// 2026-10-21 用户定为 400 万：token 数含缓存读写（docs/adr/0001-token-usage.md），旧的 200 万让一个普通的执行 Run 就告警。
export const DEFAULT_TOKEN_BUDGET = 4_000_000;

// 预算告警的档位：预算、2 倍、4 倍……返回 total 越过的最高一档；没超过预算时是 0。
// 告警是工单的事，不是 Run 的事（2026-10-29）：以前每个 Run 从头算，同一张工单的每个新 Run 都告警一次，
// #158、#161 一晚上各收到好几条，Lead 每条都要花一轮记 no_action。
export function budgetThresholdPassed(total: number, budget: number): number {
  if (!(budget > 0) || !(total > budget)) return 0;
  let threshold = budget;
  while (threshold * 2 < total) threshold *= 2;
  return threshold;
}

// 这张工单已经告警过的最高档位。告警可能被去抖并进同一张工单的别的行（inbox 行上没有它），所以也读它的事件。
// 旧的告警没有 threshold，按它当时的 budget 算。
function notifiedBudgetThreshold(db: Db, itemId: number): number {
  const fromInbox = db.prepare(
    `SELECT MAX(COALESCE(json_extract(payload, '$.threshold'), json_extract(payload, '$.budget'))) AS t
     FROM inbox WHERE dedup_scope = ? AND json_valid(payload) AND json_extract(payload, '$.kind') = 'token_budget_exceeded'`,
  ).get(`item:${itemId}`) as { t: number | null };
  const fromEvents = db.prepare(
    `SELECT MAX(COALESCE(json_extract(payload, '$.payload.threshold'), json_extract(payload, '$.payload.budget'))) AS t
     FROM events WHERE entity_key = ? AND kind = 'inbox.attention' AND json_valid(payload)
       AND json_extract(payload, '$.inboxKind') = 'token_budget_exceeded'`,
  ).get(itemEntityKey(db, itemId)) as { t: number | null };
  return Math.max(Number(fromInbox.t ?? 0), Number(fromEvents.t ?? 0));
}

export type IngestOutcome = {
  type: "terminal_handoff_required";
  criticalToolFailure: CriticalToolFailure | null;
};

export interface Ingestor {
  onEvent(event: any): IngestOutcome | undefined;
  onExit(code: number | null): void;
  restore(event: any): void;
}

// Event Pipeline 的 M1 规则子集（DESIGN §7.1）。确定性代码，不经 LLM。
export function createIngestor(
  db: Db,
  ctx: { itemId: number; runId: number },
): Ingestor {
  const touch = db.prepare(
    "UPDATE items SET last_activity_at = datetime('now') WHERE id = ?",
  );
  const addUsage = db.prepare(
    "UPDATE items SET total_tokens = total_tokens + ?, total_cost_usd = total_cost_usd + ? WHERE id = ?",
  );
  let hadError = false;      // 本 run 出现过 stopReason=error
  // 最近一条 LLM 错误消息。llm_error blocker 在 Run 以完成结束时才升起（见 raiseLlmError）。
  let llmError: { stopReason: string; detail: string } | null = null;
  // 这张工单已经告警过的最高档位，只是缓存：库里的只会更高（同一张工单别的 Run 也会告警），所以要告警前再读一次库。
  let budgetNotifiedUpTo = 0;
  // 这个 Run 的用量账，规则和 runTokenUsage 相同（工单 #102）。items 上只加这本账总量的变化，变化可以是负的。
  const usage = createRunUsageLedger();
  let criticalToolFailure: CriticalToolFailure | null = null;

  const recordUsage = (event: { type: "usage.updated"; mode: unknown; totalTokens: unknown; costUsd: unknown }) => {
    const before = usage.total();
    usage.apply(event);
    const after = usage.total();
    addUsage.run(after.tokens - before.tokens, after.costUsd - before.costUsd, ctx.itemId);
    if (typeof event.costUsd === "number") updateRun(db, ctx.runId, { costKnown: true });
    const budget = Number(process.env.PLC_BUDGET_TOKENS ?? DEFAULT_TOKEN_BUDGET);
    const threshold = budgetThresholdPassed(getItem(db, ctx.itemId)!.total_tokens, budget);
    if (threshold <= budgetNotifiedUpTo) return;
    const notified = notifiedBudgetThreshold(db, ctx.itemId);
    budgetNotifiedUpTo = Math.max(threshold, notified);
    if (notified >= threshold) return;
    // 马上叫醒 Lead：要不要停下、要不要告诉用户，由它判断。
    addInbox(db, {
      itemId: ctx.itemId, severity: "attention", source: "structural",
      summary: threshold === budget
        ? `工单 #${ctx.itemId} 预算告警：累计 tokens 已超 ${budget}`
        : `工单 #${ctx.itemId} 预算告警：累计 tokens 已超 ${threshold}（预算 ${budget} 的 ${threshold / budget} 倍）`,
      payload: { kind: "token_budget_exceeded", runId: ctx.runId, budget, threshold, wakeLead: true, needsUser: false },
    });
  };

  // 这次工单对话是谁发起的：routeTicketMessageToAgentRun 在建 Run 的同一笔事务里记下发消息的人。
  const conversationRequestedBy = (runId: number): string | null => {
    const row = db.prepare(
      "SELECT actor FROM activities WHERE run_id=? AND kind='comment' ORDER BY id LIMIT 1",
    ).get(runId) as { actor: string } | undefined;
    return row?.actor ?? null;
  };

  // LLM 错误结局的 blocker（工单 13）。它说的是"Run 完成了，但以 LLM 错误结束"，所以只在 settle 时升起。
  // adapter 也可能在错误消息之后给出类型化的 run.failed。这时 crash 按 scope 处理，这里不升起。
  // 否则账号故障也会请 lead 检查，用户还会多收到一条通知。
  // 修复回合不升起新的 blocker（spec D4）。
  // 工单对话以 LLM 错误结束也不是 blocker（和下面 crash 的对话分支同一个理由）：回执上的那一轮已经失败了。
  // 代查（lookup）以 LLM 错误结束也不升 blocker、不叫醒 Lead：结果只交给通道 hub（slack-takeover spec D5）。
  const raiseLlmError = (run: Run): void => {
    if (!llmError || run.purpose === "outcome_repair" || run.purpose === "lookup") return;
    if (run.purpose === "conversation") {
      addInbox(db, {
        itemId: ctx.itemId,
        severity: "attention",
        source: "structural",
        summary: `工单 #${ctx.itemId} 的对话 Run #${ctx.runId} 以 LLM 错误结束：${(llmError.detail || "").slice(0, 400)}`,
        payload: {
          kind: "conversation_run_failed", runId: ctx.runId, stopReason: llmError.stopReason,
          requestedBy: conversationRequestedBy(ctx.runId), wakeLead: true, needsUser: false,
        },
      });
      return;
    }
    raiseBlocker(db, {
      // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
      needsUser: false,
      itemId: ctx.itemId,
      runId: ctx.runId,
      code: "llm_error",
      title: "LLM error 结局",
      summary: llmError.detail || "Child 的 LLM 运行以 error 结局结束。",
      nextStep: "Lead 应检查错误详情和本次 Run 的日志，判断是否需要调整执行路径或重试。",
      source: "structural",
      dedupKey: `llm-error:${ctx.runId}`,
      evidence: { stopReason: llmError.stopReason, detail: llmError.detail },
    });
  };

  const settle = (): IngestOutcome | undefined => {
    updateRun(db, ctx.runId, { state: "finished", endedAt: true });
    const run = getRun(db, ctx.runId)!;
    raiseLlmError(run);
    // 代查不改工单的生命周期：工单的终态由代查的启动器按结果写（daemon 的 lookup.ts）。
    if (run.purpose === "conversation" || run.purpose === "outcome_repair" || run.purpose === "lookup") return undefined;
    const item = getItem(db, ctx.itemId)!;
    if (item.stage === "active") {
      if (hadError) {
        transition(db, {
          itemId: ctx.itemId, to: "blocked", actor: "system",
          reason: "LLM error 结局", runId: ctx.runId,
        });
      } else if (!["waiting", "integrating"].includes(item.plan_state ?? "none")) {
        return { type: "terminal_handoff_required", criticalToolFailure };
      }
    }
    return undefined;
  };

  const crash = (
    code: number | null,
    reason: string,
    errorCode = "process_exit",
    typed: TypedFailure | null = null,
  ) => {
    const run = getRun(db, ctx.runId)!;
    // paused 也必须免疫：用户暂停时我们主动杀掉进程（gateway/user-actions.ts），
    // 随之而来的退出事件不是崩溃。少了这一项，按一次暂停就会在账本上留下一次 crash、
    // 一条 blocker，还会把工单从 active 推到 blocked——用户看到的是"我暂停了它，它崩了"。
    // 显式标注元素类型：无类型的字符串数组在 v16 改值时不会报错，只会静默失效。
    const quiet: readonly Run["state"][] = ["finished", "stopped", "failed", "paused"];
    if (quiet.includes(run.state)) return;
    // 失败状态和它的类型化失败在同一次写入里落库：重试预算紧接着就要按 scope 计数。
    // adapter 没给类型时（旧事件、onExit），按同一张映射表兜底分类。
    const failure = typed ?? classifyFailure(run.runtime, { errorCode, message: reason });
    updateRun(db, ctx.runId, {
      state: "failed", endedAt: true, exitCode: code, errorCode, errorMessage: reason, failure,
    });
    // 错误码排在 reason 前面（工单 03）：读的人常按长度截断 payload，reason 可能很长，截掉的不能是错误码。
    addActivity(db, {
      itemId: ctx.itemId, runId: ctx.runId, actor: "system", kind: "crash",
      payload: { errorCode, failureScope: failure.scope, failureCode: failure.code, exitCode: code, reason },
    });
    // 代查失败不是工单受阻（slack-takeover spec D5）：不升 blocker、不进 blocked、不叫醒 Lead。
    // 失败交回通道 hub，工单由代查的启动器收进 cancelled。
    if (run.purpose === "lookup") return;
    // 账号和配置故障属于 profile，不属于这张工单（spec D2）。它们记在健康账本上，
    // 用户按故障收到一条通知，所以这里不再升起单个 Run 的 blocker。
    // 工单也不进 blocked：内核已经排了挂起的重试，工单在等 runtime 恢复，而不是在等人做决定。
    // 瞬时失败由内核退避后自动重试（spec D5，工单 06），同样不升起 blocker，工单不进 blocked。
    // 自动重试到上限时，child manager 经 transient-retry 升起整条重试链上唯一的 blocker。
    if (kernelHandlesFailure(failure, run.purpose)) return;
    // 修复回合失败时，child manager 记下修复失败。原来的 blocker 保留，工单的 stage 不变。
    if (run.purpose === "outcome_repair") return;
    // 工单对话失败只是这一句话没答上，工单没有受阻：不是 blocker，不发"阻塞"通知。
    // 以前这里升起 blocker，#66 的一次对话失败在会话里出现了四次，说法还互相矛盾
    // （"影响：无法继续"旁边写着"不改变工单执行状态"）。用户在会话里看到的仍然只有那条带着失败原因和「重发」的回执。
    // 2026-10-15 起，不论消息是谁发的，都马上叫醒 Lead（attention，不向用户播报）：用户还在等答案时，
    // Lead 可以换个模型重发（recover_ticket_run）。
    if (run.purpose === "conversation") {
      addInbox(db, {
        itemId: ctx.itemId,
        severity: "attention",
        source: "structural",
        summary: `工单 #${ctx.itemId} 的对话 Run #${ctx.runId} 没有答完（exitCode=${code ?? "-"}）：${reason.slice(0, 400)}`,
        payload: {
          kind: "conversation_run_failed", runId: ctx.runId, exitCode: code, errorCode, reason,
          requestedBy: conversationRequestedBy(ctx.runId), wakeLead: true, needsUser: false,
        },
      });
      return;
    }
    // 耗尽的宣告**并进这一条 blocker**，而不是另发一条。inbox 对同一 scope 有熔断：
    // 一小时内第三条 blocker 会被折叠成"异常频繁"的聚合行。而按缺省 retry_limit=1，
    // 耗尽恰好发生在第二次崩溃时——另发一条就正好是第三条，于是最该被读到的那句话
    // 每次都被折叠掉。并进来还更贴事实：让这条线停下的就是这一次崩溃。
    const halt = haltIfExhausted();
    // blocker 保留（spec D1）。只有 task 和 unknown 请 lead 判断要不要重试；
    // 其他作用域的 blocker 只说明系统会怎么处理，或者需要谁做什么。
    const asksLead = leadDecides(failure);
    raiseBlocker(db, {
      // 重试额度用完要用户决定；其余先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
      needsUser: Boolean(halt),
      itemId: ctx.itemId,
      runId: ctx.runId,
      code: errorCode,
      title: asksLead ? `Child Run 崩溃（exitCode=${code ?? "-"}）` : runtimeFailureTitle(run.runtime, failure),
      summary: `工单 #${ctx.itemId} child crash（exitCode=${code ?? "-"}）：${reason.slice(0, 1_400)}`
        + (halt ? `｜${halt}` : ""),
      nextStep: halt
        ? "不要继续自动重试；Lead 应把失败原因和重试预算状态告知用户，等待用户决定。"
        : asksLead
          ? "Lead 应检查本次 Run 的失败证据，判断是否可以安全重试。"
          : failureNextStep(run.runtime, failure),
      source: "structural",
      dedupKey: `run-crash:${ctx.runId}`,
      evidence: {
        exitCode: code, errorCode, reason,
        failure: { scope: failure.scope, retry: failure.retry, needs: failure.needs, code: failure.code },
      },
    });
    const stage = getItem(db, ctx.itemId)!.stage;
    if (stage === "active") {
      transition(db, {
        itemId: ctx.itemId, to: "blocked", actor: "system",
        reason, runId: ctx.runId,
      });
    }
  };

  // 闸门（run-gate）已经让耗尽之后的派发不可能，但"不可能"是沉默的：lead 只有真去
  // spawn_child 撞上去才知道。这里把耗尽写进账本，让它在被撞上之前就看得见：
  //   · plan_state='failed' —— 工单自己带上"这条编排线已经停了"，get_ticket 会显示；
  //   · 崩溃那条 blocker 的后半句 —— read_inbox 里明说停了、决定权在用户手上。
  // 只宣告一次：以 plan_state 是否已是 failed 为准，所以每次崩溃都重算也不会复读。
  // 调用时机是 updateRun(state='failed') 之后——本次失败必须已经计入预算。
  const haltIfExhausted = (): string | null => {
    if (getItem(db, ctx.itemId)!.plan_state === "failed") return null;
    const budget = executorRetryBudget(db, ctx.itemId);
    if (!budget.exhausted) return null;
    updateOrchestrationState(db, ctx.itemId, "failed");
    return `执行重试已耗尽（执行失败 ${budget.failures}/${budget.retryLimit}），已停止派发。`
      + `不要再重试或另建工单——请把失败原因摆给用户，由用户决定改方案、放宽 retry_limit 还是取消。`;
  };

  return {
    onEvent(event: any): IngestOutcome | undefined {
      touch.run(ctx.itemId);
      switch (event.type) {
        case "run.started":
        case "agent_start": {
          // 新的 runtime 进程从 0 重新累计用量。
          if (event.type === "run.started") usage.apply(event);
          // 只把 starting 推进到 running。用户已经暂停或停止的 Run，不能被一个晚到的启动事件改回 running：
          // 过期会话在同一个 Run 里开新会话时，新进程的启动事件正好晚于用户的暂停（过期会话的发布评审 L1）。
          const current = (db.prepare("SELECT state FROM runs WHERE id=?").get(ctx.runId) as { state: string } | undefined)?.state;
          if (current === "starting" || current === "running") updateRun(db, ctx.runId, { state: "running" });
          // 这里曾有 assigned → in_progress。两者已并入同一个 active（spec §6.1），
          // 而 active 是在派发/spawn 时就写下的，agent_start 已无 stage 可推进——
          // Run 真正起来这件事现在只由 runs.state 记录。
          break;
        }
        case "usage.updated": {
          recordUsage(event);
          break;
        }
        case "message.completed": {
          if (event.stopReason === "error") {
            hadError = true;
            llmError = { stopReason: event.stopReason, detail: String(event.error ?? event.text ?? "").slice(0, 1_600) };
          }
          break;
        }
        case "message_end": {
          const m = event.message;
          if (m?.role === "assistant" && m.usage) {
            recordUsage({
              type: "usage.updated", mode: "delta", totalTokens: m.usage.totalTokens, costUsd: m.usage.cost?.total ?? 0,
            });
          }
          if (m?.role === "assistant" && m.stopReason === "error") {
            hadError = true;
            llmError = { stopReason: m.stopReason, detail: String(m.errorMessage ?? "").slice(0, 1_600) };
          }
          break;
        }
        case "tool.failed": {
          const name = criticalHandoffToolName(event.name);
          if (name) {
            criticalToolFailure = {
              name,
              error: String(event.error ?? "critical tool call failed").slice(0, 2_000),
            };
          }
          break;
        }
        case "run.completed":
        case "agent_end": {
          return settle();
        }
        case "run.failed": {
          crash(
            event.exitCode ?? null,
            String(event.error ?? "runtime failed"),
            String(event.errorCode ?? "runtime_failed"),
            event.failure ?? null,
          );
          break;
        }
      }
      return undefined;
    },

    onExit(code: number | null): void {
      crash(code, `child process exited with code ${code}`);
    },

    // daemon 重启后接管 Run 时（工单 15），adapter 重放上一个 daemon 已经处理过的事件。
    // 这些事件不再写库，只重建这里积累的状态：用量账、LLM error 结局、关键工具的失败。
    // 预算告警不用重建：告警过哪一档记在库里（notifiedBudgetThreshold）。
    restore(event: any): void {
      switch (event.type) {
        case "run.started":
        case "usage.updated":
          usage.apply(event);
          break;
        case "message.completed":
          if (event.stopReason === "error") hadError = true;
          break;
        case "tool.failed": {
          const name = criticalHandoffToolName(event.name);
          if (name) {
            criticalToolFailure = {
              name,
              error: String(event.error ?? "critical tool call failed").slice(0, 2_000),
            };
          }
          break;
        }
      }
    },
  };
}
