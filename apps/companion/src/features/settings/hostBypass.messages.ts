// Text for Settings → Sandbox bypass (theme 11.17). The settings page is the only place that shows this switch; the conversation has no marker above the composer.
// 和「Lead 忙时你发的消息」（busyPlacement.messages.ts，主题 11.19）同一种写法：标题、每个选项一句说明、最后一行写什么时候生效。
import { defineMessages } from '@/i18n';

import type { HostBypassOption } from './hostBypassModel';

export const hostBypassMessages = defineMessages({
  en: {
    title: 'Skip the sandbox',
    options: { off: 'Off', on: 'On' } satisfies Record<HostBypassOption, string>,
    notes: {
      off: (leadName: string) => `${leadName} runs every command in the sandbox. `
        + `For work outside the sandbox, ${leadName} asks you on a confirmation card first.`,
      on: (leadName: string) => `${leadName} runs commands outside the sandbox and without a confirmation card, in every turn. `
        + 'Two cases still get a confirmation card. '
        + `One: the command reads credentials, writes the PLC database, uses the plc command line, or ${leadName} says it spends money. `
        + 'Two: the turn read content from other people (for example Slack messages), and the decision model judges that '
        + 'the command is not something you asked for and is hard to undo. '
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
    title: '免沙箱',
    options: { off: '关着', on: '开着' },
    notes: {
      off: (leadName) => `${leadName} 的命令都在沙箱里跑。沙箱外的事，${leadName} 先发一张确认卡问你。`,
      on: (leadName) => `${leadName} 的命令在哪一轮都在沙箱外跑，不弹确认卡。只有两种情况还会弹确认卡。`
        + `一种是命令要读凭证、写 PLC 的数据库、用 plc 命令行，或者 ${leadName} 自己认为会花钱。`
        + '另一种是这一轮读过别人写的内容（例如 Slack 消息），而决策模型判断这条命令不是你交代的事、又难撤回。'
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
