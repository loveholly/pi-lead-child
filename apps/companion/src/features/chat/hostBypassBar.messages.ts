// 输入框上方「免沙箱」标记（工单 #246 设计 5.3，主题 11.17）的文案。没有剩余时间：开关没有时限（用户 2026-11-10）。
import { defineMessages } from '@/i18n';

export const hostBypassBarMessages = defineMessages({
  en: {
    line: 'Sandbox bypass · On',
    close: 'Turn off',
    closing: 'Turning off…',
    failed: (reason: string) => `Did not turn off: ${reason}`,
  },
  zh: {
    line: '免沙箱 · 开着',
    close: '关闭',
    closing: '正在关闭…',
    failed: (reason) => `没有关掉：${reason}`,
  },
});
