import { Pressable } from 'react-native';

import { TaskCardLayout, type TaskCardToggleProps } from './TaskCardLayout';
import type { TaskCardProps } from './TaskCard.types';

export type {
  TaskCardNote, TaskCardProps, TaskCardStatus, TaskCardStep, TaskCardTool, TaskStepState,
} from './TaskCard.types';

// 原生实现：展开按钮是 React Native 的 Pressable，VoiceOver 和 TalkBack 读作按钮，并读出展开或收起。
// 卡片的其余部分和 web 一样由 Tamagui 渲染（TaskCardLayout）。web 实现见 TaskCard.tsx。
function NativeToggle({ expanded, onPress, label, controls, children, testID, inline }: TaskCardToggleProps) {
  return (
    <Pressable
      testID={testID}
      nativeID={`${controls}-toggle`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={label}
      accessibilityHint={expanded ? '收起' : '展开'}
      onPress={onPress}
      hitSlop={inline ? { top: 10, bottom: 10 } : undefined}
      style={({ pressed }) => ({ alignSelf: inline ? 'flex-start' : 'stretch', opacity: pressed ? 0.6 : 1 })}
    >
      {children}
    </Pressable>
  );
}

export function TaskCard(props: TaskCardProps) {
  return <TaskCardLayout {...props} Toggle={NativeToggle} />;
}
