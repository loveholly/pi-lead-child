import { SymbolView, type SymbolViewProps } from 'expo-symbols';

import { palette, type ColorToken } from '../theme/tokens';
import { icons, type IconName } from './icons';

export type IconWeight = 'regular' | 'medium' | 'semibold' | 'bold';

export type IconProps = {
  name: IconName;
  size?: number;
  color?: ColorToken;
  weight?: IconWeight;
  accessibilityLabel?: string;
};

// 系统图标：iOS 用 SF Symbols，Android 和 web 用 Material Symbols（expo-symbols）。
export function Icon({ name, size = 18, color = 'text-secondary', weight = 'medium', accessibilityLabel }: IconProps) {
  const icon = icons[name];
  return (
    <SymbolView
      name={{ ios: icon.ios, android: icon.android, web: icon.android } as SymbolViewProps['name']}
      size={size}
      weight={weight}
      tintColor={palette[color]}
      accessibilityLabel={accessibilityLabel}
    />
  );
}
