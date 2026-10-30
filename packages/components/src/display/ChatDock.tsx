import { styled, View } from '@tamagui/core';
import { useEffect } from 'react';

import { ChatDockFrame } from './ChatDockFrame';
import type { ChatDockProps, ChatDockToggleProps } from './ChatDock.types';

export type { ChatDockProps } from './ChatDock.types';

// web 实现：展开按钮是真正的 <button>，键盘能聚焦，回车和空格能按下；aria-expanded 报告展开状态，
// aria-controls 指向展开后的对话区域。展开时按 Esc 收起。原生实现见 ChatDock.native.tsx。
const ToggleFrame = styled(View, {
  displayName: 'ChatDockToggle',
  render: 'button',
  role: 'button',
  w: '100%',
  p: 0,
  m: 0,
  borderWidth: 0,
  bg: 'transparent',
  cursor: 'pointer',
  items: 'stretch',
});

function WebToggle({ expanded, onPress, label, controls, children, testID }: ChatDockToggleProps) {
  return (
    <ToggleFrame
      testID={testID}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={label}
      onPress={onPress}
    >
      {children}
    </ToggleFrame>
  );
}

export function ChatDock(props: ChatDockProps) {
  const { expanded, onExpandedChange } = props;
  useEffect(() => {
    if (!expanded || typeof document === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onExpandedChange(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [expanded, onExpandedChange]);
  return <ChatDockFrame {...props} Toggle={WebToggle} />;
}
