import { Pressable } from 'react-native';

import { ChatDockFrame } from './ChatDockFrame';
import type { ChatDockProps, ChatDockToggleProps } from './ChatDock.types';

export type { ChatDockProps } from './ChatDock.types';

// 原生实现：展开按钮是 React Native 的 Pressable，VoiceOver 和 TalkBack 读作按钮，并读出展开或收起。
// 其余部分和 web 一样由 Tamagui 渲染（ChatDockFrame）。web 实现见 ChatDock.tsx。
function NativeToggle({ expanded, onPress, label, controls, children, testID }: ChatDockToggleProps) {
  return (
    <Pressable
      testID={testID}
      nativeID={`${controls}-toggle`}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ alignSelf: 'stretch', opacity: pressed ? 0.6 : 1 })}
    >
      {children}
    </Pressable>
  );
}

export function ChatDock(props: ChatDockProps) {
  return <ChatDockFrame {...props} Toggle={NativeToggle} />;
}
