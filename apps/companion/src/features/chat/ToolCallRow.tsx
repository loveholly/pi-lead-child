import { Box, Column, Icon, Pressable, Row, Spinner, Text } from '@pi-lead-child/components';

import type { ToolDisplayProjection, ToolState } from '../../state/types';

type ToolCallRowProps = {
  tool: string;
  state: ToolState;
  args: ToolDisplayProjection | null;
  result: ToolDisplayProjection | null;
  error: string | null;
  expanded: boolean;
  onToggle: () => void;
  label?: string;
};

export const toolStateLabel: Record<ToolState, string> = {
  started: 'starting',
  running: 'running',
  completed: 'done',
  failed: 'failed',
};

// 会话里的一次工具调用：状态图标、工具名，可以展开看参数或结果的预览。
export function ToolCallRow({ tool, state, args, result, error, expanded, onToggle, label }: ToolCallRowProps) {
  const running = state === 'started' || state === 'running';
  const failed = state === 'failed';
  const projection = result ?? args;
  const hasDetails = Boolean(projection?.preview || error);

  return (
    <Column
      aria-label={`${label ?? tool}，${toolStateLabel[state]}${hasDetails ? (expanded ? '，收起详情' : '，展开详情') : ''}`}
      borderBottomWidth={1}
      borderBottomColor={failed ? 'danger-border' : 'border-soft'}
    >
      <Pressable
        testID={`tool-row-${tool}`}
        onPress={hasDetails ? onToggle : undefined}
        feedback={hasDetails ? 'highlight' : 'none'}
        cursor={hasDetails ? 'pointer' : 'default'}
        h={38}
        px="row-x"
        justify="center"
      >
        <Row items="center" gap="side-item">
          <Box
            w={20}
            h={20}
            rounded="xs"
            items="center"
            justify="center"
            bg={failed ? 'danger-soft' : running ? 'accent-soft' : 'success-soft'}
          >
            {running ? (
              <Spinner testID={`tool-spinner-${tool}`} color="accent" size={12} />
            ) : (
              <Icon name={failed ? 'exclamation' : 'check'} color={failed ? 'danger' : 'success'} size={12} weight="bold" />
            )}
          </Box>
          <Row flex={1} minW={0} items="center" gap="inline-item" overflow="hidden">
            <Text size="code" mono weight="semibold" numberOfLines={1}>{tool}</Text>
            {label && label !== tool ? <Text size="meta" tone="muted" numberOfLines={1}>{label}</Text> : null}
          </Row>
          {hasDetails ? (
            <Box w={20} h={20} items="center" justify="center">
              <Icon name={expanded ? 'chevron-up' : 'chevron-down'} color="text-muted" size={13} weight="semibold" />
            </Box>
          ) : null}
        </Row>
      </Pressable>
      {expanded && hasDetails ? (
        // spacing-exempt: 图标宽加间距的缩进
        <Column gap="card-row" px={40} pt="row-y" pb="row-y">
          {error ? <Text size="note" weight="medium" tone="danger-dark">{error}</Text> : null}
          {projection?.preview ? <Text size="code" mono tone="secondary">{projection.preview}</Text> : null}
          {projection?.redacted ? <Text size="note" weight="bold" tone="warning-dark">敏感字段已脱敏</Text> : null}
          {projection?.truncated ? <Text size="note" weight="bold" tone="warning-dark">内容已截断</Text> : null}
          {projection?.artifactRefs.map((artifactId) => (
            <Text key={artifactId} size="code" mono weight="semibold" tone="accent">{`artifact · ${artifactId}`}</Text>
          ))}
        </Column>
      ) : null}
    </Column>
  );
}
