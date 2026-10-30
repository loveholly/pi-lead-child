// 选核查员（2026-10-20）。
//
// 以前只有能做可执行只读核查的 Codex 能当核查员，这一条是硬闸：用户停用 Codex、或者 Codex 账号出了故障，
// 核查请求就挂起等着，Lead 换不了，用户也换不了（2026-10-20 用户反馈）。现在任何登记的 runtime 都能当核查员：
//   - 顺序：PLC_REVIEW_RUNTIME（设置了的话）→ 能做可执行只读核查的 → 其余，各自按 registry 的顺序（registry.ts 的
//     reviewRuntimeOrder）。能不能跑命令只影响排序。
//   - 跳过用户停用的 runtime，跳过 profile 上有没关闭故障的 runtime（查健康账本，和派发 gate 查同一个目标）。
//   - 一个能用的都没有时，返回第一个没停用的：请求照常排队，由派发 gate 挂起并写明原因，故障关闭后自动放行。
// 派发时（dispatch.ts）、自动核查排队时（automatic-review.ts）、reviewer 重试（orchestrator.ts）、Lead 派核查员
// （spawn_child）和用户换核查员（change-reviewer.ts）都用这里。
//
// 一张工单的核查员（工单 09，spec 5.6、D3）：核查员和执行者一起选。
//   - Lead 建单时选的，或者之后 Lead、用户换的，存在 store 的 item_reviewer_settings（reviewer-settings.ts）。能用就用它。
//   - 没选，或者选的现在不能用：系统按上面的规则选，优先选和执行者不同的 runtime。只剩和执行者同一种时用它，标明 sameAsExecutor。
//   - 自然语言（brief 里「严禁调用 codex」）由 Lead 读懂再落成选择，这里不读 brief。
import type { Actor, Item, RuntimeId } from "@pi-lead-child/core";
import type { Db, ReviewerChooser, RuntimeIncident } from "@pi-lead-child/store";
import { addActivity, getItem, getReviewerSetting, runtimeIncidentTitle, unavailableIncident } from "@pi-lead-child/store";
import {
  defaultRuntimeProfile, isRuntimeDisabled, isRuntimeId, reviewRuntimeOrder, runtimeDisabledReason, runtimeDisplayName,
  type RuntimeEnv, type RuntimeProfile,
} from "@pi-lead-child/runtime";
import { runModelFor } from "./run-choice.js";

export interface ReviewerOption {
  runtime: RuntimeId;
  displayName: string;
  available: boolean;
  // 不能用时的原因（停用、故障）。能用时没有。
  reason?: string;
}

export interface ReviewerChoiceOptions {
  env?: RuntimeEnv;
  // 健康账本按哪个 profile 查。daemon 的派发 gate 用自己 registry 里的 profile；缺省用 runtime 的默认 profile。
  profile?: (runtime: RuntimeId) => RuntimeProfile;
}

// 核查员用的模型。核查不拿执行者的模型（run-choice.ts），所以只看 PLC_<RUNTIME>_MODEL 这类配置；
// 派发请求换了核查员以后模型清空，派发 gate 按同一条规则算出同一个模型。
function reviewerModel(runtime: RuntimeId): string | null {
  return runModelFor({ role: "reviewer", runtime, item: { requested_runtime: null, requested_model: null } }) ?? null;
}

// 故障给人看的一句话，例如「Codex 账号已停用（故障 #3）」。换核查员的活动、选项列表都用它。
export function reviewerIncidentReason(incident: RuntimeIncident): string {
  return `${runtimeIncidentTitle(incident)}（故障 #${incident.id}）`;
}

// 一个 runtime 现在为什么不能当核查员；能用时返回 null。db 为空时不查健康账本（设置页这类没有数据库的地方）。
export function reviewerUnavailableReason(
  db: Db | null,
  runtime: RuntimeId,
  options: ReviewerChoiceOptions & { model?: string | null } = {},
): string | null {
  const env = options.env ?? process.env;
  if (isRuntimeDisabled(runtime, env)) return runtimeDisabledReason(runtime);
  if (!db) return null;
  let profile: RuntimeProfile;
  try {
    profile = (options.profile ?? defaultRuntimeProfile)(runtime);
  } catch {
    // 没有 profile 的 runtime（例如测试登记的 adapter）：健康账本不记它，按可用处理。
    return null;
  }
  const model = options.model === undefined ? reviewerModel(runtime) : options.model;
  const incident = unavailableIncident(db, { profile, model });
  return incident ? reviewerIncidentReason(incident) : null;
}

// 所有登记的 runtime，按选核查员的顺序，标明能不能用、为什么。
export function reviewerOptions(db: Db | null, options: ReviewerChoiceOptions = {}): ReviewerOption[] {
  return reviewRuntimeOrder(options.env ?? process.env).map((runtime) => {
    const reason = reviewerUnavailableReason(db, runtime, options);
    return {
      runtime,
      displayName: runtimeDisplayName(runtime),
      available: reason === null,
      ...(reason === null ? {} : { reason }),
    };
  });
}

// 选一个核查员：第一个能用的；都不能用时第一个没停用的；都停用了时第一个。
// 给了 avoid（执行者的 runtime，D3）时，每一档里先找和它不同的，没有再用它。
// 配置里点名的核查员（PLC_REVIEW_RUNTIME）是明确的选择，先于「避开执行者」：它在这一档里就用它。
// exclude 里的 runtime 不参加（选好的核查员连默认模型都不能用时，itemReviewer 用它去掉那个 runtime）。
export function pickReviewRuntime(
  db: Db | null,
  options: ReviewerChoiceOptions & { avoid?: RuntimeId | null; exclude?: readonly RuntimeId[] } = {},
): RuntimeId {
  const env = options.env ?? process.env;
  const configured = env.PLC_REVIEW_RUNTIME?.trim();
  const every = reviewerOptions(db, options);
  const remaining = every.filter((option) => !options.exclude?.includes(option.runtime));
  const all = remaining.length ? remaining : every;
  const first = (ok: (option: ReviewerOption) => boolean) =>
    all.find((option) => ok(option) && option.runtime === configured)
    ?? all.find((option) => ok(option) && option.runtime !== options.avoid)
    ?? all.find(ok);
  return (first((option) => option.available)
    ?? first((option) => !isRuntimeDisabled(option.runtime, env))
    ?? all[0]!).runtime;
}

// 执行者的 runtime：最近一个执行 Run 的；还没有 Run 时是工单要求的。都没有时为 null（不知道执行者，就不避开谁）。
export function executorRuntimeOf(db: Db, item: Pick<Item, "id" | "requested_runtime">): RuntimeId | null {
  const run = db.prepare(
    "SELECT runtime FROM runs WHERE item_id=? AND role='executor' AND runtime IS NOT NULL ORDER BY id DESC LIMIT 1",
  ).get(item.id) as { runtime: string } | undefined;
  if (run && isRuntimeId(run.runtime)) return run.runtime;
  return item.requested_runtime && isRuntimeId(item.requested_runtime) ? item.requested_runtime : null;
}

export interface ItemReviewer {
  runtime: RuntimeId;
  // 核查用的模型和推理强度。null 表示用这个 runtime 的默认模型（PLC_<RUNTIME>_MODEL 或 CLI 的配置，run-choice.ts）。
  model: string | null;
  effort: string | null;
  // 谁选的：Lead、用户（item_reviewer_settings），或者系统。只换成同一个 runtime 的默认模型时，仍是选它的人。
  chosenBy: ReviewerChooser | "system";
  executorRuntime: RuntimeId | null;
  // 核查员和执行者是同一种 agent（D3：没有别的可用时允许，界面上写明）。
  sameAsExecutor: boolean;
  // Lead 或用户选的核查员（runtime 加模型）现在不能用，系统换了：选的是什么，为什么不能用。没换时为 null。
  replaced: { runtime: RuntimeId; model: string | null; reason: string } | null;
}

// 这张工单现在的核查员。能不能用按「runtime 加模型」判断（2026-10-22 审查 H1：以前只看 runtime，选好的模型有故障时
// 核查一直挂起）：
//   1. 选好的组合能用：用它。
//   2. 只是选好的模型不能用，同一个 runtime 的默认模型能用：改用默认模型（model、effort 清空）。
//   3. 这个 runtime 连默认模型也不能用：把它从候选里去掉，系统选，避开执行者的 runtime。
//   4. 别的 runtime 也都不能用（它没被停用时）：还是选好的，请求由派发 gate 挂起，故障恢复后放行。
// 没人选过时直接是 3 的系统选择。
export function itemReviewer(db: Db, itemId: number, options: ReviewerChoiceOptions = {}): ItemReviewer {
  const item = getItem(db, itemId);
  if (!item) throw new Error(`item #${itemId} not found`);
  const executorRuntime = executorRuntimeOf(db, item);
  const setting = getReviewerSetting(db, itemId);
  const system = (exclude: readonly RuntimeId[], replaced: ItemReviewer["replaced"]): ItemReviewer => {
    const runtime = pickReviewRuntime(db, { ...options, avoid: executorRuntime, exclude });
    return {
      runtime, model: null, effort: null, chosenBy: "system", executorRuntime, sameAsExecutor: runtime === executorRuntime, replaced,
    };
  };
  if (!setting) return system([], null);
  const chosen = (model: string | null, effort: string | null, replaced: ItemReviewer["replaced"]): ItemReviewer => ({
    runtime: setting.runtime, model, effort, chosenBy: setting.chosenBy,
    executorRuntime, sameAsExecutor: setting.runtime === executorRuntime, replaced,
  });
  const unusable = reviewerUnavailableReason(db, setting.runtime, { ...options, ...(setting.model ? { model: setting.model } : {}) });
  if (unusable === null) return chosen(setting.model, setting.effort, null);
  const replaced = { runtime: setting.runtime, model: setting.model, reason: unusable };
  if (setting.model && reviewerUnavailableReason(db, setting.runtime, options) === null) return chosen(null, null, replaced);
  const others = reviewerOptions(db, options).filter((option) => option.runtime !== setting.runtime);
  if (!isRuntimeDisabled(setting.runtime, options.env ?? process.env) && !others.some((option) => option.available)) {
    return chosen(setting.model, setting.effort, null);
  }
  return system([setting.runtime], replaced);
}

// 核查 Run 用哪个模型和推理强度：这张工单现在的核查员（itemReviewer，已经按能不能用换过）。执行 Run 没有，为 null。
// run-choice.ts 的 runModelFor、runEffortFor 在 runtime 一致时用它。派发认领（dispatch.ts 的 dispatchTarget）、
// 直接启动（manager.ts）和 Lead 的 spawn_child 都用这里。
export function reviewerProfileFor(
  db: Db,
  itemId: number,
  role: "executor" | "reviewer",
  options: ReviewerChoiceOptions = {},
): Pick<ItemReviewer, "runtime" | "model" | "effort"> | null {
  return role === "reviewer" ? itemReviewer(db, itemId, options) : null;
}

// 排核查请求时点名哪个核查员：选好的就点名它，不管它现在能不能用。不能用时由派发认领时自动换人（换模型或者换 runtime），
// 并在工单上记一条「核查员从 X 换成 Y」（dispatch.ts 的 switchReviewer，工单 01）。没选时按系统的规则选。
export function reviewRequestRuntime(db: Db, itemId: number, options: ReviewerChoiceOptions = {}): RuntimeId {
  return getReviewerSetting(db, itemId)?.runtime ?? itemReviewer(db, itemId, options).runtime;
}

// 换了核查员时在工单上记一条活动，例如「核查员从 Codex 换成 Claude Code：Codex 账号已停用（故障 #3）」。
// 同一个 runtime 只换模型时写出模型，例如「核查员从 Claude Code（opus）换成 Claude Code（默认模型）：……」。
// 派发时自动换（actor=system）、用户换、Lead 换（change-reviewer.ts）、Lead 直接派核查员（spawn_child）都记这一条，
// 界面和 Lead 的工单详情读它。不经过派发请求的（spawn_child）dispatchRequestId 为 null。
export function recordReviewerSwitch(
  db: Db,
  args: {
    itemId: number; dispatchRequestId: number | null; from: RuntimeId; to: RuntimeId; reason: string; actor: Actor;
    fromModel?: string | null; toModel?: string | null;
  },
): void {
  const modelChanged = args.from === args.to && (args.fromModel ?? null) !== (args.toModel ?? null);
  const label = (runtime: RuntimeId, model: string | null | undefined) =>
    modelChanged ? `${runtimeDisplayName(runtime)}（${model || "默认模型"}）` : runtimeDisplayName(runtime);
  const message = `核查员从 ${label(args.from, args.fromModel)} 换成 ${label(args.to, args.toModel)}：${args.reason}`;
  addActivity(db, {
    itemId: args.itemId,
    actor: args.actor,
    kind: "decision",
    payload: {
      decision: "reviewer_runtime_switched",
      dispatchRequestId: args.dispatchRequestId,
      from: args.from,
      to: args.to,
      ...(args.fromModel === undefined ? {} : { fromModel: args.fromModel }),
      ...(args.toModel === undefined ? {} : { toModel: args.toModel }),
      reason: args.reason,
      message,
    },
  });
}
