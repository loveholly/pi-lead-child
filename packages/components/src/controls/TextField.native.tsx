import { Host, TextInput, useNativeState } from '@expo/ui';
import { useEffect } from 'react';

import { fontFaces, palette } from '../theme/tokens';
import { textFieldSpec } from './TextField.shared';
import type { TextFieldProps } from './TextField.types';

export type { TextFieldProps, TextFieldSize, TextFieldVariant } from './TextField.types';

// 原生实现：iOS 上是 SwiftUI TextField，Android 上是 Compose TextField（Expo UI）。
// Expo UI 的输入框用可观察状态（useNativeState）保存文字。这里把它和受控的 value 双向同步，
// 调用方仍然只处理普通字符串，和 web 一样。
export function TextField({
  value, onChangeText, placeholder, variant, size, fontSize, mono = false, disabled = false, multiline = false, height,
  secure = false, autoComplete, autoFocus, autoCapitalize, autoCorrect, keyboardType, returnKeyType, maxLength, grow = false,
  onSubmit, onFocus, onBlur, testID, emphasis,
}: TextFieldProps) {
  const spec = textFieldSpec({ variant, size, fontSize });
  const text = useNativeState(value);

  // 调用方改了 value（例如发送后清空）时，把它写回原生输入框。
  useEffect(() => {
    if (text.get() !== value) text.set(value);
  }, [text, value]);

  return (
    <Host
      seedColor={palette.accent}
      matchContents={{ vertical: true }}
      style={grow ? { flex: 1, minWidth: 0 } : { alignSelf: 'stretch' }}
    >
      <TextInput
        testID={testID}
        value={text}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette[spec.placeholder]}
        editable={!disabled}
        multiline={multiline}
        secureTextEntry={secure}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        keyboardType={keyboardType}
        returnKeyType={returnKeyType}
        maxLength={maxLength}
        onSubmitEditing={onSubmit}
        onFocus={onFocus}
        onBlur={onBlur}
        style={{
          height: multiline ? height : spec.height,
          paddingHorizontal: spec.paddingX,
          borderRadius: spec.radius,
          borderWidth: spec.borderWidth,
          // 原生上没有光晕，只换边框色（主题 11.2）。
          borderColor: emphasis === 'accent' ? palette.accent : spec.border === 'transparent' ? 'transparent' : palette[spec.border],
          backgroundColor: spec.bg === 'transparent' ? 'transparent' : palette[spec.bg],
          opacity: disabled ? 0.6 : 1,
        }}
        textStyle={{
          fontFamily: mono ? fontFaces['mono-medium'] : fontFaces.regular,
          fontSize: Number(spec.fontSize),
          color: palette[spec.text],
        }}
      />
    </Host>
  );
}
