// 四个用户诉求的端到端验收。刻意不用 vitest：走的是真实 store / coordinator / scheduler /
// children 代码路径，断言失败就抛错退出，避免"测试替身通过、真实路径不通"这种假绿。
//   1. 提醒不出现在任务列表
//   2. 提醒不显示 timing / checkpoints / 产物 / 日志
//   3. 新建任务缺省建完即跑；hold 的停在 draft，确认之前不会跑，lead 无权替用户确认
//   4. 执行中可手动暂停（真的杀掉子进程）并恢复
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@pi-lead-child/store";
import { createItem, getItem, listItems, transition } from "@pi-lead-child/store";
import { canTransition } from "@pi-lead-child/store";
import { createRun, getRun, pauseRun, resumeRun } from "@pi-lead-child/store";
import { assertRunAllowed } from "@pi-lead-child/store";
import { createCronTrigger, listTriggers } from "@pi-lead-child/store";
import { listNotifications } from "@pi-lead-child/store";
import { listInbox } from "@pi-lead-child/store";
import { createScheduler } from "@pi-lead-child/engine";
import { createControlPlaneService } from "@pi-lead-child/gateway";

let checks = 0;
function ok(label: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) throw new Error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

// 验收用的数据目录在进程退出时删除，断言失败抛错退出时也删除。以前每跑一次 verify 都留下一个 plc-accept-* 目录。
const dataDir = mkdtempSync(join(tmpdir(), "plc-accept-"));
process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));
const db = openDb(join(dataDir, "plc.db"));
const NOW = new Date("2026-07-27T10:00:00.000Z");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[1] 提醒不出现在任务列表");

const reminderId = createItem(db, {
  title: "三点开会", brief: "", createdBy: "user",
  kind: "reminder", remindAt: "2026-07-27T15:00:00.000Z",
});
const taskId = createItem(db, { title: "重构 X", brief: "把 X 拆开", createdBy: "user" }); // → ready

const nowIso = NOW.toISOString();
const taskView = listItems(db, { view: "tasks", now: nowIso }).map((t) => t.id);
ok("任务列表含真任务", taskView.includes(taskId));
ok("任务列表不含提醒", !taskView.includes(reminderId), `got ${JSON.stringify(taskView)}`);
ok("提醒在自己的视图里",
  listItems(db, { view: "reminders", now: nowIso }).map((t) => t.id).includes(reminderId));

// 循环提醒：以前每次触发都新建一条永不执行的工单，且会被 inbox 去抖吞掉
createCronTrigger(db, {
  label: "每周一交周报", cronExpr: "0 9 * * 1", tz: "UTC", createdBy: "user",
  action: { type: "create_item", payload: { kind: "reminder", title: "交周报" } },
}, NOW);
const scheduler = createScheduler(db, { now: () => new Date("2026-08-03T09:00:01.000Z") });
scheduler.tick();
scheduler.tick(); // 第二次 tick 不得重复触发同一 occurrence
const weekly = listItems(db, { view: "reminders", now: "2026-08-03T09:00:01.000Z" })
  .filter((t) => t.title === "交周报");
ok("循环提醒只产出一条（幂等）", weekly.length === 1, `got ${weekly.length}`);
ok("循环提醒不进任务列表",
  !listItems(db, { view: "tasks", now: "2026-08-03T09:00:01.000Z" })
    .some((t) => t.title === "交周报"));
ok("规则本身不是工单", listTriggers(db).length === 1);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[2] 提醒不显示执行细节");

let ranOnReminder = false;
try { assertRunAllowed(db, { itemId: reminderId, role: "executor", purpose: "execution" }); ranOnReminder = true; } catch { /* expected */ }
ok("提醒结构上不能有 Run", !ranOnReminder);
try { createRun(db, { itemId: reminderId, role: "executor" }); ranOnReminder = true; } catch { /* expected */ }
ok("createRun 也挡住了提醒（不只是闸门函数）", !ranOnReminder);

const svc = createControlPlaneService(db, {
  runtime: () => ({ model: "m", sessionId: "s", busy: false, runningItemIds: [], aish: null }),
  now: () => NOW,
});
const reminderDetail = svc.getItem(reminderId)!;
ok("提醒投影 kind=reminder", reminderDetail.ticket.kind === "reminder");
ok("提醒投影 hasRun=false", reminderDetail.ticket.hasRun === false);
const wb = svc.getKernelTicketWorkbenchV2(reminderId);
ok("提醒 workbench 无 timing", wb?.timing === undefined, JSON.stringify(wb?.timing));
ok("提醒 workbench 无 checkpoints",
  wb?.latestCheckpoints === undefined, JSON.stringify(wb?.latestCheckpoints));
ok("提醒 workbench 无 pow", wb?.pow === undefined);

// 已确认但从未跑过的任务同样不该有执行面板
ok("未跑过的任务 hasRun=false", svc.getItem(taskId)!.ticket.hasRun === false);

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[3] 建完先别跑（有的时候）");

// 诉求原文是"**有的时候**我希望刚建的时候不需要立即执行"：缺省建完即跑，
// 想让它等，就得在建的时候显式说一声 hold。
const autoId = createItem(db, { title: "照常跑", brief: "b", createdBy: "user" });
ok("不 hold 的任务生于 ready", getItem(db, autoId)!.stage === "ready");

const freshId = createItem(db, { title: "先别跑", brief: "b", createdBy: "user", hold: true });
ok("hold 的任务生于 draft", getItem(db, freshId)!.stage === "draft");

let started = false;
try { assertRunAllowed(db, { itemId: freshId, role: "executor", purpose: "execution" }); started = true; } catch { /* expected */ }
ok("draft 不可开跑", !started);

// 2026-10-28（用户：「工单操作让 Lead 自己判断」）：lead 也能确认开跑，hold 由 Lead 遵守用户的话。system 和 child 仍然不能。
ok("lead 能确认 draft→ready", canTransition("task", "draft", "ready", "lead"));
ok("system 无权确认 draft→ready", !canTransition("task", "draft", "ready", "system"));
ok("child 无权确认 draft→ready", !canTransition("task", "draft", "ready", "child"));
ok("user 能确认", canTransition("task", "draft", "ready", "user"));

let childConfirmed = false;
try { transition(db, { itemId: freshId, to: "ready", actor: "child", reason: "x" }); childConfirmed = true; } catch { /* expected */ }
ok("child 实际调用被拒", !childConfirmed);

transition(db, { itemId: freshId, to: "ready", actor: "user", reason: "confirmed" });
ok("用户确认后变 ready", getItem(db, freshId)!.stage === "ready");
assertRunAllowed(db, { itemId: freshId, role: "executor", purpose: "execution" });
ok("确认后可开跑", true);

// child 拆出的子任务不受此闸门阻塞，否则编排会死锁（spec §6.6）
const childSub = createItem(db, {
  title: "子任务", brief: "b", createdBy: "child",
  parentItemId: freshId, rootItemId: freshId,
});
ok("child 拆的子任务生于 ready（确认发生在树根）",
  getItem(db, childSub)!.stage === "ready");

// lead 手工挂的子任务同理：hold 只对树根生效，否则一次十阶段的分解会在
// 「需要你介入」里堆出十几条，而用户只该确认那一个根。
const leadSub = createItem(db, {
  title: "lead 子任务", brief: "b", createdBy: "lead", hold: true,
  parentItemId: freshId, rootItemId: freshId,
});
ok("lead 挂的子任务不吃 hold，同样生于 ready",
  getItem(db, leadSub)!.stage === "ready");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[4] 执行中手动暂停");

const runId = createRun(db, { itemId: freshId, role: "executor" });
db.prepare("UPDATE runs SET state='running', pid=?, session_id='sess-1' WHERE id=?")
  .run(process.pid, runId);
transition(db, { itemId: freshId, to: "active", actor: "system", reason: "start" });

pauseRun(db, runId, new Date("2026-07-27T10:00:00.000Z"));
const paused = getRun(db, runId)!;
ok("Run 进入 paused", paused.state === "paused");
ok("pid 被清空", paused.pid === null);
ok("session 保留（恢复要用）", paused.session_id === "sess-1");
ok("工单仍是 active（暂停不是一个 stage）", getItem(db, freshId)!.stage === "active");

resumeRun(db, runId, new Date("2026-07-27T10:00:30.000Z"));
const resumed = getRun(db, runId)!;
ok("Run 恢复 running", resumed.state === "running");
ok("暂停时长被累计", resumed.paused_ms === 30_000, `got ${resumed.paused_ms}`);

// 暂停不是 stage 的边（上面：工单仍是 active）。停下整张工单（active → ready）lead 也能做（用户 2026-10-22）。
ok("lead 能停下整张工单", canTransition("task", "active", "ready", "lead"));

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[5] 回归：提醒不再被通知去抖吞掉（spec §1 记录的既有缺陷）");

const r1 = createItem(db, { title: "提醒A", brief: "", createdBy: "user",
  kind: "reminder", remindAt: "2026-07-27T09:00:00.000Z" });
const r2 = createItem(db, { title: "提醒B", brief: "", createdBy: "user",
  kind: "reminder", remindAt: "2026-07-27T09:00:00.000Z" });
const before = listNotifications(db, { state: ["pending"] }).length;
createScheduler(db, { now: () => NOW }).tick();
const after = listNotifications(db, { state: ["pending"] });
ok("两条提醒各自产生一条通知，未被合并",
  after.length - before === 2, `delta=${after.length - before}`);
ok("提醒走 notifications 而非 lead 的 inbox",
  !listInbox(db).some((i) => i.summary.includes("提醒A") || i.summary.includes("提醒B")));
ok("两条提醒都进入 fired",
  getItem(db, r1)!.stage === "fired" && getItem(db, r2)!.stage === "fired");

console.log(`\n全部 ${checks} 项验收通过。`);
db.close();
