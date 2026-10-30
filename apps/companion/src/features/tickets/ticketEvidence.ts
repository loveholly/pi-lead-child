// 验收证据的拆分（工单 #66 复核 F6/F7）。
//
// 以前清单把所有 Run 报过的条目混在一起：#66 上两个两个月前的红叉（Run #42，交付之前）和一条
// 后来证明它们不成立的通过项（Run #45）并排显示，而最新交付 Run #49 的验证结果一条都没有——
// 它们在成果快照里。标题还用正则把 agent 自己的借口（沙箱权限错误）改判成环境问题，可 reviewer
// 已经驳回了那句话。
//
// 现在：本次交付的证据 = 它的成果快照里的验证结果 + 它自己报的 proof items；更早 Run 的条目
// 按 Run 分组放进"历史证据"，并写明被哪次交付取代。条目的状态只用数据里的状态，不再猜。
import type { KernelOutcomeSnapshotResource, KernelTicketPow } from '@pi-lead-child/protocol';

export type EvidenceState = 'passed' | 'failed' | 'pending' | 'not_run';

export type EvidenceRow = {
  id: string;
  label: string;
  detail: string;
  state: EvidenceState;
};

export type EvidenceGroup = {
  attemptId: number | null;
  title: string;
  rows: EvidenceRow[];
};

export type EvidencePresentation = {
  deliveryAttemptId: number | null;
  currentTitle: string;
  current: EvidenceRow[];
  history: EvidenceGroup[];
  summary: { title: string; tone: 'muted' | 'attention' | 'passed'; mark: '✓' | '!' | '·' };
  needsAttention: boolean;
};

const STATE_WORD: Record<EvidenceState, string> = {
  passed: '项通过',
  failed: '项未通过',
  pending: '项待补证据',
  not_run: '项未运行',
};

function powRow(item: KernelTicketPow['items'][number]): EvidenceRow {
  return { id: `proof-${item.id}`, label: item.label, detail: item.evidence ?? '等待新的 Checkpoint 证据', state: item.state };
}

export function buildEvidencePresentation(
  pow: KernelTicketPow | null,
  outcome: KernelOutcomeSnapshotResource | null | undefined,
): EvidencePresentation {
  const snapshot = outcome?.latest ?? null;
  const delivery = pow?.deliveryAttemptId ?? snapshot?.executorAttemptId ?? null;
  const items = pow?.items ?? [];
  // 旧 daemon 不给 attemptId：没法区分，就全部当作当前证据（与以前的显示相同）。
  const attributed = items.some((item) => item.attemptId !== undefined);
  // 条目属于哪一次交付：reviewer 和工单对话报的条目属于它们之前那次交付。
  // 不给 deliveryAttemptId 的 daemon 只能按报告它的 Run 算。
  const deliveryOf = (item: KernelTicketPow['items'][number]) =>
    item.deliveryAttemptId !== undefined ? item.deliveryAttemptId : item.attemptId ?? null;
  const isCurrent = (item: KernelTicketPow['items'][number]) =>
    !attributed || delivery === null || deliveryOf(item) === delivery;

  const current: EvidenceRow[] = [
    ...(snapshot && snapshot.executorAttemptId === delivery
      ? snapshot.validations.map((validation, index): EvidenceRow => ({
          id: `validation-${index}`,
          label: validation.command,
          detail: validation.summary,
          state: validation.outcome,
        }))
      : []),
    ...items.filter(isCurrent).map(powRow),
  ];

  const historyById = new Map<number | null, EvidenceRow[]>();
  for (const item of items.filter((entry) => !isCurrent(entry))) {
    const key = deliveryOf(item);
    historyById.set(key, [...(historyById.get(key) ?? []), powRow(item)]);
  }
  const history = [...historyById.entries()]
    .sort(([left], [right]) => (right ?? 0) - (left ?? 0))
    .map(([attemptId, rows]): EvidenceGroup => ({
      attemptId,
      title: `${attemptId === null ? '系统记录' : `Run #${attemptId}`} 的证据 · 已被 Run #${delivery} 取代`,
      rows,
    }));

  const counts = current.reduce<Record<EvidenceState, number>>(
    (total, row) => ({ ...total, [row.state]: total[row.state] + 1 }),
    { passed: 0, failed: 0, pending: 0, not_run: 0 },
  );
  const open = counts.failed + counts.pending + counts.not_run;
  const summary = current.length === 0
    ? { title: delivery === null ? '还没有可验证证据' : `Run #${delivery} 没有登记验证结果`, tone: 'muted' as const, mark: '·' as const }
    : {
        title: (['passed', 'failed', 'not_run', 'pending'] as const)
          .filter((state) => counts[state] > 0)
          .map((state) => `${counts[state]} ${STATE_WORD[state]}`)
          .join(' · '),
        tone: open > 0 ? 'attention' as const : 'passed' as const,
        mark: open > 0 ? '!' as const : '✓' as const,
      };
  return {
    deliveryAttemptId: delivery,
    currentTitle: delivery === null ? '当前证据' : `本次交付 · Run #${delivery}`,
    current,
    history,
    summary,
    needsAttention: open > 0 || (pow?.metrics.pendingInterventionCount ?? 0) > 0,
  };
}
