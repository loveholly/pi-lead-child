import { useRouter } from 'expo-router';

import { CollectionScreen } from '@/components/CollectionScreen';
import { AgendaTimeline } from '@/features/workspace/AgendaTimeline';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useTimeline } from '@/state/hooks';

export default function AgendaScreen() {
  const router = useRouter();
  const runtime = useCompanionRuntime();
  const phase = useConnectionPhase();
  const timeline = useTimeline();
  return (
    <CollectionScreen title="日程" subtitle="过期的在上面，今天和接下来的在下面">
      <AgendaTimeline
        timeline={phase === 'ready' ? timeline : null}
        onOpenTicket={(ticketId) => router.push(`/ticket/${ticketId}`)}
        onUpdateMilestone={(milestoneId, patch) => runtime.updateMilestone(milestoneId, patch)}
      />
    </CollectionScreen>
  );
}
