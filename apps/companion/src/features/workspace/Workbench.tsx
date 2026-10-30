import { Screen } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';

import { LeadConversation } from '@/features/chat/LeadConversation';
import { useConnectionPhase } from '@/state/hooks';
import { WorkspaceBootShell } from './WorkspaceBootShell';

// 原生上的对话页。web 上的工作台见 Workbench.web.tsx。
export default function Workbench() {
  const phase = useConnectionPhase();
  const router = useRouter();

  if (phase === 'loading' || phase === 'connecting') {
    return <WorkspaceBootShell />;
  }

  return (
    <Screen edges={['top', 'bottom']} bg="surface">
      <LeadConversation
        compact
        onOpenAll={() => router.push('/tickets')}
        onToggleViews={() => router.push('/views')}
      />
    </Screen>
  );
}
