import { connectionsDescription } from '@/features/settings/connectionModel';
import { ConnectionsSection } from '@/features/settings/ConnectionsSection';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLeadName } from '@/state/hooks';

export default function ConnectionsRoute() {
  const leadName = useLeadName();
  return (
    <SettingsPage title="连接" description={connectionsDescription(leadName)}>
      <ConnectionsSection connectionId={null} />
    </SettingsPage>
  );
}
