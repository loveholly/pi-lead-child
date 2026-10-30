import { AppearanceSection } from '@/features/settings/AppearanceSection';
import { APPEARANCE_DESCRIPTION } from '@/features/settings/appearanceModel';
import { SettingsPage } from '@/features/settings/SettingsPage';

export default function AppearanceRoute() {
  return (
    <SettingsPage title="外观" description={APPEARANCE_DESCRIPTION}>
      <AppearanceSection />
    </SettingsPage>
  );
}
