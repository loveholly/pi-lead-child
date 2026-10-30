import { runtimesDescription, RuntimesSection } from '@/features/settings/RuntimesSection';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLeadName } from '@/state/hooks';

export default function RuntimesRoute() {
  const leadName = useLeadName();
  return (
    <SettingsPage title="执行器" description={runtimesDescription(leadName)}>
      <RuntimesSection />
    </SettingsPage>
  );
}
