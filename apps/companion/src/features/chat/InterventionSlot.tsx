import { Card, Text } from '@pi-lead-child/components';

import { useCompanionRuntime, useControlPlaneStore, useWorkspaceStore } from '../../state/CompanionStateProvider';
import { useConnectionState, useLeadName, useTicketCheckpoints, useTicketInterventions } from '../../state/hooks';
import { InterventionCard } from './InterventionCard';
import { useOpenTicket } from './useOpenTicket';

// 一条介入请求，只凭编号画（genui 的对象节点 Intervention，2026-10-27）：和会话里的介入请求卡是同一张。
// 请求的现状从这张工单的介入请求里取；child 写这一步时的检查点（卡片头部写 child 自己的话）从这张工单的检查点里取。
// 取不到请求时（这台设备还没同步到），先写一行占位，同步到以后就是整张卡。
export function InterventionSlot({ kind, id, ticket, checkpoint }: {
  kind: 'approval' | 'decision';
  id: number;
  ticket: number;
  checkpoint?: number;
}) {
  const runtime = useCompanionRuntime();
  const connected = useConnectionState() === 'connected';
  const leadName = useLeadName();
  const openTicket = useOpenTicket();
  const interventionId = `${kind}:${id}`;
  const { interventions } = useTicketInterventions(ticket);
  const { checkpoints } = useTicketCheckpoints(ticket);
  const held = useControlPlaneStore((state) => (checkpoint === undefined ? undefined : state.checkpointsById[checkpoint]));
  const commandState = useWorkspaceStore((state) => state.interventionCommandStateById[interventionId]);
  const intervention = interventions.find((item) => item.id === interventionId);
  const found = held ?? checkpoints.find((item) => item.id === checkpoint);
  if (!intervention) {
    return (
      <Card testID={`intervention-slot-${interventionId}`} w="100%" p="card" rounded="xl" borderWidth={1} borderColor="border">
        <Text size="secondary" tone="secondary">{`${kind === 'approval' ? '审批' : '决定'} #${id}（工单 #${ticket}）正在同步。`}</Text>
      </Card>
    );
  }
  return (
    <InterventionCard
      {...(found ? { checkpoint: found } : {})}
      commandState={commandState}
      intervention={intervention}
      leadName={leadName}
      onOpenTicket={openTicket}
      onResolve={connected ? (command) => runtime.resolveIntervention(interventionId, command) : undefined}
      showOpenTicket={false}
    />
  );
}
