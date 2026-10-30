import { View } from '@tamagui/core';
import type { ReactNode } from 'react';

import { Text } from '../primitives/Text';
import type { ColorToken } from '../theme/tokens';
import { Dot } from './Dot';

export type BadgeTone =
  | 'neutral' | 'strong' | 'muted' | 'gray'
  | 'accent' | 'success' | 'warning' | 'danger' | 'danger-tint'
  | 'inverse';

// soft：浅底深字。solid：实底白字。outline：浅底、同色系描边、深字。
export type BadgeVariant = 'soft' | 'solid' | 'outline';

type Colors = { bg: ColorToken; text: ColorToken; border?: ColorToken; dot: ColorToken };

const SOFT: Record<BadgeTone, Colors> = {
  neutral: { bg: 'surface-muted', text: 'text-secondary', dot: 'text-muted' },
  strong: { bg: 'surface-muted', text: 'text-strong', dot: 'text-muted' },
  muted: { bg: 'surface-muted', text: 'text-muted', dot: 'text-muted' },
  gray: { bg: 'neutral-soft', text: 'text-secondary', dot: 'text-muted' },
  accent: { bg: 'accent-soft', text: 'accent', dot: 'accent' },
  success: { bg: 'success-soft', text: 'success-dark', dot: 'success' },
  warning: { bg: 'warning-soft', text: 'warning-dark', dot: 'warning' },
  danger: { bg: 'danger-soft', text: 'danger-dark', dot: 'danger' },
  'danger-tint': { bg: 'danger-tint', text: 'danger-dark', dot: 'danger' },
  inverse: { bg: 'text', text: 'surface', dot: 'surface' },
};

const SOLID: Record<BadgeTone, Colors> = {
  neutral: { bg: 'text-secondary', text: 'surface', dot: 'surface' },
  strong: { bg: 'text-strong', text: 'surface', dot: 'surface' },
  muted: { bg: 'text-muted', text: 'surface', dot: 'surface' },
  gray: { bg: 'text-muted', text: 'surface', dot: 'surface' },
  accent: { bg: 'accent', text: 'surface', dot: 'surface' },
  success: { bg: 'success', text: 'surface', dot: 'surface' },
  warning: { bg: 'warning', text: 'surface', dot: 'surface' },
  danger: { bg: 'danger', text: 'surface', dot: 'surface' },
  'danger-tint': { bg: 'danger-dark', text: 'surface', dot: 'surface' },
  inverse: { bg: 'text', text: 'surface', dot: 'surface' },
};

const OUTLINE: Record<BadgeTone, Colors> = {
  neutral: { bg: 'surface', border: 'border', text: 'text-secondary', dot: 'text-muted' },
  strong: { bg: 'surface', border: 'border', text: 'text-strong', dot: 'text-muted' },
  muted: { bg: 'surface', border: 'border', text: 'text-muted', dot: 'text-muted' },
  gray: { bg: 'surface', border: 'border', text: 'text-secondary', dot: 'text-muted' },
  accent: { bg: 'accent-soft', border: 'accent-muted', text: 'accent', dot: 'accent' },
  success: { bg: 'success-surface', border: 'success-border', text: 'success-dark', dot: 'success' },
  warning: { bg: 'warning-surface', border: 'warning-border', text: 'warning-dark', dot: 'warning' },
  danger: { bg: 'danger-surface', border: 'danger-border', text: 'danger-dark', dot: 'danger' },
  'danger-tint': { bg: 'danger-tint', border: 'danger-border', text: 'danger-dark', dot: 'danger' },
  inverse: { bg: 'text', border: 'text', text: 'surface', dot: 'surface' },
};

const PALETTES: Record<BadgeVariant, Record<BadgeTone, Colors>> = { soft: SOFT, solid: SOLID, outline: OUTLINE };

export type BadgeProps = {
  label: string;
  tone?: BadgeTone;
  variant?: BadgeVariant;
  // md：状态徽章，24 高。sm：紧凑的标签，随文字高度。xs：列表行和表格里的判定，20 高（第四轮画板）。
  size?: 'xs' | 'sm' | 'md';
  // 文字前的状态圆点。
  dot?: boolean;
  mono?: boolean;
  // 跟在标签后面的次要文字，例如进度百分比。
  detail?: string;
  icon?: ReactNode;
  testID?: string;
};

// 胶囊形的状态标签。
export function Badge({
  label, tone = 'neutral', variant = 'soft', size = 'md', dot = false, mono = false, detail, icon, testID,
}: BadgeProps) {
  const colors = PALETTES[variant][tone];
  const md = size === 'md';
  const xs = size === 'xs';
  return (
    <View
      testID={testID}
      flexDirection="row"
      items="center"
      self="flex-start"
      shrink={0}
      gap="icon-label"
      h={md ? 24 : xs ? 20 : undefined}
      px={xs ? 7 : 9}
      py={xs ? 0 : 4}
      rounded="full"
      bg={colors.bg}
      borderWidth={colors.border ? 1 : 0}
      borderColor={colors.border ?? 'transparent'}
    >
      {dot ? <Dot color={colors.dot} size={6} /> : null}
      {icon}
      {/* spacing-exempt: 徽标行高 */}
      <Text size={md ? '11.5' : '11'} leading={15} weight="bold" mono={mono} color={colors.text} numberOfLines={1}>
        {label}
      </Text>
      {detail ? (
        // spacing-exempt: 徽标行高
        <Text size={md ? '11' : '10.5'} leading={15} weight="bold" mono={mono} color={colors.text}>{detail}</Text>
      ) : null}
    </View>
  );
}
