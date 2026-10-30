import { describe, it, expect } from "vitest";
import { plistContent, LAUNCHD_LABEL } from "../src/deploy/launchd.js";

describe("plistContent", () => {
  const xml = plistContent({
    nodeBin: "/usr/local/bin/node",
    entry: "/repo/dist/supervisor.mjs",
    cwd: "/repo",
    logDir: "/home/.pi-lead-child/logs",
  });
  it("包含 label、入口、工作目录与日志路径", () => {
    expect(xml).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/repo/dist/supervisor.mjs</string>");
    expect(xml).toContain("<string>/repo</string>");
    expect(xml).toContain("supervisor.out.log");
    expect(xml).toContain("supervisor.err.log");
  });
  it("Supervisor 始终由 launchd 保活，daemon stop 不影响 Supervisor，带 Throttle", () => {
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
    expect(xml).toContain("<key>RunAtLoad</key>");
  });
  it("路径含 & 时做 XML 转义，不产生裸 &", () => {
    const escaped = plistContent({
      nodeBin: "/usr/local/bin/node",
      entry: "/repo/dist/coordinatord.mjs",
      cwd: "/repo & co",
      logDir: "/home/.pi-lead-child/logs",
    });
    expect(escaped).toContain("<string>/repo &amp; co</string>");
    expect(escaped).not.toMatch(/&(?!amp;|lt;|gt;)/);
  });
});
