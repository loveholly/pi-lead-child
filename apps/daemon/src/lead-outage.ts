// 一次停摆，一张卡片（2026-10-16）。这里是 daemon 记停摆的两条规则，server.ts 的停摆汇总用它们：
//   · 新的一次停摆不能从上一次停摆恢复之前开始。不然两张卡片的时间段重叠（发布评审：19:12–21:09 和 19:19–08:30）；
//   · daemon 重启以后，从会话里那条停摆通知读回还没结束的那一次，接着更新同一张卡片。
//     停摆只记在内存里时，重启后那张卡片永远停在「起」，新的停摆另开一张。
// 停摆通知的 id 是 turn_outage_<开始的毫秒>（writeOutageNotice），正文是 leadOutageHeadline 加每件事一行。
import type { Db } from "@pi-lead-child/store";
import { isLeadOutageHeadline, leadOutageCause, type LeadModelFailureKind } from "@pi-lead-child/protocol";

export type OutageKind = LeadModelFailureKind | "silent";
export type OutageItem = { line: string; kind: "inbox" | "pushed"; hasRecord: boolean };
export interface OpenOutage {
  since: number;
  kind: OutageKind;
  items: OutageItem[];
  turnId: string | null;
}

const OUTAGE_KINDS: readonly OutageKind[] = ["network", "unavailable", "busy", "auth", "config", "unknown", "silent"];
const TURN_PREFIX = "turn_outage_";
// 每件事一行：「· <事> —— <状态>」。状态是 daemon 自己写的那几种（outageText）。
const ITEM_LINE = /^·\s*(.+?)\s+——\s+(.+)$/u;

/** 新的一次停摆从什么时候算：Lead 不能工作的起点，但不早于上一次停摆恢复的时间。 */
export function outageStart(incapacitySince: number, lastEndedAt: number | null): number {
  return lastEndedAt === null ? incapacitySince : Math.max(incapacitySince, lastEndedAt);
}

/**
 * 一拍轮询对停摆卡片做什么：
 *   · Lead 不能工作（incapacity 有值）：把积压的事汇总给用户（summarize）；
 *   · Lead 能工作（null）、模型调用也正常：收尾还开着的停摆（close）。读回的那一次要等 daemon 起来满一个宽限期；
 *   · 这一拍没判断出 Lead 能不能工作（undefined，判断出错）：不动卡片（none）。不能当成「能工作」把停摆收尾
 *     （发布评审 reliability-backlog 复核）。
 * leadOnline 只在要收尾时才问。
 */
export function outageStep<T>(input: {
  incapacity: T | null | undefined;
  outage: { restored?: true } | null;
  leadOnline: () => boolean;
  now: number;
  daemonStartedAt: number;
  graceMs: number;
}): "summarize" | "close" | "none" {
  if (input.incapacity === undefined) return "none";
  if (input.incapacity !== null) return "summarize";
  if (!input.outage || !input.leadOnline()) return "none";
  if (input.outage.restored && input.now - input.daemonStartedAt < input.graceMs) return "none";
  return "close";
}

/**
 * daemon 启动时读回停摆记录：还没结束的那一次（最新的一张没有结束时间的卡片），和上一次结束的时间
 * （已经结束的卡片最后一次更新的时间）。认不出的卡片不动。
 * 没结束的卡片比某张已经结束的卡片还早时，它不是「还没结束的那一次」：之后又有一次停摆开始并结束了。
 * 不接着更新它，免得新的停摆写进一张旧卡片（发布评审 reliability-backlog）。
 */
export function restoreOutages(db: Db): { open: OpenOutage | null; lastEndedAt: number | null } {
  const rows = db.prepare(
    `SELECT id, assistant_text, updated_at FROM channel_turns
     WHERE origin_kind = 'system:fallback-notice' AND id LIKE '${TURN_PREFIX}%'
     ORDER BY created_at, rowid`,
  ).all() as Array<{ id: string; assistant_text: string; updated_at: string }>;
  let open: OpenOutage | null = null;
  let lastEndedAt: number | null = null;
  let latestClosedSince: number | null = null;
  for (const row of rows) {
    const since = Number(row.id.slice(TURN_PREFIX.length));
    const [headline = "", ...lines] = row.assistant_text.split("\n");
    // 标题开头是 Lead 的名字，写下以后可能又改过：不认具体的名字（protocol 的 isLeadOutageHeadline）。
    if (!Number.isFinite(since) || !isLeadOutageHeadline(headline)) continue;
    // 还没结束的标题写着「<开始> 起（原因）」；结束了的写着结束时间。
    const cause = /起（(.+?)）/u.exec(headline)?.[1];
    if (cause === undefined) {
      const ended = Date.parse(row.updated_at);
      if (Number.isFinite(ended)) lastEndedAt = Math.max(lastEndedAt ?? ended, ended);
      latestClosedSince = Math.max(latestClosedSince ?? since, since);
      continue;
    }
    // 2026-10-22 以前「没有响应」写成「Lead 没有响应」。
    const kind = OUTAGE_KINDS.find((candidate) => leadOutageCause(candidate) === cause)
      ?? (cause.endsWith("没有响应") ? "silent" : "unknown");
    const items = lines.flatMap((line): OutageItem[] => {
      const parsed = ITEM_LINE.exec(line.trim());
      if (!parsed) return [];
      return [{ line: parsed[1]!, kind: parsed[2] === "已推送给你" ? "pushed" : "inbox", hasRecord: false }];
    });
    open = { since, kind, items, turnId: row.id };
  }
  if (open && latestClosedSince !== null && latestClosedSince > open.since) open = null;
  return { open, lastEndedAt };
}
