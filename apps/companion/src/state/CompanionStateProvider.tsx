import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';
import { useStore } from 'zustand';

import { ControlPlaneClient, resolveLoopbackAutoPairEndpoint } from '@pi-lead-child/client';
import { appInForeground, platformOS, subscribeAppForeground, subscribeUserActivity } from '@pi-lead-child/components';
import { PRESENCE_IDLE_MS } from '@pi-lead-child/protocol';
import { platformCredentialStore } from '@/data/platformCredentialStore';
import { platformOutboxStorage } from '@/data/platformOutboxStorage';
import { platformRandomBytes, platformSha256 } from '@/data/platformCrypto';
import { platformReloadApp, platformWebBuild } from '@/data/platformWebBuild';

import {
  createCompanionStateRuntime,
  mountCompanionRuntime,
  type CompanionStateRuntime,
  type ConnectivitySource,
} from './runtime';
import { AttendanceTracker } from './attendance';
import type { ControlPlaneStoreState } from './control-plane/store';
import type { StreamStoreState } from './streams/store';
import type { WorkspaceStoreState } from './workspace/store';

const CompanionRuntimeContext = createContext<CompanionStateRuntime | null>(null);

const scheduler = {
  schedule(callback: () => void, delayMs: number) {
    return globalThis.setTimeout(callback, delayMs);
  },
  cancel(handle: unknown) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  now() {
    return Date.now();
  },
};

// 回到前台（web：标签页可见）、设备上线或离线。web 上另有 window 的 online / offline 事件；原生应用只有前后台。
const connectivity: ConnectivitySource = {
  subscribe(listener) {
    const stopForeground = subscribeAppForeground((foreground) => { if (foreground) listener('foreground'); });
    const target = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
    const online = () => listener('online');
    const offline = () => listener('offline');
    target?.addEventListener('online', online);
    target?.addEventListener('offline', offline);
    return () => {
      stopForeground();
      target?.removeEventListener('online', online);
      target?.removeEventListener('offline', offline);
    };
  },
};

export function CompanionStateProvider({ children }: PropsWithChildren) {
  const [runtime] = useState(() => createCompanionStateRuntime({
    client: new ControlPlaneClient({
      credentials: platformCredentialStore,
      randomBytes: platformRandomBytes,
      sha256: platformSha256,
    }),
    credentials: platformCredentialStore,
    scheduler,
    outboxStorage: platformOutboxStorage,
    ...(platformWebBuild ? { webBuild: platformWebBuild } : {}),
    ...(platformReloadApp ? { reloadApp: platformReloadApp } : {}),
  }));

  useEffect(() => {
    const loopbackEndpoint = resolveLoopbackAutoPairEndpoint({
      platform: platformOS,
      appOrigin: typeof location === 'undefined' ? null : location.origin,
      configuredEndpoint: process.env.EXPO_PUBLIC_PLC_GATEWAY_URL,
      servedByGateway: process.env.EXPO_PUBLIC_PLC_SERVED_BY_GATEWAY === '1',
    });
    // 应用在前台、并且 PRESENCE_IDLE_MS（5 分钟）内有过操作，才算有人在看：daemon 只在这时
    // 让 lead 播报即时通知，桌面通知才不弹。
    const attendance = new AttendanceTracker({
      foreground: appInForeground(),
      idleMs: PRESENCE_IDLE_MS,
      now: () => Date.now(),
      setTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const stopForeground = subscribeAppForeground((foreground) => attendance.setForeground(foreground));
    const stopActivity = subscribeUserActivity(() => attendance.activity());
    const unmount = mountCompanionRuntime(runtime, { loopbackEndpoint, presence: attendance, connectivity });
    return () => {
      unmount();
      stopActivity();
      stopForeground();
      attendance.dispose();
    };
  }, [runtime]);

  return <CompanionRuntimeProvider runtime={runtime}>{children}</CompanionRuntimeProvider>;
}

// 把一个已经建好的 runtime 交给下面的组件。CompanionStateProvider 用它；测试用它渲染读 store 的组件。
export function CompanionRuntimeProvider({ runtime, children }: PropsWithChildren<{ runtime: CompanionStateRuntime }>) {
  return (
    <CompanionRuntimeContext.Provider value={runtime}>
      {children}
    </CompanionRuntimeContext.Provider>
  );
}

export function useCompanionRuntime(): CompanionStateRuntime {
  const runtime = useContext(CompanionRuntimeContext);
  if (!runtime) throw new Error('Companion state hooks must be used inside CompanionStateProvider');
  return runtime;
}

export function useControlPlaneStore<T>(selector: (state: ControlPlaneStoreState) => T): T {
  return useStore(useCompanionRuntime().control, selector);
}

export function useStreamStore<T>(selector: (state: StreamStoreState) => T): T {
  return useStore(useCompanionRuntime().streams, selector);
}

export function useWorkspaceStore<T>(selector: (state: WorkspaceStoreState) => T): T {
  return useStore(useCompanionRuntime().workspace, selector);
}
