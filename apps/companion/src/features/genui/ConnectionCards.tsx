import {
  Box, Button, Column, Dot, Icon, Pressable, Row, ServiceMark, Spinner, Text,
} from '@pi-lead-child/components';
import type { ConnectionConfirmationDto, ConnectionDto } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { ConnectFlowSteps, initialFlowState, useConnectFlow } from '@/features/settings/ConnectFlow';
import {
  connectionErrorText, connectionNeedsUser, opensBrowser, providerForKey,
} from '@/features/settings/connectionModel';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnections, useLeadName } from '@/state/hooks';

// 会话里的两张连接卡（方案 C）。卡片只带 key 或确认号：状态都从 daemon 实时读取，旧卡片不会显示过期的状态。

const CONFIRM_POLL_MS = 2_000;

// Lead 请你连接一个账号（或者重新授权）。按钮走和设置页一样的连接流程。「以后再说」只在这台设备上收起这张卡。
export function ConnectionConnectCard({ connection: key, reason }: { connection: string; reason?: string }) {
  const { connections } = useConnections();
  const connection = connections?.items.find((item) => item.key === key) ?? null;
  if (!connections) return <Text size="secondary" tone="secondary">正在读取连接…</Text>;
  if (!connection) return <Text size="secondary" tone="secondary">{`没有找到连接 ${key}。`}</Text>;
  return <ConnectionConnectBody key={connection.key} connection={connection} reason={reason} />;
}

function ConnectionConnectBody({ connection, reason }: { connection: ConnectionDto; reason?: string }) {
  const runtime = useCompanionRuntime();
  const [initial] = useState(() => initialFlowState(connection));
  const flow = useConnectFlow(initial);
  const [later, setLater] = useState(false);
  const leadName = useLeadName();
  const reauth = connectionNeedsUser(connection);
  const connected = !reauth && (connection.state === 'connected' || connection.state === 'degraded');

  // 已经连上（包括在这张卡上刚连上、已经点了「完成」）：只剩一行。
  if (connected && (flow.state.step === 'consent' || flow.state.step === 'starting')) {
    return (
      <Row testID={`surface-connection-${connection.key}`} items="center" gap="side-item">
        <ServiceMark service={connection.provider} label={connection.label} size={24} />
        <Text flex={1} minW={0} size="card-title" weight="semibold">{`${connection.label} 已连接`}</Text>
        <Dot color="success" size={7} />
      </Row>
    );
  }

  if (later) {
    return (
      <Row testID={`surface-connection-${connection.key}`} items="center" gap="side-item">
        <ServiceMark service={connection.provider} label={connection.label} size={24} />
        <Text flex={1} minW={0} size="secondary" tone="secondary">{`${reauth ? '还没有重新授权' : '还没有连接'} ${connection.label}`}</Text>
        <Button label={reauth ? '重新授权' : '连接'} variant="ghost" tone="accent" size="xs" onPress={() => setLater(false)} />
      </Row>
    );
  }

  const start = () => flow.run(() => runtime.startConnection(connection.key), { browser: opensBrowser(connection.provider) });

  return (
    <Column testID={`surface-connection-${connection.key}`} gap="card-row">
      <Row items="center" gap="side-item">
        <ServiceMark service={connection.provider} label={connection.label} size={32} />
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="card-title" weight="extrabold">{`${reauth ? '重新授权' : '连接'} ${connection.label}`}</Text>
          {reason ? <Text size="secondary" tone="secondary">{reason}</Text> : null}
        </Column>
      </Row>
      {flow.state.step === 'consent' ? (
        <>
          <Text size="body">{`连接以后，${leadName} 可以${connection.capability}`}</Text>
          <Row gap="actions">
            <Button testID={`surface-connect-${connection.key}`} label={reauth ? '重新授权' : '连接'} onPress={start} />
            <Button testID={`surface-connect-later-${connection.key}`} label="以后再说" variant="ghost" tone="neutral" onPress={() => setLater(true)} />
          </Row>
        </>
      ) : (
        <ConnectFlowSteps target={connection} flow={flow} onClose={flow.reset} onRetry={flow.reset} />
      )}
    </Column>
  );
}

const CONFIRM_STATE: Record<Exclude<ConnectionConfirmationDto['state'], 'pending' | 'running'>, { label: string; tone: 'success-dark' | 'danger-dark' | 'secondary' }> = {
  done: { label: '已执行', tone: 'success-dark' },
  failed: { label: '执行失败', tone: 'danger-dark' },
  rejected: { label: '已拒绝', tone: 'secondary' },
  expired: { label: '已过期', tone: 'secondary' },
};

// 一次写入的确认。允许以后 daemon 执行存下的那一次调用；执行时每 2 秒读一次结果。
export function ConnectionConfirmCard({ confirmation: id }: { confirmation: string }) {
  const runtime = useCompanionRuntime();
  const { connections } = useConnections();
  const [confirmation, setConfirmation] = useState<ConnectionConfirmationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showArgs, setShowArgs] = useState(false);
  const state = confirmation?.state ?? null;

  useEffect(() => {
    const controller = new AbortController();
    runtime.connectionConfirmation(id, controller.signal).then(
      (value) => { if (!controller.signal.aborted) setConfirmation(value); },
      (reason: unknown) => { if (!controller.signal.aborted) setError(connectionErrorText(reason)); },
    );
    return () => controller.abort();
  }, [id, runtime]);

  useEffect(() => {
    if (state !== 'running') return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      runtime.connectionConfirmation(id, controller.signal).then(
        (value) => { if (!controller.signal.aborted) setConfirmation(value); },
        () => {
          // 读失败时再等一轮：重新设一次同样的值，让这个 effect 再跑。
          if (!controller.signal.aborted) setConfirmation((current) => current ? { ...current } : current);
        },
      );
    }, CONFIRM_POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [confirmation, id, runtime, state]);

  const resolve = (approve: boolean) => {
    setSubmitting(true);
    setError(null);
    runtime.resolveConnectionConfirmation(id, approve)
      .then(setConfirmation, (reason: unknown) => setError(connectionErrorText(reason)))
      .finally(() => setSubmitting(false));
  };

  if (!confirmation) {
    return error ? <Text size="secondary" tone="danger-dark">{error}</Text> : <Text size="13" tone="secondary">正在读取写入确认…</Text>; // spacing-exempt: 提示文字字号
  }
  const settled = confirmation.state === 'pending' || confirmation.state === 'running' ? null : CONFIRM_STATE[confirmation.state];
  return (
    <Column testID={`surface-confirmation-${confirmation.id}`} gap="card-row">
      <Row items="center" gap="side-item">
        <ServiceMark service={providerForKey(confirmation.key, connections?.items)} label={confirmation.label} size={24} />
        <Text flex={1} minW={0} size="card-title" weight="bold">{`${confirmation.label} · 写入确认`}</Text>
      </Row>
      <Text size="body">{confirmation.summary}</Text>
      <Pressable testID="surface-confirmation-args-toggle" aria-label={showArgs ? '收起参数' : '展开参数'} onPress={() => setShowArgs((value) => !value)} self="flex-start">
        <Row items="center" gap="icon-label">
          {/* spacing-exempt: 操作旁说明字号 */}
          <Text size="12.5" weight="bold" tone="secondary">参数</Text>
          <Icon name={showArgs ? 'chevron-up' : 'chevron-down'} size={13} color="text-secondary" />
        </Row>
      </Pressable>
      {showArgs ? (
        <Box testID="surface-confirmation-args" px="inset-x" py="inset-y" rounded="md" bg="surface-muted">
          <Text size="code" mono>{confirmation.argumentsPreview}</Text>
        </Box>
      ) : null}
      {confirmation.state === 'pending' ? (
        <Row gap="actions">
          <Button testID="surface-confirmation-approve" label="允许" disabled={submitting} onPress={() => resolve(true)} />
          <Button testID="surface-confirmation-reject" label="不要" variant="outline" tone="neutral" disabled={submitting} onPress={() => resolve(false)} />
        </Row>
      ) : null}
      {confirmation.state === 'running' ? (
        <Row testID="surface-confirmation-running" items="center" gap="icon-label">
          <Spinner size={14} />
          <Text size="secondary" tone="secondary">正在执行</Text>
        </Row>
      ) : null}
      {settled ? (
        <Column testID="surface-confirmation-result" gap="text-stack">
          <Text size="label" weight="bold" tone={settled.tone}>{settled.label}</Text>
          {confirmation.resultPreview ? <Text size="body" tone={confirmation.state === 'failed' ? 'danger-dark' : 'default'}>{confirmation.resultPreview}</Text> : null}
        </Column>
      ) : null}
      {error ? <Text size="note" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}
