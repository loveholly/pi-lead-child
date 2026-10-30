import { Button as ExpoButton, Host, RNHostView, Row, Text as ExpoText, type ButtonVariant as ExpoVariant } from '@expo/ui';
import { View } from 'react-native';

import { Dot } from '../display/Dot';
import { Icon } from '../display/Icon';
import { fontFaces, palette } from '../theme/tokens';
import { buttonSpec, iconButtonSpec, type ButtonSpec } from './Button.shared';
import type { ButtonProps, ButtonVariant, IconButtonProps } from './Button.types';
import { fullWidthModifiers } from './nativeModifiers';

export type { ButtonProps, ButtonSize, ButtonTone, ButtonVariant, IconButtonProps } from './Button.types';

// 原生实现：iOS 上是 SwiftUI Button，Android 上是 Jetpack Compose Button（Expo UI）。
// 尺寸和颜色来自和 web 同一份 buttonSpec。

const EXPO_VARIANT: Record<ButtonVariant, ExpoVariant> = {
  solid: 'filled',
  soft: 'filled',
  outline: 'outlined',
  ghost: 'text',
  link: 'text',
};

function color(token: ButtonSpec['bg']): string {
  return token === 'transparent' ? 'transparent' : palette[token];
}

function frameStyle(spec: ButtonSpec) {
  return {
    height: spec.height,
    paddingHorizontal: spec.paddingX,
    paddingVertical: 0,
    borderRadius: spec.radius,
    backgroundColor: color(spec.bg),
    borderWidth: spec.borderWidth,
    borderColor: color(spec.border),
    opacity: spec.opacity,
  };
}

export function Button({
  label, onPress, variant = 'solid', tone, size, shape, icon, iconPosition = 'start', disabled = false, fullWidth = false,
  testID,
}: ButtonProps) {
  const spec = buttonSpec({ variant, tone, size, shape, disabled });
  const iconNode = icon ? (
    <RNHostView matchContents>
      <Icon name={icon} size={spec.iconSize} color={spec.text} weight="semibold" />
    </RNHostView>
  ) : null;
  return (
    <Host
      matchContents={fullWidth ? { vertical: true } : true}
      seedColor={palette.accent}
      style={fullWidth ? { alignSelf: 'stretch' } : undefined}
    >
      <ExpoButton
        testID={testID}
        variant={EXPO_VARIANT[variant]}
        disabled={disabled}
        onPress={onPress}
        style={frameStyle(spec)}
        modifiers={fullWidth ? fullWidthModifiers() : undefined}
      >
        <Row alignment="center" spacing={6}>
          {iconPosition === 'start' ? iconNode : null}
          <ExpoText
            numberOfLines={1}
            textStyle={{ fontFamily: fontFaces[spec.fontFace], fontSize: Number(spec.fontSize), color: palette[spec.text] }}
          >
            {label}
          </ExpoText>
          {iconPosition === 'end' ? iconNode : null}
        </Row>
      </ExpoButton>
    </Host>
  );
}

export function IconButton({
  icon, label, onPress, variant = 'outline', tone, size, disabled = false, badge = false, iconSize, iconColor, rounded,
  testID,
}: IconButtonProps) {
  const spec = iconButtonSpec({ variant, tone, size, disabled, rounded, iconSize, iconColor });
  return (
    <Host matchContents seedColor={palette.accent}>
      <ExpoButton
        testID={testID ?? label}
        variant={EXPO_VARIANT[variant]}
        disabled={disabled}
        onPress={onPress}
        style={{ ...frameStyle(spec), width: spec.box, paddingHorizontal: 0 }}
      >
        <RNHostView matchContents>
          <View accessibilityLabel={label} style={{ width: spec.box, height: spec.box, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={icon} size={spec.iconSize} color={spec.iconColor} weight={variant === 'solid' ? 'bold' : 'medium'} />
            {badge ? (
              <View style={{ position: 'absolute', top: 6, right: 7 }}>
                <Dot color="danger" size={7} ring="surface" ringWidth={1.5} />
              </View>
            ) : null}
          </View>
        </RNHostView>
      </ExpoButton>
    </Host>
  );
}
