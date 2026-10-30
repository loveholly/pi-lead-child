import { Badge, Button, Column, Row, Text } from '@pi-lead-child/components';
import type { StandingOrderProposalDto } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

import { proposalConcerns, proposalOutcome, proposalTitle, shortTime, standingOrderErrorText } from './standingOrderModel';

// Lead 提议的一次常设指令修改（更放开的那一档，工单 10）。设置页和会话里的 StandingOrderChangeConfirm 卡用同一个。
// 「批准」走 POST /v1/standing-order-proposals/:id/decision（权限 approvals:respond），Lead 的工具走不到那里。
// 内容（标题、原因、为什么要你批准）都从 daemon 读：理由是系统比较新旧版本写的，不是 Lead 自己说的。
// 标题和系统的判断里的「Lead」换成 Lead 的名字（withLeadName）；Lead 写的原因原样显示。
export function StandingOrderProposalView({ proposal, onChange, testID }: {
  proposal: StandingOrderProposalDto;
  // 决定以后（或者决定失败后重读）的新状态。
  onChange: (next: StandingOrderProposalDto) => void;
  testID?: string;
}) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outcome = proposalOutcome(proposal);
  const id = testID ?? `standing-order-proposal-${proposal.approvalId}`;

  const decide = (approve: boolean) => {
    setSubmitting(true);
    setError(null);
    runtime.decideStandingOrderProposal(proposal.approvalId, approve)
      .then((response) => onChange(response.proposal), (reason: unknown) => {
        setError(standingOrderErrorText(reason));
        // 已经处理过、过期或者作废（409）：重读一次，显示它现在的状态。
        runtime.standingOrderProposal(proposal.approvalId).then((response) => onChange(response.proposal), () => {});
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Column testID={id} gap="card-row">
      <Row items="center" gap="inline-item">
        <Text flex={1} size="card-title" weight="bold">{proposalTitle(proposal, leadName)}</Text>
        {proposal.state === 'pending' ? <Badge label="要你批准" tone="warning" dot size="sm" /> : null}
      </Row>
      <Text testID={`${id}-reason`} size="body">{`${leadName} 的原因：${proposal.reason}`}</Text>
      <Column gap="text-stack">
        <Text size="eyebrow" weight="bold" tone="secondary">系统的判断</Text>
        {proposalConcerns(proposal, leadName).map((line, index) => (
          <Text key={index} testID={`${id}-concern-${index}`} size="secondary" tone="secondary">{`· ${line}`}</Text>
        ))}
      </Column>
      {proposal.state === 'pending' ? (
        <Column gap="card-section">
          <Text size="note" tone="muted">
            {`不批准时指令照旧。${shortTime(proposal.expiresAt)} 前没有决定就作废。以后也可以在设置 → 常设指令里回滚。`}
          </Text>
          <Row gap="actions" flexWrap="wrap">
            <Button testID={`${id}-approve`} label="批准" disabled={submitting} onPress={() => decide(true)} />
            <Button testID={`${id}-reject`} label="不批准" variant="outline" tone="neutral" disabled={submitting} onPress={() => decide(false)} />
          </Row>
        </Column>
      ) : null}
      {outcome ? <Text testID={`${id}-result`} size="label" weight="bold" tone={outcome.tone}>{outcome.label}</Text> : null}
      {error ? <Text testID={`${id}-error`} size="secondary" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}
