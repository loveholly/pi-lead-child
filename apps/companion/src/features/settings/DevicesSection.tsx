import {
  Badge, Box, Button, Card, Code, Column, Icon, isWeb, Row, Text, type IconName,
} from '@pi-lead-child/components';
import type { AdminBinding, BindingDto } from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useConnectionState } from '@/state/hooks';

import { AddPhone } from './AddPhone';
import {
  bindingKindLabel, canRevokeBinding, lastSeenLabel, reasonText, sortBindings,
} from './deviceModel';
import { isDevicePaired } from './settingsNav';
import { UnpairedNotice } from './UnpairedNotice';
import { useBindingList, useOwnBinding } from './useDeviceData';

// 设置 → 设备 → 已配对设备。列表要 admin scope；普通的 companion 凭证没有它（网关回 403），
// 这时只列出这台设备，并说明在 Mac 上怎样管理别的设备（apps/cli 的 plc pair list / revoke）。
// web 上（网页运行在 Mac 上）列表下面还有「添加手机」：生成配对二维码，手机扫码配对。原生应用本身就是手机，不显示它。
export function DevicesSection() {
  const phase = useConnectionPhase();
  const paired = isDevicePaired(phase);
  const list = useBindingList(paired);

  if (!paired) return <UnpairedNotice />;

  return (
    <Column gap="page-section">
      <DeviceList list={list} />
      {isWeb ? <AddPhone onPaired={list.reload} /> : null}
    </Column>
  );
}

function DeviceList({ list }: { list: ReturnType<typeof useBindingList> }) {
  const runtime = useCompanionRuntime();
  const own = useOwnBinding(true);
  const online = useConnectionState() === 'connected';
  const currentId = own.binding?.id ?? null;

  if (list.state === 'loading') {
    return <Text size="body" tone="muted">正在读取已配对设备…</Text>;
  }

  if (list.state === 'forbidden') {
    return (
      <Column gap="page-section">
        <Card testID="devices-list" rounded="2xl" overflow="hidden">
          {own.binding ? <CurrentDeviceRow binding={own.binding} online={online} /> : (
            <Box px="row-x" py="row-y"><Text size="body" tone="muted">正在读取这台设备…</Text></Box>
          )}
        </Card>
        <Text testID="devices-cli-hint" size="secondary" tone="secondary">
          {'要查看或撤销别的设备，请在运行 daemon 的 Mac 上运行 '}
          <Code size="code">plc pair list</Code>
          {' 和 '}
          <Code size="code">{'plc pair revoke <编号>'}</Code>
          {'。'}
        </Text>
      </Column>
    );
  }

  if (list.state === 'error') {
    return (
      <Card testID="devices-error" p="page-card" rounded="2xl" gap="card-row">
        <Text size="secondary" tone="danger-dark">{`读不到已配对设备：${list.error}`}</Text>
        <Row><Button label="重试" variant="outline" tone="neutral" size="sm" onPress={list.reload} /></Row>
      </Card>
    );
  }

  const items = sortBindings(list.items, currentId);
  return (
    <Card testID="devices-list" rounded="2xl" overflow="hidden">
      {items.map((binding, index) => (
        binding.id === currentId ? (
          <CurrentDeviceRow key={binding.id} binding={binding} online={online} lastSeenAt={binding.lastSeenAt} first={index === 0} />
        ) : (
          <OtherDeviceRow
            key={binding.id}
            binding={binding}
            first={index === 0}
            revocable={canRevokeBinding(binding, currentId)}
            onRevoke={async () => {
              await runtime.revokeBinding(binding.id);
              list.reload();
            }}
          />
        )
      ))}
    </Card>
  );
}

function CurrentDeviceRow({ binding, online, lastSeenAt, first = true }: {
  binding: BindingDto;
  online: boolean;
  lastSeenAt?: string | null;
  first?: boolean;
}) {
  // 这台设备现在连着 daemon 时写「在线」；没连上时写上次在线的时间（列表里才有）。
  const status = online ? '在线' : lastSeenAt === undefined ? '离线' : lastSeenLabel(lastSeenAt);
  return (
    <DeviceRowFrame testID={`device-row-${binding.id}`} divider={!first} kind={binding.kind}>
      <DeviceText name={binding.name} detail={`${bindingKindLabel(binding.kind)} · ${status}`} />
      <Badge testID="device-current" label="本设备" tone="accent" />
    </DeviceRowFrame>
  );
}

function OtherDeviceRow({ binding, first, revocable, onRevoke }: {
  binding: AdminBinding;
  first: boolean;
  revocable: boolean;
  onRevoke: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoked = binding.status === 'revoked';

  const revoke = async () => {
    setRevoking(true);
    setError(null);
    try {
      await onRevoke();
      setConfirming(false);
    } catch (reason) {
      setError(reasonText(reason));
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Column borderTopWidth={first ? 0 : 1} borderTopColor="border">
      <DeviceRowFrame testID={`device-row-${binding.id}`} kind={binding.kind}>
        <DeviceText
          name={binding.name}
          detail={`${bindingKindLabel(binding.kind)} · ${lastSeenLabel(binding.lastSeenAt)}`}
          muted={revoked}
        />
        {revoked ? <Badge label="已撤销" tone="muted" /> : null}
        {revocable && !confirming ? (
          <Button
            testID={`device-revoke-${binding.id}`}
            label="撤销"
            variant="outline"
            tone="danger"
            size="sm"
            onPress={() => { setError(null); setConfirming(true); }}
          />
        ) : null}
      </DeviceRowFrame>
      {/* 撤销要在这一行里再确认一次，不弹系统对话框。 */}
      {confirming ? (
        // spacing-exempt: 确认面板内缩
        <Column testID={`device-revoke-confirm-${binding.id}`} mx={16} mb={14} px="inset-x" py="inset-y" gap="card-row" rounded="lg" bg="danger-surface">
          <Text size="body">{`撤销以后，「${binding.name}」要重新配对才能再用。`}</Text>
          {error ? <Text size="secondary" weight="semibold" tone="danger-dark">{`撤销没有完成：${error}`}</Text> : null}
          <Row gap="actions">
            <Button
              testID={`device-revoke-confirm-button-${binding.id}`}
              label={revoking ? '正在撤销…' : '确认撤销'}
              tone="danger"
              size="sm"
              disabled={revoking}
              onPress={() => void revoke()}
            />
            <Button label="取消" variant="ghost" tone="neutral" size="sm" disabled={revoking} onPress={() => setConfirming(false)} />
          </Row>
        </Column>
      ) : null}
    </Column>
  );
}

// 一行设备。divider：和上一行之间画一条线。
function DeviceRowFrame({ testID, divider = false, kind, children }: {
  testID: string;
  divider?: boolean;
  kind: string;
  children: ReactNode;
}) {
  return (
    <Row testID={testID} items="center" gap="side-item" px="row-x" py="row-y" borderTopWidth={divider ? 1 : 0} borderTopColor="border">
      <Box w={32} h={32} rounded="md" bg="icon-well" items="center" justify="center" shrink={0}>
        <Icon name={kindIcon(kind)} size={17} color="text-strong" />
      </Box>
      {children}
    </Row>
  );
}

function DeviceText({ name, detail, muted = false }: { name: string; detail: string; muted?: boolean }) {
  return (
    <Column flex={1} minW={0} gap="text-stack">
      <Text size="card-title" weight="bold" tone={muted ? 'muted' : 'default'} numberOfLines={1}>{name}</Text>
      <Text size="secondary" tone={muted ? 'muted' : 'secondary'} numberOfLines={1}>{detail}</Text>
    </Column>
  );
}

function kindIcon(kind: string): IconName {
  if (kind === 'cli') return 'document';
  if (kind === 'aish-slack') return 'chat';
  return kind === 'desktop' ? 'devices' : 'device';
}
