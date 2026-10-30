import { Box, Column, Icon, Pressable, Row, Text, type IconName } from '@pi-lead-child/components';

import type { CompactDestination } from '@/state/types';

const destinations: { id: CompactDestination; label: string; icon: IconName }[] = [
  { id: 'conversation', label: '对话', icon: 'chat' },
  { id: 'inbox', label: '收件箱', icon: 'inbox' },
  { id: 'tickets', label: '工单', icon: 'tickets' },
  { id: 'projects', label: '项目', icon: 'folder' },
  { id: 'agenda', label: '日程', icon: 'calendar' },
];

// 窄屏工作台的导航：对话、收件箱、工单、项目、日程。
export function CompactWorkspaceNav({
  active,
  todoCount,
  onSelect,
  placement = 'bottom',
}: {
  active: CompactDestination;
  todoCount: number;
  onSelect: (destination: CompactDestination) => void;
  placement?: 'top' | 'bottom';
}) {
  return (
    <Row
      testID="compact-nav"
      role="tablist"
      h={64}
      items="stretch"
      px="row-x"
      py="row-y"
      borderTopWidth={placement === 'bottom' ? 1 : 0}
      borderBottomWidth={placement === 'top' ? 1 : 0}
      borderColor="border-strong"
      bg="surface"
    >
      {destinations.map((destination) => {
        const selected = active === destination.id;
        return (
          <Box key={destination.id} role="tab" aria-selected={selected} flex={1} minW={0}>
            <Pressable
              testID={`compact-nav-${destination.id}`}
              onPress={() => onSelect(destination.id)}
              feedback="none"
              h={54}
              rounded="md"
              items="center"
              justify="center"
              bg={selected ? 'accent-soft' : 'transparent'}
            >
              <Column items="center" gap="icon-label">
                <Row items="center" gap="icon-label">
                  <Icon name={destination.icon} color={selected ? 'accent' : 'text-secondary'} size={18} />
                  {destination.id === 'inbox' && todoCount > 0 ? (
                    // spacing-exempt: 徽标字号
                    <Text size="9.5" weight="extrabold" tone={selected ? 'accent' : 'muted'}>
                      {String(Math.min(todoCount, 99))}
                    </Text>
                  ) : null}
                </Row>
                <Text size="label" weight={selected ? 'extrabold' : 'bold'} tone={selected ? 'accent' : 'secondary'} align="center">
                  {destination.label}
                </Text>
              </Column>
            </Pressable>
          </Box>
        );
      })}
    </Row>
  );
}
