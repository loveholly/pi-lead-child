import {
  Box, Button, canCopyText, Card, Chip, Column, copyText, IconButton, QrCode, Row, Text, TextField,
} from '@pi-lead-child/components';
import type { LoopbackInvitation } from '@pi-lead-child/protocol';
import { useState } from 'react';

import {
  countdownLabel, DEFAULT_PHONE_NAME, endpointLabel, PHONE_NAME_MAX, phoneNameError, qrModuleSize,
} from './phonePairingModel';
import { usePhoneInvitation } from './usePhoneInvitation';

// 设置 → 设备 → 添加手机（只在 web 上显示，见 DevicesSection）。
// 网页生成一个配对二维码，手机上的 Companion 点「扫描局域网配对码」扫它。
// 邀请是凭证：页面上只画二维码，不显示 URI 的文字；「复制邀请」把它放进剪贴板。
export function AddPhone({ onPaired }: { onPaired?: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(DEFAULT_PHONE_NAME);
  const { state, create, reset } = usePhoneInvitation(onPaired);

  const close = () => {
    reset();
    setName(DEFAULT_PHONE_NAME);
    setOpen(false);
  };

  if (!open) {
    return (
      <Row>
        <Button testID="add-phone" label="添加手机" icon="plus" variant="outline" tone="neutral" size="sm" onPress={() => setOpen(true)} />
      </Row>
    );
  }

  const nameError = phoneNameError(name);

  return (
    <Card testID="add-phone-panel" rounded="2xl" p="page-card" gap="card-section">
      <Row items="center" gap="inline-item">
        <Text flex={1} size="card-title" weight="bold">添加手机</Text>
        <IconButton testID="add-phone-close" icon="close" label="关闭" variant="ghost" size="sm" iconSize={15} onPress={close} />
      </Row>

      {state.phase === 'idle' || state.phase === 'failed' ? (
        <Column gap="form-field">
          <Text size="secondary" tone="secondary">
            在手机上打开 Companion，点「扫描局域网配对码」，扫这里生成的二维码。手机要和这台 Mac 在同一个局域网。
          </Text>
          <Column gap="field">
            <Text size="label" weight="semibold" tone="secondary">设备名</Text>
            <TextField
              testID="add-phone-name"
              value={name}
              onChangeText={setName}
              maxLength={PHONE_NAME_MAX}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="设备名"
              onSubmit={() => { if (!nameError) create(name.trim()); }}
            />
            {nameError ? <Text testID="add-phone-name-error" size="note" tone="danger-dark">{nameError}</Text> : null}
          </Column>
          {state.phase === 'failed' ? (
            <Text testID="add-phone-error" size="secondary" tone="danger-dark">{state.error}</Text>
          ) : null}
          <Row>
            <Button
              testID="add-phone-create"
              label="生成二维码"
              size="sm"
              disabled={nameError !== null}
              onPress={() => create(name.trim())}
            />
          </Row>
        </Column>
      ) : null}

      {state.phase === 'creating' ? (
        <Text testID="add-phone-creating" size="body" tone="secondary">正在生成二维码…</Text>
      ) : null}

      {state.phase === 'showing' || state.phase === 'expired' ? (
        <InvitationView
          name={state.name}
          invitation={state.invitation}
          remainingMs={state.phase === 'showing' ? state.remainingMs : 0}
          expired={state.phase === 'expired'}
          onRegenerate={(endpoint) => create(state.name, endpoint)}
        />
      ) : null}

      {state.phase === 'paired' ? (
        <Column testID="add-phone-paired" gap="card-row">
          <Text size="label" weight="bold" tone="success-dark">{`「${state.name}」已配对。`}</Text>
          <Text size="secondary" tone="secondary">手机上的 Companion 已经连上这台 Mac 的 daemon。</Text>
          <Row><Button testID="add-phone-done" label="完成" size="sm" onPress={close} /></Row>
        </Column>
      ) : null}
    </Card>
  );
}

function InvitationView({ name, invitation, remainingMs, expired, onRegenerate }: {
  name: string;
  invitation: LoopbackInvitation;
  remainingMs: number;
  expired: boolean;
  onRegenerate: (endpoint: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const side = (invitation.qr.size + 8) * qrModuleSize(invitation.qr.size);

  return (
    <Column gap="card-row">
      <Row gap="side-item" items="flex-start" flexWrap="wrap">
        {expired ? (
          <Box testID="add-phone-expired" w={side} h={side} rounded="md" bg="surface-muted" items="center" justify="center" px="inset-x" py="inset-y" gap="card-row">
            <Text size="label" weight="bold" tone="secondary">二维码已过期</Text>
            <Button testID="add-phone-regenerate" label="重新生成" size="sm" onPress={() => onRegenerate(invitation.endpoint)} />
          </Box>
        ) : (
          <Box rounded="md" overflow="hidden" borderWidth={1} borderColor="border">
            <QrCode
              testID="add-phone-qr"
              rows={invitation.qr.rows}
              moduleSize={qrModuleSize(invitation.qr.size)}
              accessibilityLabel={`配对「${name}」的二维码`}
            />
          </Box>
        )}
        <Column flex={1} minW={200} gap="card-row">
          <Text size="card-title" weight="bold">{`扫码配对「${name}」`}</Text>
          <Text size="secondary" tone="secondary">在手机的 Companion 里点「扫描局域网配对码」，对准这个二维码。</Text>
          {expired ? null : (
            <Text testID="add-phone-countdown" size="secondary" tone="secondary">{`${countdownLabel(remainingMs)} 后过期`}</Text>
          )}
          <EndpointChoice invitation={invitation} onPick={onRegenerate} />
          {canCopyText && !expired ? (
            <Row>
              <Button
                testID="add-phone-copy"
                label={copied ? '已复制' : '复制邀请'}
                icon="copy"
                variant="outline"
                tone="neutral"
                size="sm"
                onPress={() => { void copyText(invitation.uri).then(setCopied); }}
              />
            </Row>
          ) : null}
        </Column>
      </Row>
    </Column>
  );
}

// 网关在几个局域网地址上监听时（例如 Wi-Fi 和 Tailscale），让用户选手机能连到的那个。选了别的就重新生成。
function EndpointChoice({ invitation, onPick }: { invitation: LoopbackInvitation; onPick: (endpoint: string) => void }) {
  if (invitation.endpoints.length < 2) {
    return <Text testID="add-phone-endpoint" size="meta" tone="muted">{`地址 ${endpointLabel(invitation.endpoint)}`}</Text>;
  }
  return (
    <Column gap="field">
      <Text size="label" tone="muted">手机连哪个地址：</Text>
      <Row gap="chips" flexWrap="wrap">
        {invitation.endpoints.map((endpoint) => (
          <Chip
            key={endpoint}
            testID={`add-phone-endpoint-${endpointLabel(endpoint)}`}
            label={endpointLabel(endpoint)}
            selected={endpoint === invitation.endpoint}
            onPress={endpoint === invitation.endpoint ? undefined : () => onPick(endpoint)}
          />
        ))}
      </Row>
    </Column>
  );
}
