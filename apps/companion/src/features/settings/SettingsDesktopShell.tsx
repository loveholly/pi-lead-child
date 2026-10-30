import { Badge, Box, Column, Pressable, Row, Screen, ScrollArea, SlidePanel, Text } from '@pi-lead-child/components';
import type { ReactNode } from 'react';

import { useLeadName } from '@/state/hooks';

import { SETTINGS_GROUPS, settingsGroupLabel, type SettingsBadges, type SettingsItem, type SettingsSectionId } from './settingsNav';

type SettingsDesktopShellProps = {
  selected: SettingsSectionId | null;
  onSelect: (item: SettingsItem) => void;
  onExit: () => void;
  badges?: SettingsBadges;
  // 右边的抽屉（一个连接的详情）。没有时不占地方。
  drawer?: ReactNode;
  // 抽屉的身份。换了连接时抽屉重新滑入，里面的状态也重来。
  drawerKey?: string;
  children?: ReactNode;
};

// 抽屉固定 372 宽，和工作台的工单面板一样用 SlidePanel 滑入。
const DRAWER_LAYOUT = { grow: 0, basis: 372, minWidth: 372, maxWidth: 372 };

// 桌面上的设置页（方案 A）：它整页替换工作台。左边是 236 宽的分组侧栏，右边是当前分组的内容。
// 右边的滚动区按内容定高：内容放在滚动区里面，不用 flex 撑开（见 ScrollArea 的说明）。
export function SettingsDesktopShell({
  selected, onSelect, onExit, badges = {}, drawer, drawerKey, children,
}: SettingsDesktopShellProps) {
  const leadName = useLeadName();
  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} bg="canvas">
      <Row
        testID="settings-desktop"
        flex={1}
        minW={0}
        minH={0}
        overflow="hidden"
        borderWidth={1}
        borderColor="border-strong"
        rounded="4xl"
        bg="workspace"
      >
        <Column
          testID="settings-sidebar"
          w={236}
          shrink={0}
          bg="surface"
          borderRightWidth={1}
          borderRightColor="border"
          px="page-x"
          py="page-top"
          gap="nav-item"
        >
          <Pressable
            testID="settings-exit"
            aria-label="回到工作台"
            onPress={onExit}
            self="flex-start"
            px={10} // spacing-exempt: 返回链接点击区
            pt={4} // spacing-exempt: 返回链接点击区
            pb={8} // spacing-exempt: 返回链接点击区
            rounded="sm"
          >
            {/* spacing-exempt: 链接字号 */}
            <Text size="12" weight="bold" tone="secondary">‹ 回到工作台</Text>
          </Pressable>
          <Text size="page-title" weight="extrabold" px="section-label-x" pt="section-label-top" pb="section-label-bottom">设置</Text>
          {SETTINGS_GROUPS.map((group) => (
            <Column key={group.id} gap="nav-item">
              <Text size="eyebrow" weight="extrabold" tone="muted" letterSpacing={0.9} px="section-label-x" pt="section-label-top" pb="section-label-bottom">{settingsGroupLabel(group, leadName)}</Text>
              {group.items.map((item) => (
                <SidebarItem
                  key={item.id}
                  item={item}
                  selected={item.id === selected}
                  badge={badges[item.id]}
                  onPress={() => onSelect(item)}
                />
              ))}
            </Column>
          ))}
        </Column>
        <ScrollArea testID="settings-content">
          {/* spacing-exempt: 桌面设置页内容列的留白 */}
          <Column w="100%" maxW={720} px={32} pt={28} pb={48}>
            {children}
          </Column>
        </ScrollArea>
        {drawer ? (
          <SlidePanel key={drawerKey} edge="right" {...DRAWER_LAYOUT} bg="surface" borderLeftWidth={1} borderLeftColor="border">
            <ScrollArea testID="settings-drawer">
              {/* spacing-exempt: 右侧抽屉自己的规格 */}
              <Column px={22} pt={20} pb={32}>{drawer}</Column>
            </ScrollArea>
          </SlidePanel>
        ) : null}
      </Row>
    </Screen>
  );
}

function SidebarItem({ item, selected, badge, onPress }: {
  item: SettingsItem;
  selected: boolean;
  badge: number | undefined;
  onPress: () => void;
}) {
  const count = badge !== undefined && badge > 0 ? badge : null;
  return (
    <Pressable
      testID={`settings-nav-${item.id}`}
      aria-current={selected ? 'page' : undefined}
      onPress={onPress}
      feedback="none"
      flexDirection="row"
      items="center"
      justify="space-between"
      gap="inline-item"
      h={34}
      px="row-x"
      rounded="md"
      bg={selected ? 'accent-soft' : { default: 'transparent', hover: 'surface-subtle', press: 'surface-muted' }}
    >
      <Text size="label" weight={selected ? 'bold' : 'semibold'} color={selected ? 'accent-strong' : 'text-strong'} numberOfLines={1}>
        {item.label}
      </Text>
      {count !== null ? (
        <Box testID={`settings-nav-${item.id}-badge`}>
          <Badge label={String(Math.min(count, 99))} tone="warning" variant="solid" size="sm" />
        </Box>
      ) : null}
    </Pressable>
  );
}
