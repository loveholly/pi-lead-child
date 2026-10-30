import {
  Badge, Box, Button, Card, Column, Icon, Pressable, Row, ServiceMark, Text, useBreakpoint, type BadgeTone,
} from '@pi-lead-child/components';
import type { ConnectionDto } from '@pi-lead-child/protocol';
import { useRouter, type Href } from 'expo-router';
import { useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useConnections } from '@/state/hooks';

import { AddCustomConnection } from './AddCustomConnection';
import { ConnectFlowPanel } from './ConnectFlow';
import { ConnectionDetail } from './ConnectionDetail';
import { ConnectionHealthBar } from './ConnectionHealthBar';
import {
  connectionNeedsUser, connectionSecondLine, connectionStatus, groupConnections, type ConnectionGroupId, type ConnectionStatus,
} from './connectionModel';
import { isDevicePaired } from './settingsNav';
import { UnpairedNotice } from './UnpairedNotice';

export type ConnectionsSectionProps = {
  // /settings/connections/[id] 打开的那个连接（连接的 key）。列表页是 null。
  connectionId: string | null;
};

// 设置 → 账号 → 连接（第三方账号）。
//   /settings/connections       → 列表
//   /settings/connections/[id]  → 桌面上列表不动，详情在右边的抽屉里（app/settings/_layout.tsx）；手机上是详情页。
// 桌面上 /settings 本身也停在这里。
export function ConnectionsSection({ connectionId }: ConnectionsSectionProps) {
  const { desktop } = useBreakpoint();
  if (!desktop && connectionId) return <ConnectionDetail connectionKey={connectionId} />;
  return <ConnectionList selectedKey={desktop ? connectionId : null} />;
}

const STATUS_TONE: Record<ConnectionStatus['tone'], BadgeTone> = {
  success: 'success', warning: 'warning', danger: 'danger', muted: 'muted',
};

function ConnectionList({ selectedKey }: { selectedKey: string | null }) {
  const router = useRouter();
  const { desktop } = useBreakpoint();
  const runtime = useCompanionRuntime();
  const paired = isDevicePaired(useConnectionPhase());
  const { connections, resource } = useConnections();
  // 正在走连接流程的那一行，和它开始时在哪一组。同一时间只开一个。
  const [flow, setFlow] = useState<{ key: string; group: ConnectionGroupId } | null>(null);
  const [adding, setAdding] = useState(false);

  if (!paired) return <UnpairedNotice />;
  if (!connections) {
    if (resource?.state === 'error') {
      return (
        <Card testID="connections-error" p="page-card" rounded="2xl" gap="card-row">
          <Text size="secondary" tone="danger-dark">{`读不到连接：${resource.error ?? ''}`}</Text>
          <Row><Button label="重试" variant="outline" tone="neutral" size="sm" onPress={() => void runtime.ensureResource('connections', true).catch(() => {})} /></Row>
        </Card>
      );
    }
    if (resource?.state === 'unsupported') return <Text size="body" tone="muted">这台 daemon 还不支持连接。</Text>;
    return <Text testID="connections-loading" size="body" tone="muted">正在读取连接…</Text>;
  }

  // 桌面上详情在抽屉里，换一个连接不往历史里压新的一页；手机上推进详情页。
  const openDetail = (key: string) => {
    const href = `/settings/connections/${encodeURIComponent(key)}` as Href;
    if (desktop) router.replace(href);
    else router.push(href);
  };

  return (
    <Column testID="connections-list">
      <ConnectionHealthBar items={connections.items} />
      {groupConnections(connections.items, flow).map((group) => (
        <Column key={group.id} testID={`connections-group-${group.id}`} mb="page-section">
          <Text testID={`connections-group-title-${group.id}`} size="eyebrow" weight="bold" tone="secondary" px="section-label-x" pb="section-label-bottom">{group.label}</Text>
          <Card rounded="2xl" overflow="hidden">
            {group.items.map((connection, index) => (
              <ConnectionRow
                key={connection.key}
                connection={connection}
                divider={index > 0}
                selected={connection.key === selectedKey}
                flowOpen={flow?.key === connection.key}
                onOpen={() => openDetail(connection.key)}
                onStartFlow={() => setFlow({ key: connection.key, group: group.id })}
                onCloseFlow={() => setFlow(null)}
              />
            ))}
          </Card>
        </Column>
      ))}
      {adding ? <AddCustomConnection onClose={() => setAdding(false)} /> : (
        <Pressable
          testID="connections-add-custom"
          aria-label="添加 MCP 服务器"
          onPress={() => setAdding(true)}
          flexDirection="row"
          items="center"
          gap="side-item"
          py={6} // spacing-exempt: 链接按钮点击区
          self="flex-start"
        >
          <ServiceMark service="custom" size={24} />
          {/* spacing-exempt: 链接字号 */}
          <Text size="13" weight="bold" tone="accent">+ 添加 MCP 服务器</Text>
          <Text size="note" tone="muted">任何支持 OAuth 的远程 MCP 服务器</Text>
        </Pressable>
      )}
    </Column>
  );
}

function ConnectionRow({ connection, divider, selected, flowOpen, onOpen, onStartFlow, onCloseFlow }: {
  connection: ConnectionDto;
  divider: boolean;
  selected: boolean;
  flowOpen: boolean;
  onOpen: () => void;
  onStartFlow: () => void;
  onCloseFlow: () => void;
}) {
  const status = connectionStatus(connection);
  const second = connectionSecondLine(connection);
  const unavailable = connection.state === 'unavailable';
  // 右边的按钮：要重新授权的写「重新授权」，可以连接的写「连接」，要先配置的写「设置」。
  const action = connectionNeedsUser(connection) ? '重新授权'
    : connection.state === 'not_connected' ? '连接'
    : connection.state === 'needs_setup' ? '设置'
    : null;
  // 已连接的行点开详情；别的行没有详情可看，按钮就是入口。
  const opensDetail = connection.state === 'connected' || connection.state === 'degraded' || connection.state === 'needs_reauth';
  // 包在 Pressable 里时不给 flex：Pressable 已经在横向撑满，它是纵向的容器，里面的 Row 再写 flex 1，
  // react-native-web 输出 flex: 1 1 0%，高度被压成 0，内容溢出到行外，留白和垂直居中都没了（2026-10-21）。
  const body = (
    <Row items="center" gap="side-item" flex={opensDetail ? undefined : 1} minW={0} opacity={unavailable ? 0.62 : 1}>
      <ServiceMark service={connection.provider} label={connection.label} size={32} />
      <Column flex={1} minW={0} gap="text-stack">
        <Text size="card-title" weight="bold" numberOfLines={1}>{connection.label}</Text>
        <Text testID={`connection-second-${connection.key}`} size="secondary" tone={second.tone} numberOfLines={2}>{second.text}</Text>
      </Column>
      {status ? (
        // Badge 自带 self="flex-start"（它常放在纵向的列里）；放在行里会贴着顶部。包一层，让它跟着行垂直居中。
        <Box shrink={0}>
          <Badge testID={`connection-status-${connection.key}`} label={status.label} tone={STATUS_TONE[status.tone]} dot={status.tone !== 'muted'} />
        </Box>
      ) : null}
    </Row>
  );
  return (
    <Column testID={`connection-row-${connection.key}`} borderTopWidth={divider ? 1 : 0} borderTopColor="border" bg={selected ? 'accent-wash' : 'surface'}>
      <Row items="center" gap="side-item" px="row-x" py="row-y">
        {opensDetail ? (
          <Pressable testID={`connection-open-${connection.key}`} aria-label={`查看 ${connection.label}`} onPress={onOpen} flex={1} minW={0}>
            {body}
          </Pressable>
        ) : body}
        {action && !flowOpen ? (
          <Button
            testID={`connection-action-${connection.key}`}
            label={action}
            variant={action === '连接' ? 'soft' : 'outline'}
            tone={action === '连接' ? 'accent' : 'neutral'}
            size="sm"
            onPress={onStartFlow}
          />
        ) : null}
        {opensDetail ? (
          <Box shrink={0}><Icon name="chevron-right" size={14} color="text-ghost" /></Box>
        ) : null}
      </Row>
      {flowOpen ? (
        <Box px="row-x" pb="card-row">
          <ConnectFlowPanel target={connection} onClose={onCloseFlow} />
        </Box>
      ) : null}
    </Column>
  );
}
