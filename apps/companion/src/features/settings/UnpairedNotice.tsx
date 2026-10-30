import { Button, Card, Dot, Row, Text } from '@pi-lead-child/components';
import { useRouter, type Href } from 'expo-router';

import { useLeadName } from '@/state/hooks';

// 设备分组里还没配对时的提示。配对表单只有配对页一份，这里只给入口。
export function UnpairedNotice() {
  const router = useRouter();
  const leadName = useLeadName();
  return (
    <Card testID="settings-unpaired" p="page-card" rounded="2xl" gap="card-row">
      <Row items="center" gap="icon-label">
        <Dot color="text-muted" size={9} />
        <Text size="card-title" weight="extrabold">还没有配对</Text>
      </Row>
      <Text size="secondary" tone="secondary">{`这台设备还没有和 ${leadName} 配对。配对以后才能看到它和工单。`}</Text>
      <Row>
        <Button testID="settings-pair" label={`配对 ${leadName}`} size="lg" onPress={() => router.push('/pair' as Href)} />
      </Row>
    </Card>
  );
}
