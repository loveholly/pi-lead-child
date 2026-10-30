import { DeviceSection } from '@/features/settings/DeviceSection';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLeadName } from '@/state/hooks';

export default function DeviceRoute() {
  const leadName = useLeadName();
  return (
    <SettingsPage title="本设备" description={`这台设备和 ${leadName} 的配对。`}>
      <DeviceSection />
    </SettingsPage>
  );
}
