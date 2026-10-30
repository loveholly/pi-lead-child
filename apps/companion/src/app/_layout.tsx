import { ActivityBoundary, DesignPreferencesProvider, palette, UIProvider, useUIFonts } from '@pi-lead-child/components';
import type { PropsWithChildren } from 'react';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { CompanionStateProvider } from '@/state/CompanionStateProvider';
import { useDesignPreferences } from '@/state/hooks';

void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useUIFonts();

  useEffect(() => {
    if (loaded || error) void SplashScreen.hideAsync();
  }, [error, loaded]);

  if (!loaded && !error) return null;

  return (
    <UIProvider>
      <CompanionStateProvider>
        <DesignPreferencesBridge>
        <StatusBar style="dark" />
        {/* 原生上收集触摸，用来判断最近有没有人在看；web 上不加元素。 */}
        <ActivityBoundary>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: palette.workspace } }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="ticket/[id]" />
            {/* 视图面板（2026-10-30）：原生上是自己的一页，网页上在工作台的右侧（Workbench.web.tsx）。 */}
            <Stack.Screen name="views" />
            <Stack.Screen name="pair" options={{ presentation: 'modal' }} />
            {/* 设置：桌面上整页替换工作台，手机上是自己的栈（app/settings/_layout.tsx）。 */}
            <Stack.Screen name="settings" />
          </Stack>
        </ActivityBoundary>
        </DesignPreferencesBridge>
      </CompanionStateProvider>
    </UIProvider>
  );
}

// 外观偏好（设置 → 外观）从 daemon 取到后交给组件库：密度、字号、行高、圆角、颜色都按它画。没取到时用缺省值。
function DesignPreferencesBridge({ children }: PropsWithChildren) {
  const { designPreferences } = useDesignPreferences();
  return <DesignPreferencesProvider value={designPreferences}>{children}</DesignPreferencesProvider>;
}
