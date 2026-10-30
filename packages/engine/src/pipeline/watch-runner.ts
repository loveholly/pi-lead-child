// 后台检查的执行（.scratch/lead-watch/spec.md）。daemon 每次轮询（3 秒）调一次 tick：挑出到点、没在跑的检查，
// 命令检查在 Lead 的 bash 沙箱里跑，子代理检查开一个轻子 agent。检查过程中不叫醒 Lead；store 的 decideAfterCheck
// 说要叫醒时，写一条叫醒 Lead 的 inbox（和跟进、Run 结束一样走事件日志）。
//
// 子代理检查交回由 Run 结束的说明叫醒 Lead（daemon 的 run-finished.ts），这里只记下这一次检查结束了（settleAgentCheck）。
// 命令跑不起来（沙箱起不来、工作目录没了）算出错；退出码非 0、超时算没通过。
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { localIso } from "@pi-lead-child/core";
import {
  abandonWatchCheck, addInbox, agentWatchTokensSince, attachWatchCheckItem, dueWatches, finishWatchCheck, getItem, publishGatewayEvent,
  runningWatchChecks, startWatchCheck, watchAgentDailyTokens, watchCheckOfItem, watchOrigin, WATCH_LIMITS,
  type Db, type FinishedWatchCheck, type Watch, type WatchStatus, type WatchWake,
} from "@pi-lead-child/store";

export interface WatchCommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

/** 子代理检查要开的轻子 agent：标题和任务说明（系统按检查写好）。 */
export interface WatchAgentTask {
  title: string;
  brief: string;
}

export interface WatchRunnerOptions {
  now?: () => Date;
  // 跑一条命令。跑不起来时抛错（算出错）；超时返回 timedOut。
  runCommand: (command: string, timeoutSeconds: number) => Promise<WatchCommandResult>;
  // 开一个轻子 agent，返回它的工单编号。daemon 里是建轻工单再 spawnItemChild。没接时子代理检查算没开起来。
  startAgentCheck?: (watch: Watch, task: WatchAgentTask) => Promise<number> | number;
  env?: Record<string, string | undefined>;
  onError?: (step: string, error: unknown) => void;
}

export interface WatchRunner {
  // 开始到点的检查。返回的 Promise 在这一次开始的检查都结束时完成（daemon 不等它，测试等它）。
  tick(): Promise<void>;
  // 子代理检查的轻工单的 Run 结束了：记下这一次检查结束。delivered：工单交回了结果（系统已结单）。
  settleAgentCheck(itemId: number, result: { delivered: boolean; detail?: string }): FinishedWatchCheck | null;
  // daemon 启动时：重启打断的命令检查马上重查；子代理检查的工单已经结束的，记下结束（spec D8）。
  recover(): void;
}

const SCHEDULE_CHANGED = { type: "ticket.updated", requiredScope: "tickets:view", payload: { snapshotRequired: true } } as const;

const WAKE_WORDS: Record<WatchWake, string> = {
  passed: "通过了，检查结束",
  failed: "没通过",
  recovered: "恢复了，又通过了",
  expired: "到期了，一直没通过，检查结束",
  errors: `连续出错 ${WATCH_LIMITS.maxConsecutiveErrors} 次，检查停了`,
  agent_failed: "这一次子代理检查没开起来",
};

const clip = (text: string, max: number) => {
  const chars = [...text];
  return chars.length > max ? `…${chars.slice(-max).join("")}` : text;
};

function when(iso: string | null): string {
  return iso ? localIso(new Date(iso)).slice(5, 16).replace("T", " ") : "—";
}

/** 一句话说这个检查怎样查（给 Lead 的说明、子 agent 的任务说明、提醒列表都用它）。 */
export function describeWatchSchedule(watch: Pick<Watch, "mode" | "every_seconds" | "cron_expr" | "until_at">): string {
  const every = watch.every_seconds ?? 0;
  const interval = every % 3600 === 0 && every >= 3600 ? `${every / 3600} 小时` : every % 60 === 0 && every >= 60 ? `${every / 60} 分钟` : `${every} 秒`;
  if (watch.mode === "until") return `每 ${interval}查一次，最晚到 ${when(watch.until_at)}`;
  return watch.cron_expr ? `按「${watch.cron_expr}」一直查` : `每 ${interval}查一次，一直查`;
}

/** 子代理检查交给轻子 agent 的任务说明。 */
export function agentCheckTask(watch: Watch): WatchAgentTask {
  const what = watch.brief ?? "";
  const title = `后台检查 #${watch.id}：${watch.label}`.slice(0, 200);
  if (watch.mode === "until") {
    return {
      title,
      brief: [
        `这是 Lead 设的后台检查 #${watch.id}「${watch.label}」。你的任务：反复检查下面这件事，直到有结果或者到期。`,
        `要检查的：${what}`,
        `- 每隔 ${watch.every_seconds} 秒检查一次。在沙箱里用 bash 写循环（sleep），不要每查一次就写一段说明。`,
        `- 最晚查到 ${watch.until_at ? localIso(new Date(watch.until_at)) : "期限"}。到期还没有结果就停，交回「到期，没有结果」和最后看到的状态。`,
        "- 有结果时马上停，交回结论和依据。",
        "- 这是检查：只看结果。要做的事写进结论，交给 Lead 去做。",
      ].join("\n"),
    };
  }
  return {
    title,
    brief: [
      `这是 Lead 设的后台检查 #${watch.id}「${watch.label}」的一次检查（${describeWatchSchedule(watch)}）。`,
      `要检查的：${what}`,
      "检查一次，交回结论和依据。一切正常时简短地说「正常」和依据；有问题时写清是什么问题。",
      "这是检查：只看结果。要做的事写进结论，交给 Lead 去做。",
    ].join("\n"),
  };
}

/** 叫醒 Lead：写一条 inbox（tell 级，事件日志马上叫醒它）。外部来源的检查按外部的一轮算。 */
export function wakeLeadForWatch(db: Db, finished: FinishedWatchCheck, wake: WatchWake): void {
  const { watch, check } = finished;
  const how = watch.check_kind === "command" ? `命令 \`${clip(watch.command ?? "", 300)}\`` : "子代理检查";
  const result = check.status === "pass" ? "退出码 0"
    : check.exit_code !== null ? `退出码 ${check.exit_code}`
    : check.status === "fail" ? `超过 ${WATCH_LIMITS.commandTimeoutSeconds} 秒没跑完` : "没跑起来";
  const lines = [
    `后台检查 #${watch.id}「${watch.label}」${WAKE_WORDS[wake]}。`,
    `检查：${how}，${describeWatchSchedule(watch)}。最后一次（${when(check.finished_at)}）：${result}。`,
    check.output?.trim() ? `输出的最后一段：${clip(check.output.trim(), 800)}` : "没有输出。",
    watch.note ? `你设它时写的：${watch.note}` : "",
    watch.state === "waiting"
      ? `检查还在继续，下一次 ${when(watch.next_check_at)}。不要了就取消：perform_action(target_type='timer', target_id='watch:${watch.id}', action='cancel')。`
      : "这个检查已经结束。",
  ].filter(Boolean);
  const external = watchOrigin(watch).kind === "external";
  addInbox(db, {
    ...(watch.item_id !== null ? { itemId: watch.item_id } : {}),
    dedupScope: `watch:${watch.id}:${check.id}`,
    severity: "attention",
    source: "structural",
    summary: lines.join("\n"),
    payload: {
      kind: "watch_result", watch: watch.id, check: check.id, reason: wake, state: watch.state,
      wakeLead: true, needsUser: false, ...(external ? { external: true } : {}),
    },
    lossless: true,
  });
}

function settle(db: Db, finished: FinishedWatchCheck | null): FinishedWatchCheck | null {
  if (!finished) return null;
  if (finished.decision.wake) wakeLeadForWatch(db, finished, finished.decision.wake);
  // 结束了或者叫醒了 Lead：提醒列表重取（每次都发会让客户端每 10 秒重取一次）。
  if (finished.decision.wake || finished.watch.state !== "waiting") publishGatewayEvent(db, SCHEDULE_CHANGED);
  return finished;
}

/**
 * 子代理检查的轻工单的 Run 结束了（daemon 的 run-finished.ts）：记下这一次检查结束。delivered：子 agent 交回了结果、系统已结单。
 * 不是子代理检查开的工单、或者这一次已经记过时返回 null。叫醒 Lead 的是 Run 结束的说明，这里不再叫醒。
 */
export function settleWatchAgentCheck(
  db: Db, itemId: number, result: { delivered: boolean; detail?: string }, now: Date = new Date(),
): FinishedWatchCheck | null {
  const found = watchCheckOfItem(db, itemId);
  if (!found || found.check.status !== "running") return null;
  return settle(db, finishWatchCheck(db, {
    checkId: found.check.id, status: result.delivered ? "pass" : "error",
    output: result.detail ?? (result.delivered ? `子 agent 交回了结果（工单 #${itemId}）` : `子 agent 没有交回结果（工单 #${itemId}）`),
    now,
  }));
}

export function createWatchRunner(db: Db, opts: WatchRunnerOptions): WatchRunner {
  const now = opts.now ?? (() => new Date());
  const report = (step: string, error: unknown) => opts.onError?.(step, error);

  async function runCommandCheck(watch: Watch, checkId: number): Promise<void> {
    let status: WatchStatus;
    let exitCode: number | null = null;
    let output: string;
    try {
      const result = await opts.runCommand(watch.command ?? "", WATCH_LIMITS.commandTimeoutSeconds);
      exitCode = result.timedOut ? null : result.exitCode;
      status = !result.timedOut && result.exitCode === 0 ? "pass" : "fail";
      output = result.timedOut ? `${result.output}\n（超过 ${WATCH_LIMITS.commandTimeoutSeconds} 秒，命令被停了）` : result.output;
    } catch (error) {
      status = "error";
      output = error instanceof Error ? error.message : String(error);
    }
    settle(db, finishWatchCheck(db, { checkId, status, exitCode, output, now: now() }));
  }

  async function startAgent(watch: Watch, checkId: number): Promise<void> {
    const at = now();
    const fail = (output: string) => settle(db, finishWatchCheck(db, { checkId, status: "error", output, agentFailed: true, now: now() }));
    const cap = watchAgentDailyTokens(opts.env);
    const used = agentWatchTokensSince(db, new Date(at.getTime() - 24 * 60 * 60 * 1000));
    if (used >= cap) {
      fail(`最近 24 小时子代理检查一共用了 ${used} token，到了上限 ${cap}（PLC_WATCH_AGENT_DAILY_TOKENS），这一次没有开子 agent。`);
      return;
    }
    if (!opts.startAgentCheck) {
      fail("这里不能开子 agent（没有接派发）。");
      return;
    }
    try {
      const itemId = await opts.startAgentCheck(watch, agentCheckTask(watch));
      attachWatchCheckItem(db, checkId, itemId);
    } catch (error) {
      fail(`开子 agent 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const settleAgentCheck = (itemId: number, result: { delivered: boolean; detail?: string }) =>
    settleWatchAgentCheck(db, itemId, result, now());

  return {
    async tick(): Promise<void> {
      const started: Array<Promise<void>> = [];
      for (const watch of dueWatches(db, now())) {
        try {
          const checkId = startWatchCheck(db, watch.id, now());
          if (checkId === null) continue;
          const run = watch.check_kind === "command" ? runCommandCheck(watch, checkId) : startAgent(watch, checkId);
          started.push(run.catch((error) => report(`watch #${watch.id}`, error)));
        } catch (error) {
          report(`watch #${watch.id}`, error);
        }
      }
      await Promise.all(started);
    },

    settleAgentCheck,

    recover(): void {
      for (const { watch, check } of runningWatchChecks(db)) {
        try {
          if (watch.check_kind === "command" || check.item_id === null) {
            abandonWatchCheck(db, check.id, { reason: "daemon 重启，这一次检查中断了，马上重查", now: now() });
            continue;
          }
          const item = getItem(db, check.item_id);
          if (!item) abandonWatchCheck(db, check.id, { reason: `子 agent 的工单 #${check.item_id} 不见了`, now: now() });
          else if (item.stage === "done" || item.stage === "cancelled") {
            settleAgentCheck(item.id, { delivered: item.stage === "done" });
          }
        } catch (error) {
          report(`watch #${watch.id} recover`, error);
        }
      }
    },
  };
}

/** 命令检查用的执行函数：Lead 的 bash 沙箱，工作目录是 Lead 的临时目录。输出只留最后一段。 */
export function sandboxWatchCommand(
  operations: Pick<BashOperations, "exec">, cwd: string,
): (command: string, timeoutSeconds: number) => Promise<WatchCommandResult> {
  return async (command, timeoutSeconds) => {
    const chunks: string[] = [];
    let size = 0;
    const onData = (data: Buffer) => {
      chunks.push(data.toString("utf8"));
      size += data.length;
      // 只要最后一段：太长时丢掉前面的。
      while (size > WATCH_LIMITS.outputChars * 8 && chunks.length > 1) size -= Buffer.byteLength(chunks.shift()!);
    };
    try {
      const result = await operations.exec(command, cwd, { onData, timeout: timeoutSeconds });
      return { exitCode: result.exitCode, output: chunks.join(""), timedOut: false };
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("timeout:")) return { exitCode: null, output: chunks.join(""), timedOut: true };
      throw error;
    }
  };
}
