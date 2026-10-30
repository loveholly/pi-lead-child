// Lead 改日程和工单的工具做完以后，用白话说它做了什么（「提醒 #83 已创建」）。
// 失败行（failurePresentation）和会话里的事项卡片用同一套说法。认不得的工具返回 null，由调用方计数或略过。
const DONE_WORDS: Record<string, (id: string | null) => string> = {
  create_reminder: (id) => `提醒${id ? ` #${id}` : ''} 已创建`,
  reschedule_reminder: (id) => `提醒${id ? ` #${id}` : ''} 已改期`,
  ack_reminder: (id) => `提醒${id ? ` #${id}` : ''} 已确认`,
  create_task: (id) => `工单${id ? ` #${id}` : ''} 已创建`,
  update_item: (id) => `${id ? `#${id}` : '事项'} 已更新`,
  defer_item: (id) => `${id ? `#${id}` : '事项'} 已推迟`,
  cancel_item: (id) => `${id ? `#${id}` : '事项'} 已取消`,
  create_cron_trigger: () => '定时任务已创建',
  create_once_trigger: () => '定时任务已创建',
  set_trigger_enabled: () => '定时任务已更新',
};

export function itemOperationDoneWords(name: string, itemId: number | string | null): string | null {
  const words = DONE_WORDS[name];
  return words ? words(itemId === null ? null : String(itemId)) : null;
}

// 只对提醒做的操作。卡片据此在还没取到事项时就按提醒来画。
export const REMINDER_OPERATIONS: ReadonlySet<string> = new Set(['create_reminder', 'reschedule_reminder', 'ack_reminder']);

// 一张提醒卡上，后来的操作是什么事件。新建不另说：卡片本身就是新建的那条提醒。leadName 是 Lead 的名字。
export function reminderEventWords(name: string, leadName: string): string | null {
  if (name === 'reschedule_reminder') return `${leadName} 改了时间`;
  if (name === 'cancel_item') return `${leadName} 取消了它`;
  if (name === 'ack_reminder') return `${leadName} 帮你确认了`;
  return null;
}
