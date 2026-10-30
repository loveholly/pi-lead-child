// 「本设备」和「已配对设备」的纯函数：类型的叫法、上次在线的写法、列表的顺序、怎样认出 403。
import type { AdminBinding } from '@pi-lead-child/protocol';

import { timeLabel } from '@/features/tickets/timeLabels';

const KIND_LABELS: Record<string, string> = {
  companion: 'Companion',
  desktop: '桌面',
  cli: 'plc 命令行',
  'aish-slack': 'Slack（aish）',
};

// binding 的 kind 是 daemon 写的字符串。认识的换成中文叫法，不认识的原样显示。
export function bindingKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function lastSeenLabel(lastSeenAt: string | null, now: Date = new Date()): string {
  if (!lastSeenAt) return '没有在线记录';
  const label = timeLabel(lastSeenAt, now);
  return label ? `上次在线 ${label}` : '没有在线记录';
}

// 本设备排第一，然后是有效的，撤销过的排最后。同一类里按 daemon 给的顺序（编号）。
export function sortBindings(items: readonly AdminBinding[], currentId: number | null): AdminBinding[] {
  const rank = (binding: AdminBinding) => (binding.id === currentId ? 0 : binding.status === 'revoked' ? 2 : 1);
  return items
    .map((binding, index) => ({ binding, index }))
    .sort((left, right) => rank(left.binding) - rank(right.binding) || left.index - right.index)
    .map(({ binding }) => binding);
}

// 这台设备能不能撤销这个 binding：不能撤销自己，撤销过的不再撤销。
export function canRevokeBinding(binding: AdminBinding, currentId: number | null): boolean {
  return binding.id !== currentId && binding.status !== 'revoked';
}

// 网关拒绝了（没有 admin scope）。ControlPlaneClientError 带着 HTTP 状态码。
export function isForbidden(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && (reason as { status?: unknown }).status === 403;
}

export function reasonText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message || '请求没有完成';
}
