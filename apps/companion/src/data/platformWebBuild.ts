import type { WebBuildSource } from '@/state/runtime';

// 兜底实现：Metro 在 web 上选 .web.ts。原生应用和 node 测试没有网页版本，也不能自己重新加载。
export const platformWebBuild: WebBuildSource | undefined = undefined;
export const platformReloadApp: (() => void) | undefined = undefined;
