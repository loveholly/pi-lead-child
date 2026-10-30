import { channelsDescription, ChannelSettingsSection } from '@/features/settings/ChannelSettingsSection';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLeadName } from '@/state/hooks';

export default function ChannelsRoute() {
  const leadName = useLeadName();
  return (
    <SettingsPage title="消息通道" description={channelsDescription(leadName)}>
      <ChannelSettingsSection />
    </SettingsPage>
  );
}
