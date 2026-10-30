// 执行器的开关（设置页「执行器」，2026-10-19）。
//
// 用户说「不用 codex」以后，这句话只记在 Lead 的笔记里（note #33）。系统不读笔记：suggest_route 照样推荐 codex，
// 自动核查照样派给 codex。所以停用要是一个系统认得的状态：
//   - 名单存在 config.json 的 runtimes.disabled，设置页改它。
//   - 内核读环境变量 PLC_DISABLED_RUNTIMES（packages/runtime 的 registry.ts）。这里在 daemon 启动时、设置改了以后写它，
//     所以改了立即生效，不用重启；子进程也继承它。
//   - config.json 里没有 runtimes.disabled 时不碰环境变量：手设的环境变量（测试、临时排查）照样生效。
// daemon 关闭时把环境变量恢复成启动前的样子：测试在同一个进程里起好几个 daemon，不能互相影响。
//
// Lead 也能拨这个开关（2026-10-22 用户定的规则：UI 上每个调用后端的操作是一个操作、两个入口）。设置页（网关的
// /v1/runtimes/settings）和 Lead 的 perform_action 都经过 engine 的操作层（ui-actions/ 的 runtime 的 disable、enable），
// 操作层再调这里的 update。谁能拨由操作层判断：
//   - 用户（设置页）：随时都能拨。
//   - Lead 停用：随时都可以，要写原因（lead_allowed）。
//   - Lead 启用：它自己停用的可以（lead_allowed）。用户停用的（或者来历不明的）只属于用户（user_only）：操作层核对用户本人
//     当前这一轮（store 的 activePairedUserTurn），核对过才带上 onBehalfOf。
// refusal 用同一个权限函数（engine 的 runtimeEnablePermission）再查一次：不经过操作层、又没有 onBehalfOf 的 Lead 启用不了；
// 带着 onBehalfOf 的，这里再核对一次那一轮（daemon 注入的 userTurn，store 的 activePairedUserTurn），不只认这个字段。
// 谁停用的、为什么记在 config.json 的 runtimes.disabledBy（core 的 RuntimeDisabledBy）。线上的 RuntimeSettingsDto 不加字段：
// 它是严格的契约，加字段旧客户端会失败。界面显示「Lead 停用：原因」留给后续的界面工单。
import {
  DISABLED_RUNTIMES_ENV, defaultReviewRuntime, disabledRuntimes, isRuntimeId, runtimeAdapters, runtimeDisplayName,
} from "@pi-lead-child/runtime";
import {
  loadPlcConfig, writePlcConfig, type RuntimeDisabledBy, type RuntimeId, type RuntimeSwitchBy,
} from "@pi-lead-child/core";
import { probeChildRuntimeCatalog, runtimeEnablePermission } from "@pi-lead-child/engine";
import {
  KERNEL_RUNTIME_IDS, type KernelRuntimeId, type RuntimeSettingsDto, type RuntimeSettingsRequest,
} from "@pi-lead-child/protocol";
import type { RuntimeSettingsService } from "@pi-lead-child/gateway";

export interface RuntimeSettingsOptions {
  dataDir: string;
  env?: Record<string, string | undefined>;
  // 名单变了以后调：网关发 snapshot.required（resource 是 runtime-settings），客户端重新 GET。
  publish?: (resource: "runtime-settings") => void;
  // 名单变了以后调：叫醒编排器马上 claim（2026-10-20）。停用一个 runtime 以后，点名它的核查请求马上换核查员，
  // 不等下一个 tick；重新启用以后，挂起的请求马上放行。
  onChange?: () => void;
  log?: (line: string) => void;
  // 这一轮还是用户本人当前已认证的配对轮次吗：不是时抛错，错误说明原因（daemon 用 store 的 activePairedUserTurn）。
  // Lead 说是代用户启用用户停用的执行器时要它。没有注入时一律不认（审查 2026-10-22 第 3 条）。
  userTurn?: (turnId: string) => void;
}

export const RUNTIME_SETTINGS_RESOURCE = "runtime-settings";

// 拨不了：refusal 给的原因。
export class RuntimeSwitchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeSwitchRefused";
  }
}

export class RuntimeSettings implements RuntimeSettingsService {
  private readonly env: Record<string, string | undefined>;
  private readonly before: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: RuntimeSettingsOptions) {
    this.env = options.env ?? process.env;
    this.before = this.env[DISABLED_RUNTIMES_ENV];
    const configured = this.configured();
    if (configured) this.apply(configured);
  }

  // config.json 的 runtimes.disabled。没有这一项、或者读不了 config.json 时返回 null。
  private configured(): RuntimeId[] | null {
    let list: unknown;
    try {
      list = loadPlcConfig(this.options.dataDir).runtimes?.disabled;
    } catch (error) {
      this.options.log?.(`runtime settings: config.json not read: ${(error as Error).message}`);
      return null;
    }
    if (!Array.isArray(list)) return null;
    return list.filter((value, index, all): value is RuntimeId => isRuntimeId(value) && all.indexOf(value) === index);
  }

  private apply(disabled: readonly RuntimeId[]): void {
    if (disabled.length) this.env[DISABLED_RUNTIMES_ENV] = disabled.join(",");
    else delete this.env[DISABLED_RUNTIMES_ENV];
  }

  get(): RuntimeSettingsDto {
    const disabled = new Set(disabledRuntimes(this.env));
    const installed = new Map(probeChildRuntimeCatalog({ env: this.env }).entries.map((entry) => [entry.id, entry.available]));
    const runtimes = runtimeAdapters()
      .filter((adapter): adapter is typeof adapter & { id: KernelRuntimeId } =>
        (KERNEL_RUNTIME_IDS as readonly string[]).includes(adapter.id))
      .map((adapter) => ({
        id: adapter.id,
        label: adapter.displayName,
        enabled: !disabled.has(adapter.id),
        installed: installed.get(adapter.id) ?? false,
        canReview: adapter.capabilities.executableReadOnlyReview,
      }));
    // 下一次自动核查用哪个 runtime（2026-10-20 起任何 runtime 都能当核查员，能跑命令的优先）。这里没有数据库，
    // 不看健康账本：有故障的核查员在派发时会被换掉。canReview=false 只在所有 runtime 都停用时出现。
    const reviewer = defaultReviewRuntime(this.env) as KernelRuntimeId;
    return {
      runtimes,
      reviewer: { id: reviewer, canReview: !disabled.has(reviewer) },
    };
  }

  // 这个执行器是谁停用的。没停用、或者 config.json 里没有记录（手设的环境变量、旧的配置）时为 null，按用户停用的处理。
  // 读不出 config.json 时也是 null：设置页「Lead 能不能重新启用」按用户停用的算，Lead 不能启用。
  disabledBy(runtime: RuntimeId): RuntimeDisabledBy | null {
    if (!disabledRuntimes(this.env).includes(runtime)) return null;
    try {
      return loadPlcConfig(this.options.dataDir).runtimes?.disabledBy?.[runtime] ?? null;
    } catch {
      return null;
    }
  }

  // 给工单操作的宿主（D11，工单 11）：停用的执行器是谁停用的。没有记录时和 disabledBy 一样是 null（按用户停用的算）。
  // 读不出 config.json 时按 Lead 停用的算（复核 2026-10-23 第 1 条）：用户停用的执行器才算「核查做不成」，读不出时不知道，
  // 不能因此放行 Lead 凭托管代验收。两个方向都偏向不放行：这里不让 Lead 代验收，disabledBy 不让 Lead 重新启用。
  disabledByForDelegation(runtime: RuntimeId): RuntimeDisabledBy | null {
    if (!disabledRuntimes(this.env).includes(runtime)) return null;
    try {
      return loadPlcConfig(this.options.dataDir).runtimes?.disabledBy?.[runtime] ?? null;
    } catch {
      return { by: "lead", reason: "读不出 config.json，不知道是谁停用的", at: new Date().toISOString() };
    }
  }

  // 现在能不能这样拨；能时返回 null。update 先查它。谁能拨由操作层判断：Lead 在哪一轮都能启用用户停用的执行器
  // （用户 2026-10-27），要写原因。说是代用户启用的，再核对那一轮还是用户本人当前的一轮。
  refusal(request: RuntimeSettingsRequest, by: RuntimeSwitchBy): string | null {
    if (by.actor === "user") return null;
    const name = runtimeDisplayName(request.runtime);
    if (!by.reason.trim()) return `Lead ${request.enabled ? "启用" : "停用"} ${name} 要写原因。`;
    if (!request.enabled || !by.onBehalfOf) return null;
    const disabled = disabledRuntimes(this.env).includes(request.runtime);
    if (runtimeEnablePermission(disabled, this.disabledBy(request.runtime)) === "lead_allowed") return null;
    try {
      if (!this.options.userTurn) throw new Error("没有办法核对用户这一轮");
      this.options.userTurn(by.onBehalfOf.sourceTurnId);
      return null;
    } catch (error) {
      return `Lead 说是代用户启用 ${name}，但那一轮不是用户本人当前的一轮（${error instanceof Error ? error.message : String(error)}）。`;
    }
  }

  // 一次拨一个开关。设置页和 Lead 都调它（by 缺省是用户）。先查 refusal，再写 config.json（停用名单和谁停用的）和环境变量，
  // 然后通知客户端。同一时间只有一次写入。
  update(request: RuntimeSettingsRequest, by: RuntimeSwitchBy = { actor: "user" }): Promise<RuntimeSettingsDto> {
    const next = this.queue.then(() => {
      const refused = this.refusal(request, by);
      if (refused) throw new RuntimeSwitchRefused(refused);
      const file = loadPlcConfig(this.options.dataDir);
      const current = new Set(disabledRuntimes(this.env));
      const { disabledBy: recorded, ...runtimes } = file.runtimes ?? {};
      const who: Record<string, RuntimeDisabledBy> = { ...recorded };
      if (request.enabled) {
        current.delete(request.runtime);
        delete who[request.runtime];
      } else {
        // 用户的记录优先：用户停用的（或者来历不明的）又被 Lead 停用一次，仍算用户停用的，Lead 不能借此去启用它。
        const wasDisabled = current.has(request.runtime);
        if (by.actor === "user" || !wasDisabled || who[request.runtime]?.by === "lead") {
          who[request.runtime] = {
            by: by.actor, reason: by.actor === "lead" ? by.reason.trim() : null, at: new Date().toISOString(),
          };
        }
        current.add(request.runtime);
      }
      const disabled = runtimeAdapters().map((adapter) => adapter.id).filter((id) => current.has(id));
      for (const runtime of Object.keys(who)) if (!current.has(runtime as RuntimeId)) delete who[runtime];
      writePlcConfig({
        ...file, runtimes: { ...runtimes, disabled, ...(Object.keys(who).length ? { disabledBy: who } : {}) },
      }, this.options.dataDir);
      this.apply(disabled);
      this.options.log?.(`runtime settings: ${request.runtime} ${request.enabled ? "enabled" : "disabled"} by ${by.actor}`
        + `${by.actor === "lead" && by.onBehalfOf ? ` for user (turn ${by.onBehalfOf.sourceTurnId})` : ""}`
        + `${by.actor === "lead" ? ` (${by.reason.trim()})` : ""}; disabled=[${disabled.join(",")}]`);
      this.options.publish?.(RUNTIME_SETTINGS_RESOURCE);
      this.options.onChange?.();
      return this.get();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    if (this.before === undefined) delete this.env[DISABLED_RUNTIMES_ENV];
    else this.env[DISABLED_RUNTIMES_ENV] = this.before;
  }
}
