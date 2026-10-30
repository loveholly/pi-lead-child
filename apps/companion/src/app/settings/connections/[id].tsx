import { useBreakpoint } from '@pi-lead-child/components';
import { useLocalSearchParams } from 'expo-router';

import { connectionsDescription } from '@/features/settings/connectionModel';
import { ConnectionsSection } from '@/features/settings/ConnectionsSection';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { useLeadName } from '@/state/hooks';

// 一个连接（id 是连接的 key）。桌面上列表留着，详情在右边的抽屉里；手机上是详情页，返回到连接列表。
export default function ConnectionRoute() {
  const { desktop } = useBreakpoint();
  const { id } = useLocalSearchParams<{ id: string }>();
  const leadName = useLeadName();
  return (
    <SettingsPage
      title={desktop ? '连接' : undefined}
      description={desktop ? connectionsDescription(leadName) : undefined}
      back={{ label: '连接', href: '/settings/connections' }}
    >
      <ConnectionsSection connectionId={id ?? null} />
    </SettingsPage>
  );
}
