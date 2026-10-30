import { styled, View } from '@tamagui/core';

import { TaskCardLayout, type TaskCardToggleProps } from './TaskCardLayout';
import type { TaskCardProps } from './TaskCard.types';

export type {
  TaskCardNote, TaskCardProps, TaskCardStatus, TaskCardStep, TaskCardTool, TaskStepState,
} from './TaskCard.types';

// web 实现：展开按钮是真正的 <button>，键盘能聚焦，回车和空格能按下；aria-expanded 报告展开状态，
// aria-controls 指向被展开的区域。原生实现见 TaskCard.native.tsx。
const ToggleFrame = styled(View, {
  displayName: 'TaskCardToggle',
  render: 'button',
  role: 'button',
  w: '100%',
  p: 0,
  m: 0,
  borderWidth: 0,
  bg: { default: 'transparent', hover: 'surface-subtle', press: 'surface-muted' },
  cursor: 'pointer',
  items: 'stretch',
  rounded: 'xs',
});

function WebToggle({ expanded, onPress, label, controls, children, testID, inline }: TaskCardToggleProps) {
  return (
    <ToggleFrame
      testID={testID}
      {...(inline ? { w: 'auto', rounded: 'sm' } as const : {})}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={label}
      onPress={onPress}
    >
      {children}
    </ToggleFrame>
  );
}

export function TaskCard(props: TaskCardProps) {
  return <TaskCardLayout {...props} Toggle={WebToggle} />;
}
