import { Button, Card, Column, Row, ServiceMark, Text } from '@pi-lead-child/components';
import type { ConnectionDto } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { ConnectFlowPanel } from './ConnectFlow';
import { attentionConnections, attentionMessage, connectionNeedsUser } from './connectionModel';

// 健康条（方案 B）：只在有连接要你处理时出现（要重新授权，或者授权快到期）。设置首页和连接页的最上面都有它。
// 每个要处理的连接一条。点「重新授权」在这一条下面走连接流程。
export function ConnectionHealthBar({ items }: { items: readonly ConnectionDto[] | null | undefined }) {
  // 正在重新授权的那一条。授权完成后它不再要你处理，但这一条留到你点「完成」，好看到结果。
  const [openKey, setOpenKey] = useState<string | null>(null);
  const all = items ?? [];
  const attention = attentionConnections(all);
  const open = openKey ? all.find((item) => item.key === openKey) : undefined;
  const shown = open && !attention.includes(open) ? [...attention, open] : attention;
  if (shown.length === 0) return null;
  return (
    <Column testID="connection-health-bar" gap="stacked-card" mb="page-section">
      {shown.map((connection) => (
        <HealthItem
          key={connection.key}
          connection={connection}
          open={connection.key === openKey}
          onOpen={() => setOpenKey(connection.key)}
          onClose={() => setOpenKey(null)}
        />
      ))}
    </Column>
  );
}

function HealthItem({ connection, open, onOpen, onClose }: {
  connection: ConnectionDto;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <Card testID={`connection-health-${connection.key}`} tone="warning" rounded="xl" px="banner-x" py="banner-y" gap="card-section">
      <Row items="center" gap="side-item">
        <ServiceMark service={connection.provider} label={connection.label} size={24} />
        <Text flex={1} minW={0} size="body" weight="semibold">
          {connectionNeedsUser(connection) ? attentionMessage(connection) : connection.label}
        </Text>
        {!open ? (
          <Button
            testID={`connection-health-reauth-${connection.key}`}
            label="重新授权"
            variant="outline"
            tone="neutral"
            size="sm"
            onPress={onOpen}
          />
        ) : null}
      </Row>
      {open ? <ConnectFlowPanel target={connection} onClose={onClose} /> : null}
    </Card>
  );
}
