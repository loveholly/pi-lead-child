// get_ticket 里的交付快照摘要（工单 04，spec 5.5）。和工单详情读的是同一份快照（engine 的 delivery-snapshot.ts）：
// 交付时由系统跑 git diff 存下，worktree 清掉以后还在。Lead 回答「改了哪些文件」时以它为准，不用 agent 自述的文件列表。
import type { Db, DeliverySnapshot, DeliverySnapshotFile } from "@pi-lead-child/store";
import { getItem, getLatestDeliverySnapshot, listDeliverySnapshotHeaders } from "@pi-lead-child/store";
import { recordedDeliverySnapshot } from "@pi-lead-child/engine";

// 最多列这么多个文件，其余只报个数。
const MAX_LISTED_FILES = 30;

const STATUS_LABEL: Record<NonNullable<DeliverySnapshotFile["status"]>, string> = {
  added: "新增", modified: "修改", deleted: "删除", renamed: "改名", unchanged: "没改",
};

function fileLine(file: DeliverySnapshotFile): string {
  const parts = [file.status ? STATUS_LABEL[file.status] : "agent 报的"];
  if (file.previousPath) parts.push(`原名 ${file.previousPath}`);
  if (file.binary) parts.push("二进制");
  else if (file.additions !== null || file.deletions !== null) parts.push(`+${file.additions ?? 0} −${file.deletions ?? 0}`);
  const explained = [file.label, file.note].filter(Boolean).join("；");
  return `- ${file.path}（${parts.join("，")}）${explained ? `：${explained}` : ""}`;
}

// 存这一份时刚结束的 Run（审查 L3）。返工中取消的工单，返工的执行 Run 没有交付，写明「未交付」。
function triggerText(snapshot: DeliverySnapshot): string {
  if (!snapshot.triggerRunId) return snapshot.reason === "delivered" ? "" : "（打开交付视图时发现）";
  const run = snapshot.triggerKind === "conversation" ? "对话"
    : snapshot.triggerKind === "review" ? "核查"
      : snapshot.triggerKind === "execution"
        ? (snapshot.triggerRunId === snapshot.executorRunId ? "执行" : "执行（未交付）")
        : "其他";
  return `（${run} Run #${snapshot.triggerRunId} 结束时${snapshot.reason === "delivered" ? "补存" : "发现"}）`;
}

function header(snapshot: DeliverySnapshot, deliveries: number, revisions: number): string[] {
  // 补存的那一份：分支头可能已经包含交付以后的改动。
  const reason = snapshot.reason !== "delivered"
    ? `交付以后工作区又变了，第 ${snapshot.revision} 份${triggerText(snapshot)}`
    : snapshot.backfilled ? `交付时没有存，事后补存，可能含交付以后的改动${triggerText(snapshot)}` : "交付时存的";
  const lines = [
    `第 ${snapshot.sequence} 次交付（共 ${deliveries} 次）· 执行 Run #${snapshot.executorRunId} · ${reason}`
      + `${revisions > 1 ? ` · 这次交付共 ${revisions} 份` : ""}`,
  ];
  if (snapshot.source === "git") {
    const totals = snapshot.totals;
    lines.push([
      "来源：系统跑的 git diff",
      `${snapshot.baseSha?.slice(0, 7) ?? "?"} → ${snapshot.headSha?.slice(0, 7) ?? "?"}`,
      `${snapshot.commitCount} 个提交`,
      totals ? `改了 ${totals.files} 个文件 +${totals.additions} −${totals.deletions}` : null,
      snapshot.uncommittedFiles ? `没提交的文件 ${snapshot.uncommittedFiles} 个（不会被合并）` : null,
    ].filter(Boolean).join(" · "));
  } else {
    lines.push("来源：执行 agent 自己报的文件（没有隔离分支，系统没有 diff 可跑）");
  }
  return lines;
}

/** get_ticket 的「交付快照」一段。没有交付时说一句。 */
export async function deliverySnapshotLines(db: Db, itemId: number): Promise<string> {
  const item = getItem(db, itemId);
  let snapshot: DeliverySnapshot | null | undefined;
  try {
    // 快照上线以前的交付先补存一份，和工单详情第一次打开时一样。
    snapshot = item ? await recordedDeliverySnapshot(db, item) : null;
  } catch {
    snapshot = getLatestDeliverySnapshot(db, itemId);
  }
  if (!snapshot) return "（还没有交付快照：这张工单还没交付过）";
  const headers = listDeliverySnapshotHeaders(db, itemId);
  const deliveries = new Set(headers.map((row) => row.sequence)).size;
  const revisions = headers.filter((row) => row.sequence === snapshot!.sequence).length;
  const noted = snapshot.files.filter((file) => file.label || file.note);
  const generated = snapshot.files.filter((file) => !file.label && !file.note && file.generated);
  const others = snapshot.files.filter((file) => !file.label && !file.note && !file.generated);
  const lines = header(snapshot, deliveries, revisions);
  let budget = MAX_LISTED_FILES;
  const listed = (files: DeliverySnapshotFile[]) => {
    const shown = files.slice(0, Math.max(budget, 0));
    budget -= shown.length;
    return shown.map(fileLine);
  };
  if (noted.length) lines.push("重点文件（执行 agent 写了说明）：", ...listed(noted));
  if (others.length) lines.push("其他文件：", ...listed(others));
  if (generated.length) {
    lines.push(`lock 或生成的文件 ${generated.length} 个：${generated.slice(0, 5).map((file) => file.path).join("、")}`
      + `${generated.length > 5 ? " 等" : ""}`);
  }
  const unlisted = noted.length + others.length - Math.min(noted.length + others.length, MAX_LISTED_FILES);
  if (unlisted > 0) lines.push(`（还有 ${unlisted} 个文件没有列出）`);
  if (snapshot.truncated) lines.push("（文件超过 2000 个，快照只存了前 2000 个；合计照样算全部）");
  if (!snapshot.files.length) lines.push("（这次交付没有改文件）");
  return lines.join("\n");
}
