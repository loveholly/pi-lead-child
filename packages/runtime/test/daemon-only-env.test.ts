// child 继承 daemon 的全部环境（工单 11），但 daemon 自己的密钥不给 child：不管它来自 daemon 的环境、
// adapter 还是请求。别的变量照常继承。
import { describe, expect, it } from "vitest";
import { DAEMON_ONLY_ENV_NAMES } from "@pi-lead-child/core";
import { childEnvironment, runtimeEnvironment } from "../src/environment.js";

describe("the child environment", () => {
  it("drops daemon-only secrets from every layer and keeps everything else", () => {
    const daemonEnv = { PATH: "/usr/bin", GH_TOKEN: "user-token", PLC_SLACK_CLIENT_SECRET: "daemon-only" };
    const env = childEnvironment(runtimeEnvironment({}, daemonEnv), { PLC_GITHUB_CLIENT_SECRET: "x" }, { PLC_SLACK_CLIENT_SECRET: "y" }, daemonEnv);
    for (const name of DAEMON_ONLY_ENV_NAMES) expect(env[name]).toBeUndefined();
    expect(env.GH_TOKEN).toBe("user-token");
  });
});
