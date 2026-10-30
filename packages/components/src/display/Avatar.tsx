import { View } from '@tamagui/core';

import { Text } from '../primitives/Text';
import type { ColorToken, FontSizeToken, RadiusToken } from '../theme/tokens';
import { Dot } from './Dot';

export type AvatarTone = 'dark' | 'muted' | 'accent' | 'surface';

const TONES: Record<AvatarTone, { bg: ColorToken; text: ColorToken }> = {
  dark: { bg: 'text', text: 'surface' },
  muted: { bg: 'surface-muted', text: 'text-muted' },
  accent: { bg: 'accent', text: 'surface' },
  surface: { bg: 'surface', text: 'text' },
};

export type AvatarProps = {
  // 显示在方块里的一两个字符，例如 "P"、"π"、"?"。
  label: string;
  size?: number;
  tone?: AvatarTone;
  rounded?: RadiusToken;
  mono?: boolean;
  textSize?: FontSizeToken;
  weight?: 'bold' | 'extrabold';
  // 右下角的状态圆点。
  status?: ColorToken;
  testID?: string;
};

// 圆角方块头像，用来表示 Lead、child 或 runtime。
export function Avatar({
  label, size = 28, tone = 'dark', rounded = 'sm', mono = false, textSize, weight = 'extrabold', status, testID,
}: AvatarProps) {
  const colors = TONES[tone];
  const fontSize = textSize ?? (size >= 36 ? '15' : size >= 32 ? '15' : '11.5');
  return (
    <View testID={testID} position="relative" shrink={0}>
      <View w={size} h={size} rounded={rounded} bg={colors.bg} items="center" justify="center">
        <Text size={fontSize} leading={Math.round(Number(fontSize) * 1.2)} weight={weight} mono={mono} color={colors.text} align="center">
          {label}
        </Text>
      </View>
      {status ? (
        <View position="absolute" r={-3} b={-3}>
          <Dot color={status} size={11} ring="surface" />
        </View>
      ) : null}
    </View>
  );
}
