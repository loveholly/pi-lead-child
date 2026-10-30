// Trigger 的 action 执行器（spec §5.3）。**它对 source 一无所知**：只接受
// (trigger, occurrenceAt)，不知道自己是被 scheduler 的时钟叫醒的、还是将来被一次入站
// webhook 叫醒的。这就是它单独成文件的全部理由——source/action 分离的那道接缝在这里，
// 把它塞进 scheduler 里等于把 webhook 挡在门外，只能再开一条平行路径（spec §3.3）。
//
// 本文件绝不 catch 异常：失败必须冒泡给调用方，由它写 trigger_fires.status='failed'
// 并累加 consecutive_failures。在这里吞掉异常，熔断就永远数不到 5。
import type { Db } from "./db.js";
import type { Actor, ItemKind, ItemStage } from "@pi-lead-child/core";
import type { Trigger } from "./triggers.js";
import { createItem } from "./items.js";
import { addActivity } from "./activities.js";
import { assertRunAllowed } from "./run-gate.js";
import { timerOriginOf } from "@pi-lead-child/protocol";
import { recordReminderTimeSetter } from "./reminders.js";
import { labelTimer } from "./timer-origins.js";

export interface TriggerActionDeps {
  // 真正把进程拉起来是 daemon 的事，store 层不认识进程。执行器只负责过 §6.5 的闸门、
  // 把 item 摆到闸门认可的 stage，然后把"开跑"交给注入的这一钩子。
  startRun?: (itemId: number) => void;
  // 降级之类的说明。调用方（scheduler）把它写进 trigger_fires.error——执行器自己拿不到
  // fire 行的 id，也不该为了记一行日志去认识 trigger_fires 的结构。
  onNote?: (note: string) => void;
}

// initial_stage 的合法域按 kind 分开：draft/ready 只属于 task 状态机，reminder 用不了
// （spec §5.3 的 action_payload 契约）。
const KIND_INITIAL_STAGES: Record<ItemKind, ItemStage[]> = {
  task: ["draft", "ready"],
  reminder: ["scheduled"],
};

interface ItemTemplate {
  kind?: string;
  title?: string;
  body?: string;
  brief?: string;
  initial_stage?: string;
  priority?: "urgent" | "high" | "normal" | "low";
  project?: string;
  workdir?: string;
  due_at?: string;
  item_id?: number;
  // 谁要求设这条规则（protocol 的 timer-origins.ts，spec D16）。展开出来的提醒带着它：外部来源的提醒到点那一轮按外部的一轮算。
  origin?: unknown;
}

function parsePayload(trigger: Trigger): ItemTemplate {
  let payload: unknown;
  try {
    payload = JSON.parse(trigger.action_payload || "{}");
  } catch (error) {
    throw new Error(`trigger #${trigger.id} action_payload is not valid JSON`, { cause: error });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`trigger #${trigger.id} action_payload must be a JSON object`);
  }
  return payload as ItemTemplate;
}

// 展开出来的 item 记谁的账（spec §6.6 + (C4)）。
// (C4) 只允许 user / lead 作者的 item 停在 draft，而 §5.3 又要求非 user 的 trigger 一律
// 降级到 draft——child / system 建的 trigger 撞上这两条时无解。这里把作者记成 lead：
// trigger 展开本来就是"代理侧"的创作，lead 正是本仓库里那一侧的名字，且安全侧优先于
// 溯源精度。本期没有任何代码会建 child / system 的 trigger，这一支只是把结构补全。
function itemAuthor(trigger: Trigger): Actor {
  return trigger.created_by === "user" || trigger.created_by === "lead"
    ? trigger.created_by
    : "lead";
}

function resolveInitialStage(
  trigger: Trigger, kind: ItemKind, declared: string | undefined,
  fallback: ItemStage, deps: TriggerActionDeps,
): ItemStage {
  if (declared !== undefined && !KIND_INITIAL_STAGES[kind].includes(declared as ItemStage)) {
    throw new Error(`initial_stage '${declared}' is not valid for kind '${kind}'`);
  }
  const wanted = (declared as ItemStage | undefined) ?? fallback;
  // 权限传递（spec §5.3）：initial_stage='ready' 是一次 INSERT 而不是 stage 跃迁，绕开了
  // §6.4 的 actor 校验。不降级的话，lead 建的 trigger 就能替用户完成"确认开跑"这一步。
  // 静默降级到安全侧，而不是 ABORT——让整条例行任务挂掉更不符合意图。
  if (wanted === "ready" && trigger.created_by !== "user") {
    deps.onNote?.(
      `initial_stage 'ready' downgraded to 'draft': trigger #${trigger.id} was created by `
      + `'${trigger.created_by}', not 'user'`,
    );
    return "draft";
  }
  return wanted;
}

function createFromTemplate(
  db: Db, trigger: Trigger, template: ItemTemplate, occurrenceAt: string,
  fallbackStage: ItemStage, deps: TriggerActionDeps,
): number {
  const kind = (template.kind ?? "task") as string;
  if (kind !== "task" && kind !== "reminder") {
    throw new Error(`unknown item kind '${kind}' in trigger #${trigger.id}`);
  }
  const title = template.title?.trim();
  if (!title) throw new Error(`trigger #${trigger.id} template has no title`);
  const stage = resolveInitialStage(trigger, kind, template.initial_stage, fallbackStage, deps);
  const createdBy = itemAuthor(trigger);

  const itemId = createItem(db, {
    kind,
    title,
    brief: template.brief ?? title,
    createdBy,
    // createItem 现在缺省建于 ready，而 trigger 展开的初始 stage 由 §5.3 的 initial_stage
    // 决定，不能随缺省漂走：算出来是 draft 就必须显式 hold，否则"非 user 的 trigger 一律
    // 降级到 draft"这条权限传递会静默失效——lead 建的规则将直接产出可开跑的 item。
    hold: stage === "draft",
    priority: template.priority,
    project: template.project,
    // reminder 的 remind_at 必须每次触发时按 occurrence 注入，不能写死在静态模板里：
    // 写死会得到一个恒在过去的固定时刻；不写则 remind_at IS NULL，而 NULL <= now 恒为
    // NULL，该 reminder 永远停在 scheduled——正是本设计要消灭的静默丢失（spec §5.3）。
    remindAt: kind === "reminder" ? occurrenceAt : undefined,
    workdir: kind === "task" ? template.workdir : undefined,
  });
  addActivity(db, {
    itemId, actor: "system", kind: "comment",
    payload: { from_trigger: trigger.id, occurrence_at: occurrenceAt },
  });
  const origin = timerOriginOf(template.origin);
  if (origin && kind === "reminder") {
    recordReminderTimeSetter(db, itemId, { remindAt: occurrenceAt, setBy: createdBy === "user" ? "user" : "lead", actor: "lead", origin });
  }
  // 没问就设的外部来源规则照常到点了：校准样本「照做」（一个决策只记一次）。
  if (origin?.kind === "external") labelTimer(db, "trigger", trigger.id, "kept", "system");

  // stage='ready' 不再需要补一次 draft -> ready：item 本来就生于 ready，
  // 补跃迁只会撞上 "illegal transition ready -> ready"。展开的溯源痕迹由上面那条
  // from_trigger 的 activity 承担。
  return itemId;
}

function startRun(db: Db, itemId: number, trigger: Trigger, deps: TriggerActionDeps): void {
  // 闸门在这里显式跑一遍（spec §6.5），而不是只交给 startRun 里面那条路径：
  // 没接派发器时配错的 trigger 也必须当场失败，而不是安静地什么都没发生。
  assertRunAllowed(db, { itemId, role: "executor", purpose: "execution" });
  if (!deps.startRun) {
    throw new Error(
      `trigger #${trigger.id} action '${trigger.action_type}' has no runner wired`,
    );
  }
  deps.startRun(itemId);
}

// 返回本次触发产出/命中的 item id。
export function runTriggerAction(
  db: Db, trigger: Trigger, occurrenceAt: string, deps: TriggerActionDeps = {},
): number | null {
  const template = parsePayload(trigger);

  if (trigger.action_type === "create_item") {
    return createFromTemplate(db, trigger, template, occurrenceAt, "draft", deps);
  }

  if (trigger.action_type === "create_and_start") {
    // 声明 draft 又要求开跑是自相矛盾的：闸门只认 ready/active/blocked。
    if (template.initial_stage === "draft") {
      throw new Error(`trigger #${trigger.id} cannot create_and_start an item at 'draft'`);
    }
    const itemId = createFromTemplate(db, trigger, template, occurrenceAt, "ready", deps);
    startRun(db, itemId, trigger, deps);
    return itemId;
  }

  if (trigger.action_type === "start_item") {
    const itemId = template.item_id;
    if (typeof itemId !== "number" || !Number.isSafeInteger(itemId)) {
      throw new Error(`trigger #${trigger.id} start_item needs a numeric item_id`);
    }
    startRun(db, itemId, trigger, deps);
    return itemId;
  }

  throw new Error(`unknown trigger action '${trigger.action_type}'`);
}
