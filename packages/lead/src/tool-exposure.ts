// Lead 的工具怎样给到模型（2026-10-28，文档「按需加载方案」，用户定的）。
// 工具的说明和参数每一轮都发给模型：93 个工具约 8 万字符，比系统提示词还大。所以按线上的调用次数分两类：
//   - 常驻（pi 的 exposure 缺省 direct）：每一轮声明给模型。最近 14 天 96% 的调用落在它们上面。
//   - codemode：不声明给模型，系统提示词的「不常用的工具在 codemode 里」一节列出它们的名字，Lead 在 codemode 脚本里用 tools.<名字>(参数) 调。
//     它们 14 天一共只被调了几十次。调用走的是同一个工具，同样的检查、钩子和账本。
// 不用「按事件或按需启用」：声明的工具一变，整段请求的提示缓存就失效。codemode 下声明的集合固定。
// 要授权才启用的工具（GRANT_GATED_LEAD_TOOLS，例如 confirm_item）不能放这里：codemode 的工具只要注册了就能调，
// 会绕过授权。它们保持 direct，没授权时不激活（session.ts 的 leadActiveToolNames）。
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 放进 codemode 的工具，按用途分组。名单之外的 Lead 工具都常驻。分组也用在「你运行的环境」一节，让 Lead 知道有哪些。 */
export const LEAD_CODEMODE_TOOL_GROUPS: ReadonlyArray<{ label: string; tools: readonly string[] }> = [
  {
    label: "时间和日程",
    tools: [
      "create_cron_trigger", "create_once_trigger", "set_trigger_enabled", "list_triggers", "reschedule_reminder", "ack_reminder",
      "defer_item", "agenda", "update_agenda_note", "set_milestone", "update_milestone", "list_milestones", "cancel_follow_up",
      // 后台检查（2026-10-28 合并 master 时归类）：watch 常驻，提示词要 Lead 在发出请求的同一轮里就设；
      // 列出检查的 list_watches 少用，用户在提醒卡上就能看到它们。
      "list_watches",
    ],
  },
  {
    label: "项目和少用的工单操作",
    tools: [
      "create_project", "merge_projects", "update_project_summary", "link_project_repository", "get_project", "set_display_title",
      "get_ticket_tree", "list_items", "update_item", "steer_child",
      "authorize_retry", "record_handback",
    ],
  },
  {
    label: "验收和托管",
    tools: [
      "complete_delivery", "create_continuation", "preflight_delegation", "register_run_outcome",
      "get_capability", "list_learning_candidates",
    ],
  },
  { label: "工作区", tools: ["provision_workspace", "release_workspace", "cleanup_workspace", "integrate_workspace"] },
  {
    label: "设置和系统",
    tools: [
      "update_lead_profile", "set_lead_avatar", "update_design_preferences", "switch_lead_model", "clear_lead_model_quota",
      "propose_standing_order_change", "get_standing_order", "list_standing_orders", "get_triage_shadow_report",
      "read_lead_turns", "request_runtime_maintenance", "suggest_route",
      // 沙箱里跑不了 ps（2026-10-29）：daemon 在沙箱外读进程表。少用。
      "list_processes",
      // get_system_usage 常驻（2026-10-28 合并时改回）：系统提示词点名用它回答「某个组件被调用了几次」，
      // 用户真的这样问过（daemon 的 lead-self-knowledge 场景 10）。说明约 300 token。
      // get_environment 也常驻（2026-10-30）：「你运行的环境」不再写现在的值，点名用它现查。
    ],
  },
  { label: "外部通道", tools: ["list_channel_conversations", "mark_channel_card_handled"] },
];

export const LEAD_CODEMODE_TOOLS: ReadonlySet<string> = new Set(LEAD_CODEMODE_TOOL_GROUPS.flatMap((group) => group.tools));

/**
 * codemode 的说明里不列这些工具的签名（session.ts 把 inlineBudget 设成 0）：列 38 个要多发约 5,600 token。
 * 改由系统提示词「不常用的工具在 codemode 里」一节列出它们的名字，参数要用时在脚本里用 describeTool 查。
 */
export const LEAD_CODEMODE_INLINE_BUDGET = 0;

/** 系统提示词里放在 codemode 的工具名，按用途分组，每组一行。名单固定，不影响提示缓存。 */
export function codemodeToolList(): string {
  return LEAD_CODEMODE_TOOL_GROUPS.map((group) => `- ${group.label}：${group.tools.join("、")}`).join("\n");
}

/** 按名单给 Lead 的工具设 exposure：名单里的放进 codemode，其余照旧常驻。 */
export function applyLeadToolExposure<T extends ToolDefinition<any>>(tools: T[]): T[] {
  return tools.map((tool) => (LEAD_CODEMODE_TOOLS.has(tool.name) ? { ...tool, exposure: "codemode" as const } : tool));
}
