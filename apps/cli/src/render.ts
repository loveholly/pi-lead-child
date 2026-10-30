// plc 的输出格式。只依赖线上契约的 DTO，不认识账本的行。
import type {
  ActivityDto, AdminBinding, AishCredentialStatus, AishForgetResponse, CreatePairingResponse, LeadTrustStatus,
  LeadTrustUpdate, RuntimeRecheckResponse, TicketDetail, TicketSummary,
} from "@pi-lead-child/protocol";

export function ticketRow(ticket: TicketSummary): string {
  return `#${ticket.id}\t[${ticket.stage}]\t(${ticket.priority}${ticket.project ? `, ${ticket.project}` : ""})\t${ticket.title}`;
}

export function ticketDetail(detail: TicketDetail, activities: ActivityDto[]): string {
  const lines = [
    `#${detail.ticket.id} [${detail.ticket.stage}] ${detail.ticket.title}`,
    `brief: ${detail.brief}`,
    `tokens=${detail.totalTokens}\t$${detail.totalCostUsd.toFixed(4)}`,
  ];
  if (detail.body) lines.push("", "--- body ---", detail.body);
  lines.push("", "--- activities ---");
  for (const activity of activities) {
    lines.push(`${activity.createdAt}  ${activity.actor}/${activity.kind}  ${JSON.stringify(activity.payload)}`);
  }
  return lines.join("\n");
}

export function trustStatus(status: LeadTrustStatus): string {
  const grant = status.grant;
  return grant
    ? `lead 持有 ${status.capability} 授权 #${grant.id}（${grant.granted_at} 经 ${grant.granted_via} 授予）`
    : `lead 没有 ${status.capability} 授权`;
}

export function trustUpdate(update: LeadTrustUpdate): string {
  if (update.granted) {
    return `已授权 lead 使用 ${update.capability}（授权 #${update.grant.id}，${update.grant.granted_at}）\n`
      + "随时撤销：plc trust lead --revoke";
  }
  return update.revoked
    ? `已撤销 lead 的 ${update.capability} 授权（${update.revoked} 条）`
    : `lead 本来就没有 ${update.capability} 授权`;
}

export function recheckResults(runtime: string | undefined, results: RuntimeRecheckResponse["results"]): string {
  if (!results.length) return runtime ? `${runtime} 没有未关闭的故障。` : "没有未关闭的 runtime 故障。";
  return results.map((result) => result.summary).join("\n");
}

export function bindingRow(binding: AdminBinding): string {
  return `#${binding.id}\t[${binding.status}]\t${binding.kind}\t${binding.name}\tlast_seen=${binding.lastSeenAt ?? "-"}`;
}

// plc pair new 建的配对，child 用 plc.sock 也建得出来，所以兑换出来的设备做不了用户的决定（protocol 的 originMayDecide）。
const PAIRED_DEVICE_CANNOT_DECIDE = "这样配对的设备不能批审批。要在手机上批，在网页的「设置 → 设备 → 添加手机」扫码配对。";

export function pairingCode(name: string, pairing: CreatePairingResponse): string {
  if (pairing.uri) {
    return [`配对 URI: ${pairing.uri}`, `手动配对码: ${pairing.code}`, PAIRED_DEVICE_CANNOT_DECIDE].join("\n");
  }
  return [
    `配对码: ${pairing.code}（15 分钟内有效，至 ${pairing.expiresAt}）`,
    `${name} 用 POST /v1/paired/redeem {"pairing_code":"${pairing.code}"} 换取 access_token`,
    PAIRED_DEVICE_CANNOT_DECIDE,
  ].join("\n");
}

const ENV_TOKEN_TEXT: Record<AishCredentialStatus["envToken"], string> = {
  unset: "未设置",
  set: "已设置",
  same_as_stored: "已设置，与已保存的 token 相同",
  different_from_stored: "已设置，与已保存的 token 不同",
  marked_failed: "已设置。这个 token 已被标记为鉴权失败",
};

export function aishStatus(status: AishCredentialStatus): string {
  const lines = [`已保存的凭证：${status.stored ? "有" : "无"}`];
  if (status.url) lines.push(`URL：${status.url}`);
  if (status.stored) {
    lines.push(status.failure
      ? `鉴权失败标记：有。${status.failure.reason}（${status.failure.at}）。daemon 启动时跳过这个 token。`
      : "鉴权失败标记：无");
  }
  lines.push(`PLC_AISH_TOKEN（daemon 进程的环境，含 config.json 的 env 段）：${ENV_TOKEN_TEXT[status.envToken]}`);
  lines.push("更新或删除凭证：plc aish --help");
  return lines.join("\n");
}

export function aishForgotten(result: AishForgetResponse): string {
  const lines = [result.removed ? "已删除保存的 aish 凭证和鉴权失败标记。" : "没有保存的 aish 凭证。"];
  if (result.envTokenSet) {
    lines.push("注意：daemon 的环境或 config.json 的 env 段里还有 PLC_AISH_TOKEN。daemon 下次启动时会重新保存它。");
  }
  if (result.removed) {
    lines.push('运行中的 daemon 在重启前保留当前连接。要立即断开，运行 plc daemon restart --reason "forget aish token"。');
  }
  return lines.join("\n");
}
