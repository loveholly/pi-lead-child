import { Theme } from '@tamagui/core';
import type { PropsWithChildren } from 'react';

import { useDesignPreferences, type DensityZone } from '../theme/preferences';
import type { Density as DensityName } from '../theme/tokens';

// 密度区域。页面在外层声明一次，里面所有语义间距和语义字号按这一档取值（见 theme/density.ts）。
// 用 zone 时，这一档来自外观偏好（设置 → 外观，缺省：工作台和工单详情紧凑，会话和设置标准）；
// 用 name 时固定一档（测试和特殊情况）。standard 回到基础 theme，所以紧凑区域里可以再放一块标准区域。
export function Density({ name, zone, children }: PropsWithChildren<{ name?: DensityName; zone?: DensityZone }>) {
  const preferences = useDesignPreferences();
  const level = name ?? (zone ? preferences.density[zone] : 'standard');
  return <Theme name={level === 'standard' ? 'light' : level}>{children}</Theme>;
}
