// 安全报警：daemon 发现有人绕过 API 直接改了账本里的权限设置（2026-10-19 审查）。
//
// 背景：一个 child 在 bash 里执行了 `sqlite3 plc.db "UPDATE connections SET write_policy = 'direct' …"`，
// 之后 GitHub 的写入都不再出确认卡，事件日志里也没有记录。现在 daemon 用保险库给每个连接的权限设置加封印，
// 启动时、每分钟、每次用到连接时核对。核对不上时，恢复成更严的值，并记下这里的事件、直接推送给用户。
//
// 和主人操作的提醒（owner-actions.ts）同级：interrupt 级，daemon 直接推，不经过 Lead。
// 改动可能就是一个 child 做的，提醒不能取决于 Lead 判断要不要说。没有发出操作的凭证，所以没有「不是我」。
import { Type } from "typebox";
import { describeConnectionSettings, type ConnectionSettings } from "./connections.ts";
import { registerEventKind, type EventKindDefinition } from "./events.ts";
import { DEFAULT_LEAD_NAME } from "./lead-profile.ts";

// 推送用的通知（notifications.kind）。daemon 直接推送它，不请 Lead 播报。不挂工单。
export const SECURITY_ALERT_NOTIFICATION_KIND = "security_alert";

export const CONNECTION_SETTINGS_TAMPERED_KIND = "connection.settings_tampered";
// child 的一条命令像是在直接写账本（plc.db）或配置（config.json）。规则：这两个文件可以读，不能写，改设置走 daemon 的 API。
export const LEDGER_WRITE_ATTEMPTED_KIND = "ledger.write_attempted";
// config.json 的内容变了，但不是 daemon 自己写的（设置页、Lead 换模型、plc lead use 都经 daemon 写）。
// 多半是用户自己手改的，所以它是 tell 级，交给 Lead 告诉用户，不直接推送（2026-10-19 审查）。
// child 改配置的命令另有 ledger.write_attempted（interrupt 级，直接推送）。
export const CONFIG_CHANGED_OUTSIDE_API_KIND = "config.changed_outside_api";
// 账本的写入守卫有触发器不见了，或者被换成了同名的别的触发器（有进程 DROP TRIGGER）。daemon 已经补装。
export const LEDGER_GUARD_REMOVED_KIND = "ledger.guard_removed";

// daemon 直接推送、不交给 Lead 的报警。config.changed_outside_api 不在里面：它交给 Lead。
export const PUSHED_SECURITY_ALERT_KINDS: readonly string[] = [
  "connection.settings_tampered", "ledger.write_attempted", "ledger.guard_removed",
];

// 封印的状态：missing 是这一行没有封印（功能上线前建的行，或者封印被删了），invalid 是封印解不开（被改过）。
export type ConnectionSettingsSealState = "valid" | "missing" | "invalid";

const SettingsPayload = Type.Object({
  roles: Type.Array(Type.String()),
  writePolicy: Type.String(),
});

export const SECURITY_ALERT_EVENT_KINDS: readonly EventKindDefinition[] = [
  {
    kind: CONNECTION_SETTINGS_TAMPERED_KIND,
    sources: ["system"],
    anomaly: true,
    payload: Type.Object({
      connection: Type.Object({ id: Type.Integer({ minimum: 1 }), key: Type.String(), label: Type.String() }),
      // 最后一次经设置页（或者连接时）定下的设置。没有封印、也没有改动记录时是缺省设置。
      expected: SettingsPayload,
      // 账本里发现的设置。
      found: SettingsPayload,
      // 恢复成的设置：expected 和 found 里更严的那一份。
      restored: SettingsPayload,
      seal: Type.Union([Type.Literal("valid"), Type.Literal("missing"), Type.Literal("invalid")]),
      notificationId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    }),
    description: "daemon 发现一个连接的权限设置（谁能用、写入策略）不是经设置页改的，已经恢复成更严的值。",
  },
  {
    kind: LEDGER_WRITE_ATTEMPTED_KIND,
    sources: ["system"],
    anomaly: true,
    payload: Type.Object({
      runId: Type.Integer({ minimum: 1 }),
      itemId: Type.Integer({ minimum: 1 }),
      target: Type.Union([Type.Literal("plc.db"), Type.Literal("config.json")]),
      // 那条命令，脱敏并截断过。
      command: Type.String(),
      notificationId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    }),
    description: "一个 child 执行的命令像是在直接写 plc.db 或 config.json。写库会被账本的写入守卫拦住；这条事件让用户知道它试过。",
  },
  {
    kind: CONFIG_CHANGED_OUTSIDE_API_KIND,
    sources: ["system"],
    anomaly: true,
    payload: Type.Object({
      // 变了的配置项，例如 env.GH_TOKEN、lead.models。只有名字，没有值。
      changed: Type.Array(Type.String()),
      notificationId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    }),
    description: "config.json 被 daemon 以外的进程改了（不是经设置页、Lead 的工具或 plc lead use）。tell 级，交给 Lead。",
  },
  {
    kind: LEDGER_GUARD_REMOVED_KIND,
    sources: ["system"],
    anomaly: true,
    payload: Type.Object({
      // 不见了的触发器（最多列 20 个）和总数。
      missing: Type.Array(Type.String()),
      count: Type.Integer({ minimum: 1 }),
      notificationId: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    }),
    description: "账本的写入守卫有触发器被删掉了。daemon 已经补装；删掉它的进程可能在准备直接改库。",
  },
];

for (const definition of SECURITY_ALERT_EVENT_KINDS) registerEventKind(definition);

/** 推送和收件箱里的文字。标题说发生了什么，正文说现在是什么、要用户做什么。 */
export function connectionSettingsTamperAlertText(input: {
  label: string;
  expected: ConnectionSettings;
  found: ConnectionSettings;
  restored: ConnectionSettings;
  seal: ConnectionSettingsSealState;
}): { title: string; body: string } {
  const how = input.seal === "invalid"
    ? "设置的封印对不上"
    : "账本里的设置和设置页的记录不一致";
  return {
    title: `${input.label} 的权限设置被绕过设置页修改，已恢复`,
    body: [
      `${how}：发现的是「${describeConnectionSettings(input.found)}」，记录的是「${describeConnectionSettings(input.expected)}」。`,
      `已恢复成更严的「${describeConnectionSettings(input.restored)}」。`,
      "这通常是有进程直接改了数据库（例如 child 用 sqlite3）。如果需要放开，请在设置 → 连接里改。",
    ].join("\n"),
  };
}

const TARGET_WORDS = { "plc.db": "账本 plc.db", "config.json": "配置 config.json" } as const;

export function ledgerWriteAttemptAlertText(input: {
  itemId: number; runId: number; target: "plc.db" | "config.json"; command: string;
}): { title: string; body: string } {
  return {
    title: `工单 #${input.itemId} 的 agent 想直接改${TARGET_WORDS[input.target]}`,
    body: [
      `Run #${input.runId} 执行了：${input.command}`,
      input.target === "plc.db"
        ? "plc.db 只能由 daemon 写，用 sqlite3 写库会被写入守卫拦住。"
        : "config.json 只能经 daemon 改（设置页）。",
      "请看看这个 agent 为什么要这样做。需要改设置时，在设置页改。",
    ].join("\n"),
  };
}

// leadName 是 Lead 的名字（设置 → 身份与风格），不给时用缺省的。
export function configChangedAlertText(changed: readonly string[], leadName: string = DEFAULT_LEAD_NAME): { title: string; body: string } {
  return {
    title: "config.json 被直接修改了",
    body: [
      changed.length ? `变了的配置项：${changed.join("、")}。` : "内容变了。",
      `这次修改不是经 daemon 做的（设置页、${leadName} 的工具都经 daemon 写）。如果是你自己改的，可以忽略；不是的话，请查一下是哪个进程改的。`,
    ].join("\n"),
  };
}

export function ledgerGuardRemovedAlertText(count: number): { title: string; body: string } {
  return {
    title: "plc.db 的写入守卫被删掉或换掉了，已补装",
    body: [
      `有 ${count} 个守卫触发器不见了或者被换过，daemon 已经补装。`,
      "删掉它们的进程可能在准备直接改库。请看看最近的 child 在做什么；连接的权限设置另有封印核对。",
      "如果是你自己为回滚卸掉的，先停 daemon 再卸（plc daemon ledger-guard uninstall）。",
    ].join("\n"),
  };
}
