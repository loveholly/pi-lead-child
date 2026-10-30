import type { Ticket } from '@/features/workspace/model';

import { TicketRecords } from './TicketRecords';
import { useTicketDetailModel } from './useTicketDetailModel';

// 桌面上的「证据与记录」：占 Lead 会话栏，数据和工单面板读同一个 useTicketDetailModel。
export function ConnectedTicketRecords({ ticket }: { ticket: Ticket }) {
  const model = useTicketDetailModel(ticket);
  return (
    <TicketRecords
      key={ticket.id}
      variant="page"
      onClose={() => model.onRecordsOpenChange?.(false)}
      ticket={model.ticket}
      checkpoints={model.checkpoints}
      checkpointResource={model.checkpointResource}
      interventions={model.interventions}
      interventionCommandStates={model.interventionCommandStates}
      onResolveIntervention={model.onResolveIntervention}
      resolutionError={model.resolutionError}
      onRetryCheckpoints={model.onRetryCheckpoints}
      onOpenTicket={model.onOpenTicket}
      runFacts={model.runFacts}
      pow={model.pow}
      outcome={model.outcome}
      attempts={model.attempts}
      logs={model.logs}
      logRuns={model.logRuns}
      lifecycle={model.lifecycle}
      executionResource={model.executionResource}
      onRetryExecution={model.onRetryExecution}
      artifacts={model.artifacts}
      artifactCapability={model.artifactCapability}
      artifactDownloadStates={model.artifactDownloadStates}
      onDownloadArtifact={model.onDownloadArtifact}
      onCancelArtifactDownload={model.onCancelArtifactDownload}
    />
  );
}
