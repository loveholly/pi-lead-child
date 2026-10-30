import { Density, palette, useBreakpoint } from '@pi-lead-child/components';
import { Slot, Stack, usePathname, useRouter, type Href } from 'expo-router';

import { ConnectionDetail } from '@/features/settings/ConnectionDetail';
import { SettingsDesktopShell } from '@/features/settings/SettingsDesktopShell';
import { connectionKeyForPath, settingsSectionForPath } from '@/features/settings/settingsNav';
import { memoryNeedsUser } from '@/features/settings/memoryModel';
import { useConnections, useMemorySettings } from '@/state/hooks';

// 设置页（方案 A）。
// 桌面上整页替换工作台：侧栏一直在，右边换成当前分组。分组之间是同级的，点侧栏不往历史里压新的一页。
// 一个连接的详情（/settings/connections/<key>）是右边的抽屉，列表留在原处。
// 手机上是一个栈：设置首页是分组列表，每一行推进一个分组的页面。
// 进了设置就取连接列表：侧栏「连接」的角标是要你处理的连接数。
export default function SettingsLayout() {
  const { desktop } = useBreakpoint();
  const router = useRouter();
  const pathname = usePathname();
  const { connections } = useConnections();
  const { memory } = useMemorySettings();

  if (desktop) {
    const connectionKey = connectionKeyForPath(pathname);
    return (
      <Density zone="settings"><SettingsDesktopShell
        selected={settingsSectionForPath(pathname, { desktop })}
        onSelect={(item) => router.replace(item.href as Href)}
        onExit={() => router.dismissTo('/' as Href)}
        badges={{ connections: connections?.attention ?? 0, memory: memoryNeedsUser(memory) ? 1 : 0 }}
        drawerKey={connectionKey ?? undefined}
        drawer={connectionKey ? (
          <ConnectionDetail connectionKey={connectionKey} onClose={() => router.replace('/settings/connections' as Href)} />
        ) : null}
      >
        <Slot />
      </SettingsDesktopShell></Density>
    );
  }

  return <Density zone="settings"><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette['surface-muted'] } }} /></Density>;
}
