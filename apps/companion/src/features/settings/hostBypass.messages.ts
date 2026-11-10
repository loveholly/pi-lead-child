// 设置 → 免沙箱（工单 #246，主题 11.17）的文案。输入框上方的标记在 chat 的 hostBypassBar.messages.ts。
// 和「Lead 忙时你发的消息」（busyPlacement.messages.ts，主题 11.19）同一种写法：标题、每个选项一句说明、最后一行写什么时候生效。
import { defineMessages } from '@/i18n';

import type { HostBypassOption } from './hostBypassModel';

export const hostBypassMessages = defineMessages({
  en: {
    title: 'Skip the sandbox in your own turns',
    options: { off: 'Off', on: 'On' } satisfies Record<HostBypassOption, string>,
    notes: {
      off: (leadName: string) => `${leadName} runs every command in the sandbox. `
        + `For work outside the sandbox, ${leadName} asks you on a confirmation card first.`,
      on: (leadName: string) => `In a turn that you start yourself, ${leadName} runs commands outside the sandbox and without a confirmation card. `
        + 'When the turn reads external content (for example Slack messages or attachments), it goes back to the sandbox. '
        + 'The safety floors stay on: no credentials, no writes to the PLC database, no deletes outside the work folders, '
        + 'no launchd changes, no paid operations. '
        + `This stays on until you or ${leadName} turn it off.`,
    },
    footnote: (leadName: string) => `Saves right away and applies on all your devices. Only you can turn this on. ${leadName} can turn it off.`,
    saving: 'Saving…',
    failed: (reason: string) => `The change did not save: ${reason}`,
    loading: 'Loading…',
    loadFailed: (reason: string) => `Cannot load this setting: ${reason}`,
    errorForbidden: 'This device does not have permission to change this setting.',
    errorUnknown: 'Try again.',
  },
  zh: {
    title: '用户本人发话时免沙箱',
    options: { off: '关着', on: '开着' },
    notes: {
      off: (leadName) => `${leadName} 的命令都在沙箱里跑。沙箱外的事，${leadName} 先发一张确认卡问你。`,
      on: (leadName) => `你自己发话的那一轮里，${leadName} 的命令在沙箱外跑，不弹确认卡。这一轮读了外部内容（例如 Slack 消息、附件）以后就退回沙箱。`
        + '底线照样保留：不碰凭证，不写 PLC 的数据库，不删工作目录以外的东西，不改 launchd，不做花钱的操作。'
        + `一直开着，直到你或 ${leadName} 关掉。`,
    },
    footnote: (leadName) => `选了马上保存，所有设备一起生效。只有你能打开，${leadName} 能关。`,
    saving: '正在保存…',
    failed: (reason) => `没有保存成功：${reason}`,
    loading: '正在读取…',
    loadFailed: (reason) => `读不到这个设置：${reason}`,
    errorForbidden: '这台设备没有改这个设置的权限。',
    errorUnknown: '请再试一次。',
  },
});
