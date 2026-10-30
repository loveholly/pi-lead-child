// 生命周期里一条决策活动的标题。服务端写的是机器 id（rework_grant_attributed、runtime_failure_classified…），
// 界面上只给人看的话。#66 的生命周期里 56 行有 13 行直接显示了原始 id。
// 没收录的 id 不原样当标题：标题写「系统记录」，id 留在说明里，方便排查。
// 称呼 Lead 的标题写 Lead 的名字（leadName，useLeadName 取到的）。

function titles(leadName: string): Record<string, string> {
  return {
    // 派发与返工
    dispatch_requested: '派发请求已入队',
    rework_dispatch_requested: '返工已请求，等待派发',
    rework_request_replayed: '返工请求已存在',
    rework_grant_attributed: `返工计入 ${leadName} 托管的额度`,
    auto_redispatch: '自动重新派发',
    retry_authorized: '已授权重试',
    start_authorized: '你在对话里确认开工',
    retry_exhaustion_repaired: '修正了重试额度的记录',
    dispatch_blocked_by_ticket_relation: '派发受依赖阻塞',
    dispatch_blocked_retry_exhausted: '派发受重试额度阻塞',
    dispatch_blocked_by_budget: '派发受预算阻塞',
    dispatch_refused_by_preflight: '派发前检查没有通过',
    dispatch_refused_by_run_gate: '派发被运行闸门拒绝',
    dispatch_suspended_by_runtime_health: '派发暂停：runtime 暂时不可用',
    run_start_refused: 'Run 没有启动',
    dispatch_start_refused_requeued: 'Run 没有启动，稍后重新派发',
    transient_retry_scheduled: '临时故障，已安排自动重试',
    transient_retry_exhausted: '临时故障，自动重试已用完',
    // 核查与验收
    review_requested_by_user: '你派发了独立核查',
    review_requested_by_lead: `${leadName} 派发了独立核查`,
    reviewer_runtime_switched: '换了核查员',
    workspace_pr_opened: '开了草稿 PR',
    delivery_file_opened: '在电脑上打开了交付的文件',
    review_request_expired: '核查请求已作废',
    automatic_review_request_failed: '自动派发核查失败',
    delegated_review_accept: `${leadName} 按托管验收通过`,
    delegated_review_rework: `${leadName} 按托管打回返工`,
    delegated_review_escalate: `${leadName} 把核查结果转给你决定`,
    delegated_delivery_completed: `${leadName} 按托管完成交付`,
    delegation_preflight_accepted: `你授权 ${leadName} 托管`,
    delegation_preflight_blocked: `${leadName} 托管的前置检查没有通过`,
    // 核查没做成（工单 11）
    review_retry_requested: '重试了核查',
    review_verdict_discarded: '工单已经离开待验收，这次核查的结论没有登记',
    accepted_without_review: '没有独立核查，直接验收',
    // 成果登记
    outcome_repair_requested: '已请求补登记成果',
    outcome_repaired: '成果已补登记',
    outcome_repair_failed: '成果补登记失败',
    outcome_repair_cancelled: '成果补登记已取消',
    outcome_repair_request_failed: '成果补登记请求失败',
    outcome_registered_from_run_evidence: '从 Run 的输出补登记了成果',
    outcome_normalized: '成果记录已规整',
    invalid_outcome_envelope: '成果格式无效',
    spurious_outcome_record_removed: '删除了一条误报的「成果未登记」记录',
    historical_outcome_blocker_reconciled: '撤回了一条历史的成果阻塞',
    // runtime
    runtime_selected: '选定执行的 runtime',
    runtime_failure_classified: '系统判断了 runtime 失败的原因',
    runtime_session_expired: '原来的会话已过期，已开新会话',
    runtime_incident_opened: 'runtime 故障',
    runtime_incident_recurred: 'runtime 故障再次出现',
    runtime_recovery_queued: 'runtime 恢复已排队',
    runtime_recovery_selected: '选定恢复用的 runtime',
    runtime_recovery_rejected: 'runtime 恢复被拒绝',
    runtime_canary_released: 'runtime 恢复检查通过',
    runtime_health_retry_superseded: 'runtime 重试被新的检查取代',
    ticket_runtime_switched: '执行 agent 已切换',
    // 换模型和推理强度、换执行 agent（工单 08）
    execution_profile_selected: '选定了模型和推理强度',
    run_profile_changed: '换了模型和推理强度',
    executor_runtime_changed: '换了执行 agent',
    token_usage_recomputed: '按新口径重算了 token 用量',
    ticket_agent_run_activated: '启动了工单 agent',
    ticket_agent_turn_text_restored: '补回了被截断的对话回复',
    tool_bridge_restore_failed: '工具通道没有恢复',
    false_crash_projection_repaired: '修正了一条误报的崩溃记录',
    review_verdict_waiting_user: '核查有结论，等你决定',
    // 重启与登记
    restart_recovery: '重启后恢复',
    restart_crash_loop: '重启后反复崩溃',
    registration_pending: '等待登记',
    registration_reregistered: '重新登记',
    // 验收标准（工单 05）
    acceptance_criteria_edited: '改了验收标准',
    criterion_confirmed: '确认了一条验收标准',
    criterion_unconfirmed: '取消确认一条验收标准',
    // 关系与工作区
    link_ticket_relation: '建立工单关系',
    relation_execution_gate_migrated: '关系的启动条件已迁移',
    workspace_release: '释放工作区',
    workspace_cleanup: '清理工作区',
  };
}

const VERDICT_TITLES: Record<string, Record<string, string>> = {
  review_verdict_waiting_user: { fail: '核查不通过，等你决定', pass: '核查通过，等你验收' },
};

// 按凭什么做的分开写（payload.authority）。托管下 Lead 凭证据验收（工单 11，D11），要写明没有独立核查。
function authorityTitle(decision: string, authority: unknown, leadName: string): string | undefined {
  if (decision === 'accepted_without_review' && authority === 'delegated') return `没有独立核查，${leadName} 凭证据代为验收`;
  return undefined;
}

export type DecisionLabel = {
  title: string;
  /** 没收录的机器 id。界面放在说明里，不当标题。 */
  unknownId: string | null;
};

export function decisionLabel(decision: string | null, leadName: string, payload: Record<string, unknown> = {}): DecisionLabel {
  if (decision === null) {
    // 决策类 checkpoint 写的活动没有 decision，只有标题和摘要。
    const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : '记录决策';
    return { title, unknownId: null };
  }
  const verdict = typeof payload.verdict === 'string' ? payload.verdict : null;
  const byVerdict = verdict ? VERDICT_TITLES[decision]?.[verdict] : undefined;
  if (byVerdict) return { title: byVerdict, unknownId: null };
  const byAuthority = authorityTitle(decision, payload.authority, leadName);
  if (byAuthority) return { title: byAuthority, unknownId: null };
  const known = titles(leadName)[decision];
  if (known) return { title: known, unknownId: null };
  // 用户动作直接用中文记（「开始执行」「停止执行」），不是机器 id。
  if (!/^[a-z0-9_]+$/.test(decision)) return { title: decision, unknownId: null };
  return { title: '系统记录', unknownId: decision };
}
