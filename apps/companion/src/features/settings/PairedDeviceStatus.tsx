import { Button, Column, Dot, Row, Text } from '@pi-lead-child/components';
import type { ReactNode } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useEndpointMismatch } from '@/state/hooks';

// 已经配对的设备：状态、说明、配置的地址配不上时的提示，以及移除凭证。
// 设置的「本设备」和配对页（配对完成的那一刻）都用它。details 放在状态下面，例如这个设备的名称和类型。
export function PairedDeviceStatus({ details }: { details?: ReactNode }) {
  const runtime = useCompanionRuntime();
  const endpointMismatch = useEndpointMismatch();
  return (
    <Column testID="paired-device-status" gap="card-row">
      <Row items="center" gap="icon-label">
        <Dot color="success" size={9} />
        <Text size="card-title" weight="extrabold">已配对</Text>
      </Row>
      {details}
      <Text size="note" tone="muted">凭证已保存。事件流断开时会使用持久化序号自动续传。</Text>
      {endpointMismatch ? (
        <Text size="secondary" weight="semibold" tone="danger-dark">
          {`配置的本机 daemon ${endpointMismatch.configuredEndpoint} 无法配对（${endpointMismatch.error}），继续使用已保存的 ${endpointMismatch.activeEndpoint}。`}
        </Text>
      ) : null}
      <Button
        testID="pair-forget"
        label="移除此设备凭证"
        variant="outline"
        tone="danger"
        size="lg"
        fullWidth
        onPress={() => void runtime.forget()}
      />
    </Column>
  );
}
