import { Icon } from '../display/Icon';
import { Box, Column, Row } from '../primitives/layout';
import { Text, type TextTone } from '../primitives/Text';

// skipped：这一步不做了，detail 写原因。blocked：这一步卡住了，等别人或别的事，detail 写卡在哪里。
export type StepState = 'done' | 'current' | 'pending' | 'failed' | 'skipped' | 'blocked';

export type StepItem = { label: string; state: StepState; detail?: string };

export type StepsProps = {
  items: readonly StepItem[];
  /**
   * regular：聊天卡片里的步骤，20 的圆形标记用竖线连起来。
   * compact：工单详情的执行计划（第四轮画板），18 的浅色标记，不画连线。
   */
  variant?: 'regular' | 'compact';
  testID?: string;
};

// 每种状态在无障碍服务里的名字，也是标记的 aria-label。
const STEP_LABEL: Record<StepState, string> = {
  done: '已完成', current: '进行中', pending: '未开始', failed: '失败', skipped: '已跳过', blocked: '受阻',
};

function labelTone(state: StepState): TextTone {
  if (state === 'skipped' || state === 'pending') return 'secondary';
  if (state === 'failed') return 'danger-dark';
  if (state === 'blocked') return 'warning-dark';
  return 'default';
}

// 一列步骤：左边是状态标记，右边是步骤名和说明。
export function Steps({ items, variant = 'regular', testID }: StepsProps) {
  if (variant === 'compact') {
    return (
      <Column testID={testID}>
        {items.map((item, index) => (
          <Row key={index} gap="side-item" items="flex-start" py="row-y">
            {/* spacing-exempt: 光学对齐 */}
            <Box mt={1} shrink={0}><CompactMark state={item.state} /></Box>
            <Column flex={1} minW={0}>
              <Text
                size="card-title"

                weight={item.state === 'current' ? 'bold' : 'regular'}
                tone={item.state === 'pending' ? 'default' : labelTone(item.state)}
              >
                {item.label}
              </Text>
              {item.detail ? <Text size="secondary" tone="secondary">{item.detail}</Text> : null}
            </Column>
          </Row>
        ))}
      </Column>
    );
  }
  return (
    <Column testID={testID}>
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <Row key={index} gap="side-item" items="stretch">
            <Column w={20} items="center" shrink={0}>
              <StepMark state={item.state} />
              {/* spacing-exempt: 轨道线和标记的间隙 */}
              {last ? null : <Box flex={1} w={2} minH={8} my={2} rounded="full" bg={item.state === 'done' ? 'success-line' : 'border'} />}
            </Column>
            <Column flex={1} minW={0} gap="text-stack" pb={last ? 0 : 12}>
              <Text
                size="card-title"

                weight={item.state === 'current' ? 'semibold' : 'regular'}
                tone={labelTone(item.state)}
              >
                {item.label}
              </Text>
              {item.detail ? <Text size="secondary" tone="secondary">{item.detail}</Text> : null}
            </Column>
          </Row>
        );
      })}
    </Column>
  );
}

function StepMark({ state }: { state: StepState }) {
  const label = STEP_LABEL[state];
  if (state === 'done' || state === 'failed') {
    return (
      <Box aria-label={label} role="img" w={20} h={20} rounded="full" bg={state === 'done' ? 'success' : 'danger'} items="center" justify="center">
        <Icon name={state === 'done' ? 'check' : 'close'} size={11} color="white" weight="bold" />
      </Box>
    );
  }
  if (state === 'blocked') {
    return (
      <Box aria-label={label} role="img" w={20} h={20} rounded="full" bg="warning" items="center" justify="center">
        <Icon name="exclamation" size={11} color="white" weight="bold" />
      </Box>
    );
  }
  if (state === 'current') {
    return (
      <Box aria-label={label} role="img" w={20} h={20} rounded="full" borderWidth={2} borderColor="accent" items="center" justify="center">
        <Box w={8} h={8} rounded="full" bg="accent" />
      </Box>
    );
  }
  if (state === 'skipped') {
    return (
      <Box aria-label={label} role="img" w={20} h={20} rounded="full" bg="surface-muted" items="center" justify="center">
        <Box w={8} h={2} rounded="full" bg="text-muted" />
      </Box>
    );
  }
  return <Box aria-label={label} role="img" w={20} h={20} rounded="full" borderWidth={1.5} borderColor="border-strong" bg="surface" />;
}

// 浅底深色的小标记：完成是浅绿底的勾，失败和受阻是同样做法的红色、琥珀色。
function CompactMark({ state }: { state: StepState }) {
  const label = STEP_LABEL[state];
  if (state === 'done' || state === 'failed' || state === 'blocked') {
    const look = {
      done: { bg: 'success-soft', icon: 'check', color: 'success-dark' },
      failed: { bg: 'danger-soft', icon: 'close', color: 'danger-dark' },
      blocked: { bg: 'warning-soft', icon: 'exclamation', color: 'warning-dark' },
    } as const;
    const { bg, icon, color } = look[state];
    return (
      <Box aria-label={label} role="img" w={18} h={18} rounded="full" bg={bg} items="center" justify="center">
        <Icon name={icon} size={11} color={color} weight="bold" />
      </Box>
    );
  }
  if (state === 'current') {
    return (
      <Box aria-label={label} role="img" w={18} h={18} rounded="full" borderWidth={2} borderColor="accent" items="center" justify="center">
        <Box w={8} h={8} rounded="full" bg="accent" />
      </Box>
    );
  }
  if (state === 'skipped') {
    return (
      <Box aria-label={label} role="img" w={18} h={18} rounded="full" bg="surface-muted" items="center" justify="center">
        <Box w={8} h={2} rounded="full" bg="text-muted" />
      </Box>
    );
  }
  return <Box aria-label={label} role="img" w={18} h={18} rounded="full" borderWidth={1.5} borderColor="text-muted" />;
}
