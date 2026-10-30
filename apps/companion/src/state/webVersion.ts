import { createStore } from 'zustand/vanilla';

// 网页版本（2026-10-20，protocol 的 web-build.ts）：daemon 重启时页面只重连 WebSocket，不重新加载 JS，
// 部署以后已经打开的页面一直跑旧代码。这里记着三个版本号：
//   current：这个页面的（构建时内联）；served：daemon 现在提供的（每次连上、回到前台时读）；
//   dismissed：用户收起提示时的 served。同一个版本只提示一次。
export interface WebVersionState {
  current: string | null;
  served: string | null;
  dismissed: string | null;
}

export function createWebVersionStore(current: string | null) {
  return createStore<WebVersionState>(() => ({ current, served: null, dismissed: null }));
}

// daemon 提供的网页和这个页面的关系，不看用户收起了什么：
//   newer：不一样，刷新后会拿到 daemon 现在提供的那一版；same：一样，刷新拿到的还是这个页面；
//   unknown：不知道（还没读到、读失败，或者这个 App 没有网页版本：dev server、原生应用）。
export type ServedWebVersion = 'newer' | 'same' | 'unknown';

export function servedWebVersion(state: WebVersionState): ServedWebVersion {
  if (state.current === null || state.served === null) return 'unknown';
  return state.served === state.current ? 'same' : 'newer';
}

/** 刷新后会拿到另一个版本，并且用户没有收起过这个版本的提示。 */
export function webUpdateAvailable(state: WebVersionState): boolean {
  return servedWebVersion(state) === 'newer' && state.dismissed !== state.served;
}
