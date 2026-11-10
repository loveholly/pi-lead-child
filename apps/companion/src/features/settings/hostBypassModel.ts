// 设置 → 免沙箱（工单 #246）和输入框上方标记的纯函数：两个选项、现在开没开、错误的说法。
// 开关没有时限（用户 2026-11-10）：开没开只看 daemon 回的 enabled，不按本机时间再算。
import type { HostBypassDto, Locale } from '@pi-lead-child/protocol';

import { hostBypassMessages } from './hostBypass.messages';

// 设置页上的两个选项，关着（缺省）在前。
export const HOST_BYPASS_OPTIONS = ['off', 'on'] as const;
export type HostBypassOption = typeof HOST_BYPASS_OPTIONS[number];

export function isHostBypassOption(value: string): value is HostBypassOption {
  return (HOST_BYPASS_OPTIONS as readonly string[]).includes(value);
}

/** 现在开没开。没读到时当作关着。 */
export function hostBypassOn(state: HostBypassDto | null): boolean {
  return state?.enabled === true;
}

/** 开、关失败时给人看的一句话。 */
export function hostBypassErrorText(reason: unknown, locale: Locale): string {
  const m = hostBypassMessages(locale);
  const status = typeof reason === 'object' && reason !== null && 'status' in reason ? (reason as { status?: unknown }).status : undefined;
  if (status === 403) return m.errorForbidden;
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return message || m.errorUnknown;
}
