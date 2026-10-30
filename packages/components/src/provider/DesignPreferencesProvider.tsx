import { useEffect, useMemo, type PropsWithChildren } from 'react';

import { DEFAULT_PREFERENCES, DesignPreferencesContext, designColorCss, type DesignPreferences } from '../theme/preferences';

// 外观偏好的提供者。应用从 daemon 取到偏好后放进来；没取到时用缺省值。
// 密度、字号、行高、圆角由 withDensity 在每个原语上换值（三端一样）。颜色在 web 上写成 CSS 变量覆盖；
// 原生上这一版不改颜色（Tamagui 的颜色 token 在启动时固定）。
const STYLE_ID = 'ui-design-colors';

export function DesignPreferencesProvider({ value, children }: PropsWithChildren<{ value?: Partial<DesignPreferences> | null }>) {
  const preferences = useMemo<DesignPreferences>(() => ({
    ...DEFAULT_PREFERENCES,
    ...(value ?? {}),
    density: { ...DEFAULT_PREFERENCES.density, ...(value?.density ?? {}) },
    colors: { ...DEFAULT_PREFERENCES.colors, ...(value?.colors ?? {}) },
  }), [value]);
  const css = useMemo(() => designColorCss(preferences.colors), [preferences.colors]);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!css) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement('style');
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = css;
  }, [css]);
  return <DesignPreferencesContext.Provider value={preferences}>{children}</DesignPreferencesContext.Provider>;
}
