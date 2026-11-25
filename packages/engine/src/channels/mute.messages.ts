// 对话静音写进事件、界面上给用户看的文字（工单 #533）：「Lead 动态」卡上的那一句和按钮上的字。
// 写进事件 payload，按写入时用户选的语言（store 的 getLocale）写；以后换语言，旧记录不重写。
import { defineMessages } from "@pi-lead-child/protocol";

export const channelMuteMessages = defineMessages({
  en: {
    breaker: (label: string, lead: string, wakes: number, windowMinutes: number, minutes: number) =>
      `${label} woke ${lead} ${wakes} times in ${windowMinutes} minutes, and each time it needed no action. `
      + `Muted it for ${minutes} minutes: its messages are only recorded until then. It comes back on its own.`,
    byLead: (lead: string, label: string, minutes: number, reason: string) =>
      `${lead} muted ${label} for ${minutes} minutes: its messages are only recorded until then. Why: ${reason}`,
    byUser: (label: string, minutes: number) => `You muted ${label} for ${minutes} minutes.`,
    ended: (who: string, label: string) => `${who} unmuted ${label}: its messages are handled as usual again.`,
    you: "You",
    unmute: "Unmute",
    undo: "Undo",
  },
  zh: {
    breaker: (label, lead, wakes, windowMinutes, minutes) =>
      `${label}在 ${windowMinutes} 分钟里叫醒 ${lead} ${wakes} 次，每次都不用管。`
      + `已经静音 ${minutes} 分钟：这段时间它的消息只记录。到点自动恢复。`,
    byLead: (lead, label, minutes, reason) => `${lead} 把${label}静音 ${minutes} 分钟：这段时间它的消息只记录。原因：${reason}`,
    byUser: (label, minutes) => `你把${label}静音了 ${minutes} 分钟。`,
    ended: (who, label) => `${who}取消了${label}的静音：它的消息照常处理。`,
    you: "你",
    unmute: "取消静音",
    undo: "撤销",
  },
});
