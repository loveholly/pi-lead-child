// 设置 → Lead → 身份与风格 →「自动调用模型的上限」（AutoBudgetSection，工单 #553）的文案。
import type { AutoBudgetKey } from '@pi-lead-child/protocol';

import { defineMessages } from '@/i18n';

const count = (value: number) => value.toLocaleString('en-US');

export const autoBudgetMessages = defineMessages({
  en: {
    title: 'Limits on automatic model calls',
    intro: (leadName: string) => `${leadName} calls the model on its own when an event or a reminder wakes it. `
      + 'When any limit is reached, the system pauses automatic calls and tells you. Your own messages do not count and are never limited.',
    labels: {
      callsPerHour: 'Calls per hour',
      callsPerDay: 'Calls per day',
      uncachedTokensPerDay: 'Uncached input per day (tokens)',
    } satisfies Record<AutoBudgetKey, string>,
    notes: {
      callsPerHour: (fallback: number, used: number) => `Default ${count(fallback)}. ${count(used)} used in the last hour.`,
      callsPerDay: (fallback: number, used: number) => `Default ${count(fallback)}. ${count(used)} used in the last 24 hours.`,
      uncachedTokensPerDay: (fallback: number, used: number) => `Default ${count(fallback)}. ${count(used)} used in the last 24 hours.`,
    } satisfies Record<AutoBudgetKey, (fallback: number, used: number) => string>,
    footnote: (leadName: string) => `0 means no limit. Saving applies at once, no restart. You can also ask ${leadName} in the conversation.`,
    invalid: (label: string) => `${label}: write a whole number from 0 up.`,
    tooLarge: (label: string, max: number) => `${label}: the largest value is ${count(max)}.`,
    restoreDefaults: 'Restore defaults',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved. The new limits apply now.',
    failed: (reason: string) => `The change did not save: ${reason}`,
    unsupported: 'This daemon cannot change these limits yet. Update it, then come back.',
    loading: 'Loading…',
    loadFailed: (reason: string) => `Cannot load the limits: ${reason}`,
  },
  zh: {
    title: '自动调用模型的上限',
    intro: (leadName) => `${leadName} 被事件、提醒叫醒时自己调模型。到了任何一个上限，系统暂停自动调用并告诉你。你发的消息不算，也不受限制。`,
    labels: {
      callsPerHour: '每小时的次数',
      callsPerDay: '每天的次数',
      uncachedTokensPerDay: '每天没命中缓存的输入（token）',
    },
    notes: {
      callsPerHour: (fallback, used) => `缺省 ${count(fallback)}。最近一小时用了 ${count(used)} 次。`,
      callsPerDay: (fallback, used) => `缺省 ${count(fallback)}。最近 24 小时用了 ${count(used)} 次。`,
      uncachedTokensPerDay: (fallback, used) => `缺省 ${count(fallback)}。最近 24 小时用了 ${count(used)}。`,
    },
    footnote: (leadName) => `0 是不限。保存后马上生效，不用重启。也可以在会话里让 ${leadName} 改。`,
    invalid: (label) => `${label}：写一个 0 或更大的整数。`,
    tooLarge: (label, max) => `${label}：最大是 ${count(max)}。`,
    restoreDefaults: '恢复缺省',
    save: '保存',
    saving: '正在保存…',
    saved: '已保存，新的上限已经生效。',
    failed: (reason) => `没有保存成功：${reason}`,
    unsupported: '这个 daemon 还不能改这些上限。更新以后再来。',
    loading: '正在读取…',
    loadFailed: (reason) => `读不到上限：${reason}`,
  },
});
