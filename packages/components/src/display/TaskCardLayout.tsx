import { useId, useState, type ComponentType, type ReactNode } from 'react';

import { Icon } from './Icon';
import { Spinner } from './Spinner';
import { Card } from './Card';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import {
  formatToolDetail,
  groupTaskSteps,
  stepStateLabel,
  summarizeGroupArgs,
  summarizeToolArgs,
  taskCardSpec,
  taskCardSummary,
  type TaskCardSummary,
  type TaskTimelineItem,
} from './TaskCard.shared';
import type { TaskCardProps, TaskCardTool, TaskStepState } from './TaskCard.types';

// 展开和收起的按钮。web 和原生各给一个实现（TaskCard.tsx / TaskCard.native.tsx）：
// 都是 button 角色，并报告展开状态；web 上是真正的 <button>，键盘可以聚焦和按下。
export type TaskCardToggleProps = {
  expanded: boolean;
  onPress: () => void;
  // 无障碍名称。
  label: string;
  // 被展开的区域的 id。区域只在展开时存在，所以实现只在 expanded 时引用它。
  controls: string;
  children: ReactNode;
  testID?: string;
  // 并进消息头时按钮只占文字的宽度。
  inline?: boolean;
};

type Toggle = ComponentType<TaskCardToggleProps>;

// 受控或自管的展开状态：调用方给了值就用调用方的，否则卡片自己记。
function useExpansion(props: TaskCardProps) {
  const [ownExpanded, setOwnExpanded] = useState(false);
  const [ownSteps, setOwnSteps] = useState<readonly string[]>([]);
  const expanded = props.expanded ?? ownExpanded;
  const expandedSteps = props.expandedStepIds ?? ownSteps;
  return {
    expanded,
    setExpanded(next: boolean) {
      if (props.expanded === undefined) setOwnExpanded(next);
      props.onExpandedChange?.(next);
    },
    isStepExpanded: (id: string) => expandedSteps.includes(id),
    toggleStep(id: string) {
      const next = !expandedSteps.includes(id);
      if (props.expandedStepIds === undefined) {
        setOwnSteps((current) => next ? [...current, id] : current.filter((value) => value !== id));
      }
      props.onStepExpandedChange?.(id, next);
    },
  };
}

export function TaskCardLayout({ Toggle, ...props }: TaskCardProps & { Toggle: Toggle }) {
  const summary = taskCardSummary(props);
  const expansion = useExpansion(props);
  const bodyId = `task-card-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const items = groupTaskSteps(props.steps);
  const thinking = props.status === 'thinking' || (props.status === 'working' && summary.title === 'Thinking');
  const title = summary.detail ? `${summary.title} · ${summary.detail}` : summary.title;
  const timeline = expansion.expanded ? (
    <Column
      id={bodyId}
      {...(props.variant === 'inline'
        ? { pt: 4, pl: 2 } as const
        : { borderTopWidth: 1, borderTopColor: 'border-soft', px: taskCardSpec.paddingX, pt: 11, pb: 3 } as const)}
    >
      {items.map((item, index) => (
        <TimelineItem
          key={item.id}
          item={item}
          last={index === items.length - 1 && !thinking}
          Toggle={Toggle}
          isStepExpanded={expansion.isStepExpanded}
          toggleStep={expansion.toggleStep}
        />
      ))}
      {thinking ? (
        <TimelineRow marker={<Spinner size={taskCardSpec.markerIcon + 1} color="accent" />} last>
          <Text size="label" weight="semibold" tone="secondary">Thinking</Text>
        </TimelineRow>
      ) : null}
      {items.length === 0 && !thinking ? (
        <Text size="note" tone="muted" pb="timeline-event">没有步骤。</Text>
      ) : null}
    </Column>
  ) : null;
  if (props.variant === 'inline') {
    return <InlineSummary {...props} Toggle={Toggle} expansion={expansion} bodyId={bodyId} title={title} timeline={timeline} />;
  }
  return (
    <Card
      testID={props.testID}
      w="100%"
      rounded="lg"
      bg="surface"
      borderColor={taskCardSpec.border[summary.tone]}
      overflow="hidden"
    >
      <Toggle
        expanded={expansion.expanded}
        onPress={() => expansion.setExpanded(!expansion.expanded)}
        label={`任务步骤，${title}`}
        controls={bodyId}
        testID={props.testID ? `${props.testID}-toggle` : undefined}
      >
        <Row w="100%" minH={taskCardSpec.headerMinHeight} items="center" gap="side-item" px={taskCardSpec.paddingX} py="card">
          <SummaryMarker tone={summary.tone} testID={props.testID ? `${props.testID}-marker` : undefined} />
          <Row flex={1} minW={0} items="center" gap="inline-item">
            <Text
              size="card-title"
              weight="semibold"
              mono={summary.detail !== null && !thinking}
              tone={summary.tone === 'failed' ? 'danger-dark' : 'default'}
              align="left"
              numberOfLines={1}
              shrink={0}
            >
              {summary.title}
            </Text>
            {summary.detail ? (
              <Text flex={1} minW={0} size="code" mono tone="muted" align="left" numberOfLines={1}>{`· ${summary.detail}`}</Text>
            ) : null}
          </Row>
          <Icon name={expansion.expanded ? 'chevron-up' : 'chevron-down'} size={13} color="text-muted" weight="semibold" />
        </Row>
      </Toggle>
      {timeline}
    </Card>
  );
}

// 并进消息头的一行：「Lead · 17:57 · 5 个工具 · 21 秒 ⌄」。和时间一样是灰色小字，没有卡片、没有成功的勾。
// 在跑时前面有一个小转圈；有失败的工具时，失败数单独用琥珀色写出来。
function InlineSummary({
  Toggle, expansion, bodyId, title, timeline, ...props
}: TaskCardProps & {
  Toggle: Toggle;
  expansion: ReturnType<typeof useExpansion>;
  bodyId: string;
  title: string;
  timeline: ReactNode;
}) {
  const summary = taskCardSummary(props);
  const failedCount = props.steps.filter((step) => step.kind === 'tool' && step.state === 'failed').length;
  const failedLabel = failedCount ? `${failedCount} 个失败` : null;
  const quietTitle = failedLabel ? title.replace(` · ${failedLabel}`, '') : title;
  return (
    <Column testID={props.testID ? `${props.testID}-inline` : undefined} w="100%" gap="card-row">
      <Row items="center" gap="inline-item" flexWrap="wrap">
        {props.leadingMark ?? null}
        {props.leading ? <Text size="meta" weight="semibold" tone="secondary">{props.leading}</Text> : null}
        {/* spacing-exempt: 分隔点字号 */}
        {props.leading ? <Text size="11" weight="semibold" tone="secondary" aria-hidden>·</Text> : null}
        <Toggle
          inline
          expanded={expansion.expanded}
          onPress={() => expansion.setExpanded(!expansion.expanded)}
          label={`任务步骤，${title}`}
          controls={bodyId}
          testID={props.testID ? `${props.testID}-toggle` : undefined}
        >
          {/* spacing-exempt: 摘要开关点击区 */}
          <Row items="center" gap="inline-item" px={4} minH={24}>
            {summary.tone === 'running' && !props.leadingMark ? <Spinner size={10} color="accent" /> : null}
            <Text size="meta" weight="semibold" tone={summary.tone === 'failed' ? 'danger-dark' : 'secondary'} numberOfLines={1}>{quietTitle}</Text>
            {failedLabel ? (
              <Text testID={props.testID ? `${props.testID}-failures` : undefined} size="meta" weight="semibold" tone="warning-dark">{failedLabel}</Text>
            ) : null}
            <Icon name={expansion.expanded ? 'chevron-up' : 'chevron-down'} size={10} color="text-secondary" weight="semibold" />
          </Row>
        </Toggle>
      </Row>
      {timeline}
    </Column>
  );
}

function SummaryMarker({ tone, testID }: { tone: TaskCardSummary['tone']; testID?: string }) {
  if (tone === 'running') return <Box testID={testID} w={18} h={18} items="center" justify="center"><Spinner size={13} color="accent" /></Box>;
  const failed = tone === 'failed';
  return (
    <Box testID={testID} w={18} h={18} rounded="full" items="center" justify="center" bg={failed ? 'danger-soft' : 'success-soft'}>
      <Icon name={failed ? 'exclamation' : 'check'} size={11} color={failed ? 'danger' : 'success'} weight="bold" />
    </Box>
  );
}

function StepMarker({ state }: { state: TaskStepState }) {
  if (state === 'running') return <Spinner size={taskCardSpec.markerIcon + 1} color="accent" />;
  if (state === 'stopped') {
    return (
      <Box w={taskCardSpec.markerBox} h={taskCardSpec.markerBox} rounded="full" items="center" justify="center" bg={taskCardSpec.markerBackground.stopped}>
        <Box w={7} h={1.5} rounded="full" bg={taskCardSpec.markerColor.stopped} />
      </Box>
    );
  }
  return (
    <Box
      w={taskCardSpec.markerBox}
      h={taskCardSpec.markerBox}
      rounded="full"
      items="center"
      justify="center"
      bg={taskCardSpec.markerBackground[state]}
    >
      <Icon
        name={state === 'failed' ? 'exclamation' : 'check'}
        size={taskCardSpec.markerIcon}
        color={taskCardSpec.markerColor[state]}
        weight="bold"
      />
    </Box>
  );
}

// 时间线的一行：左边是圆点和连到下一步的竖线，右边是内容。
function TimelineRow({ marker, last, children }: { marker: ReactNode; last: boolean; children: ReactNode }) {
  return (
    <Row items="stretch" gap="timeline">
      <Column w={taskCardSpec.markerBox} items="center">
        <Box w={taskCardSpec.markerBox} h={18} items="center" justify="center">{marker}</Box>
        {/* spacing-exempt: 轨道线和标记的间隙 */}
        {last ? null : <Box flex={1} w={taskCardSpec.railWidth} bg={taskCardSpec.railColor} my={2} />}
      </Column>
      <Column flex={1} minW={0} pb={last ? 8 : 12}>{children}</Column>
    </Row>
  );
}

type StepHandlers = {
  Toggle: Toggle;
  isStepExpanded: (id: string) => boolean;
  toggleStep: (id: string) => void;
};

function TimelineItem({ item, last, ...handlers }: { item: TaskTimelineItem; last: boolean } & StepHandlers) {
  if (item.kind === 'note') {
    return (
      <TimelineRow
        last={last}
        marker={<Box w={taskCardSpec.noteDot} h={taskCardSpec.noteDot} rounded="full" bg="text-faint" />}
      >
        <Text size="secondary" tone="secondary">{item.step.text}</Text>
      </TimelineRow>
    );
  }
  if (item.kind === 'tool') {
    return (
      <TimelineRow last={last} marker={<StepMarker state={item.step.state} />}>
        <ToolCall step={item.step} {...handlers} />
      </TimelineRow>
    );
  }
  const open = handlers.isStepExpanded(item.id);
  const detailId = `${item.id}-calls`.replace(/[^A-Za-z0-9_-]/g, '-');
  const summary = summarizeGroupArgs(item.steps);
  return (
    <TimelineRow last={last} marker={<StepMarker state={item.state} />}>
      <handlers.Toggle
        expanded={open}
        onPress={() => handlers.toggleStep(item.id)}
        label={`${item.name} ×${item.steps.length}，${stepStateLabel[item.state]}`}
        controls={detailId}
      >
        <StepLine name={item.name} count={item.steps.length} summary={summary} open={open} />
      </handlers.Toggle>
      {open ? (
        // spacing-exempt: 分组调用的小缩进
        <Column id={detailId} gap="list-row" pt="timeline-event" pl={2}>
          {item.steps.map((step) => (
            <Row key={step.id} items="flex-start" gap="timeline">
              <Box w={12} h={18} items="center" justify="center">
                <Box w={5} h={5} rounded="full" bg={taskCardSpec.markerColor[step.state]} />
              </Box>
              <Column flex={1} minW={0}>
                <ToolCall step={step} {...handlers} />
              </Column>
            </Row>
          ))}
        </Column>
      ) : null}
    </TimelineRow>
  );
}

function StepLine({ name, count, summary, open }: { name: string; count?: number; summary: string; open: boolean }) {
  return (
    <Row w="100%" minH={18} items="center" gap="inline-item">
      <Text size="code" mono weight="semibold" align="left" numberOfLines={1} shrink={0} maxW="60%">{name}</Text>
      {count ? <Text size="meta" mono weight="semibold" tone="muted" shrink={0}>{`×${count}`}</Text> : null}
      <Text flex={1} minW={0} size="code" mono tone="muted" align="left" numberOfLines={1}>{summary}</Text>
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={11} color="text-faint" weight="semibold" />
    </Row>
  );
}

// 一次工具调用：一行名字和参数，展开后是完整的参数、结果和失败原因。
function ToolCall({ step, Toggle, isStepExpanded, toggleStep }: { step: TaskCardTool } & StepHandlers) {
  const open = isStepExpanded(step.id);
  const summary = summarizeToolArgs(step.args);
  const detailId = `${step.id}-detail`.replace(/[^A-Za-z0-9_-]/g, '-');
  return (
    <Column>
      <Toggle
        expanded={open}
        onPress={() => toggleStep(step.id)}
        label={[step.name, summary, stepStateLabel[step.state]].filter(Boolean).join('，')}
        controls={detailId}
      >
        <StepLine name={step.name} summary={summary} open={open} />
      </Toggle>
      {open ? <ToolCallDetail id={detailId} step={step} /> : null}
    </Column>
  );
}

function ToolCallDetail({ id, step }: { id: string; step: TaskCardTool }) {
  const args = formatToolDetail(step.args);
  const result = formatToolDetail(step.result);
  const error = step.error;
  const showResult = step.state !== 'running' && result && !(step.state === 'failed' && result === error);
  return (
    // spacing-exempt: 光学对齐
    <Column id={id} gap="card-row" pt="card-row" pb={2}>
      {args && args !== '{}' ? <DetailBlock label="参数" text={args} /> : null}
      {step.state === 'running' ? <Text size="meta" tone="muted">运行中…</Text> : null}
      {showResult ? <DetailBlock label="结果" text={result} /> : null}
      {error ? <Text size="note" weight="medium" tone="danger-dark">{error}</Text> : null}
      {step.truncated ? <Text size="note" weight="bold" tone="warning-dark">内容已截断</Text> : null}
    </Column>
  );
}

function DetailBlock({ label, text }: { label: string; text: string }) {
  return (
    <Column gap="text-stack">
      <Text size="label" weight="bold" tone="muted">{label}</Text>
      <Box bg="surface-subtle" rounded="sm" borderWidth={1} borderColor="border-soft" px="inset-x" py="inset-y">
        <Text size="code" mono tone="strong">{text}</Text>
      </Box>
    </Column>
  );
}
