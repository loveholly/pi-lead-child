import {
  Badge, Box, Button, Card, Column, Icon, IconButton, Pressable, Row, SegmentedControl, ServiceMark, Switch, Text, type BadgeTone,
} from '@pi-lead-child/components';
import type { ConnectionDto, ConnectionRole, ConnectionToolDto, ConnectionWritePolicy } from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { timeLabel } from '@/features/tickets/timeLabels';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnections, useLeadName } from '@/state/hooks';

import { ConnectFlowPanel } from './ConnectFlow';
import {
  accessExpiryLabel, attentionMessage, connectionErrorText, connectionRoles, connectionNeedsUser, connectionStatus,
  renewalLabel, retryLabel, toggleRole, toolCountLabel,
} from './connectionModel';

const WRITE_POLICIES: { value: ConnectionWritePolicy; label: string }[] = [
  { value: 'confirm', label: '先问我' },
  { value: 'direct', label: '直接执行' },
];

const STATUS_TONE: Record<'success' | 'warning' | 'danger' | 'muted', BadgeTone> = {
  success: 'success', warning: 'warning', danger: 'danger', muted: 'muted',
};

// 一个连接的详情：授权、Lead 能做什么、谁可以用、写入之前，以及测试和断开。
// 桌面上在连接列表右边的抽屉里（onClose 关掉抽屉）；手机上是一整页。
export function ConnectionDetail({ connectionKey, onClose }: { connectionKey: string; onClose?: () => void }) {
  const { connections } = useConnections();
  const connection = connections?.items.find((item) => item.key === connectionKey) ?? null;

  if (!connection) {
    return (
      <Column testID="connection-detail-missing" gap="page-section">
        {onClose ? <Row justify="flex-end"><CloseButton onClose={onClose} /></Row> : null}
        <Text size="body" tone="muted">{connections ? '找不到这个连接。' : '正在读取连接…'}</Text>
      </Column>
    );
  }
  return <ConnectionDetailBody key={connection.key} connection={connection} onClose={onClose} />;
}

function ConnectionDetailBody({ connection, onClose }: { connection: ConnectionDto; onClose?: () => void }) {
  const status = connectionStatus(connection);
  const connected = connection.state === 'connected' || connection.state === 'degraded' || connection.state === 'needs_reauth';
  // 在这一页上连接时，连上以后先留在连接流程里，看到「已连接」再换成详情。
  const [connecting, setConnecting] = useState(false);
  return (
    <Column testID={`connection-detail-${connection.key}`} gap="page-section">
      <Row items="center" gap="side-item">
        <ServiceMark service={connection.provider} label={connection.label} size={40} />
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="section-title" weight="extrabold" numberOfLines={1}>{connection.label}</Text>
          {status ? (
            <Badge
              label={connection.account && connection.state === 'connected' ? `${status.label} · ${connection.account}` : status.label}
              tone={STATUS_TONE[status.tone]}
              dot={status.tone !== 'muted'}
            />
          ) : null}
        </Column>
        {onClose ? <CloseButton onClose={onClose} /> : null}
      </Row>
      {connected && !connecting ? <ConnectedSections connection={connection} /> : (
        <NotConnected connection={connection} open={connecting} onOpen={() => setConnecting(true)} onClose={() => setConnecting(false)} />
      )}
    </Column>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return <IconButton testID="connection-detail-close" icon="close" label="关闭详情" variant="ghost" size="sm" onPress={onClose} />;
}

// 还没连上的服务：说明它能做什么，下面是连接流程。即将支持的只有说明。
function NotConnected({ connection, open, onOpen, onClose }: {
  connection: ConnectionDto;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <Column gap="page-section">
      <Text size="body" tone="secondary">{connection.setupHint ?? connection.capability}</Text>
      {connection.state === 'unavailable' ? null : open ? (
        <ConnectFlowPanel target={connection} onClose={onClose} />
      ) : (
        <Row>
          <Button testID="connection-detail-connect" label={connection.state === 'needs_setup' ? '设置' : '连接'} onPress={onOpen} />
        </Row>
      )}
    </Column>
  );
}

function ConnectedSections({ connection }: { connection: ConnectionDto }) {
  const leadName = useLeadName();
  return (
    <>
      <ProblemBanner connection={connection} />
      <Section title="授权">
        <Fact label="账号" value={connection.account ?? '—'} />
        {connection.connectedAt ? <Fact label="连接时间" value={timeLabel(connection.connectedAt)} /> : null}
        {renewalLabel(connection) ? <Fact label="续期" value={renewalLabel(connection)!} /> : null}
        {connection.accessExpiresAt ? <Fact label="访问令牌" value={accessExpiryLabel(connection.accessExpiresAt)} /> : null}
        {connection.grantExpiresAt ? <Fact label="授权到期" value={timeLabel(connection.grantExpiresAt)} /> : null}
      </Section>
      <Section title={`${leadName} 能做什么`}>
        <Text size="body">{connection.capability}</Text>
        <ToolList connection={connection} />
      </Section>
      <Section title="谁可以用">
        <RoleSwitches connection={connection} />
      </Section>
      <Section title="写入之前">
        <WritePolicy connection={connection} />
      </Section>
      <Footer connection={connection} />
    </>
  );
}

// 要你处理的事：重新授权、授权快到期；或者暂时连不上（daemon 自己会重试）。
function ProblemBanner({ connection }: { connection: ConnectionDto }) {
  const [open, setOpen] = useState(false);
  // 重新授权完成后它不再要你处理；这一条留到你点「完成」。
  if (connectionNeedsUser(connection) || open) {
    return (
      <Card testID="connection-detail-problem" tone="warning" rounded="xl" px="banner-x" py="banner-y" gap="card-row">
        {connectionNeedsUser(connection) ? <Text size="body" weight="semibold">{attentionMessage(connection)}</Text> : null}
        {open ? <ConnectFlowPanel target={connection} onClose={() => setOpen(false)} /> : (
          <Row><Button testID="connection-detail-reauth" label="重新授权" variant="outline" tone="neutral" size="sm" onPress={() => setOpen(true)} /></Row>
        )}
      </Card>
    );
  }
  if (connection.state === 'degraded') {
    return (
      <Card testID="connection-detail-problem" tone="warning" rounded="xl" px="banner-x" py="banner-y">
        <Text size="body">{retryLabel(connection.problem)}</Text>
      </Card>
    );
  }
  return null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Column gap="group-label">
      <Text size="eyebrow" weight="bold" tone="secondary">{title}</Text>
      {children}
    </Column>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Row items="baseline" gap="inline-item">
      <Text w={72} shrink={0} size="label" tone="secondary">{label}</Text>
      <Text flex={1} minW={0} size="meta" weight="semibold">{value}</Text>
    </Row>
  );
}

// 工具数，以及「查看全部」：从 daemon 读这个连接的工具，标出只读和会写入。
function ToolList({ connection }: { connection: ConnectionDto }) {
  const runtime = useCompanionRuntime();
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<ConnectionToolDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!connection.tools) return null;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || tools) return;
    setError(null);
    runtime.connectionTools(connection.key).then(setTools, (reason: unknown) => setError(connectionErrorText(reason)));
  };
  return (
    <Column gap="card-row">
      <Row items="center" gap="inline-item">
        <Text flex={1} size="meta" tone="secondary">{toolCountLabel(connection.tools)}</Text>
        <Pressable testID="connection-tools-toggle" onPress={toggle} aria-label={open ? '收起工具' : '查看全部工具'}>
          {/* spacing-exempt: 链接字号 */}
          <Text size="12.5" weight="bold" tone="accent">{open ? '收起' : '查看全部'}</Text>
        </Pressable>
      </Row>
      {open ? (
        <Column testID="connection-tools" gap="stacked-card">
          {error ? <Text size="note" tone="danger-dark">{error}</Text> : null}
          {!tools && !error ? <Text size="body" tone="muted">正在读取工具…</Text> : null}
          {tools?.map((tool) => (
            <Row key={tool.name} items="flex-start" gap="inline-item">
              <Column flex={1} minW={0} gap="text-stack">
                <Text size="code" mono weight="semibold" numberOfLines={1}>{tool.name}</Text>
                {(tool.description ?? tool.title) ? (
                  <Text size="secondary" tone="secondary" numberOfLines={2}>{tool.description ?? tool.title}</Text>
                ) : null}
              </Column>
              <Badge label={tool.readOnly ? '只读' : '会写入'} tone={tool.readOnly ? 'neutral' : 'warning'} size="sm" />
            </Row>
          ))}
        </Column>
      ) : null}
    </Column>
  );
}

function RoleSwitches({ connection }: { connection: ConnectionDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = (role: ConnectionRole, on: boolean) => {
    setSaving(true);
    setError(null);
    runtime.updateConnectionSettings(connection.key, { roles: toggleRole(connection.roles, role, on) })
      .catch((reason: unknown) => setError(connectionErrorText(reason)))
      .finally(() => setSaving(false));
  };
  return (
    <Column gap="card-row">
      {connectionRoles(leadName).map((item) => (
        <Row key={item.role} items="center" gap="inline-item">
          <Text flex={1} minW={0} size="label">{item.label}</Text>
          <Switch
            testID={`connection-role-${item.role}`}
            value={connection.roles.includes(item.role)}
            disabled={saving}
            onValueChange={(on) => change(item.role, on)}
          />
        </Row>
      ))}
      {error ? <Text size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}

function WritePolicy({ connection }: { connection: ConnectionDto }) {
  const runtime = useCompanionRuntime();
  const [error, setError] = useState<string | null>(null);
  const change = (writePolicy: ConnectionWritePolicy) => {
    if (writePolicy === connection.writePolicy) return;
    setError(null);
    runtime.updateConnectionSettings(connection.key, { writePolicy }).catch((reason: unknown) => setError(connectionErrorText(reason)));
  };
  return (
    <Column gap="field">
      <SegmentedControl
        options={WRITE_POLICIES}
        value={connection.writePolicy}
        onChange={change}
        optionTestID={(value) => `connection-write-${value}`}
      />
      <Text size="note" tone="secondary">建 issue、改状态、发评论这类工具会先发一张确认卡。</Text>
      {error ? <Text size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}

// 测试连接（结果写在按钮下面）和断开连接（在这里再确认一次，不弹系统对话框）。
function Footer({ connection }: { connection: ConnectionDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const test = () => {
    setTesting(true);
    setResult(null);
    runtime.testConnection(connection.key)
      .then((response) => setResult({ ok: response.ok, message: response.message }))
      .catch((reason: unknown) => setResult({ ok: false, message: connectionErrorText(reason) }))
      .finally(() => setTesting(false));
  };
  const disconnect = () => {
    setDisconnecting(true);
    setError(null);
    runtime.disconnectConnection(connection.key)
      .then(() => setConfirming(false))
      .catch((reason: unknown) => setError(connectionErrorText(reason)))
      .finally(() => setDisconnecting(false));
  };

  return (
    <Column gap="card-row" pt="text-stack">
      <Row items="center" gap="actions">
        <Button testID="connection-test" label={testing ? '正在测试…' : '测试连接'} variant="outline" tone="neutral" size="sm" disabled={testing} onPress={test} />
        <Box flex={1} />
        {!confirming ? (
          <Button testID="connection-disconnect" label="断开连接" variant="outline" tone="danger" size="sm" onPress={() => setConfirming(true)} />
        ) : null}
      </Row>
      {result ? (
        <Row testID="connection-test-result" items="center" gap="icon-label">
          <Icon name={result.ok ? 'check' : 'error-outline'} size={14} color={result.ok ? 'success-dark' : 'danger-dark'} />
          <Text flex={1} size="note" tone={result.ok ? 'success-dark' : 'danger-dark'}>{result.message}</Text>
        </Row>
      ) : null}
      {confirming ? (
        <Column testID="connection-disconnect-confirm" px="inset-x" py="inset-y" gap="card-row" rounded="lg" bg="danger-surface">
          <Text size="body">{`断开后 ${leadName} 不能再用这个账号。`}</Text>
          {error ? <Text size="note" weight="semibold" tone="danger-dark">{error}</Text> : null}
          <Row gap="actions">
            <Button
              testID="connection-disconnect-confirm-button"
              label={disconnecting ? '正在断开…' : '断开'}
              tone="danger"
              size="sm"
              disabled={disconnecting}
              onPress={disconnect}
            />
            <Button label="取消" variant="ghost" tone="neutral" size="sm" disabled={disconnecting} onPress={() => setConfirming(false)} />
          </Row>
        </Column>
      ) : null}
    </Column>
  );
}
