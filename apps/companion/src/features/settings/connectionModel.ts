// 设置 → 连接的纯函数：分组、状态的写法、时间的写法、角色、错误原因。界面组件只调这里，不自己拼文字。
import type {
  ConnectionDto, ConnectionProblem, ConnectionProvider, ConnectionRole,
} from '@pi-lead-child/protocol';

import { clockTimeLabel, timeLabel } from '@/features/tickets/timeLabels';

// leadName 是 Lead 的名字（useLeadName）。
export function connectionsDescription(leadName: string): string {
  return `${leadName} 用这些账号替你查资料、做事。授权只保存在这台 Mac 上，到期前自动续期。`;
}

export type ConnectionGroupId = 'connected' | 'available' | 'setup';

export type ConnectionGroup = { id: ConnectionGroupId; label: string; items: ConnectionDto[] };

const GROUP_LABELS: Record<ConnectionGroupId, string> = {
  connected: '已连接',
  available: '可以连接',
  setup: '需要额外设置',
};

export function connectionGroupOf(connection: ConnectionDto): ConnectionGroupId {
  if (connection.state === 'connected' || connection.state === 'degraded' || connection.state === 'needs_reauth') return 'connected';
  if (connection.state === 'not_connected') return 'available';
  return 'setup';
}

// 三组：已连接、可以连接、需要额外设置。空的组不返回。「即将支持」排在需要设置的后面。
// pinned：正在走连接流程的那一个留在原来的组里。不然它连上的那一刻换到「已连接」组，
// 行下面的连接流程会重新开始，看不到「已连接」那一步。
export function groupConnections(
  items: readonly ConnectionDto[],
  pinned: { key: string; group: ConnectionGroupId } | null = null,
): ConnectionGroup[] {
  const groupOf = (item: ConnectionDto) => (pinned && item.key === pinned.key ? pinned.group : connectionGroupOf(item));
  const groups: ConnectionGroup[] = (['connected', 'available', 'setup'] as const).map((id) => ({
    id, label: GROUP_LABELS[id], items: items.filter((item) => groupOf(item) === id),
  }));
  const setup = groups[2]!;
  setup.items = [...setup.items.filter((item) => item.state !== 'unavailable'), ...setup.items.filter((item) => item.state === 'unavailable')];
  return groups.filter((group) => group.items.length > 0);
}

// 要你处理：授权失效了，或者授权快到期。和 daemon 的 attention 同一条规则。
export function connectionNeedsUser(connection: ConnectionDto): boolean {
  return connection.state === 'needs_reauth' || connection.problem?.kind === 'expiring';
}

export function attentionConnections(items: readonly ConnectionDto[]): ConnectionDto[] {
  return items.filter(connectionNeedsUser);
}

export function attentionMessage(connection: ConnectionDto): string {
  return connection.problem?.message ?? `${connection.label} 需要重新授权`;
}

export type ConnectionStatus = { label: string; tone: 'success' | 'warning' | 'danger' | 'muted' };

// 行右边的状态。可以连接的服务没有状态，右边是「连接」按钮。
export function connectionStatus(connection: ConnectionDto): ConnectionStatus | null {
  switch (connection.state) {
    case 'connected': return { label: '已连接', tone: 'success' };
    case 'degraded': return { label: '暂时连不上', tone: 'warning' };
    case 'needs_reauth': return { label: '需要重新授权', tone: 'danger' };
    case 'unavailable': return { label: '即将支持', tone: 'muted' };
    default: return null;
  }
}

// 行的第二行字和它的颜色。
export function connectionSecondLine(connection: ConnectionDto, now: Date = new Date()): { text: string; tone: 'secondary' | 'warning-dark' | 'danger-dark' } {
  if (connection.state === 'needs_reauth') return { text: attentionMessage(connection), tone: 'danger-dark' };
  if (connection.state === 'degraded') return { text: connection.problem?.message ?? '暂时连不上，daemon 会自动重试', tone: 'warning-dark' };
  if (connection.problem?.kind === 'expiring') return { text: connection.problem.message, tone: 'warning-dark' };
  if (connection.state === 'connected') {
    const used = lastUsedLabel(connection.lastUsedAt, now);
    return { text: connection.account ? `${connection.account} · ${used}` : used, tone: 'secondary' };
  }
  if (connection.state === 'not_connected') return { text: connection.capability, tone: 'secondary' };
  return { text: connection.setupHint ?? connection.capability, tone: 'secondary' };
}

// 上次用的时间：一小时以内写几分钟前，更早的写时间点（timeLabels 的写法）。
export function lastUsedLabel(lastUsedAt: string | null, now: Date = new Date()): string {
  if (!lastUsedAt) return '还没用过';
  const at = Date.parse(lastUsedAt);
  if (Number.isNaN(at)) return '还没用过';
  const minutes = Math.floor((now.getTime() - at) / 60_000);
  if (minutes < 1) return '刚刚用过';
  if (minutes < 60) return `${minutes} 分钟前用过`;
  return `${timeLabel(lastUsedAt, now)} 用过`;
}

// 授权一节的「续期」。
export function renewalLabel(connection: ConnectionDto, now: Date = new Date()): string | null {
  switch (connection.tokenSource) {
    case 'oauth': {
      const last = connection.lastRefreshAt ?? connection.connectedAt;
      return last ? `自动 · 上次 ${timeLabel(last, now)}` : '自动';
    }
    case 'gh_cli': return '用这台 Mac 上 gh 的登录';
    case 'device': return '设备码登录，令牌不过期';
    case 'pat': return '个人令牌';
    default: return null;
  }
}

// 访问令牌还有多久到期。两小时以内写分钟，更久的写小时。
export function accessExpiryLabel(accessExpiresAt: string, now: Date = new Date()): string {
  const minutes = Math.ceil((Date.parse(accessExpiresAt) - now.getTime()) / 60_000);
  if (Number.isNaN(minutes)) return '';
  if (minutes <= 0) return '已到期，下次使用前会续期';
  if (minutes < 120) return `${minutes} 分钟后到期，会提前续期`;
  return `${Math.floor(minutes / 60)} 小时后到期，会提前续期`;
}

// 暂时连不上时的一句话。
export function retryLabel(problem: ConnectionProblem | null): string {
  const at = problem?.nextAttemptAt ? clockTimeLabel(problem.nextAttemptAt) : '';
  return at ? `暂时连不上，daemon 会在 ${at} 自动重试` : '暂时连不上，daemon 会自动重试';
}

export function toolCountLabel(tools: NonNullable<ConnectionDto['tools']>): string {
  return `${tools.total} 个工具 · 只读 ${tools.readOnly} · 会写入 ${tools.write}`;
}

const CONNECTION_ROLE_ORDER: readonly ConnectionRole[] = ['lead', 'executor', 'reviewer'];

// 谁可以用这个连接：每个角色和它的说法。lead 那一行写 Lead 的名字（leadName）。
export function connectionRoles(leadName: string): readonly { role: ConnectionRole; label: string }[] {
  const labels: Record<ConnectionRole, string> = {
    lead: leadName,
    executor: '执行工单的 agent',
    reviewer: '评审 agent（只给只读工具）',
  };
  return CONNECTION_ROLE_ORDER.map((role) => ({ role, label: labels[role] }));
}

// 打开或关掉一个角色。顺序固定，和 connectionRoles 一致。
export function toggleRole(roles: readonly ConnectionRole[], role: ConnectionRole, on: boolean): ConnectionRole[] {
  const next = new Set(roles);
  if (on) next.add(role);
  else next.delete(role);
  return CONNECTION_ROLE_ORDER.filter((item) => next.has(item));
}

// 连上以后「试一下」的一句话。
export function tryPrompt(provider: ConnectionProvider, label: string): string {
  switch (provider) {
    case 'atlassian': return '我名下还没关的 issue 有哪些？';
    case 'notion': return '帮我找一下上周的会议记录';
    case 'github': return '我有哪些待 review 的 PR？';
    case 'slack': return '今天 #general 有什么新消息？';
    default: return `看看你能用 ${label} 做什么`;
  }
}

// GitHub 不用浏览器授权（用 gh 的登录、设备码或令牌），别的服务都会打开授权页。
export function opensBrowser(provider: ConnectionProvider): boolean {
  return provider !== 'github';
}

// 写入确认只带 key。预设服务的 key 就是服务名，自定义服务器是 custom-<id>。
export function providerForKey(key: string, items: readonly ConnectionDto[] = []): ConnectionProvider {
  const known = items.find((item) => item.key === key);
  if (known) return known.provider;
  const preset: readonly ConnectionProvider[] = ['atlassian', 'notion', 'github', 'slack', 'google'];
  return preset.includes(key as ConnectionProvider) ? key as ConnectionProvider : 'custom';
}

// 网关错误里的原因（body.error.details.reason），例如 needs_setup、temporarily_unavailable。
export function connectionErrorReason(reason: unknown): string | null {
  const body = typeof reason === 'object' && reason !== null ? (reason as { body?: unknown }).body : null;
  const details = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details;
  return typeof details?.reason === 'string' ? details.reason : null;
}

// 给你看的错误。网关的 message 已经是中文。
export function connectionErrorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return message || '请求没有完成，请再试一次。';
}

// 自定义 MCP 服务器的地址：先在这里挡住明显不对的，别的由 daemon 检查。
export function serverUrlProblem(input: string): string | null {
  const value = input.trim();
  if (!value) return '请填写服务器地址。';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '这不是一个网址。';
  }
  if (url.protocol !== 'https:') return '地址要以 https:// 开头。';
  return null;
}

// 授权页地址里给人看的部分，例如 github.com/login/device。
export function displayUrl(value: string): string {
  return value.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

// 一个时间点之前还有几分钟（至少 1）。
export function minutesUntil(value: string, now: Date = new Date()): number | null {
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return Math.max(1, Math.ceil((at - now.getTime()) / 60_000));
}
