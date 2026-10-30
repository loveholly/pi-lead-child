// 网页的构建版本（2026-10-20）。daemon 重启时页面只重连 WebSocket，不重新加载 JS：部署以后，已经打开的页面一直跑旧代码，
// 新组件的卡在旧页面里只剩 fallbackText。
//
// build:web（apps/daemon/scripts/build-web.ts）算出一个版本号，同时写进两处：
//   · bundle：EXPO_PUBLIC_PLC_WEB_BUILD，页面知道自己是哪个版本；
//   · 导出目录里的 web-build.json：网关在 WEB_BUILD_PATH 原样提供，和页面文件一起换（同一次 rename）。
// 页面每次连上、回到前台时读一次 web-build.json，和自己的比较：不一样就是刷新后会拿到新版本。
// 不放进 hello.v2：旧页面严格校验 hello.v2，多一个字段它就连不上。

export const WEB_BUILD_FILE = "web-build.json";
export const WEB_BUILD_PATH = `/${WEB_BUILD_FILE}`;

export interface WebBuildInfo {
  version: 1;
  // 页面比较的就是它。
  build: string;
  commit: string;
  builtAt: string;
}

const BUILD_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * 从一次构建的来源算出网页版本。已提交的代码：版本就是 commit，同一个 commit 重新构建不会让人刷新。
 * 有没提交的改动：每次构建的代码可能不同，版本里加上构建时间。
 */
export function webBuildInfo(source: { commit: string; dirty: boolean; builtAt: string }): WebBuildInfo {
  const build = source.dirty ? `${source.commit}-dirty.${source.builtAt.replace(/\D/g, "")}` : source.commit;
  return { version: 1, build, commit: source.commit, builtAt: source.builtAt };
}

/** 读 web-build.json 的内容。只认 version 1 和一个普通的版本号；不认识的字段不管。其他情况返回 null。 */
export function parseWebBuildInfo(value: unknown): WebBuildInfo | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.build !== "string" || !BUILD_PATTERN.test(input.build)) return null;
  return {
    version: 1,
    build: input.build,
    commit: typeof input.commit === "string" ? input.commit : "",
    builtAt: typeof input.builtAt === "string" ? input.builtAt : "",
  };
}
