// 网页的构建版本（2026-10-20）：daemon 重启时页面只重连 WebSocket，不重新加载 JS，部署以后已经打开的页面一直跑旧代码。
// 构建时把同一个版本号写进 bundle 和 dist/web/web-build.json；页面读 daemon 现在提供的 web-build.json，和自己的比较。
import { describe, expect, it } from "vitest";
import { parseWebBuildInfo, WEB_BUILD_FILE, WEB_BUILD_PATH, webBuildInfo } from "../src/index.js";

describe("the web build version", () => {
  it("is the commit for a build of committed code, so rebuilding the same commit asks nobody to refresh", () => {
    const first = webBuildInfo({ commit: "e3894103abc", dirty: false, builtAt: "2026-10-20T06:31:00.000Z" });
    const again = webBuildInfo({ commit: "e3894103abc", dirty: false, builtAt: "2026-10-20T07:00:00.000Z" });
    expect(first.build).toBe("e3894103abc");
    expect(again.build).toBe(first.build);
  });

  it("is different for every build with uncommitted changes, because the code can differ", () => {
    const first = webBuildInfo({ commit: "e3894103abc", dirty: true, builtAt: "2026-10-20T06:31:00.000Z" });
    const again = webBuildInfo({ commit: "e3894103abc", dirty: true, builtAt: "2026-10-20T07:00:00.000Z" });
    expect(first.build).not.toBe("e3894103abc");
    expect(first.build).not.toBe(again.build);
    expect(parseWebBuildInfo(first)).toEqual(first);
  });

  it("is served next to the page, from the file the build writes", () => {
    expect(WEB_BUILD_PATH).toBe(`/${WEB_BUILD_FILE}`);
  });
});

describe("reading web-build.json", () => {
  it("reads the version and ignores fields it does not know, so a newer build file still reads", () => {
    expect(parseWebBuildInfo({ version: 1, build: "abc123", commit: "abc123", builtAt: "2026-10-20T06:31:00.000Z", extra: true }))
      .toEqual({ version: 1, build: "abc123", commit: "abc123", builtAt: "2026-10-20T06:31:00.000Z" });
  });

  it("rejects anything that is not a plain version", () => {
    for (const value of [null, "abc", {}, { version: 1 }, { version: 1, build: 7 }, { version: 1, build: "" },
      { version: 1, build: "x".repeat(200) }, { version: 1, build: "<script>" }, { version: 2, build: "abc" }]) {
      expect(parseWebBuildInfo(value)).toBeNull();
    }
  });
});
