import { DevicesSection } from '@/features/settings/DevicesSection';
import { SettingsPage } from '@/features/settings/SettingsPage';

export default function DevicesRoute() {
  return (
    <SettingsPage title="已配对设备" description="和这台 daemon 配对过的设备。">
      <DevicesSection />
    </SettingsPage>
  );
}
