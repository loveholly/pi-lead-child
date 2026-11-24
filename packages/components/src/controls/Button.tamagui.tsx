import { styled, View } from '@tamagui/core';

import { Dot } from '../display/Dot';
import { Icon } from '../display/Icon';
import { Text } from '../primitives/Text';
import { buttonSpec, iconButtonSpec } from './Button.shared';
import type { ButtonProps, IconButtonProps } from './Button.types';

const LABEL_CENTERED = { includeFontPadding: false, textAlignVertical: 'center' } as const;

// Tamagui 实现：web 上渲染成 <button>，Android 上是普通的可点视图。
// web（Button.tsx）和 Android（Button.android.tsx）都用它；iOS 用 SwiftUI（Button.native.tsx）。
// Android 不用 Compose Button（2026-11-12）：它自带的内边距、最小尺寸和外观压不掉，图标按钮里的图标被裁掉，
// 文字被截断，外框画两遍。
const Frame = styled(View, {
  displayName: 'ButtonFrame',
  render: 'button',
  role: 'button',
  flexDirection: 'row',
  items: 'center',
  justify: 'center',
  gap: 6,
  shrink: 0,
  cursor: 'pointer',
  borderStyle: 'solid',
  variants: {
    disabled: { true: { cursor: 'default', pointerEvents: 'none' } },
  } as const,
});

export function TamaguiButton({
  label, onPress, variant, tone, size, shape, icon, iconPosition = 'start', disabled = false, fullWidth = false,
  testID, accessibilityLabel, expanded,
}: ButtonProps) {
  const spec = buttonSpec({ variant, tone, size, shape, disabled });
  const iconNode = icon ? <Icon name={icon} size={spec.iconSize} color={spec.text} weight="semibold" /> : null;
  return (
    <Frame
      testID={testID}
      aria-label={accessibilityLabel ?? label}
      aria-disabled={disabled || undefined}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      h={spec.height}
      px={spec.paddingX}
      rounded={spec.radius}
      bg={{ default: spec.bg, hover: spec.hoverBg }}
      borderWidth={spec.borderWidth}
      borderColor={spec.border}
      // 按下时变淡：Android 没有悬停，按下要有反馈。
      opacity={{ default: spec.opacity, press: spec.opacity * 0.72 }}
      w={fullWidth ? '100%' : undefined}
      self={fullWidth ? 'stretch' : undefined}
    >
      {iconPosition === 'start' ? iconNode : null}
      {/* Android 默认在字的上下留出字体自带的内边距（includeFontPadding），Plus Jakarta 的上边距大，英文字母整体偏下
          （2026-11-15，决定卡的 Accept 低了约 2dp）。关掉它，再让字在行高里竖直居中。网页上没有这两个属性。 */}
      <Text fontFamily={spec.fontFace} size={spec.fontSize} color={spec.text} numberOfLines={1} style={LABEL_CENTERED}>{label}</Text>
      {iconPosition === 'end' ? iconNode : null}
    </Frame>
  );
}

export function TamaguiIconButton({
  icon, label, onPress, variant, tone, size, disabled = false, badge = false, iconSize, iconColor, rounded, testID,
}: IconButtonProps) {
  const spec = iconButtonSpec({ variant, tone, size, disabled, rounded, iconSize, iconColor });
  return (
    <Frame
      testID={testID ?? label}
      aria-label={label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      position="relative"
      w={spec.box}
      h={spec.box}
      p={0} // spacing-exempt: 图标按钮没有内边距
      rounded={spec.radius}
      bg={{ default: spec.bg, hover: spec.hoverBg }}
      borderWidth={spec.borderWidth}
      borderColor={spec.border}
      // 按下时变淡：Android 没有悬停，按下要有反馈。
      opacity={{ default: spec.opacity, press: spec.opacity * 0.72 }}
    >
      <Icon name={icon} size={spec.iconSize} color={spec.iconColor} weight={variant === 'solid' ? 'bold' : 'medium'} />
      {badge ? (
        <View position="absolute" t={6} r={7}>
          <Dot color="danger" size={7} ring="surface" ringWidth={1.5} />
        </View>
      ) : null}
    </Frame>
  );
}
