// 会话顶栏 Lead 状态点的三种状态。以前只看 WebSocket：连上就是绿点，哪怕 Lead 每次调模型都是 503。
//   · 离线：和 daemon 的连接断了（这时 daemon 报的健康状态已经过时，不看它）；
//   · 降级：daemon 说 Lead 的模型调用失败，系统会自己再试，写出下一次几点；
//   · 在线：连接正常，Lead 的模型调用正常；小字写「最近巡检 HH:MM」。
import type { ColorToken } from '@pi-lead-child/components';
import type { ConnectionState } from '@pi-lead-child/client';
import {
  classifyLeadModelError, leadModelFailureNeedsUser, leadModelFailureShortLabel, type LeadStatus,
} from '@pi-lead-child/protocol';

import type { ControlPlanePhase } from '@/state/types';

export type LeadPresence = {
  state: 'online' | 'degraded' | 'offline';
  dotColor: ColorToken;
  pulse: boolean;
  // 读屏和测试读的完整说法。
  label: string;
  // 名字下面的一行小字。在线时是最近一次巡检的时间（没有巡检过就没有）。
  subtitle: string | null;
};

export function leadPresence(input: {
  connectionState: ConnectionState;
  phase: ControlPlanePhase;
  lead: LeadStatus | undefined;
  // 现在的时间（毫秒）。下一次自动重试的时间过了，就不再写那个时间。
  now?: number;
  // Lead 的名字（useLeadName）。
  name: string;
}): LeadPresence {
  const { connectionState, phase, lead, name } = input;
  const now = input.now ?? Date.now();
  if (connectionState !== 'connected') {
    return {
      state: 'offline',
      dotColor: 'text-muted',
      pulse: false,
      label: phase === 'unpaired' ? '未配对 · 点击配对' : `${name} 离线`,
      subtitle: phase === 'unpaired'
        ? '未配对 · 点击配对'
        : connectionState === 'reconnecting' ? '离线 · 正在重连' : connectionState === 'connecting' ? '连接中' : '离线',
    };
  }
  if (lead?.state === 'degraded') {
    const kind = classifyLeadModelError(lead.detail ?? '');
    const short = leadModelFailureShortLabel(kind);
    // 断网不是模型的问题：说离线，等网络恢复，不给时间（2026-10-16）。
    if (kind === 'network') {
      return {
        state: 'degraded',
        dotColor: 'text-muted',
        pulse: false,
        label: `${name} 离线：网络不可用`,
        subtitle: '离线：网络不可用，恢复后继续',
      };
    }
    // 认证、配置这类失败系统自己再试也好不了：不说"自动重试"，说要检查配置。
    if (leadModelFailureNeedsUser(kind)) {
      return {
        state: 'degraded',
        dotColor: 'danger',
        pulse: false,
        label: `${name} 降级：${lead.reason ?? `${name} 调用模型失败`}`,
        subtitle: `${short}，需要检查配置`,
      };
    }
    // 时间已经过了：系统正在重试，或者刚试完、新的状态还没到。不再写一个过去的时间。
    const retry = !lead.nextAttemptAt
      ? '你发消息时会再试'
      : Date.parse(lead.nextAttemptAt) <= now ? '正在重试' : `${formatClock(lead.nextAttemptAt)} 自动重试`;
    return {
      state: 'degraded',
      dotColor: 'warning',
      pulse: false,
      label: `${name} 降级：${lead.reason ?? `${name} 调用模型失败`}`,
      subtitle: `${short} · ${retry}`,
    };
  }
  // 心跳巡检没有要说的话时，会话里不留消息；这里写最近一次巡检的时间，让人知道它一直在看。
  const patrol = lead?.lastPatrolAt ? `最近巡检 ${formatClock(lead.lastPatrolAt)}` : null;
  return { state: 'online', dotColor: 'success', pulse: true, label: `${name} 在线`, subtitle: patrol };
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
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
