// 会话顶栏 Lead 状态点的三种状态。以前只看 WebSocket：连上就是绿点，哪怕 Lead 每次调模型都是 503。
//   · 离线：和 daemon 的连接断了（这时 daemon 报的健康状态已经过时，不看它）；
//   · 降级：daemon 说 Lead 的模型调用失败，系统会自己再试，写出下一次几点；
//   · 在线：连接正常，Lead 的模型调用正常；小字写「最近巡检 HH:MM」。
import type { ColorToken } from '@pi-lead-child/components';
import type { ConnectionState } from '@pi-lead-child/client';
import {
  classifyLeadModelError, leadModelFailureNeedsUser, leadModelFailureShortLabel, type LeadStatus,
} from '@pi-lead-child/protocol';

import { DEFAULT_LOCALE, intlLocale, type Locale } from '@/i18n';
import type { ControlPlanePhase } from '@/state/types';

import { leadPresenceMessages } from './leadPresence.messages';

export type LeadPresence = {
  state: 'online' | 'degraded' | 'offline';
  dotColor: ColorToken;
  pulse: boolean;
  // 读屏和测试读的完整说法。
  label: string;
  // 名字下面的一行小字。在线时是最近一次巡检的时间（没有巡检过就没有）。
  subtitle: string | null;
  // 认证、配置这类失败（没有 key、key 错、模型名不对）：系统自己好不了，要用户去设置 → 模型。点 Lead 的名字打开那里。
  needsModelSetup?: boolean;
};

export function leadPresence(input: {
  connectionState: ConnectionState;
  phase: ControlPlanePhase;
  lead: LeadStatus | undefined;
  // 现在的时间（毫秒）。下一次自动重试的时间过了，就不再写那个时间。
  now?: number;
  // Lead 的名字（useLeadName）。
  name: string;
  // 界面语言（useLocale）。不给时用缺省语言。
  locale?: Locale;
}): LeadPresence {
  const { connectionState, phase, lead, name } = input;
  const locale = input.locale ?? DEFAULT_LOCALE;
  const m = leadPresenceMessages(locale);
  const now = input.now ?? Date.now();
  if (connectionState !== 'connected') {
    return {
      state: 'offline',
      dotColor: 'text-muted',
      pulse: false,
      label: phase === 'unpaired' ? m.unpaired : m.offlineNamed(name),
      subtitle: phase === 'unpaired'
        ? m.unpaired
        : connectionState === 'reconnecting' ? m.reconnecting : connectionState === 'connecting' ? m.connecting : m.offline,
    };
  }
  if (lead?.state === 'degraded') {
    const kind = classifyLeadModelError(lead.detail ?? '');
    const short = leadModelFailureShortLabel(kind, locale);
    // 断网不是模型的问题：说离线，等网络恢复，不给时间（2026-10-16）。
    if (kind === 'network') {
      return {
        state: 'degraded',
        dotColor: 'text-muted',
        pulse: false,
        label: m.networkLabel(name),
        subtitle: m.networkSubtitle,
      };
    }
    // 认证、配置这类失败系统自己再试也好不了：不说"自动重试"，说要检查配置。
    if (leadModelFailureNeedsUser(kind)) {
      return {
        state: 'degraded',
        dotColor: 'danger',
        pulse: false,
        label: m.degraded(name, lead.reason ?? m.modelFailed(name)),
        subtitle: m.checkConfig(short),
        needsModelSetup: true,
      };
    }
    // 时间已经过了：系统正在重试，或者刚试完、新的状态还没到。不再写一个过去的时间。
    const retry = !lead.nextAttemptAt
      ? m.retryOnMessage
      : Date.parse(lead.nextAttemptAt) <= now ? m.retrying : m.retryAt(formatClock(lead.nextAttemptAt, locale));
    return {
      state: 'degraded',
      dotColor: 'warning',
      pulse: false,
      label: m.degraded(name, lead.reason ?? m.modelFailed(name)),
      subtitle: `${short} · ${retry}`,
    };
  }
  // 心跳巡检没有要说的话时，会话里不留消息；这里写最近一次巡检的时间，让人知道它一直在看。
  const patrol = lead?.lastPatrolAt ? m.lastPatrol(formatClock(lead.lastPatrolAt, locale)) : null;
  return { state: 'online', dotColor: 'success', pulse: true, label: m.online(name), subtitle: patrol };
}

function formatClock(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(intlLocale(locale), { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

// Fairy 表示 Lead 的整体状态（方案 C，主题 F-4、F-7）：左栏头部，和手机上、左栏收起时的会话顶栏。
// Lead 在一轮里时在想。离线时是灰色、静止；离线和降级时下面一行写说明（presence 的 subtitle）。
export function leadFairy(presence: LeadPresence, busy: boolean): { state: 'idle' | 'thinking'; tone: 'color' | 'quiet'; note: string | null } {
  const offline = presence.state === 'offline' || presence.dotColor === 'text-muted';
  return {
    state: busy && !offline ? 'thinking' : 'idle',
    tone: offline ? 'quiet' : 'color',
    note: presence.state === 'online' ? null : presence.subtitle,
  };
}
