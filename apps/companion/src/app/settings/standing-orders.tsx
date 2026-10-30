import { standingOrdersDescription } from '@/features/settings/standingOrderModel';
import { StandingOrdersSection } from '@/features/settings/StandingOrdersSection';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLeadName } from '@/state/hooks';

export default function StandingOrdersRoute() {
  const leadName = useLeadName();
  return (
    <SettingsPage title="常设指令" description={standingOrdersDescription(leadName)}>
      <StandingOrdersSection />
    </SettingsPage>
  );
}
