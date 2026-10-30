import { Host, TextInput, useNativeState } from '@expo/ui';
import { useEffect } from 'react';

import { fontFaces, palette, textLeading, textSizes } from '../theme/tokens';
import type { ChatInputProps } from './ChatInput.types';

export type { ChatInputProps } from './ChatInput.types';

// 原生实现：Expo UI 的多行输入框（iOS 是 SwiftUI TextField，Android 是 Compose TextField）。multiline 的输入框随内容长高。
// 键盘的回车换行，发送用旁边的按钮，所以不接 onSubmit；原生上也没有粘贴图片（onPasteFiles 不调）。
// 和 TextField.native.tsx 一样，用可观察状态保存文字，和受控的 value 双向同步。
export function ChatInput({ value, onChangeText, placeholder, disabled = false, onBlur, autoFocus, testID }: ChatInputProps) {
  const text = useNativeState(value);

  // 调用方改了 value（例如发送后清空）时，把它写回原生输入框。
  useEffect(() => {
    if (text.get() !== value) text.set(value);
  }, [text, value]);

  return (
    <Host seedColor={palette.accent} matchContents={{ vertical: true }} style={{ alignSelf: 'stretch' }}>
      <TextInput
        testID={testID}
        value={text}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette['text-muted']}
        editable={!disabled}
        multiline
        autoFocus={autoFocus}
        onBlur={onBlur}
        style={{ padding: 0, backgroundColor: 'transparent' }}
        textStyle={{
          fontFamily: fontFaces.regular,
          fontSize: textSizes['message-body'],
          lineHeight: textLeading['message-body'],
          color: palette.text,
        }}
      />
    </Host>
  );
}
