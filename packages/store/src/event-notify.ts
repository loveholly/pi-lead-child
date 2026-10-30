// 事件写入后的进程内通知（Lead 事件主干 spec D6，工单 04）。daemon 要在事件写进日志时马上知道（推），
// 再按级别决定叫醒 Lead、插话还是排队。
//
// appendEvent 在调用方的事务里执行，事务提交之前通知是不安全的：事务可能回滚，那条事件就不存在。
// 所以写入时这里只记一句「有新事件了」，等当前这段同步代码跑完（微任务）再去读库：better-sqlite3 的事务是同步的，
// 到那时事务已经提交或者回滚了。读的是库里已经提交、序号比上次通知过的大的事件，回滚掉的自然不在里面。
// 事务还没结束（手写的 BEGIN 跨了 await）时，下一拍再看。
//
// 别的连接写的事件（另一个进程、测试自己打开的连接）这里收不到通知。订阅方用 flushCommittedEvents 兜底，
// 例如 daemon 每次轮询时调一次。
import type { Db } from "./db.js";
import { listEvents, type EventRecord } from "./events.js";

export type CommittedEventsListener = (events: EventRecord[]) => void;

interface Subscription {
  listeners: Set<CommittedEventsListener>;
  // 已经通知过的最大序号。
  lastSeq: number;
  scheduled: boolean;
}

const subscriptions = new WeakMap<Db, Subscription>();

function maxSeq(db: Db): number {
  return (db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq;
}

/**
 * 订阅这个库提交的新事件。afterSeq 缺省是现在日志的末尾：只通知订阅以后提交的事件。返回取消订阅的函数。
 * 回调在事务提交以后、在微任务里调用；回调抛错只影响它自己。
 */
export function subscribeCommittedEvents(
  db: Db, listener: CommittedEventsListener, options: { afterSeq?: number } = {},
): () => void {
  let subscription = subscriptions.get(db);
  if (!subscription) {
    subscription = { listeners: new Set(), lastSeq: options.afterSeq ?? maxSeq(db), scheduled: false };
    subscriptions.set(db, subscription);
  }
  subscription.listeners.add(listener);
  return () => {
    subscription!.listeners.delete(listener);
    if (!subscription!.listeners.size) subscriptions.delete(db);
  };
}

/** appendEvent 写入一条事件以后调用（events.ts）。只排一次检查，不读库。 */
export function noteEventAppended(db: Db): void {
  const subscription = subscriptions.get(db);
  if (!subscription || subscription.scheduled) return;
  subscription.scheduled = true;
  queueMicrotask(() => deliver(db));
}

function deliver(db: Db): void {
  const subscription = subscriptions.get(db);
  if (!subscription) return;
  subscription.scheduled = false;
  if (!db.open) return;
  // 事务还没结束：提交以后再读。
  if (db.inTransaction) {
    subscription.scheduled = true;
    setImmediate(() => deliver(db));
    return;
  }
  flushCommittedEvents(db);
}

/**
 * 现在就读一次：把已经提交、还没通知过的事件交给订阅方。别的连接写的事件只能这样发现。
 * 在事务里调用时什么都不做（读到的可能还没提交）。返回这次通知了几条。
 */
export function flushCommittedEvents(db: Db): number {
  const subscription = subscriptions.get(db);
  if (!subscription || !db.open || db.inTransaction) return 0;
  let delivered = 0;
  for (;;) {
    const batch = listEvents(db, { sinceSeq: subscription.lastSeq, limit: 500 });
    if (!batch.length) return delivered;
    subscription.lastSeq = batch.at(-1)!.seq;
    delivered += batch.length;
    for (const listener of [...subscription.listeners]) {
      try {
        listener(batch);
      } catch {
        // 一个订阅方出错不影响别的订阅方，也不影响写入。
      }
    }
    if (batch.length < 500) return delivered;
  }
}
