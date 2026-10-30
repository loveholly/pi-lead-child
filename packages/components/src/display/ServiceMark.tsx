import { View } from '@tamagui/core';

import { Text } from '../primitives/Text';
import { palette, type FontSizeToken } from '../theme/tokens';

// 第三方服务（设置里的「连接」）。
export type ServiceMarkService = 'atlassian' | 'github' | 'notion' | 'slack' | 'google' | 'custom';
export type ServiceMarkSize = 24 | 32 | 40;

export type ServiceMarkProps = {
  service: ServiceMarkService;
  // custom 用它的第一个字作字母。别的服务有固定的字母。
  label?: string;
  size?: ServiceMarkSize;
  testID?: string;
};

type Brand = { bg: string; text: string; border?: string; dashed?: boolean; letter?: string };

// 各服务的品牌色只在这里。应用里只写服务名，不写颜色。
const BRANDS: Record<ServiceMarkService, Brand> = {
  atlassian: { bg: '#1868DB', text: palette.white, letter: 'J' },
  github: { bg: '#1F2328', text: palette.white, letter: 'GH' },
  notion: { bg: palette.white, text: '#191919', border: '#191919', letter: 'N' },
  slack: { bg: '#4A154B', text: palette.white, letter: 'S' },
  google: { bg: palette.white, text: '#4285F4', border: palette['border-strong'], letter: 'G' },
  custom: { bg: palette.white, text: palette['text-muted'], border: palette['text-ghost'], dashed: true },
};

const SIZES: Record<ServiceMarkSize, { radius: number; font: FontSizeToken; border: number }> = {
  24: { radius: 7, font: '11', border: 1 },
  32: { radius: 9, font: '13', border: 1.5 },
  40: { radius: 11, font: '15', border: 1.5 },
};

// 服务的标志：圆角方块里一两个字母。
export function ServiceMark({ service, label, size = 32, testID }: ServiceMarkProps) {
  const brand = BRANDS[service];
  const spec = SIZES[size];
  const letter = brand.letter ?? monogram(label);
  return (
    <View
      testID={testID}
      aria-label={label}
      w={size}
      h={size}
      shrink={0}
      items="center"
      justify="center"
      style={{
        backgroundColor: brand.bg,
        borderRadius: spec.radius,
        borderWidth: brand.border ? spec.border : 0,
        borderColor: brand.border ?? 'transparent',
        borderStyle: brand.dashed ? 'dashed' : 'solid',
      }}
    >
      <Text size={spec.font} weight="extrabold" leading={Math.round(Number(spec.font) * 1.2)} style={{ color: brand.text }}>
        {letter}
      </Text>
    </View>
  );
}

// 自定义服务的字母：名字的第一个字，英文字母大写。没有名字时是「+」。
export function monogram(label: string | undefined): string {
  const first = Array.from(label?.trim() ?? '')[0];
  return first ? first.toLocaleUpperCase() : '+';
}
