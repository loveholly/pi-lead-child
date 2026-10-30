import { LeadIdentitySettings } from '@/features/settings/LeadIdentitySettings';
import { leadProfileDescription } from '@/features/settings/leadProfileModel';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLeadName } from '@/state/hooks';

export default function LeadProfileRoute() {
  const name = useLeadName();
  return (
    <SettingsPage title="身份与风格" description={leadProfileDescription(name)}>
      <LeadIdentitySettings />
    </SettingsPage>
  );
}
