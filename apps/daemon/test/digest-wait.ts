// 测试用：把常设指令 events.digest_batch 的等待时间改短（种子是 25 分钟，工单 05），写成用户批准的一个新版本。
// 按批叫醒 Lead 的判断照常走 lead-input.ts 的 defaultDigestBatch，只是等得短。
import { recordStandingOrderVersion, SYSTEM_STANDING_ORDERS, type Db } from "@pi-lead-child/store";

export function shortenDigestWait(db: Db, maxWaitMs: number): void {
  const seed = SYSTEM_STANDING_ORDERS.find((order) => order.id === "events.digest_batch")!;
  recordStandingOrderVersion(db, {
    ...seed,
    action: { type: "rule", rule: "events.digest_batch", params: { maxWaitMs, onUserReturn: true } },
    reason: "测试：等待时间改短",
  }, { author: "user", approvedBy: "user" });
}
