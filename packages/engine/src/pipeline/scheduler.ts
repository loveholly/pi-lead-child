// 时间调度器（spec §10）：机械地"到点触发"，不理解自然语言。now 可注入以保证测试确定性。
//
// 它现在只是 Trigger 的众多 source 生产者之一——把 next_fire_at 到点的 trigger 挑出来，
// 交给 store/trigger-actions.ts 那个对 source 一无所知的执行器。将来的 webhook 接收器是
// 另一个生产者，共用同一个执行器（spec §3.3）。
//
// 四步的顺序是规格的一部分：Trigger 排在提醒之前，本轮新建的 reminder 当轮就能触发，
// 省掉一个 tick 的延迟。每一步、每一个条目各自独立事务并各自 try/catch：单条失败不得
// 中断本轮其余工作。
import type { Db } from "@pi-lead-child/store";
import {
  remindersToFire, itemsOverdue, markOverdueNotified,
  fireReminder, pushReminderEarly, remindersAwaitingRepeat, remindersDueEarly, repeatReminderPush,
  type ReminderPush,
} from "@pi-lead-child/store";
import { recordDueLeadFollowUps } from "@pi-lead-child/store";
import { escalateOverdueEvents } from "@pi-lead-child/store";
import {
  dueTriggers, claimTriggerOccurrence, completeTriggerFire,
  clearTriggerFailures, recordTriggerFailure,
} from "@pi-lead-child/store";
import { runTriggerAction } from "@pi-lead-child/store";
import {
  addNotification, notificationsNeedingFallback, markNotificationDelivered,
  type NotificationRow,
} from "@pi-lead-child/store";
import { notifyFallbackMs } from "@pi-lead-child/core";

export interface Scheduler {
  tick(): void;
  // 只做和提醒有关的几步（到点、提前推送、重复推送）。daemon 每次轮询（3 秒）调一次，提醒准时到，不等每分钟一次的 tick。
  tickReminders(): void;
}

export interface SchedulerOptions {
  now?: () => Date;
  // trigger 要求开跑时调用（daemon 里就是 spawnItemChild）。store 层不认识进程。
  onStartRun?: (itemId: number) => void;
  // 兜底投递通道：immediate 通知 pending 超窗仍未 delivered 时直接推给用户（spec §4）。
  // 没接通道就不走第 4 步——把通知标成 delivered 却没人收得到，比留在 pending 更糟。
  onFallbackNotify?: (notification: NotificationRow) => void;
  // 提醒的推送通道（工单 07）：到点、提前、没确认时的重复推送都由 daemon 直接推，不等 Lead（常设指令 reminder.fire）。
  // 每次推送先在事务里记一条 reminder.pushed，提交以后才调用它：记不上就不推，同一次不推两次。
  // 没接时，到点照常（通知留在 pending，事件交给 Lead），不推也不重复。
  onReminderPush?: (push: ReminderPush) => void;
  onError?: (step: string, error: unknown) => void;
  env?: Record<string, string | undefined>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createScheduler(db: Db, opts: SchedulerOptions): Scheduler {
  const now = opts.now ?? (() => new Date());
  const report = (step: string, error: unknown) => opts.onError?.(step, error);

  const pushReminder = (push: ReminderPush | null) => {
    if (!push || !opts.onReminderPush) return;
    try {
      opts.onReminderPush(push);
    } catch (error) {
      report("reminder-push", error);
    }
  };

  // 提醒（spec §10 步骤 2，工单 07）。scheduled → fired 的跃迁，而不是抹掉 remind_at：触发时刻是历史。
  // 通知走 notifications（无去抖）而不是 inbox——inbox 的 attention 合并会把到点的提醒折叠进别人的 payload 里静默丢掉，
  // 那正是 spec §1 记录的既有缺陷。通知的 kind、urgency 和标题前缀来自常设指令 reminder.fire（工单 05）。到点一定发通知：指令只给参数。
  // 到点、提前、重复三步各自一个事务，每条提醒各自 try/catch。
  function tickReminders(t: Date): void {
    const iso = t.toISOString();
    for (const reminder of remindersToFire(db, iso)) {
      try {
        pushReminder(fireReminder(db, reminder, t, { push: Boolean(opts.onReminderPush) }).push);
      } catch (error) {
        report("reminder", error);
      }
    }
    if (!opts.onReminderPush) return;
    for (const reminder of remindersDueEarly(db, t)) {
      try {
        pushReminder(pushReminderEarly(db, reminder, t));
      } catch (error) {
        report("reminder-early", error);
      }
    }
    for (const reminder of remindersAwaitingRepeat(db)) {
      try {
        pushReminder(repeatReminderPush(db, reminder, t).push);
      } catch (error) {
        report("reminder-repeat", error);
      }
    }
  }

  return {
    tickReminders(): void {
      tickReminders(now());
    },
    tick(): void {
      const t = now();
      const iso = t.toISOString();

      // 1) Trigger 到点
      for (const trigger of dueTriggers(db, t)) {
        try {
          const occurrenceAt = trigger.next_fire_at;
          if (!occurrenceAt) continue;
          // 占坑 + 推进 next_fire_at 同一事务，且**先于** action 执行。反过来的话，
          // 一条抛错的 action 会让 next_fire_at 永远停在过去，每 tick 重试同一个
          // occurrence，整条 schedule 冻结。UNIQUE 冲突说明本次已处理过，跳过。
          const fireId = claimTriggerOccurrence(db, trigger, occurrenceAt, t);
          if (fireId === null) continue;

          const notes: string[] = [];
          try {
            const itemId = runTriggerAction(db, trigger, occurrenceAt, {
              startRun: opts.onStartRun,
              onNote: (note) => notes.push(note),
            });
            completeTriggerFire(db, fireId, {
              status: "succeeded",
              error: notes.length ? notes.join("; ") : null, // 降级说明记在这里（spec §5.3）
              producedItemId: itemId,
            });
            clearTriggerFailures(db, trigger.id);
          } catch (error) {
            const reason = message(error);
            completeTriggerFire(db, fireId, { status: "failed", error: reason });
            recordTriggerFailure(db, trigger.id, reason, opts.env);
            report("trigger", error);
          }
        } catch (error) {
          report("trigger", error);
        }
      }

      // 2) 提醒：到点、提前推送、没确认时的重复推送（tickReminders）。
      tickReminders(t);

      // 2b) Lead 给自己设的跟进到点：记一条 timer.fired（Lead 事件主干，工单 01）。叫醒 Lead 仍由 daemon 的
      //     lead-wake 按 notBefore 判断；这里只把「到点」这件事写进事件日志。
      try {
        recordDueLeadFollowUps(db, t);
      } catch (error) {
        report("lead-followup", error);
      }

      // 3) 逾期（每单一次，可攒批）
      for (const item of itemsOverdue(db, iso)) {
        try {
          db.transaction(() => {
            addNotification(db, {
              itemId: item.id, kind: "overdue", urgency: "batchable",
              title: `工单 #${item.id} 已逾期：${item.title}`,
              body: `截止 ${item.due_at}`, createdAt: iso,
            });
            markOverdueNotified(db, item.id);
          })();
        } catch (error) {
          report("overdue", error);
        }
      }

      // 3b) 到时限还没有处置的事件升一级（Lead 事件主干 spec D3，工单 05，常设指令 events.escalate_overdue）。
      //     原事件记成 superseded，另写一条更高级别的 event.escalated。tick 每分钟一次，所以最多晚一分钟。
      try {
        escalateOverdueEvents(db, t, { onError: (seq, error) => report(`event-escalation #${seq}`, error) });
      } catch (error) {
        report("event-escalation", error);
      }

      // 4) 兜底投递（spec §4）：lead 挂了、卡住了、判断失误，用户照样收得到。
      if (opts.onFallbackNotify) {
        const windowMs = notifyFallbackMs(opts.env ?? process.env);
        for (const notification of notificationsNeedingFallback(db, t, windowMs)) {
          try {
            opts.onFallbackNotify(notification);
            markNotificationDelivered(db, notification.id, "fallback", t);
          } catch (error) {
            report("fallback", error); // 投递失败就留在 pending，下轮再试
          }
        }
      }
    },
  };
}
