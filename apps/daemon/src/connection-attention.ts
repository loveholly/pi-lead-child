// 连接要用户处理时（hub 的 onAttention：授权失效 needs_reauth，或者授权快到期 expiring），交给 Lead 的说明和等待。
// Jarvis 模式：要告诉你的事先交给 Lead，由 Lead 决定怎样说。hub 保证一次失效只来一次。
//   · inbox 说明带着要用户做的事（protocol 的 user-actions.ts）：Lead 原样放进 UserAction 卡。
//   · 授权失效时登记一条等待（store 的 lead-waits.ts）：用户重新授权，连接的状态从 needs_reauth 变回 connected，
//     等待了结，叫醒 Lead 接着做因此停下的事（工单 #98）。
//   · 快到期时不登记（2026-10-19 审查）：这时状态还是 connected，用户重新授权以后状态不变，没有 connection.status_changed，
//     等待了结不了，24 小时后会误报「没等到」。
import { userActionRequest, type UserActionRequest } from "@pi-lead-child/protocol";
import { addInbox, registerLeadWait, type Db } from "@pi-lead-child/store";
import type { ConnectionAttention } from "@pi-lead-child/connections";

// key 不合格时返回 null。
function connectionAttentionAction(event: ConnectionAttention): UserActionRequest | null {
  try {
    return userActionRequest({
      kind: "reauthorize", target: `connection:${event.key}`, title: `重新授权 ${event.label}`, reason: event.message,
    });
  } catch {
    return null;
  }
}

export function recordConnectionAttention(db: Db, event: ConnectionAttention, log: (line: string) => void): void {
  const action = connectionAttentionAction(event);
  addInbox(db, {
    dedupScope: `connection:${event.key}`, severity: "attention", source: "structural",
    summary: `${event.message}。设置 → 连接 → ${event.label} 可以重新授权。`,
    payload: {
      kind: "connection_attention", connection: event.key, attention: event.kind, wakeLead: true, needsUser: false,
      ...(action ? { userAction: action } : {}),
    },
  });
  if (!action || event.kind !== "needs_reauth") return;
  try {
    registerLeadWait(db, {
      entityKey: action.target,
      note: `${event.label} 的授权失效了，等用户重新授权；授权完成后，接着做因此停下的事。`,
      origin: "system:connection_attention",
      userAction: action,
    });
  } catch (error) {
    log(`registering the wait for ${event.key} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
