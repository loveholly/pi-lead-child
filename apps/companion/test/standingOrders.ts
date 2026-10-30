import type { StandingOrderProposalDto } from '@pi-lead-child/protocol';

// 常设指令页和会话确认卡的测试数据（工单 10）：Paimon 提议把 inbox.wake_lead 从 tell 降到 digest，审批号 42。
export function proposal(overrides: Partial<StandingOrderProposalDto> = {}): StandingOrderProposalDto {
  return {
    approvalId: 42, orderId: 'inbox.wake_lead', op: 'update', state: 'pending', voidedReason: null,
    summary: '修改常设指令 inbox.wake_lead', reason: 'blocker 太多，先进摘要', title: '要叫醒 Lead 的事告诉 Lead',
    baseVersion: 1, appliedVersion: null, rollbackTo: null, proposedStatus: 'active', definition: {},
    findings: [
      { tier: 'permissive', aspect: 'level', detail: '匹配的事件从 tell（单独告诉）改为 digest（进摘要），交给人的更少或者自动做的更多' },
      { tier: 'conservative', aspect: 'title', detail: '标题改了' },
    ],
    requestedAt: '2026-10-17T08:00:00.000Z', expiresAt: '2026-10-18T08:00:00.000Z', resolvedBy: null, resolvedAt: null,
    ...overrides,
  };
}
