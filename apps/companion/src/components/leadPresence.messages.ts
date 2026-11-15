// 会话顶栏 Lead 状态点的说法（leadPresence.ts）。
import { defineMessages } from '@/i18n';

export const leadPresenceMessages = defineMessages({
  en: {
    unpaired: 'Not paired · Click to pair',
    offline: 'Offline',
    offlineNamed: (name: string) => `${name} is offline`,
    reconnecting: 'Offline · Reconnecting',
    connecting: 'Connecting',
    networkLabel: (name: string) => `${name} is offline: no network`,
    networkSubtitle: 'Offline: no network. It continues when the network comes back.',
    degraded: (name: string, reason: string) => `${name} is degraded: ${reason}`,
    modelFailed: (name: string) => `${name} cannot call the model`,
    checkConfig: (short: string) => `${short}. Check Settings → Models.`,
    retryOnMessage: 'It tries again when you send a message',
    retrying: 'Trying again',
    retryAt: (clock: string) => `Tries again at ${clock}`,
    online: (name: string) => `${name} is online`,
    lastPatrol: (clock: string) => `Last check ${clock}`,
  },
  zh: {
    unpaired: '未配对 · 点击配对',
    offline: '离线',
    offlineNamed: (name) => `${name} 离线`,
    reconnecting: '离线 · 正在重连',
    connecting: '连接中',
    networkLabel: (name) => `${name} 离线：网络不可用`,
    networkSubtitle: '离线：网络不可用，恢复后继续',
    degraded: (name, reason) => `${name} 降级：${reason}`,
    modelFailed: (name) => `${name} 调用模型失败`,
    checkConfig: (short) => `${short}，请到「设置 → 模型」检查`,
    retryOnMessage: '你发消息时会再试',
    retrying: '正在重试',
    retryAt: (clock) => `${clock} 自动重试`,
    online: (name) => `${name} 在线`,
    lastPatrol: (clock) => `最近巡检 ${clock}`,
  },
});
