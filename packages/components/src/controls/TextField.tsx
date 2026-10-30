import { View } from '@tamagui/core';
import { TextInput, type TextStyle } from 'react-native';

import { fontFaces, palette } from '../theme/tokens';
import { textFieldSpec } from './TextField.shared';
import type { TextFieldProps } from './TextField.types';

export type { TextFieldProps, TextFieldSize, TextFieldVariant } from './TextField.types';

// 浏览器给获得焦点的输入框画的外框。外框由外层的描边表达，所以去掉。RN 的类型里没有这个 web 专有值。
const noFocusOutline = { outlineStyle: 'none' } as unknown as TextStyle;
// JetBrains Mono 的代码连字（calt）把 :// 画成一个字形，地址看起来像「https: /」。输入框里关掉连字，输入的字符原样显示。
const noLigatures = { fontVariantLigatures: 'none' } as unknown as TextStyle;

// web 实现：Tamagui 渲染外框（底色、描边、圆角），里面是 react-native-web 的 TextInput。
// 输入元素本身不经过 styled()：Tamagui 包装外来组件时会丢掉 testID，也拿不到字体类。
// 原生实现见 TextField.native.tsx。
export function TextField({
  value, onChangeText, placeholder, variant, size, fontSize, mono = false, disabled = false, multiline = false, height,
  secure = false, autoComplete, autoFocus, autoCapitalize, autoCorrect, keyboardType, returnKeyType, maxLength, grow = false,
  onSubmit, onFocus, onBlur, testID, accessibilityLabel, emphasis,
}: TextFieldProps) {
  const spec = textFieldSpec({ variant, size, fontSize });
  return (
    <View
      flexDirection="row"
      items={multiline ? 'flex-start' : 'center'}
      flex={grow ? 1 : undefined}
      minW={0}
      h={multiline ? height : spec.height}
      minH={multiline ? spec.height : undefined}
      px={spec.paddingX}
      rounded={spec.radius}
      bg={spec.bg}
      borderWidth={spec.borderWidth}
      borderColor={emphasis === 'accent' ? 'accent' : spec.border}
      // 光晕的宽度是组件规格（主题 11.2）。
      {...(emphasis === 'accent' ? { boxShadow: `0 0 0 3px ${palette['accent-soft']}` } : {})}
      opacity={disabled ? 0.6 : 1}
    >
      <TextInput
        testID={testID}
        aria-label={accessibilityLabel ?? placeholder}
        value={value}
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
        onSubmitEditing={onSubmit ? (event) => onSubmit(event.nativeEvent.text) : undefined}
        onFocus={onFocus}
        onBlur={onBlur}
        style={{
          flex: 1,
          minWidth: 0,
          alignSelf: 'stretch',
          paddingVertical: multiline ? 12 : 0,
          paddingHorizontal: 0,
          borderWidth: 0,
          backgroundColor: 'transparent',
          ...noFocusOutline,
          color: palette[spec.text],
          fontFamily: mono ? fontFaces['mono-medium'] : fontFaces.regular,
          ...(mono ? noLigatures : null),
          fontSize: Number(spec.fontSize),
        }}
      />
    </View>
  );
}
