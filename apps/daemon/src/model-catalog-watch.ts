// 模型目录自动刷新（2026-10-15 用户决定）。目录来自各 CLI（engine 的 model-catalog.ts），这里决定什么时候再问一次：
//   - daemon 启动时：Lead 的工具描述在会话建立时生成，所以先等这一次（server.ts 最多等 5 秒）。
//   - 定时：PLC_MODEL_CATALOG_REFRESH_MS，默认 15 分钟。问一次只读 CLI 的目录和帮助，不调用模型，不花 token。
//   - Run 的失败作用域是 runtime 或 account 时马上再问一次：CLI 的配置或账号可能变了（例如账号不再支持某个模型）。
// 目录变了就给 Lead 一条说明（attention，不叫醒 Lead，下一轮读到）：它的工具描述里的目录摘要是会话开始时的。
// 什么时候写说明、哪些失败作用域马上刷新、说明叫不叫醒 Lead，来自常设指令 model_catalog.announce（工单 05）。
//
// 去抖（工单 14）：2026-10-16 目录一天抖动 6 次，一次刷新变了，下一次又变回去，每次都写一条说明。现在连续
// stableRefreshes 次（种子是 2 次）刷新的结果相同，才算一次变化，才写说明。说明比的是 Lead 上一次知道的目录
// （启动那一次刷新的结果，工具描述按它生成；或者上一次说明里的目录）和现在的目录：抖一次又变回去的，什么都不写。
// 去抖的状态只在内存里：daemon 重启以后，启动那一次刷新重新定下 Lead 知道的目录。
import type { Db } from "@pi-lead-child/store";
import { addInbox, modelCatalogAnnounceParams } from "@pi-lead-child/store";
import {
  currentModelCatalog, describeModelCatalogChanges, refreshModelCatalog, type ModelCatalog,
} from "@pi-lead-child/engine";
import type { RuntimeEvent } from "@pi-lead-child/runtime";

export const DEFAULT_MODEL_CATALOG_REFRESH_MS = 15 * 60_000;

export interface ModelCatalogWatch {
  refresh(reason: string, options?: { announce?: boolean }): Promise<void>;
  onRunEvent(event: RuntimeEvent): Promise<void>;
  stop(): void;
}

/** 两份目录一样：两个方向比都没有变化（describeModelCatalogChanges 只看第二份里有的 runtime）。 */
export function sameModelCatalog(a: ModelCatalog, b: ModelCatalog): boolean {
  return describeModelCatalogChanges(a, b).length === 0 && describeModelCatalogChanges(b, a).length === 0;
}

export function startModelCatalogWatch(opts: {
  db: Db; cwd: string; log: (line: string) => void; intervalMs?: number;
}): ModelCatalogWatch {
  // Lead 上一次知道的目录。第一次刷新之前是库里存着的那一份。
  let announced: ModelCatalog | null = null;
  // 最近一次刷新的结果，和它连续出现了几次（含这一次）。
  let latest: { catalog: ModelCatalog; streak: number } | null = null;
  const refresh = async (reason: string, options: { announce?: boolean } = {}): Promise<void> => {
    announced ??= currentModelCatalog(opts.db);
    try {
      const after = await refreshModelCatalog({ db: opts.db, cwd: opts.cwd });
      // 同时进行的刷新共用 engine 的同一次刷新，拿到的是同一份目录：只算一次，后到的调用方不再处理。
      if (latest?.catalog === after) return;
      opts.log(`model catalog (${reason}): ${after.runtimes
        .map((entry) => `${entry.runtime}=${entry.state === "known" ? `${entry.models.length} models` : `unknown (${entry.error})`}`)
        .join(", ")}`);
      latest = latest && sameModelCatalog(latest.catalog, after)
        ? { catalog: after, streak: latest.streak + 1 }
        : { catalog: after, streak: 1 };
      // daemon 启动的那一次：Lead 的工具描述按这一份生成，它就是 Lead 知道的目录。
      if (options.announce === false) {
        announced = after;
        return;
      }
      const known = announced ?? after;
      const changes = describeModelCatalogChanges(known, after);
      // 和 Lead 知道的一样（没有变化，或者抖了一次又变回去了）。
      if (!changes.length) return;
      const rule = modelCatalogAnnounceParams(opts.db);
      if (!known.refreshedAt && !rule.announceFirstRefresh) {
        announced = after;
        return;
      }
      if (latest.streak < rule.stableRefreshes) {
        opts.log(`model catalog changed (${changes.join("; ")}): waiting for ${rule.stableRefreshes - latest.streak} more refresh(es) with the same result`);
        return;
      }
      announced = after;
      addInbox(opts.db, {
        dedupScope: `model-catalog:${after.refreshedAt}`,
        severity: "attention",
        source: "structural",
        summary: `模型目录有变化（${reason}）：${changes.join("；")}。`
          + "工具描述里的目录摘要是会话开始时的，选模型前用 get_model_catalog 看现在的目录。",
        payload: {
          kind: "model_catalog_changed", reason, changes, refreshedAt: after.refreshedAt,
          ...(rule.wakeLead ? { wakeLead: true } : {}),
          standingOrder: rule.order,
        },
        lossless: true,
      });
    } catch (error) {
      opts.log(`model catalog refresh failed (${reason}): ${String(error)}`);
    }
  };
  const intervalMs = opts.intervalMs ?? DEFAULT_MODEL_CATALOG_REFRESH_MS;
  const timer = intervalMs > 0 ? setInterval(() => { void refresh("定时刷新"); }, intervalMs) : null;
  timer?.unref();
  return {
    refresh,
    async onRunEvent(event) {
      if (event.type !== "run.failed" || !event.failure) return;
      if (!modelCatalogAnnounceParams(opts.db).refreshOnFailureScopes.includes(event.failure.scope)) return;
      await refresh(`Run #${event.runId} 失败：${event.failure.code}`);
    },
    stop() { if (timer) clearInterval(timer); },
  };
}
