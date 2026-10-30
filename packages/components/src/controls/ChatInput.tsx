import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import { TextInput, type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextStyle } from 'react-native';

import { fontFaces, palette, textLeading, textSizes } from '../theme/tokens';
import type { ChatInputProps } from './ChatInput.types';

export type { ChatInputProps } from './ChatInput.types';

// 规格：文字和会话正文一样（message-body，14/24）。最少一行，最多 8 行（192 像素），再多就在框里滚动。
const LINE = textLeading['message-body'];
const MAX_LINES = 8;
const MAX_HEIGHT = LINE * MAX_LINES;

// 浏览器给获得焦点的输入框画的外框。外框由调用方的卡片表达，所以去掉。RN 的类型里没有这些 web 专有值。
const webOnly = { outlineStyle: 'none', resize: 'none' } as unknown as TextStyle;

// web 实现：react-native-web 的多行 TextInput（一个 textarea）。原生实现见 ChatInput.native.tsx。
export function ChatInput({
  value, onChangeText, placeholder, disabled = false, onSubmit, onPasteFiles, onBlur, autoFocus, testID, accessibilityLabel,
}: ChatInputProps) {
  const inputRef = useRef<TextInput>(null);

  // 自动长高：先把高度清零，量出内容要多高，再设回去（textarea 的 scrollHeight 不会小于它现在的高度）。
  // 超过上限时固定在上限，出现滚动条。窗口宽度变了，折行跟着变，再量一次。
  useLayoutEffect(() => {
    const node = textareaOf(inputRef.current);
    if (!node) return;
    const fit = () => {
      node.style.height = '0px';
      const content = node.scrollHeight;
      node.style.height = `${Math.min(Math.max(content, LINE), MAX_HEIGHT)}px`;
      node.style.overflowY = content > MAX_HEIGHT ? 'auto' : 'hidden';
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [value]);

  const paste = useEffectEvent((event: ClipboardEvent) => {
    if (!onPasteFiles || disabled) return;
    const data = event.clipboardData;
    // 剪贴板里有文字（例如从 Excel、Word 复制的内容同时带着一张图）：照常粘贴文字。
    if (!data || data.getData('text/plain')) return;
    const files = imageFiles(data);
    if (!files.length) return;
    event.preventDefault();
    onPasteFiles(files);
  });

  useEffect(() => {
    const node = textareaOf(inputRef.current);
    if (!node) return;
    const listener = (event: ClipboardEvent) => paste(event);
    node.addEventListener('paste', listener);
    return () => node.removeEventListener('paste', listener);
  }, []);

  // Enter 发送，Shift+Enter 换行。输入法正在组字时（isComposing；Safari 在组字结束的那次按键上给 keyCode 229）的 Enter
  // 是确认候选词，不发送。react-native-web 先调 onKeyPress：这里 preventDefault 以后它不再插入换行。
  const keyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const key = event.nativeEvent as unknown as KeyboardEvent;
    if (key.key !== 'Enter' || key.shiftKey || key.isComposing || key.keyCode === 229) return;
    (event as unknown as { preventDefault: () => void }).preventDefault();
    if (!disabled) onSubmit?.();
  };

  return (
    <TextInput
      ref={inputRef}
      testID={testID}
      aria-label={accessibilityLabel ?? placeholder}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={palette['text-muted']}
      editable={!disabled}
      multiline
      numberOfLines={1}
      autoFocus={autoFocus}
      onKeyPress={keyPress}
      onBlur={onBlur}
      style={{
        width: '100%',
        minHeight: LINE,
        maxHeight: MAX_HEIGHT,
        padding: 0,
        borderWidth: 0,
        backgroundColor: 'transparent',
        ...webOnly,
        color: palette.text,
        fontFamily: fontFaces.regular,
        fontSize: textSizes['message-body'],
        lineHeight: LINE,
      }}
    />
  );
}

// react-native-web 的 TextInput 的 ref 就是它的 textarea 元素。
function textareaOf(input: TextInput | null): HTMLTextAreaElement | null {
  const node = input as unknown as HTMLTextAreaElement | null;
  return node && typeof node.addEventListener === 'function' && 'scrollHeight' in node ? node : null;
}

function imageFiles(data: DataTransfer): Blob[] {
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  if (fromItems.length) return fromItems;
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'));
}
