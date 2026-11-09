// 设置 → Lead → 身份与风格 →「Lead 忙时你发的消息」（BusyPlacementSection，主题 11.19）的文案。
// 选项的名字和输入框上的「插话 / 排队」（chat 的 composer.messages.ts）是同一组词。
import type { BusyPlacement } from '@pi-lead-child/protocol';

import { defineMessages } from '@/i18n';

export const busyPlacementMessages = defineMessages({
  en: {
    title: (leadName: string) => `Messages you send while ${leadName} is busy`,
    options: { followUp: 'Queue', steer: 'Steer' } satisfies Record<BusyPlacement, string>,
    notes: {
      followUp: (leadName: string) => `${leadName} gets the message after it finishes this turn. `
        + 'To send it in now, click Steer on it in the queue bar above the message box.',
      steer: (leadName: string) => `The message goes into the turn that ${leadName} is working on now.`,
    },
    footnote: 'Saves right away and applies on all your devices.',
    saving: 'Saving…',
    failed: (reason: string) => `The change did not save: ${reason}`,
    unsupported: 'This daemon cannot change this setting yet. Update it, then come back.',
    loading: 'Loading…',
    loadFailed: (reason: string) => `Cannot load this setting: ${reason}`,
  },
  zh: {
    title: (leadName) => `${leadName} 忙时你发的消息`,
    options: { followUp: '排队', steer: '插话' },
    notes: {
      followUp: (leadName) => `等 ${leadName} 答完这一轮再交给它，可以在输入框上方的排队栏里点 Steer 马上插进去。`,
      steer: (leadName) => `直接插进 ${leadName} 正在做的这一轮。`,
    },
    footnote: '选了马上保存，所有设备一起生效。',
    saving: '正在保存…',
    failed: (reason) => `没有保存成功：${reason}`,
    unsupported: '这个 daemon 还不能改这个设置。更新以后再来。',
    loading: '正在读取…',
    loadFailed: (reason) => `读不到这个设置：${reason}`,
  },
});
