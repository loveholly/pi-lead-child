// Lead 的工具清单（.scratch/tool-occupancy/spec.md L2，2026-11-11）。
//
// 每个工具声明两件事，中止兜底（tool-abort-guard.ts）按声明处理一次调用：
//   · effect：read 只读，write 改东西。这一步被调度器中止时，只读的调用收到中止信号、停下；改东西的不停，马上转后台
//     （用户 2026-11-11：插话到达时系统不知道它是「停下」还是「补充」，转后台可以撤回，杀掉不能）。用户 /stop、停机排空时都停。
//   · duration：instant 只读写本机数据库，2 秒内结束，超过写一行 [sched] tool.overrun；bounded 有自己的时限
//     （网络调用、git、子进程）；long 可能跑很久（命令、脚本），必须接收中止信号，停得下来。
// 不管哪一种，Lead 的一步里一个调用都占不过软时限（20 秒），插话到达时也马上转后台（spec I2）。
//
// 新加的工具要在这里声明，test/tool-manifest.test.ts 会列出 Lead、子 agent 会话里注册的全部工具检查。
// 运行时碰到没声明的工具（例如以后 SoL-Pi 新加的），按 write + long 处理：最保守，不会被中途杀掉，也占不住这一步。

export type ToolEffect = "read" | "write";
export type ToolDuration = "instant" | "bounded" | "long";

export interface ToolDeclaration {
  effect: ToolEffect | ((args: unknown) => ToolEffect);
  duration: ToolDuration;
}

const read = (duration: ToolDuration): ToolDeclaration => ({ effect: "read", duration });
const write = (duration: ToolDuration): ToolDeclaration => ({ effect: "write", duration });

function many(names: readonly string[], declaration: ToolDeclaration): Array<[string, ToolDeclaration]> {
  return names.map((name) => [name, declaration]);
}

const INSTANT_READS = [
  // 工单、项目、日程、规则、子 agent 的报告。
  "query_tickets", "get_ticket", "get_ticket_status", "get_ticket_relations", "get_ticket_tree", "get_session_entries",
  "read_run_events", "list_needs_user", "list_approvals", "list_learning_candidates", "get_capability", "list_milestones",
  "get_project", "list_items", "agenda", "list_triggers", "list_watches", "list_ticket_actions", "list_actions",
  "get_delegation_policy", "list_standing_orders", "get_standing_order", "preflight_delegation",
  // 账本、收件箱、通知、以前的回合、笔记、设置。
  "query_events", "read_inbox", "read_notifications", "get_triage_shadow_report", "read_lead_turns", "search_notes",
  "get_system_usage", "get_environment", "suggest_route", "list_connections", "read_connection_result", "read_signal_items",
  "read_agenda_entries",
] as const;

const INSTANT_WRITES = [
  "create_task", "create_reminder", "create_project", "set_display_title", "set_milestone", "update_milestone",
  "update_agenda_note", "update_project_summary", "link_project_repository", "merge_projects", "link_tickets",
  "authorize_retry", "register_run_outcome", "request_runtime_maintenance", "clear_lead_model_quota", "switch_lead_model",
  "save_note", "update_note", "invalidate_memory", "create_cron_trigger", "create_once_trigger", "set_trigger_enabled",
  "add_comment", "record_decision", "create_continuation", "ack_reminder", "update_item", "reschedule_reminder", "defer_item",
  "confirm_item", "render_ui", "follow_up", "cancel_follow_up", "record_disposition", "watch", "wait_for_user_action",
  "cancel_wait", "record_handback", "mark_channel_card_handled", "propose_standing_order_change", "update_lead_profile",
  "update_design_preferences", "repick_situation", "hand_off", "resume_unit", "submit_result", "update_plan", "stop_job",
] as const;

// 本机文件、网络读、子进程读：有自己的时限或者很快，但不止读数据库。
const BOUNDED_READS = [
  "read", "grep", "find", "ls", "obs_recall", "find_skill", "list_processes", "get_runtime_health", "get_model_catalog",
  "list_lead_models", "list_channel_conversations", "find_channel_conversations", "read_channel_conversation",
  "read_channel_file", "search_connection_tools", "read_ticket_attachment",
] as const;

// 写文件、发消息、git、派 child、工单操作（可能推分支、开 PR）。
const BOUNDED_WRITES = [
  "edit", "write", "spawn_child", "ticket_action", "recover_ticket_run", "continue_ticket_agent", "steer_child",
  "complete_delivery", "release_workspace", "cleanup_workspace", "resolve_workspace", "provision_workspace",
  "integrate_workspace", "notify_user", "perform_action", "send_channel_message", "react_channel_message", "reply_to_source",
  "dispatch_agent_task", "attach_to_ticket", "set_lead_avatar",
] as const;

/** bash 标了 read_only 的是只读（lead-scheduler spec D6），其余按改东西算。 */
function bashEffect(args: unknown): ToolEffect {
  return (args as { read_only?: unknown } | null)?.read_only === true ? "read" : "write";
}

export const LEAD_TOOL_MANIFEST: ReadonlyMap<string, ToolDeclaration> = new Map<string, ToolDeclaration>([
  ...many(INSTANT_READS, read("instant")),
  ...many(INSTANT_WRITES, write("instant")),
  ...many(BOUNDED_READS, read("bounded")),
  ...many(BOUNDED_WRITES, write("bounded")),
  ["bash", { effect: bashEffect, duration: "long" }],
  // 免沙箱时直接在用户的 Mac 上跑命令（下载、brew 升级）：2026-11-10 的事故就是它。
  ["run_on_host", write("long")],
  // 脚本里连着调别的工具（嵌套的调用不经过这一层）：按改东西算，跑过软时限转后台（用户 2026-11-11）。
  ["codemode", write("long")],
  // 连接的工具由外部服务器实现，可能很慢；只读的（服务器标了 readOnlyHint）由 red-line.ts 按连接再判断。
  ["call_connection_tool", write("long")],
]);

export const UNDECLARED_TOOL: ToolDeclaration = write("long");

/** 这个工具的声明。没声明的返回 undefined（调用方按 UNDECLARED_TOOL 处理）。 */
export function toolDeclaration(name: string): ToolDeclaration | undefined {
  return LEAD_TOOL_MANIFEST.get(name);
}

/** 这一次调用是只读还是改东西。没声明的按改东西算。 */
export function toolEffect(name: string, args: unknown): ToolEffect {
  const effect = (toolDeclaration(name) ?? UNDECLARED_TOOL).effect;
  return typeof effect === "function" ? effect(args) : effect;
}

export function toolDuration(name: string): ToolDuration {
  return (toolDeclaration(name) ?? UNDECLARED_TOOL).duration;
}
