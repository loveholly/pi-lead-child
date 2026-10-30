import { Badge, Box, Button, Column, Icon, Row, Text } from '@pi-lead-child/components';

import type { TimelineStep } from '@/features/workspace/model';

// 执行时间线的一步：左侧状态圆点和竖线，右侧工具名、状态、说明和时间。等待批准的一步带批准按钮。
export function TimelineRow({ step, isLast, onApprove }: { step: TimelineStep; isLast: boolean; onApprove?: () => void }) {
  const complete = step.state === 'complete';
  const running = step.state === 'running';
  const waiting = step.state === 'waiting';
  return (
    <Row minH={90} gap="timeline">
      <Column w={22} items="center">
        <Box
          w={22}
          h={22}
          rounded="full"
          items="center"
          justify="center"
          bg={complete ? 'success-soft' : running ? 'accent-soft' : waiting ? 'warning-surface' : 'transparent'}
        >
          <Icon
            name={complete ? 'check' : running ? 'circle-fill' : 'exclamation'}
            color={complete ? 'success' : running ? 'accent' : 'warning-dark'}
            size={running ? 11 : 13}
            weight="bold"
          />
        </Box>
        {/* spacing-exempt: 轨道线和标记的间隙 */}
        {!isLast ? <Box flex={1} w={2} mt={4} bg="border-soft" /> : null}
      </Column>
      <Column minW={0} flex={1} pb="timeline-event">
        <Row items="center" gap="inline-item">
          <Text size="card-title" mono weight="bold">{step.tool}</Text>
          <Badge
            label={step.stateLabel}
            tone={complete ? 'success' : running ? 'accent' : 'warning'}
            size="sm"
          />
        </Row>
        <Text mt="text-stack" size="secondary" tone="secondary">{step.description}</Text>
        <Text mt="text-stack" size="meta" mono tone="faint">{step.time}</Text>
        {waiting && onApprove ? (
          <Box self="flex-start" mt="card-section">
            <Button label="批准" onPress={onApprove} size="sm" />
          </Box>
        ) : null}
      </Column>
    </Row>
  );
}
