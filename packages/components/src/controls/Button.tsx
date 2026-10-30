import { styled, View } from '@tamagui/core';

import { Dot } from '../display/Dot';
import { Icon } from '../display/Icon';
import { Text } from '../primitives/Text';
import { buttonSpec, iconButtonSpec } from './Button.shared';
import type { ButtonProps, IconButtonProps } from './Button.types';

export type { ButtonProps, ButtonSize, ButtonTone, ButtonVariant, IconButtonProps } from './Button.types';

// web 实现：Tamagui 渲染成 <button>。原生实现见 Button.native.tsx。
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

export function Button({
  label, onPress, variant, tone, size, shape, icon, iconPosition = 'start', disabled = false, fullWidth = false,
  testID, accessibilityLabel,
}: ButtonProps) {
  const spec = buttonSpec({ variant, tone, size, shape, disabled });
  const iconNode = icon ? <Icon name={icon} size={spec.iconSize} color={spec.text} weight="semibold" /> : null;
  return (
    <Frame
      testID={testID}
      aria-label={accessibilityLabel ?? label}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onPress={disabled ? undefined : onPress}
      h={spec.height}
      px={spec.paddingX}
      rounded={spec.radius}
      bg={{ default: spec.bg, hover: spec.hoverBg }}
      borderWidth={spec.borderWidth}
      borderColor={spec.border}
      opacity={spec.opacity}
      w={fullWidth ? '100%' : undefined}
      self={fullWidth ? 'stretch' : undefined}
    >
      {iconPosition === 'start' ? iconNode : null}
      <Text fontFamily={spec.fontFace} size={spec.fontSize} color={spec.text} numberOfLines={1}>{label}</Text>
      {iconPosition === 'end' ? iconNode : null}
    </Frame>
  );
}

export function IconButton({
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
      opacity={spec.opacity}
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
