// 首次启动引导（2026-10-30，.scratch/onboarding/spec.md）的 daemon 部分。
// - 算 7 项关键设置配没配好，存进 kv（setup.status）。网关只有 db，读不到这些服务，所以由 daemon 算。
// - 准备清单卡：daemon 启动时大脑不能用、后来能用了，建一次。启动时就能用、又没有记录的（功能上线前的老用户）记成 skipped，
//   不补发（AGENTS.md Core Invariants：上线前的数据不造成刷屏）。
// - 建议卡：用户自己的一轮成功结束时，挑一项没配好、不在冷却里的，发一张（store 的 pickSetupHint，spec R2–R4）。
import type { SetupItem, SetupItemKey, SetupStatus } from "@pi-lead-child/protocol";
import {
  getLeadProfile, loadSetupChecklist, loadSetupHints, pickSetupHint, recordSetupChecklist, recordSetupHint, saveSetupStatus,
  type Db, type SetupHintRecord,
} from "@pi-lead-child/store";

// 每一项现在的样子。读不到（服务没起来）时给 null：这一项按没配好算。
export interface SetupSources {
  // 大脑：正在用的模型有没有认证，和它的名字。
  brain(): Promise<{ ready: boolean; model: string | null }>;
  // 记忆：embedding 选了没有（设置 → 记忆）。
  memory(): { mode: string; remoteBaseUrl: string | null } | null;
  // Slack：两个 token 在不在，「自动代你处理」开没开。
  slack(): { configured: boolean; autoReply: boolean; account: string | null } | null;
  // 连接：预设连接的状态（key 是 atlassian、github、notion）。
  connections(): Array<{ key: string; state: string; account: string | null }> | null;
}

const CONNECTION_KEYS: Partial<Record<SetupItemKey, string>> = { github: "github", jira: "atlassian", notion: "notion" };
// 连上了（degraded 是暂时连不上，也算配好了）。
const CONNECTED_STATES = new Set(["connected", "degraded"]);

/** 7 项现在的样子。 */
export async function computeSetupItems(db: Db, sources: SetupSources): Promise<SetupItem[]> {
  const brain = await sources.brain().catch(() => ({ ready: false, model: null }));
  const memory = sources.memory();
  const slack = sources.slack();
  const connections = sources.connections() ?? [];
  const profile = getLeadProfile(db);
  const items: SetupItem[] = [
    { key: "brain", ready: brain.ready, detail: brain.ready ? brain.model : null },
    {
      key: "memory",
      ready: memory !== null && (memory.mode !== "unset" || Boolean(memory.remoteBaseUrl)),
      detail: memory === null ? null : memory.mode === "local" ? "本机模型" : memory.mode === "remote" || memory.remoteBaseUrl ? "远端服务" : null,
    },
    {
      key: "slack",
      ready: slack !== null && slack.configured && slack.autoReply,
      detail: slack?.configured ? (slack.autoReply ? `已连上${slack.account ? ` · ${slack.account}` : ""}` : "已连上，「自动代你处理」关着") : null,
    },
    { key: "profile", ready: profile.updatedAt !== null, detail: profile.updatedAt !== null ? `叫 ${profile.name}` : null },
  ];
  for (const key of ["github", "jira", "notion"] as const) {
    const connection = connections.find((candidate) => candidate.key === CONNECTION_KEYS[key]);
    const ready = connection !== undefined && CONNECTED_STATES.has(connection.state);
    items.push({ key, ready, detail: ready ? (connection!.account ? `已连接 · ${connection!.account}` : "已连接") : null });
  }
  // detail 有长度上限（SetupItemSchema）。
  return items.map((item) => ({ ...item, detail: item.detail ? item.detail.slice(0, 120) : null }));
}

export interface SetupTracker {
  // 重算一次，存进 kv。大脑第一次变成能用时建准备清单卡。返回现在的状态。
  refresh(now?: Date): Promise<SetupStatus>;
  // 重算，但离上一次不到 minIntervalMs 时跳过（daemon 的轮询用）。
  refreshThrottled(now?: Date): Promise<void>;
  // 一轮结束时调。只有用户自己的、成功的一轮才可能发建议卡。发了时返回那张卡。
  afterTurn(turn: { userTurn: boolean; succeeded: boolean }, now?: Date): Promise<SetupHintRecord | null>;
}

export function createSetupTracker(options: {
  db: Db;
  sources: SetupSources;
  log?: (line: string) => void;
  // 有项变了（只重算、没变化时不调）。
  onChange?: (status: SetupStatus) => void;
  minIntervalMs?: number;
}): SetupTracker {
  const { db, sources } = options;
  const minIntervalMs = options.minIntervalMs ?? 5_000;
  // daemon 这次启动以来大脑是不是不能用过：是的话，它变成能用的那一刻就是「首次上线」。
  let brainWasUnready = false;
  let primed = false;
  let lastRefresh = 0;
  let running: Promise<SetupStatus> | null = null;

  async function refreshNow(now: Date): Promise<SetupStatus> {
    const items = await computeSetupItems(db, sources);
    const { status, changed } = saveSetupStatus(db, items, now);
    if (changed) options.onChange?.(status);
    const brainReady = items.find((item) => item.key === "brain")?.ready === true;
    if (!brainReady) brainWasUnready = true;
    if (brainReady && loadSetupChecklist(db) === null) {
      // 第一次算时大脑就能用：功能上线前的老用户（或者环境变量里早就有 key），不补发清单。
      const record = recordSetupChecklist(db, primed && brainWasUnready ? "shown" : "skipped", now);
      if (record.state === "shown") options.log?.("[setup] Lead 第一次上线：建了准备清单卡");
    }
    primed = true;
    lastRefresh = now.getTime();
    return status;
  }

  function refresh(now = new Date()): Promise<SetupStatus> {
    // 同一时间只算一次：轮询和一轮结束可能撞在一起。
    running ??= refreshNow(now).finally(() => { running = null; });
    return running;
  }

  return {
    refresh,
    async refreshThrottled(now = new Date()) {
      if (now.getTime() - lastRefresh < minIntervalMs) return;
      try {
        await refresh(now);
      } catch (error) {
        options.log?.(`[setup] 重算设置状态失败：${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async afterTurn(turn, now = new Date()) {
      if (!turn.userTurn || !turn.succeeded) return null;
      const status = await refresh(now);
      const item = pickSetupHint(status, loadSetupHints(db), now);
      if (!item) return null;
      const hint = recordSetupHint(db, item, now);
      options.log?.(`[setup] 一轮结束：建议配「${item}」（卡 #${hint.id}）`);
      return hint;
    },
  };
}
