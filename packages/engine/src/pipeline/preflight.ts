// preflight（spec D2，工单 05）：派发 claim 时、创建 Run 之前，内核用 RuntimeProfile 检查目标。
// 确定会失败的 Run 不创建。检查分两类：
//   - 安装检查：可执行文件能运行版本命令，child 实际会用的解释器满足 engines 要求，扩展文件存在。
//     安装检查要起进程，所以编排器的 tick 在 claim 之前异步跑它（refresh），claim 只读缓存。
//     缓存按 profile hash 存，带有效期。检查本身是 adapter 的 preflight，它和健康探针（工单 04）共用代码。
//   - 请求检查，claim 时同步跑：模型属于这个 runtime，工作区可以启动。
// 安装检查和模型检查没通过时，结果写进健康账本（复用工单 03 的挂起和通知），请求挂起。
// 工作区是工单自己的事，不进账本：请求挂起，lead 和用户收到一条 blocker。
import { isAbsolute } from "node:path";
import type { Db } from "@pi-lead-child/store";
import type { RuntimeId } from "@pi-lead-child/core";
import type { AgentRuntime, RuntimeProbeResult } from "@pi-lead-child/runtime";
import { runtimeIds, runtimeProfileOf } from "@pi-lead-child/runtime";
import {
  modelOwnershipProblem, runtimeProfileHash, type RuntimeProfile,
} from "@pi-lead-child/runtime";
import { runtimeDisplayName, typedFailure } from "@pi-lead-child/runtime";
import { recordRuntimeHealthFailure, runtimeSuspensionReason, unavailableProfileIncident } from "@pi-lead-child/store";
import { addActivity } from "@pi-lead-child/store";
import { raiseBlocker } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import { resolveWorkspace, UNLAUNCHABLE_WORKSPACE_STATES } from "@pi-lead-child/store";

export interface RuntimePreflight {
  // 这个 runtime 现在的 profile。派发 gate、preflight 和 Run 上记的 profile hash 都用它。
  profile(runtime: RuntimeId): RuntimeProfile;
  // claim 时同步读：这个 profile 的安装检查结果。没有有效的缓存时返回 null。
  cached(runtime: RuntimeId): RuntimeProbeResult | null;
  // 编排器在 claim 之前调用：缓存过期或缺失的 profile 重新检查。
  refresh(): Promise<void>;
  // claim 把一次失败记进账本之后调用。故障恢复后，下一次检查重新跑，不读旧的失败。
  forget(runtime: RuntimeId): void;
  // daemon 关闭时调用。它中止正在跑的检查，结果不再写进缓存。
  stop(): void;
}

// 安装检查的有效期。成功的结果默认 10 分钟内不重跑。
// 失败的结果最多留 1 分钟：用户修好之后，最多等这么久就会重新检查。
// 失败通常马上被 claim 记进账本，然后由健康恢复（工单 04）接手。
export function preflightTtlMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.PLC_RUNTIME_PREFLIGHT_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600_000;
}
const MAX_FAILURE_TTL_MS = 60_000;

export function createRuntimePreflight(
  db: Db,
  options: {
    // 这个 daemon 里执行这个 runtime 的 adapter。检查的必须是执行时用的同一个 profile。
    runtime: (id: RuntimeId) => AgentRuntime;
    runtimes?: readonly RuntimeId[];
    now?: () => Date;
    ttlMs?: number;
    log?: (line: string) => void;
  },
): RuntimePreflight {
  const now = options.now ?? (() => new Date());
  const ttlMs = options.ttlMs ?? preflightTtlMs();
  // 没有指定时，检查 registry 里登记的所有 runtime。每次 refresh 都重新读，所以也检查之后登记的 runtime。
  const checkedRuntimes = (): readonly RuntimeId[] => options.runtimes ?? runtimeIds();
  const log = options.log ?? (() => {});
  const cache = new Map<string, { result: RuntimeProbeResult; expiresAt: number }>();
  const inFlight = new Map<string, Promise<void>>();
  const abort = new AbortController();
  let stopped = false;

  const profile = (runtime: RuntimeId): RuntimeProfile => runtimeProfileOf(options.runtime(runtime));
  const cachedResult = (hash: string): RuntimeProbeResult | null => {
    const entry = cache.get(hash);
    return entry && entry.expiresAt > now().getTime() ? entry.result : null;
  };

  const check = async (adapter: AgentRuntime, hash: string): Promise<void> => {
    let result: RuntimeProbeResult;
    if (!adapter.preflight) {
      result = { ok: true, checks: [] };
    } else {
      try {
        result = await adapter.preflight({ signal: abort.signal });
      } catch (error) {
        result = {
          ok: false, checks: [],
          failure: typedFailure("runtime_start_failed", {
            errorCode: "preflight_error", message: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }
    if (stopped) return;
    // 超时说明不了安装坏了，例如系统第一次扫描一个新的可执行文件。
    // preflight 只挂起确定会失败的请求，所以超时按通过处理，只缓存很短的时间。
    // Run 真的失败时，健康账本照样从 Run 的失败记下它。
    const inconclusive = !result.ok && result.timedOut === true;
    const stored: RuntimeProbeResult = inconclusive ? { ok: true, checks: result.checks } : result;
    const lifetime = result.ok ? ttlMs : Math.min(ttlMs, MAX_FAILURE_TTL_MS);
    cache.set(hash, { result: stored, expiresAt: now().getTime() + lifetime });
    const outcome = result.ok ? "passed" : inconclusive ? "timed out (allowed)" : `failed (${result.failure.code})`;
    log(`[preflight] ${adapter.id} ${hash} ${outcome} checks=[${result.checks.join(", ")}]`);
  };

  return {
    profile,
    cached: (runtime) => cachedResult(runtimeProfileHash(profile(runtime))),
    async refresh() {
      if (stopped) return;
      await Promise.all(checkedRuntimes().map(async (runtime) => {
        const adapter = options.runtime(runtime);
        const current = runtimeProfileOf(adapter);
        const hash = runtimeProfileHash(current);
        if (cachedResult(hash)) return;
        // 账本已经挂起整个 profile 时不检查：这个 runtime 的请求走不到 claim，恢复由探针负责。
        // 探针通过、故障关闭以后，下一轮 refresh 再检查。
        if (unavailableProfileIncident(db, current)) return;
        let running = inFlight.get(hash);
        if (!running) {
          running = check(adapter, hash).finally(() => inFlight.delete(hash));
          inFlight.set(hash, running);
        }
        await running;
      }));
    },
    forget: (runtime) => { cache.delete(runtimeProfileHash(profile(runtime))); },
    stop() {
      stopped = true;
      abort.abort();
    },
  };
}

// ── claim 时的决策边界 ─────────────────────────────────────────────────────────
export interface PreflightRequest {
  requestId: number;
  itemId: number;
  runtime: RuntimeId;
  model: string | undefined;
  suspendedReason: string | null;
  suspendedIncidentId: number | null;
}

// 工作区能不能启动。规则和 runItem 启动前的检查一致（manager.ts 的 workspaceForRun）：
// 解析到的工作区不能是终结状态或 blocked。编码工单必须有工作区，或者有一个可以收编的绝对路径。
export function workspaceLaunchProblem(db: Db, itemId: number): string | null {
  const resolved = resolveWorkspace(db, itemId);
  if (resolved) {
    const { workspace } = resolved;
    return UNLAUNCHABLE_WORKSPACE_STATES.includes(workspace.state)
      ? `工作区 #${workspace.id} 处于 ${workspace.state} 状态，不能启动 Run。`
      : null;
  }
  const item = getItem(db, itemId);
  if (!item || (item.workdir && isAbsolute(item.workdir))) return null;
  return item.workflow_kind === "coding" ? `编码工单 #${itemId} 没有可用的工作区，不能启动 Run。` : null;
}

function touchItem(db: Db, itemId: number): void {
  db.prepare("UPDATE items SET last_activity_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(itemId);
}

// 请求挂起：保持 pending，带上看得见的原因。原因没变时不重写，每个 tick 重复检查不会刷活动。
function suspend(
  db: Db,
  request: PreflightRequest,
  args: { reason: string; incidentId: number | null; payload: Record<string, unknown> },
): void {
  if (request.suspendedReason === args.reason && request.suspendedIncidentId === args.incidentId) return;
  db.prepare(
    `UPDATE dispatch_requests SET suspended_reason=?, suspended_incident_id=?, updated_at=datetime('now')
     WHERE id=? AND state='pending'`,
  ).run(args.reason, args.incidentId, request.requestId);
  addActivity(db, {
    itemId: request.itemId, actor: "system", kind: "decision",
    payload: {
      decision: "dispatch_refused_by_preflight", dispatchRequestId: request.requestId,
      runtime: request.runtime, model: request.model ?? null, ...args.payload, message: args.reason,
    },
  });
  touchItem(db, request.itemId);
}

// 安装检查或模型检查没通过：写进健康账本，请求挂起。账本按 profile 或"profile 加模型"挂起之后的请求，
// 同一次故障只通知一次（工单 03）。
function refuseByHealth(
  db: Db,
  request: PreflightRequest,
  args: { profile: RuntimeProfile; failure: ReturnType<typeof typedFailure>; checks: string[]; at: Date },
): void {
  db.transaction(() => {
    const recorded = recordRuntimeHealthFailure(db, {
      profile: args.profile, model: request.model, failure: args.failure,
      itemId: request.itemId, runId: null, dispatchRequestId: request.requestId, at: args.at,
    });
    const payload = { code: args.failure.code, checks: args.checks };
    if (!recorded) {
      // 不是账本上的失败（adapter 给了别的作用域）：只挂起这一条请求。
      suspend(db, request, { reason: `preflight 没有通过：${args.failure.evidence.split("\n")[0]}`, incidentId: null, payload });
      return;
    }
    const { incident } = recorded;
    suspend(db, request, {
      reason: runtimeSuspensionReason(incident), incidentId: incident.id, payload: { ...payload, incidentId: incident.id },
    });
  }).immediate();
}

// 不经过派发队列的启动路径（spawnItemChild）用的同步判断：缓存里已经知道这个目标会失败时，返回原因。
// 缓存还没有结果时返回 null，调用方照旧直接启动：失败的 Run 仍由健康账本被动记下。
export function preflightKnownFailure(
  preflight: RuntimePreflight,
  runtime: RuntimeId,
  model: string | null | undefined,
): string | null {
  const install = preflight.cached(runtime);
  if (install && !install.ok) return install.failure.evidence.split("\n")[0] ?? install.failure.code;
  return modelOwnershipProblem(preflight.profile(runtime), model);
}

// 返回 true：可以创建 Run。返回 false：请求已经挂起，或者安装检查还没有结果（下一轮 tick 先检查）。
export function preflightAllowsClaim(
  db: Db,
  preflight: RuntimePreflight,
  request: PreflightRequest,
  at: Date = new Date(),
): boolean {
  const profile = preflight.profile(request.runtime);
  const install = preflight.cached(request.runtime);
  if (!install) return false;
  if (!install.ok) {
    refuseByHealth(db, request, { profile, failure: install.failure, checks: install.checks, at });
    preflight.forget(request.runtime);
    return false;
  }
  const modelProblem = modelOwnershipProblem(profile, request.model);
  if (modelProblem) {
    const agent = runtimeDisplayName(request.runtime);
    refuseByHealth(db, request, {
      profile, at, checks: ["model ownership"],
      failure: typedFailure("model_unsupported", {
        errorCode: "preflight_model_unsupported", message: `${agent} 不能使用模型 ${request.model}：${modelProblem}`,
      }),
    });
    return false;
  }
  const workspaceProblem = workspaceLaunchProblem(db, request.itemId);
  if (workspaceProblem) {
    db.transaction(() => {
      suspend(db, request, { reason: `preflight 没有通过：${workspaceProblem}`, incidentId: null, payload: { check: "workspace" } });
      raiseBlocker(db, {
        // 先交给 Lead（2026-10-15 用户决定：异常先交给 Lead，需要你时才强提醒）。
        needsUser: false,
        itemId: request.itemId,
        code: "dispatch_preflight_workspace",
        title: "工作区不能启动，派发已挂起",
        summary: `派发请求 #${request.requestId} 已挂起，没有创建 Run：${workspaceProblem}`,
        nextStep: "修复或重建这张工单的工作区。工作区可以启动后，挂起的请求会自动继续。",
        source: "structural",
        dedupKey: `preflight-workspace:${request.requestId}`,
        at,
      });
    }).immediate();
    return false;
  }
  return true;
}
