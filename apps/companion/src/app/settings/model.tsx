import { modelDescription } from '@/features/settings/memoryModel';
import { ModelSection } from '@/features/settings/ModelSection';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLeadName } from '@/state/hooks';

export default function ModelRoute() {
  const leadName = useLeadName();
  return (
    <SettingsPage title="模型" description={modelDescription(leadName)}>
      <ModelSection />
    </SettingsPage>
  );
}
