// 设置页的分组和条目。桌面侧栏和手机上的分组列表都按这一张表画。
// 只放已经有功能的条目：授权与委托、Daemon 以后有了界面再加，不放空链接。
import type { IconName } from '@pi-lead-child/components';

import type { ControlPlanePhase } from '@/state/types';

import type { settingsMessages } from './settings.messages';

type Messages = ReturnType<typeof settingsMessages>;

export type SettingsSectionId =
  | 'profile' | 'appearance' | 'connections' | 'channels' | 'device' | 'devices' | 'model' | 'memory' | 'standing-orders' | 'runtimes'
  | 'host-bypass';

// 名字在 settings.messages.ts（settingsMessages 的 items、groups），按界面语言取。
export type SettingsItem = {
  id: SettingsSectionId;
  href: string;
  icon: IconName;
};

export type SettingsGroup = {
  id: 'account' | 'device' | 'lead' | 'execution';
  items: readonly SettingsItem[];
};

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    // Lead 是谁、怎样做事：名字、人格和互动风格，决策模型、笔记的语义检索（记忆），以及它处理事件的常设指令。
    // 放在最上面（2026-10-22）。分组的标题是 Lead 的名字（settingsGroupLabel）。
    id: 'lead',
    items: [
      { id: 'profile', href: '/settings/profile', icon: 'person' },
      // 外观（2026-10-22）：密度、圆角、行高、字号、颜色和设计说明。Lead 也能按用户的要求改。
      { id: 'appearance', href: '/settings/appearance', icon: 'sidebar' },
      { id: 'model', href: '/settings/model', icon: 'agent' },
      { id: 'memory', href: '/settings/memory', icon: 'database' },
      { id: 'standing-orders', href: '/settings/standing-orders', icon: 'shield-check' },
      // 用户本人发话时免沙箱（工单 #246）：只有你本人能在这里打开，一直开着，直到你或 Lead 关掉。
      { id: 'host-bypass', href: '/settings/host-bypass', icon: 'shield' },
    ],
  },
  {
    id: 'account',
    // 消息通道（2026-10-20）：Lead 用你本人的身份读、回外部的消息（现在是 Slack）。密钥只能在这台 Mac 的网页上填。
    items: [
      { id: 'connections', href: '/settings/connections', icon: 'link' },
      { id: 'channels', href: '/settings/channels', icon: 'chat' },
    ],
  },
  {
    id: 'device',
    items: [
      { id: 'device', href: '/settings/device', icon: 'device' },
      { id: 'devices', href: '/settings/devices', icon: 'devices' },
    ],
  },
  {
    // 执行工单的 child runtime（Codex、Claude Code、pi）。停用的不再派活、不做核查，Lead 也不再推荐它（2026-10-19）。
    id: 'execution',
    items: [{ id: 'runtimes', href: '/settings/runtimes', icon: 'split' }],
  },
];

// 分组的标题。Lead 那一组用 Lead 的名字（设置 → 身份与风格）；别的组用当前语言的名字。
export function settingsGroupLabel(group: SettingsGroup, leadName: string, m: Messages): string {
  return group.id === 'lead' ? leadName : m.groups[group.id];
}

// 侧栏上条目右边的数字（例如「连接」里要你处理的个数）。没有数字或是 0 时不显示。
export type SettingsBadges = Partial<Record<SettingsSectionId, number>>;

// 地址对应哪个分组。桌面上 /settings 本身停在第一个条目「身份与风格」，手机上 /settings 是分组列表（返回 null）。
export function settingsSectionForPath(pathname: string, { desktop }: { desktop: boolean }): SettingsSectionId | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'settings') return null;
  const section = segments[1];
  if (section === undefined) return desktop ? 'profile' : null;
  if (section === 'profile' || section === 'appearance' || section === 'connections' || section === 'channels' || section === 'device' || section === 'devices' || section === 'model' || section === 'memory'
    || section === 'standing-orders' || section === 'runtimes' || section === 'host-bypass') return section;
  return null;
}

// /settings/connections/<key> 里的连接 key。别的地址返回 null。
export function connectionKeyForPath(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'settings' || segments[1] !== 'connections' || segments.length !== 3) return null;
  try {
    return decodeURIComponent(segments[2]!);
  } catch {
    return null;
  }
}

// 这台设备和 daemon 配对了没有。和配对页的判断一致：有凭证、正在连或已经连上。
export function isDevicePaired(phase: ControlPlanePhase): boolean {
  return phase === 'ready' || phase === 'connecting';
}
