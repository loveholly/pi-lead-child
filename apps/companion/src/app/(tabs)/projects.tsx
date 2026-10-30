import { CollectionScreen } from '@/components/CollectionScreen';
import { ProjectList } from '@/features/workspace/ProjectList';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useProjectOverviews } from '@/state/hooks';

export default function ProjectsScreen() {
  const runtime = useCompanionRuntime();
  const phase = useConnectionPhase();
  const overviews = useProjectOverviews();
  return (
    <CollectionScreen title="项目" subtitle="在推进的在前，安静的和归档的收在下面">
      <ProjectList
        overviews={phase === 'ready' ? overviews : null}
        onSetArchived={(projectId, archived) => runtime.setProjectArchived(projectId, archived)}
      />
    </CollectionScreen>
  );
}
