// 健康恢复（spec D2，工单 04）。到了退避的截止时间，跑 adapter 的探针。探针不发起模型调用，不花钱。
// 探针通过就关闭故障，挂起的请求马上放行（2026-10-20 去掉了"先放一个金丝雀"这一步：用户嫌它绕）。
// 探针看不到的故障关闭以后又同样失败时，账本把它并回那次故障，退避加倍（store/runtime-health.ts）。
// 用户也能用 plc recheck 立即跑一次探针，不等退避。
// 探针看不出、也不会自己消失的故障（runtime 的 recoversOnlyOnRecheck，例如账号停用）不自动探针，只等 plc recheck。
// 用量额度用完、报错里没写重置时间的故障也一样（usageResetUnknown，工单 #117）：探针看不到额度，通过了说明不了什么。
// 截止时间存成绝对时间（runtime_incidents.next_probe_at），所以 daemon 重启后只等剩下的时间。
import { clearInterval, setInterval } from "node:timers";
import type { Db } from "@pi-lead-child/store";
import type { RuntimeId } from "@pi-lead-child/core";
import type { AgentRuntime, RuntimeProbeResult } from "@pi-lead-child/runtime";
import { isRuntimeId, runtimeIds, runtimeProfileOf } from "@pi-lead-child/runtime";
import { modelOwnershipProblem, runtimeProfileKey } from "@pi-lead-child/runtime";
import { recoversOnlyOnRecheck, runtimeDisplayName, typedFailure, usageResetUnknown } from "@pi-lead-child/runtime";
import {
  closeLegacyCanaryIncidents, deferRuntimeProbe, dueProbeIncidents, incidentProbeModel, openRuntimeIncidents,
  recordProbeResult, runtimeIncidentTitle, type RuntimeIncident,
} from "@pi-lead-child/store";

// recovered：探针通过，故障已经关闭。
export type RecheckOutcome =
  | "recovered"
  | "probe_failed"
  | "profile_changed";

export interface RecheckResult {
  incidentId: number;
  runtime: RuntimeId;
  outcome: RecheckOutcome;
  // plc recheck 原样打印这一句。
  summary: string;
}

export interface HealthRecovery {
  // 关闭旧数据里停在金丝雀阶段的故障，然后跑到期的探针。返回这一轮关闭的故障。
  tick(): Promise<{ closed: number[] }>;
  // 用户的手动重检：不等退避，马上探针。不指定 runtime 时，重检所有没关闭的故障。
  recheck(args?: { runtime?: RuntimeId }): Promise<RecheckResult[]>;
  // daemon 关闭时调用。它中止正在跑的探针。这些探针的结果不再写库。
  stop(): void;
}

// 只在用户 plc recheck 时探针的故障。证据里的相对重置时间（「Resets in 2h」）从故障开启的时间算起。
function waitsForRecheck(incident: RuntimeIncident): boolean {
  return recoversOnlyOnRecheck(incident) || usageResetUnknown(incident, new Date(incident.opened_at));
}

type ProbeOutcome =
  | { kind: "probed"; result: RuntimeProbeResult; recorded: boolean }
  | { kind: "profile_changed" }
  | { kind: "stopped" };

// 探针失败时记在故障上的一句诊断。只取证据的第一行：证据里可能有 stderr。
function probeDetail(result: RuntimeProbeResult): string | null {
  if (result.ok) return null;
  const line = result.failure.evidence.trim().split(/\r?\n/)[0] ?? "";
  return `${result.failure.code}：${line.length > 200 ? `${line.slice(0, 199)}…` : line}`;
}

export function createHealthRecovery(
  db: Db,
  options: {
    // 这个 daemon 里执行这个 runtime 的 adapter。探针必须检查执行时用的同一个 profile。
    runtime: (id: RuntimeId) => AgentRuntime | null;
    now?: () => Date;
    log?: (line: string) => void;
  },
): HealthRecovery {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const inFlight = new Map<number, Promise<ProbeOutcome>>();
  const abort = new AbortController();
  let stopped = false;

  const runProbe = async (incident: RuntimeIncident, manual: boolean): Promise<ProbeOutcome> => {
    const adapter = options.runtime(incident.runtime);
    // 配置换了（例如换了可执行文件或配置目录），就是另一个 profile。派发 gate 按现在的 profile 查账本，
    // 所以这次故障只挂起用旧配置的派发。探针说明不了旧配置，所以不探，只推迟到下一个退避时间。
    // 故障不关闭：daemon 换回旧配置时，它照旧挂起派发，不会再发一条通知。
    if (!adapter || runtimeProfileKey(runtimeProfileOf(adapter)) !== incident.profile_key) {
      deferRuntimeProbe(db, incident.id, { at: now(), detail: "profile_changed" });
      return { kind: "profile_changed" };
    }
    let result: RuntimeProbeResult;
    // 模型级故障先看模型是否属于这个 runtime（工单 05）。不属于时永远修不好，不能因为探针通过就关闭：
    // claim 时的 preflight 会用同一条规则再次拦下它。这一步不起进程。
    const foreignModel = incident.level === "model"
      ? modelOwnershipProblem(runtimeProfileOf(adapter), incident.model || null)
      : null;
    if (foreignModel) {
      result = {
        ok: false, checks: ["model ownership"],
        failure: typedFailure("model_unsupported", { errorCode: "probe_failed", message: foreignModel }),
      };
    } else if (!adapter.probe) {
      // adapter 没有探针：按通过处理。真的没修好时，下一个 Run 失败，账本把它并回这次故障。
      result = { ok: true, checks: [] };
    } else {
      try {
        result = await adapter.probe({ model: incidentProbeModel(db, incident), signal: abort.signal });
      } catch (error) {
        result = {
          ok: false, checks: [],
          failure: typedFailure("runtime_start_failed", {
            errorCode: "probe_error", message: error instanceof Error ? error.message : String(error),
          }),
        };
      }
    }
    if (stopped) return { kind: "stopped" };
    const detail = probeDetail(result);
    const recorded = recordProbeResult(db, incident.id, { ok: result.ok, detail, at: now(), manual }) !== null;
    log(`[health] incident #${incident.id} probe ${result.ok ? "passed" : `failed (${detail})`}`
      + ` checks=[${result.checks.join(", ")}]${manual ? " on recheck" : ""}`);
    return { kind: "probed", result, recorded };
  };

  // 同一次故障同时只跑一个探针。手动重检遇到正在跑的探针时，等它的结果。
  const probe = (incident: RuntimeIncident, manual: boolean): Promise<ProbeOutcome> => {
    const running = inFlight.get(incident.id);
    if (running) return running;
    const started = runProbe(incident, manual).finally(() => inFlight.delete(incident.id));
    inFlight.set(incident.id, started);
    return started;
  };

  const summary = (incident: RuntimeIncident, outcome: RecheckOutcome, detail?: string | null): string => {
    const head = `${runtimeIncidentTitle(incident)}（故障 #${incident.id}）`;
    switch (outcome) {
      case "recovered":
        return `${head}：重检通过，故障已关闭，挂起的请求马上放行。`;
      case "probe_failed":
        return `${head}：重检没有通过（${detail ?? "原因未知"}）。派发保持挂起。`;
      case "profile_changed":
        return `${head}：daemon 现在用的 ${runtimeDisplayName(incident.runtime)} 配置不是这次故障的配置，`
          + "所以没有重检。这次故障只挂起用那个配置的派发。";
    }
  };

  return {
    async tick() {
      if (stopped) return { closed: [] };
      // 旧数据（2026-10-20 以前）：探针已经通过、在等金丝雀的故障，直接关闭。幂等。
      const legacy = closeLegacyCanaryIncidents(db, now());
      const due = dueProbeIncidents(db, now())
        .filter((incident) => !inFlight.has(incident.id) && !waitsForRecheck(incident));
      const outcomes = await Promise.all(due.map(async (incident) => ({
        incident, outcome: await probe(incident, false),
      })));
      const closed = [...legacy, ...outcomes
        .filter(({ outcome }) => outcome.kind === "probed" && outcome.result.ok && outcome.recorded)
        .map(({ incident }) => incident.id)];
      return { closed };
    },

    async recheck(args = {}) {
      if (stopped) return [];
      closeLegacyCanaryIncidents(db, now());
      const incidents = openRuntimeIncidents(db, args.runtime ? { runtime: args.runtime } : {});
      return Promise.all(incidents.map(async (incident): Promise<RecheckResult> => {
        const base = { incidentId: incident.id, runtime: incident.runtime };
        const outcome = await probe(incident, true);
        if (outcome.kind === "profile_changed") {
          return { ...base, outcome: "profile_changed", summary: summary(incident, "profile_changed") };
        }
        if (outcome.kind === "stopped") {
          return { ...base, outcome: "probe_failed", summary: summary(incident, "probe_failed", "daemon 正在关闭") };
        }
        const result = outcome.result.ok ? "recovered" : "probe_failed";
        return { ...base, outcome: result, summary: summary(incident, result, probeDetail(outcome.result)) };
      }));
    },

    stop() {
      stopped = true;
      abort.abort();
    },
  };
}

// ── daemon 接线 ────────────────────────────────────────────────────────────────
// socket 命令 runtime_recheck 的参数来自 CLI，属于外部输入。runtime 只能是已知的 id，或者不给。
export function parseRecheckRuntime(value: unknown): RuntimeId | undefined {
  if (value === undefined || value === null) return undefined;
  if (isRuntimeId(value)) return value;
  throw new Error(`unknown runtime: ${String(value).slice(0, 40)} (${runtimeIds().join(" | ")})`);
}

// 恢复循环的周期。环境变量不合法（不是正数）时用默认值：周期为 0 会让循环空转。
export function recoveryIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.PLC_RUNTIME_RECOVERY_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5_000;
}

// daemon 的恢复循环。每隔 intervalMs 跑一次 tick。上一轮的探针还没跑完时，跳过这一轮。
// 有故障关闭时，调用 onRelease，让编排器马上 claim，不等它自己的计时器。
export function startHealthRecoveryLoop(
  recovery: HealthRecovery,
  options: { intervalMs: number; onRelease: () => void; log: (line: string) => void },
): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void recovery.tick()
      .then(({ closed }) => { if (closed.length) options.onRelease(); })
      .catch((error: unknown) => options.log(`[health] recovery tick error: ${error instanceof Error ? error.message : error}`))
      .finally(() => { running = false; });
  }, options.intervalMs) as unknown as NodeJS.Timeout;
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      recovery.stop();
    },
  };
}
