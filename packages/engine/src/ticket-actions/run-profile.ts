// 换模型和推理强度、换执行 agent（spec 5.3、D4，工单 08）。两个工单操作定义在这一块里，catalog.ts 把它们并进清单：
//   - set_run_profile：换执行者或核查员的模型和推理强度，不丢会话。
//   - change_executor_runtime：换执行 agent。会开新会话，带上工单的上下文。
// 两个都是 lead_allowed：Lead 建单和派发时本来就选 runtime、模型和强度（create_task、spawn_child、recover_ticket_run），
// 这里让它在 Run 开始以后也能换。Lead 必须写原因（index.ts）。只能选模型目录里的，强度只能选这个模型认的档位。
//
// 换模型和强度，看这个角色现在的 Run：
//   - 在跑，adapter 能不停进程换（RuntimeHandle.setProfile，例如 pi 的 RPC）：同一个 Run 接着跑，从下一次调用模型开始生效。
//     Run 上改记新的模型和强度；活动里记下换的时候的用量和事件序号，界面按它把这个 Run 的用量分段。
//   - 在跑，adapter 不能（Claude Code、Codex 用 -p 启动，运行中没有输入通道，D4）：停在当前这一步，排一个续接同一会话的
//     派发请求，带新的模型和强度。新 Run 的 resumed_from_run_id 指向旧 Run。运行记录里是两行，用量自然按模型分开。
//   - 暂停着：改这个 Run 的模型和强度。继续时用同一个 Run、同一个会话和新的参数。
//   - 没有：新设置给下一次 Run。
// 不管哪一种，都写进这个角色的设置：执行者写工单的 requested_runtime、requested_model 和一条 execution_profile_selected
// （带 afterRunId，run-choice.ts 据此不让更早的 Run 盖过它）；核查员写核查员设置（store 的 reviewer-settings.ts，工单 09）。
// 这个角色已经排着的派发请求一起改。每次换都记一条活动：谁换的、从什么换成什么、为什么、怎么生效。
import type { Item, Run, RunPurpose, RuntimeId } from "@pi-lead-child/core";
import {
  cliEffortValue, findRuntimeAdapter, isRuntimeDisabled, resolveRuntimeModel, runtimeDisabledReason, runtimeDisplayName,
} from "@pi-lead-child/runtime";
import {
  addActivity, getReviewerSetting, getRun, runTokenUsage, setReviewerSetting, setRunModelAndEffort, type Db,
} from "@pi-lead-child/store";
import { liveChildren } from "../children/manager.js";
import { createDispatcher } from "../coordinator/dispatch.js";
import { itemReviewer, reviewerUnavailableReason, type ReviewerChoiceOptions } from "../coordinator/reviewer-choice.js";
import { runEffortFor, runModelFor } from "../coordinator/run-choice.js";
import { currentModelCatalog, ModelChoiceError, validateModelChoice } from "../model-catalog.js";
import { behalfCursor, behalfFields, type ActionAttribution } from "./attribution.js";
import { killItemRunProcess, markItemRunStopped } from "./lifecycle.js";
import {
  AVAILABLE, TicketActionError, unavailable,
  type Availability, type TicketActionDefinition, type TicketActionEnv, type TicketActionRun,
} from "./types.js";

type Role = "executor" | "reviewer";

export interface RunProfile {
  // null：不指定，由 CLI 自己的配置决定。
  model: string | null;
  effort: string | null;
}

// 新设置怎么生效：
//   in_run     同一个 Run 不停进程换了（pi 的 RPC）。
//   restarted  停在当前这一步，用同一个会话和新参数排了续接的 Run（换执行 agent 时是新会话）。
//   on_resume  Run 暂停着，继续时用新的。
//   next_run   下一次 Run 用。
export type RunProfileApplied = "in_run" | "restarted" | "on_resume" | "next_run";

export interface RunProfileResult {
  role: Role;
  runtime: RuntimeId;
  from: RunProfile;
  to: RunProfile;
  changed: boolean;
  applied: RunProfileApplied;
  // 换的是哪个 Run（在跑的、暂停的、停下续接的那个）。没有时为 null。
  runId: number | null;
  // 续接的派发请求。没有排时为 null。
  dispatchRequestId: number | null;
  // 一起改了的、已经排着的派发请求。
  retargetedDispatchRequestIds: number[];
  // 给人看的说明，例如「模型目录未知，这次选择没有核对」「新模型不认原来的强度，强度改回 CLI 的默认」。
  notes: string[];
}

export interface ExecutorRuntimeResult {
  from: RunProfile & { runtime: RuntimeId | null };
  to: RunProfile & { runtime: RuntimeId };
  applied: Extract<RunProfileApplied, "restarted" | "next_run">;
  runId: number | null;
  dispatchRequestId: number | null;
  retargetedDispatchRequestIds: number[];
  notes: string[];
}

// 能停下来续接的 Run：派发请求能重新排的用途（和 manager.ts 里内核排重试的一样）。工单对话、修复回合、学习、代查不行：
// 它们不经派发队列开始，停下以后没有办法按原样续上。
const RESTARTABLE_PURPOSES: ReadonlySet<RunPurpose> = new Set(["execution", "integration", "review"]);

const CONTINUE_AFTER_PROFILE = "换了模型和推理强度以后接着刚才的工作继续。你上一步停在中途：先看一下停在哪里，不要从头再做。";

function roleRun(db: Db, itemId: number, role: Role, states: readonly Run["state"][]): Run | undefined {
  return db.prepare(
    `SELECT * FROM runs WHERE item_id=? AND role=? AND state IN (${states.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`,
  ).get(itemId, role, ...states) as Run | undefined;
}

function latestRunId(db: Db, itemId: number): number {
  return (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM runs WHERE item_id=?").get(itemId) as { id: number }).id;
}

function executorPurpose(item: Item): RunPurpose {
  return !item.purpose || item.purpose === "review" ? "execution" : item.purpose;
}

function choiceOptions(env: TicketActionEnv): ReviewerChoiceOptions {
  return env.host.runtimeProfile ? { profile: env.host.runtimeProfile } : {};
}

// 这个角色下一次 Run 会用的 runtime、模型和强度（没有 Run 在跑、也没有暂停的时候）。执行者还没定 runtime 时为 null。
function nextRunTarget(db: Db, item: Item, role: Role, options: ReviewerChoiceOptions): { runtime: RuntimeId; profile: RunProfile } | null {
  if (role === "reviewer") {
    const setting = getReviewerSetting(db, item.id);
    if (setting) return { runtime: setting.runtime, profile: { model: setting.model, effort: setting.effort } };
    const chosen = itemReviewer(db, item.id, options);
    return { runtime: chosen.runtime, profile: { model: chosen.model, effort: chosen.effort } };
  }
  const runtime = item.requested_runtime;
  if (!runtime) return null;
  const model = runModelFor({ role, runtime, item }) ?? null;
  const effort = runEffortFor(db, { itemId: item.id, role, purpose: executorPurpose(item), runtime, model }) ?? null;
  return { runtime, profile: { model, effort } };
}

// 按模型目录核对，再查这个 runtime 和模型现在能不能用（用户停用、健康账本上没关闭的故障）。
// 只换了模型、原来的强度新模型不认时，强度改回 CLI 的默认，不替人挑一个档位；明确给的强度不认时拒绝。
function checkedProfile(
  db: Db, runtime: RuntimeId, wanted: RunProfile, explicitEffort: boolean, options: ReviewerChoiceOptions,
): { profile: RunProfile; notes: string[] } {
  const catalog = currentModelCatalog(db);
  const notes: string[] = [];
  const validate = (profile: RunProfile) => {
    // 目录未知时 validateModelChoice 不核对（model-catalog.ts）。CLI 收不收这个写法由 adapter 说了算：换不成 CLI 的模型名、
    // 强度不是 CLI 认的写法，在停下旧 Run 之前就拒绝。否则旧 Run 停了，新 Run 到认领时才报错，工作就断了（08 审查 4）。
    try {
      resolveRuntimeModel(runtime, profile.model);
      cliEffortValue(profile.effort ?? undefined);
    } catch (error) {
      throw new TicketActionError("invalid_input", error instanceof Error ? error.message : String(error));
    }
    try {
      return validateModelChoice(catalog, { runtime, model: profile.model, effort: profile.effort });
    } catch (error) {
      if (error instanceof ModelChoiceError) throw new TicketActionError("invalid_input", error.message);
      throw error;
    }
  };
  // 模型名按目录归一过（例如 pi 上只写了名字、没写 provider）：设置和排着的请求都写归一后的全名。
  let profile = wanted;
  try {
    const checked = validate(profile);
    if (checked.note) notes.push(checked.note);
    profile = { ...profile, model: checked.model };
  } catch (error) {
    if (explicitEffort || profile.effort === null) throw error;
    profile = { ...profile, effort: null };
    const checked = validate(profile);
    if (checked.note) notes.push(checked.note);
    profile = { ...profile, model: checked.model };
    notes.push(`${profile.model ?? runtimeDisplayName(runtime)} 不认原来的强度 ${wanted.effort}，强度改回 CLI 的默认。`);
  }
  const unusable = reviewerUnavailableReason(db, runtime, { ...options, model: profile.model });
  if (unusable) {
    throw new TicketActionError(
      "unavailable", `${runtimeDisplayName(runtime)}${profile.model ? `（${profile.model}）` : ""}现在不能用：${unusable}`,
    );
  }
  return { profile, notes };
}

// 写进这个角色的设置，下一次 Run 用它。
function rememberProfile(
  db: Db, item: Item, role: Role, runtime: RuntimeId, profile: RunProfile,
  input: { by: ActionAttribution; reason: string; source: "set_run_profile" | "change_executor_runtime" },
): void {
  const afterRunId = latestRunId(db, item.id);
  if (role === "executor") {
    db.prepare("UPDATE items SET requested_runtime=?, requested_model=?, updated_at=datetime('now') WHERE id=?")
      .run(runtime, profile.model, item.id);
  } else {
    setReviewerSetting(db, item.id, {
      runtime, model: profile.model, effort: profile.effort, chosenBy: input.by.actor, reason: input.reason,
    });
  }
  addActivity(db, {
    itemId: item.id, actor: input.by.actor, kind: "decision", ...behalfCursor(input.by),
    payload: {
      decision: "execution_profile_selected", role, runtime, model: profile.model, effort: profile.effort,
      afterRunId, source: input.source, reason: input.reason, ...behalfFields(input.by),
    },
  });
}

// 这个角色已经排着的派发请求改成新设置。换模型时只改同一个 runtime 上的；换执行 agent 时全部改。
// 成果修复回合不改：它续接来源 Run 的会话，补交那个 Run 的成果，只能在原来的 runtime 上跑（08 审查 2）。
function retargetPending(db: Db, itemId: number, role: Role, runtime: RuntimeId, profile: RunProfile, sameRuntimeOnly: boolean): number[] {
  const rows = db.prepare(
    `SELECT id FROM dispatch_requests WHERE item_id=? AND role=? AND state='pending' AND purpose <> 'outcome_repair'
       AND (? = 0 OR runtime=? OR runtime IS NULL)
     ORDER BY id`,
  ).all(itemId, role, sameRuntimeOnly ? 1 : 0, runtime) as Array<{ id: number }>;
  const update = db.prepare(
    `UPDATE dispatch_requests SET runtime=?, model=?, effort=?, suspended_reason=NULL, suspended_incident_id=NULL,
       updated_at=datetime('now')
     WHERE id=? AND state='pending'`,
  );
  return rows.filter((row) => update.run(runtime, profile.model, profile.effort, row.id).changes === 1).map((row) => row.id);
}

function usageAt(db: Db, run: Run): { usageTokens: number | null; atSeq: number } {
  const current = getRun(db, run.id) ?? run;
  return { usageTokens: runTokenUsage(db, run.id), atSeq: Number(current.event_cursor ?? 0) };
}

// 停掉旧 Run 的进程（它已经在事务里落了 stopped，续接的请求也排上了）。停不掉时不算这次操作失败：
// 账本已经写好，进程退出以后续接的 Run 才会被认领（daemon 的 itemBusy 等它收尾）。
async function killStoppedRun(item: Item, run: Run, reason: string, notes: string[]): Promise<void> {
  try {
    await killItemRunProcess(item.id, run.id, reason);
  } catch (error) {
    notes.push(`Run #${run.id} 的进程没有正常停下（${error instanceof Error ? error.message : String(error)}），它退出以后续接的 Run 才开始。`);
  }
}

/** 换执行者或核查员的模型和推理强度（set_run_profile）。 */
export async function setRunProfile(
  db: Db, item: Item, input: { role: Role; model?: string; effort?: string },
  args: { by: ActionAttribution; reason: string; options: ReviewerChoiceOptions },
): Promise<RunProfileResult> {
  if (input.model === undefined && input.effort === undefined) {
    throw new TicketActionError("invalid_input", "至少给 model 或 effort 中的一项。");
  }
  const { role } = input;
  if (role === "executor") {
    const starting = startingRunRefusal(db, item);
    if (starting) throw new TicketActionError("unavailable", starting);
  }
  const running = roleRun(db, item.id, role, ["running"]);
  const paused = running ? undefined : roleRun(db, item.id, role, ["paused"]);
  const current = running ?? paused;
  const target = current
    ? { runtime: current.runtime, profile: { model: current.model, effort: current.effort } }
    : nextRunTarget(db, item, role, args.options);
  // 模型和强度属于某个 runtime。执行者还没定 runtime 时（派发时由系统选），先选执行 agent。
  if (!target) {
    throw new TicketActionError("invalid_input", "这张工单还没有定执行 agent：先选执行 agent（change_executor_runtime），再换模型。");
  }
  const { runtime } = target;
  const from = target.profile;
  const wanted: RunProfile = { model: input.model?.trim() || from.model, effort: input.effort?.trim() || from.effort };
  const { profile: to, notes } = checkedProfile(db, runtime, wanted, input.effort !== undefined, args.options);
  const base = { role, runtime, from, to, retargetedDispatchRequestIds: [] as number[], notes };
  if (to.model === from.model && to.effort === from.effort) {
    return { ...base, changed: false, applied: current ? (running ? "in_run" : "on_resume") : "next_run", runId: current?.id ?? null, dispatchRequestId: null };
  }
  // 核查 Run 的 runtime 可能是认领时替补上来的（选好的核查员当时不能用，dispatch.ts 的 switchReviewer）。这时只换这个 Run，
  // 不把替补写成谁的选择：核查员设置里还是原来选的那个（08 审查 5）。
  const setting = role === "reviewer" ? getReviewerSetting(db, item.id) : null;
  const keepSetting = setting !== null && setting.runtime !== runtime;
  if (keepSetting) {
    notes.push(`核查员设置里选的是 ${runtimeDisplayName(setting.runtime)}，这次只换了现在这个 ${runtimeDisplayName(runtime)} 核查 Run 的模型和强度。`);
  }

  let applied: RunProfileApplied = "next_run";
  const child = running ? liveChildren().get(item.id) : undefined;
  const handle = running && child?.runId === running.id ? child.handle : undefined;
  if (running && handle?.setProfile) {
    applied = "in_run";
  } else if (running) {
    const why = !RESTARTABLE_PURPOSES.has(running.purpose) ? `${running.purpose} 这类 Run 不经派发队列开始，停下以后续不上`
      : running.external_session_id === null ? "它还没有会话"
      : findRuntimeAdapter(runtime)?.capabilities.resume !== true ? `${runtimeDisplayName(runtime)} 不能续接会话`
      : null;
    if (why === null) applied = "restarted";
    else notes.push(`Run #${running.id} 不能中途换（${why}），它跑完以后的下一次 Run 用新的。`);
  } else if (paused) {
    applied = "on_resume";
  }
  const usage = applied === "next_run" ? null : usageAt(db, current!);
  if (applied === "in_run") {
    // 先让 CLI 换，换成了再记账：没换成时什么都不改，原因交给调用方。
    try {
      await handle!.setProfile!({
        ...(to.model && to.model !== from.model ? { model: to.model } : {}),
        ...(to.effort && (to.effort !== from.effort || to.model !== from.model) ? { effort: to.effort } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TicketActionError("unavailable", `${runtimeDisplayName(runtime)} 没有换成：${message}`);
    }
  }

  // 一笔事务：设置、停下旧 Run（只落账）、排续接的请求、记活动。daemon 在中途退出时，要么都没写，要么都写了，
  // 不会留下一个停下的 Run 却没有续接（08 审查 3）。认领要等旧进程收尾（daemon 的 itemBusy），所以先排请求，提交以后再停进程。
  const stopReason = `换模型和推理强度：${args.reason}`;
  const { retargeted, dispatchRequestId } = db.transaction(() => {
    if (applied === "in_run" || applied === "on_resume") setRunModelAndEffort(db, current!.id, to);
    if (!keepSetting) rememberProfile(db, item, role, runtime, to, { by: args.by, reason: args.reason, source: "set_run_profile" });
    const retargeted = retargetPending(db, item.id, role, runtime, to, true);
    let dispatchRequestId: number | null = null;
    if (applied === "restarted") {
      markItemRunStopped(db, running!.id, stopReason, args.by);
      dispatchRequestId = createDispatcher(db, args.options.profile ? { runtimeProfile: args.options.profile } : undefined).request({
        itemId: item.id, role, purpose: running!.purpose, runtime,
        ...(to.model ? { model: to.model } : {}),
        ...(to.effort ? { effort: to.effort } : {}),
        resumeFromRunId: running!.id,
        instruction: CONTINUE_AFTER_PROFILE,
        trigger: "run-profile-switch",
        idempotencyKey: `run-profile-switch:${running!.id}`,
      });
    }
    addActivity(db, {
      itemId: item.id, ...(current ? { runId: current.id } : {}), actor: args.by.actor, kind: "decision", ...behalfCursor(args.by),
      payload: {
        decision: "run_profile_changed", role, runtime, from, to, applied,
        runId: current?.id ?? null, dispatchRequestId, retargetedDispatchRequestIds: retargeted,
        ...(usage ? usage : {}), ...(notes.length ? { notes } : {}),
        reason: args.reason, ...behalfFields(args.by),
      },
    });
    return { retargeted, dispatchRequestId };
  }).immediate();
  if (applied === "restarted") await killStoppedRun(item, running!, stopReason, notes);
  return { ...base, retargetedDispatchRequestIds: retargeted, changed: true, applied, runId: current?.id ?? null, dispatchRequestId };
}

/** 换执行 agent（change_executor_runtime）：开新会话，带上工单的上下文（Lead 的 spawnClaimedItem 发现换了 runtime 时补上）。 */
export async function changeExecutorRuntime(
  db: Db, item: Item, input: { runtime: RuntimeId; model?: string; effort?: string },
  args: { by: ActionAttribution; reason: string; options: ReviewerChoiceOptions },
): Promise<ExecutorRuntimeResult> {
  const runtime = input.runtime;
  const name = runtimeDisplayName(runtime);
  const running = roleRun(db, item.id, "executor", ["running"]);
  const fromRuntime = running?.runtime ?? item.requested_runtime;
  if (fromRuntime === runtime) {
    throw new TicketActionError("invalid_input", `执行 agent 已经是 ${name}。只换模型和推理强度用 set_run_profile，不用开新会话。`);
  }
  if (isRuntimeDisabled(runtime, args.options.env)) throw new TicketActionError("unavailable", `${name} 不能用：${runtimeDisabledReason(runtime)}`);
  const { profile: to, notes } = checkedProfile(
    db, runtime, { model: input.model?.trim() || null, effort: input.effort?.trim() || null }, true, args.options,
  );
  const from = running
    ? { runtime: running.runtime, model: running.model, effort: running.effort }
    : { runtime: fromRuntime, ...(fromRuntime ? nextRunTarget(db, item, "executor", args.options)!.profile : { model: null, effort: null }) };

  const restart = running !== undefined && RESTARTABLE_PURPOSES.has(running.purpose);
  if (running && !restart) notes.push(`Run #${running.id}（${running.purpose}）跑完前还用 ${runtimeDisplayName(running.runtime)}。`);
  const usage = running ? usageAt(db, running) : null;
  const stopReason = `换执行 agent：${args.reason}`;
  // 和 setRunProfile 一样：设置、停下旧 Run（只落账）、排新 runtime 的请求、记活动在一笔事务里，提交以后再停进程（08 审查 3）。
  const { retargeted, dispatchRequestId } = db.transaction(() => {
    rememberProfile(db, item, "executor", runtime, to, { by: args.by, reason: args.reason, source: "change_executor_runtime" });
    const retargeted = retargetPending(db, item.id, "executor", runtime, to, false);
    let dispatchRequestId: number | null = null;
    if (restart) {
      markItemRunStopped(db, running.id, stopReason, args.by);
      // 续接的来源是这个 Run，但它是另一个 CLI 的会话：spawnClaimedItem 开新会话，提示里补上工单的上下文（runtime_changed）。
      dispatchRequestId = createDispatcher(db, args.options.profile ? { runtimeProfile: args.options.profile } : undefined).request({
        itemId: item.id, role: "executor", purpose: running.purpose, runtime,
        ...(to.model ? { model: to.model } : {}),
        ...(to.effort ? { effort: to.effort } : {}),
        resumeFromRunId: running.id,
        instruction: `执行 agent 从 ${runtimeDisplayName(running.runtime)} 换成了 ${name}。`
          + "接着这张工单的工作继续：先看工作区里现在的状态，不要从头再做。",
        trigger: "executor-runtime-change",
        idempotencyKey: `executor-runtime-change:${running.id}`,
      });
    }
    addActivity(db, {
      itemId: item.id, ...(running ? { runId: running.id } : {}), actor: args.by.actor, kind: "decision", ...behalfCursor(args.by),
      payload: {
        decision: "executor_runtime_changed", from, to: { runtime, ...to }, applied: restart ? "restarted" : "next_run",
        runId: running?.id ?? null, dispatchRequestId, retargetedDispatchRequestIds: retargeted,
        ...(usage ?? {}), ...(notes.length ? { notes } : {}),
        reason: args.reason, ...behalfFields(args.by),
      },
    });
    return { retargeted, dispatchRequestId };
  }).immediate();
  if (restart) await killStoppedRun(item, running, stopReason, notes);
  return {
    from, to: { runtime, ...to }, applied: restart ? "restarted" : "next_run", runId: running?.id ?? null, dispatchRequestId,
    retargetedDispatchRequestIds: retargeted, notes,
  };
}

// ── 两个操作的定义 ──────────────────────────────────────────────────────────────────

function profileAvailability(item: Item): Availability {
  if (item.kind !== "task") return unavailable("提醒没有执行 agent。");
  if (item.stage === "done" || item.stage === "cancelled") return unavailable("工单已经结束，没有下一次 Run。");
  return AVAILABLE;
}

// 正在启动的 Run 还没有进程可以换，也还不能停下续接：换执行者的设置要等它开始。
// 核查员的设置不用等（2026-10-29）：它只影响以后的核查，正在启动的 Run 照原来的跑。
function startingRunRefusal(db: Db, item: Item): string | null {
  const starting = db.prepare("SELECT id FROM runs WHERE item_id=? AND state='starting' ORDER BY id DESC LIMIT 1")
    .get(item.id) as { id: number } | undefined;
  return starting ? `Run #${starting.id} 正在启动，等它开始以后再换。` : null;
}

function executorProfileAvailability(db: Db, item: Item): Availability {
  const base = profileAvailability(item);
  if (!base.available) return base;
  const starting = startingRunRefusal(db, item);
  return starting ? unavailable(starting) : AVAILABLE;
}

function touchedRuns(run: TicketActionRun<unknown>, result: unknown) {
  const { runId } = result as { runId: number | null };
  return runId === null ? {} : { runs: [{ itemId: run.item.id, runId }] };
}

type RunProfileActionId = "set_run_profile" | "change_executor_runtime";

export const RUN_PROFILE_ACTIONS: { readonly [K in RunProfileActionId]: TicketActionDefinition<K> } = {
  set_run_profile: {
    id: "set_run_profile", label: "换模型和强度", area: "execution", scope: "tickets:create",
    permission: "lead_allowed", external: false, irreversible: false, ownerAction: null,
    hint: "换执行者或核查员（role）的模型和推理强度，不丢会话。不给的一项不变；只能选模型目录里的（get_model_catalog），"
      + "强度只能选这个模型认的档位。有 Run 在跑时：agent 能不停进程换模型的，在同一个 Run 里换，从下一次调用模型开始生效；"
      + "不能的，停在当前这一步，用同一个会话和新参数接着跑（新的一个 Run）。结果的 applied 说明是哪一种。暂停的 Run 继续时用新的；"
      + "没有 Run 时下一次 Run 用。换执行 agent 是另一件事，用 change_executor_runtime。",
    defaultReason: "用户换了模型和推理强度",
    // 清单不知道这次换的是哪个角色：只按工单说能不能做。换执行者时正在启动的 Run 由 setRunProfile 拒绝。
    available: (item) => profileAvailability(item),
    run: ({ db, env, item, input, by, reason }) => setRunProfile(db, item, input, { by, reason, options: choiceOptions(env) }),
    effects: touchedRuns,
  },

  change_executor_runtime: {
    id: "change_executor_runtime", label: "换执行 agent", area: "execution", scope: "tickets:create",
    permission: "lead_allowed", external: false, irreversible: false, ownerAction: null,
    hint: "把执行者换成另一个 runtime（runtime；model、effort 是给新 runtime 的，不给时用它自己的默认）。"
      + "会开新会话：新 agent 不记得之前的对话，系统把工单的上下文（交付、核查、最近的对话）带给它。"
      + "有执行 Run 在跑时，它停在当前这一步，由新 agent 接着做；没有时下一次 Run 用新 agent。只换模型和强度用 set_run_profile。",
    defaultReason: "用户换了执行 agent",
    available(item, env) {
      const base = executorProfileAvailability(env.db, item);
      if (!base.available) return base;
      const paused = roleRun(env.db, item.id, "executor", ["paused"]);
      if (paused) {
        return unavailable(`Run #${paused.id} 暂停着。换执行 agent 要开新会话：先停下它，或者让它继续跑完，再换。`);
      }
      return AVAILABLE;
    },
    run: ({ db, env, item, input, by, reason }) =>
      changeExecutorRuntime(db, item, { ...input, runtime: input.runtime as RuntimeId }, { by, reason, options: choiceOptions(env) }),
    effects: touchedRuns,
  },
};
