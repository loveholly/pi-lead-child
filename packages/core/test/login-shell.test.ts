// 用户登录 shell 的 PATH 和工具目录变量（2026-10-28，用户：「我预期 Fairy 能正常调用我本机的 CLI，各种 bash」）。
import { describe, expect, it } from "vitest";
import { tempDir } from "../testing/index.js";
import { loginShellEnv, mergeLoginShellEnv, parseLoginShellEnv } from "../src/login-shell.js";

describe("parseLoginShellEnv", () => {
  it("reads only what follows the marker, so rc files that print banners do not leak in", () => {
    const output = "Welcome!\nPATH=/fake\n__PLC_LOGIN_ENV__PATH=/usr/bin:/opt/x\0GOPATH=/Users/u/go\0MULTI=a\nb\0bad name=1\0";
    expect(parseLoginShellEnv(output)).toEqual({ PATH: "/usr/bin:/opt/x", GOPATH: "/Users/u/go", MULTI: "a\nb" });
    expect(parseLoginShellEnv("no marker here")).toBeNull();
  });
});

describe("mergeLoginShellEnv", () => {
  it("follows the login shell's PATH order after the daemon's own Node, and fills only missing tool variables", () => {
    const target: Record<string, string | undefined> = { PATH: "/node/bin:/repo/node_modules/.bin:/usr/bin:/daemon/only", JAVA_HOME: "/daemon/java" };
    const merged = mergeLoginShellEnv(target, {
      PATH: "/Library/Frameworks/Python.framework/Versions/3.12/bin:/opt/homebrew/bin:/usr/bin:/pkg/env/global/bin:/opt/homebrew/bin",
      JAVA_HOME: "/shell/java", GOPATH: "/Users/u/go", NVM_DIR: "/Users/u/.nvm", PNPM_HOME: "/Users/u/pnpm",
      // 不补：密钥，和会改变 CLI 行为的变量。
      OPENAI_API_KEY: "sk-x", ANTHROPIC_BASE_URL: "http://127.0.0.1:1", NODE_OPTIONS: "--x",
    }, "/node/bin");
    // daemon 的 Node 仍然排第一；python3 这类命令和用户终端里找到的是同一个（3.12 在 /usr/bin 前面）。
    expect(target.PATH).toBe([
      "/node/bin", "/repo/node_modules/.bin", "/Library/Frameworks/Python.framework/Versions/3.12/bin", "/opt/homebrew/bin",
      "/usr/bin", "/pkg/env/global/bin", "/daemon/only",
    ].join(":"));
    expect(target.JAVA_HOME).toBe("/daemon/java");
    expect(target).toMatchObject({ GOPATH: "/Users/u/go", NVM_DIR: "/Users/u/.nvm", PNPM_HOME: "/Users/u/pnpm" });
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_BASE_URL", "NODE_OPTIONS"]) expect(target).not.toHaveProperty(name);
    expect(merged.sort()).toEqual(["GOPATH", "NVM_DIR", "PATH", "PNPM_HOME"]);
  });
});

describe.runIf(process.platform !== "win32")("loginShellEnv", () => {
  it("reads the environment a login shell ends up with", () => {
    const home = tempDir("plc-login-shell-");
    const env = loginShellEnv({ shell: "/bin/sh", env: { HOME: home, PATH: "/usr/bin:/bin", FOO_HOME: "/x/foo" } });
    expect(env).toMatchObject({ FOO_HOME: "/x/foo" });
    expect(env?.PATH).toContain("/usr/bin");
  });

  it("gives up instead of failing when the shell does not exist", () => {
    expect(loginShellEnv({ shell: "/no/such/shell" })).toBeNull();
  });
});
