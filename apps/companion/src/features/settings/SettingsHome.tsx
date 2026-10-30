import {
  Avatar, Badge, Box, Column, Icon, Pressable, Row, Screen, ScrollArea, Text, type ColorToken,
} from '@pi-lead-child/components';
import { useRouter, type Href } from 'expo-router';
import { leadAvatarLabel, type ConnectionDto, type MemorySettingsDto } from '@pi-lead-child/protocol';
import type { ReactNode } from 'react';

import { leadSubtitleTone, useLeadPresence } from '@/components/LeadIdentity';
import type { LeadPresence } from '@/components/leadPresence';
import { useConnectionPhase, useLeadName } from '@/state/hooks';

import { ConnectionHealthBar } from './ConnectionHealthBar';
import { PendingSwitchBanner } from './MemorySection';
import { isDevicePaired, SETTINGS_GROUPS, settingsGroupLabel, type SettingsBadges, type SettingsSectionId } from './settingsNav';

// 每个分组图标的底色。
const ICON_WELLS: Record<SettingsSectionId, ColorToken> = {
  profile: 'accent-strong',
  appearance: 'violet',
  connections: 'accent',
  channels: 'success-strong',
  device: 'success',
  devices: 'cyan',
  model: 'text',
  memory: 'violet',
  'standing-orders': 'warning',
  runtimes: 'accent',
};

// 手机上的设置首页（方案 A）：iOS 式的分组列表。最上面是 Lead 的名字（设置 → 身份与风格），下面每一行推进一个分组的页面。
export function SettingsHome({ badges = {}, connections, memory }: {
  badges?: SettingsBadges;
  connections?: readonly ConnectionDto[] | null;
  memory?: MemorySettingsDto | null;
}) {
  const router = useRouter();
  const phase = useConnectionPhase();
  const presence = useLeadPresence();
  const leadName = useLeadName();

  return (
    <Screen edges={['top', 'bottom']} bg="surface-muted">
      <Row h={44} px="page-x" items="center">
        {/* 设置是从会话顶栏的 Lead 名字进来的；栈里没有会话时（直接打开地址）换成会话。 */}
        <Pressable
          testID="settings-close"
          aria-label="返回对话"
          onPress={() => router.dismissTo('/' as Href)}
          h={36}
          px={6} // spacing-exempt: 返回链接点击区
          justify="center"
          rounded="sm"
        >
          {/* spacing-exempt: 链接字号 */}
          <Text size="15" weight="semibold" tone="accent">‹ 对话</Text>
        </Pressable>
      </Row>
      <ScrollArea>
        {/* spacing-exempt: 标题自带留白 */}
        <Column testID="settings-home" px="page-x" pt={2} pb="page-bottom">
          {/* spacing-exempt: 光学对齐 */}
          <Text size="page-title" weight="extrabold" letterSpacing={-0.4} px={2} pb="page-section">设置</Text>
          {/* 有连接要你处理时，最上面先说（方案 B 的健康条）。 */}
          <ConnectionHealthBar items={connections} />
          {/* 记忆有要你确认的切换时，也在最上面。和设置 → 记忆、会话里的卡片是同一个确认。 */}
          {memory ? <Column mb="page-section"><PendingSwitchBanner memory={memory} /></Column> : null}
          <GroupCard>
            <Pressable
              testID="settings-paimon"
              feedback="highlight"
              onPress={() => router.push((isDevicePaired(phase) ? '/settings/device' : '/pair') as Href)}
              flexDirection="row"
              items="center"
              gap="side-item"
              h={66}
              px="row-x"
            >
              <Avatar label={leadAvatarLabel(leadName)} size={36} rounded="xl" textSize="15" />
              <Column flex={1} minW={0} gap="text-stack">
                <Text testID="settings-paimon-name" size="card-title" weight="bold" numberOfLines={1}>{leadName}</Text>
                <Text testID="settings-paimon-status" size="secondary" tone={leadSubtitleTone(presence)} numberOfLines={1}>
                  {paimonCardSubtitle(presence)}
                </Text>
              </Column>
              <Icon name="chevron-right" size={16} color="text-ghost" />
            </Pressable>
          </GroupCard>
          {SETTINGS_GROUPS.map((group) => (
            <Column key={group.id}>
              {/* spacing-exempt: 和 ListItem 的 16 对齐 */}
              <Text size="eyebrow" weight="semibold" tone="secondary" px={16} pt="section-label-top" pb="section-label-bottom">{settingsGroupLabel(group, leadName)}</Text>
              <GroupCard>
                {group.items.map((item, index) => {
                  const count = badges[item.id];
                  return (
                    <Pressable
                      key={item.id}
                      testID={`settings-row-${item.id}`}
                      feedback="highlight"
                      onPress={() => router.push(item.href as Href)}
                      flexDirection="row"
                      items="center"
                      gap="side-item"
                      h={48}
                      px="row-x"
                      borderTopWidth={index === 0 ? 0 : 1}
                      borderTopColor="border-soft"
                    >
                      <Box w={28} h={28} rounded="xs" bg={ICON_WELLS[item.id]} items="center" justify="center">
                        <Icon name={item.icon} size={16} color="white" />
                      </Box>
                      <Text flex={1} minW={0} size="label" numberOfLines={1}>{item.label}</Text>
                      {count !== undefined && count > 0 ? (
                        <Box testID={`settings-row-${item.id}-badge`}>
                          <Badge label={String(Math.min(count, 99))} tone="warning" variant="solid" size="sm" />
                        </Box>
                      ) : null}
                      <Icon name="chevron-right" size={16} color="text-ghost" />
                    </Pressable>
                  );
                })}
              </GroupCard>
            </Column>
          ))}
        </Column>
      </ScrollArea>
    </Screen>
  );
}

function GroupCard({ children }: { children: ReactNode }) {
  return <Column bg="surface" rounded="xl" overflow="hidden">{children}</Column>;
}

// 名字下面的一行字：在线时写「在线」和最近一次巡检，别的状态和会话顶栏写的一样。
export function paimonCardSubtitle(presence: LeadPresence): string {
  if (presence.state === 'online') return presence.subtitle ? `在线 · ${presence.subtitle}` : '在线';
  return presence.subtitle ?? presence.label;
}
