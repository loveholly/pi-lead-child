import { parseWebBuildInfo, WEB_BUILD_PATH } from '@pi-lead-child/protocol';

import type { WebBuildSource } from '@/state/runtime';

// 网页由 daemon 提供时，build:web 把版本号内联在 EXPO_PUBLIC_PLC_WEB_BUILD 里（protocol 的 web-build.ts）。
// daemon 现在提供的版本从页面自己的 origin 读：刷新时拿到的就是这个 origin 上的页面。
// expo start --web 的 dev server 上没有版本号，不比较。
function gatewayWebBuild(): WebBuildSource | undefined {
  const current = process.env.EXPO_PUBLIC_PLC_WEB_BUILD;
  if (process.env.EXPO_PUBLIC_PLC_SERVED_BY_GATEWAY !== '1' || !current || typeof location === 'undefined') return undefined;
  const url = new URL(WEB_BUILD_PATH, location.origin).toString();
  return {
    current,
    async served() {
      const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) return null;
      return parseWebBuildInfo(await response.json())?.build ?? null;
    },
  };
}

export const platformWebBuild: WebBuildSource | undefined = gatewayWebBuild();

// 重新加载页面，拿到 daemon 现在提供的网页。
export const platformReloadApp: (() => void) | undefined = () => window.location.reload();
