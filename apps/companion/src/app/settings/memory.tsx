import { memoryDescription } from '@/features/settings/memoryModel';
import { MemorySection } from '@/features/settings/MemorySection';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLeadName } from '@/state/hooks';

export default function MemoryRoute() {
  const leadName = useLeadName();
  return (
    <SettingsPage title="记忆" description={memoryDescription(leadName)}>
      <MemorySection />
    </SettingsPage>
  );
}
