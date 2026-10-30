import { describe, expect, it } from "vitest";
import {
  claudeSandboxSettings, parseSecretHosts, SANDBOX_DEFAULT_DOMAINS, SANDBOX_EXTRA_DOMAINS_ENV, SANDBOX_SECRET_HOSTS_ENV,
  sandboxAllowedDomains, sandboxCacheEnv, sandboxEnv, sandboxPolicy, sandboxWriteBlocker, sandboxRuntimeConfig, sandboxSecrets, sandboxToolNote,
} from "../src/sandbox-policy.js";

describe("sandboxPolicy", () => {
  const home = "/Users/someone";

  // 2026-10-28 用户：「Fairy 和执行者的命令能写整个 home、能读各个 CLI 自己的登录文件，只挡绕出沙箱的路径、私钥和 plc
  // 自己的账本密钥」。
  it("writes home, the run's own directories and the temp dirs, and blocks paths that run outside the sandbox", () => {
    const policy = sandboxPolicy({
      role: "executor", writable: ["/repo.plc-workspaces/item-1", "relative/path"], home, dataDir: `${home}/.pi-lead-child`,
      env: { PATH: `/usr/bin:${home}/.local/bin:${home}/.nvm/versions/node/v24/bin` },
    });
    expect(policy.allowWrite).toEqual(expect.arrayContaining([home, "/repo.plc-workspaces/item-1", "/tmp"]));
    // 相对路径没有意义（不知道相对谁），丢掉。
    expect(policy.allowWrite.some((path) => path.includes("relative/path"))).toBe(false);
    for (const path of [".zshrc", ".zshenv", ".gitconfig", "**/.git/hooks", "**/.git/config", ".claude", ".pi", "Library/LaunchAgents"]) {
      expect(policy.denyWrite).toContain(`${home}/${path}`);
    }
    // home 下的 PATH 目录（放一个假的 git 就等于逃出沙箱），plc 的账本和配置。
    expect(policy.denyWrite).toEqual(expect.arrayContaining([
      `${home}/.local/bin`, `${home}/.nvm/versions/node/v24/bin`, `${home}/.pi-lead-child/plc.db`, `${home}/.pi-lead-child/config.json`,
    ]));
    expect(policy.denyWrite).not.toContain("/usr/bin");
    expect(policy.denyWrite).not.toContain(`${home}/.pi-lead-child/lead-scratch`);
  });

  it("reads CLI logins, and denies private keys and the data dir's secrets", () => {
    const policy = sandboxPolicy({ role: "lead", writable: [], home, dataDir: "/data", env: {} });
    expect(policy.denyRead).toEqual(expect.arrayContaining([`${home}/.ssh/id_*`, `${home}/.gnupg`, `${home}/Library/Keychains`]));
    for (const path of [".ssh", ".aws", ".config/gh/hosts.yml", ".netrc", ".kube", ".config/acme"]) {
      expect(policy.denyRead).not.toContain(`${home}/${path}`);
    }
    expect(policy.denyRead).toEqual(expect.arrayContaining(["/data/config.json", "/data/cli-credential.json", "/data/connections.key"]));
    // 账本本身能读：Lead 排查问题要用。
    expect(policy.denyRead).not.toContain("/data/plc.db");
  });

  it("refuses edit and write on the same boundary", () => {
    const policy = sandboxPolicy({
      role: "lead", writable: [], home, dataDir: `${home}/.pi-lead-child`, env: { PATH: `/usr/bin:${home}/.local/bin` },
    });
    expect(sandboxWriteBlocker(policy, `${home}/.config/clime/credentials.json`)).toBeNull();
    expect(sandboxWriteBlocker(policy, `${home}/Workspace/app/src/a.ts`)).toBeNull();
    expect(sandboxWriteBlocker(policy, `${home}/.pi-lead-child/lead-scratch/a.py`)).toBeNull();
    for (const path of [
      `${home}/.zshrc`, `${home}/.local/bin/git`, `${home}/Workspace/app/.git/hooks/pre-commit`, `${home}/Workspace/app/.git/config`,
      `${home}/.pi-lead-child/config.json`, `${home}/.claude/settings.json`, "/etc/hosts",
    ]) {
      expect(sandboxWriteBlocker(policy, path), path).not.toBeNull();
    }
  });

  it("adds the user's extra domains to the defaults", () => {
    expect(sandboxAllowedDomains({})).toEqual([...SANDBOX_DEFAULT_DOMAINS]);
    const domains = sandboxAllowedDomains({ [SANDBOX_EXTRA_DOMAINS_ENV]: " git.corp.example , github.com,," });
    expect(domains).toContain("git.corp.example");
    expect(domains.filter((domain) => domain === "github.com")).toHaveLength(1);
  });

  it("maps to Claude Code settings that never run commands outside the sandbox", () => {
    const settings = claudeSandboxSettings(sandboxPolicy({ role: "executor", writable: ["/w"], home, env: {} })) as {
      sandbox: { enabled: boolean; autoAllowBashIfSandboxed: boolean; allowUnsandboxedCommands: boolean;
        enableWeakerNetworkIsolation: boolean; credentials?: unknown;
        filesystem: { allowWrite: string[]; denyRead: string[] };
        network: { allowedDomains: string[]; allowLocalBinding: boolean; tlsTerminate?: unknown } };
    };
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    // gh 这类 Go 写的工具在 macOS 上要用 trustd 验证证书。
    expect(settings.sandbox.enableWeakerNetworkIsolation).toBe(true);
    expect(settings.sandbox.filesystem.allowWrite).toContain("/w");
    expect(settings.sandbox.filesystem.denyRead).toContain(`${home}/.ssh/id_*`);
    expect(settings.sandbox.network.allowedDomains).toContain("github.com");
    // 执行者跑测试要起本机服务。
    expect(settings.sandbox.network.allowLocalBinding).toBe(true);
    // 没有密钥时不打开 TLS 终止，也没有 credentials。
    expect(settings.sandbox.network).not.toHaveProperty("tlsTerminate");
    expect(settings.sandbox).not.toHaveProperty("credentials");
  });

  it("maps to the sandbox-runtime config shape", () => {
    const config = sandboxRuntimeConfig(sandboxPolicy({ role: "reviewer", writable: ["/w"], home, env: {} }));
    expect(config.filesystem.allowWrite).toContain("/w");
    // /w 不是 git 仓库：没有为它另加的 git 目录；home 下的那些照旧挡。
    expect(config.filesystem.denyWrite).toContain(`${home}/.zshrc`);
    expect(config.filesystem.denyWrite.some((path) => path.startsWith("/w"))).toBe(false);
    expect(config.network.deniedDomains).toEqual([]);
    expect(config.network.allowLocalBinding).toBe(true);
    expect(config.enableWeakerNetworkIsolation).toBe(true);
  });

  // 2026-10-28：网关在本机端口上，本机网页能自动配对。Lead 的命令连不了本机端口；执行者、核查员能（测试要起服务）。
  it("keeps Lead off local ports and gives only executors the ssh-agent", () => {
    const env = { SSH_AUTH_SOCK: "/private/tmp/agent.sock" };
    expect(sandboxPolicy({ role: "lead", writable: [], home, env }).allowLocalBinding).toBe(false);
    expect(sandboxPolicy({ role: "lead", writable: [], home, env }).allowUnixSockets).toEqual([]);
    expect(sandboxPolicy({ role: "executor", writable: [], home, env }).allowUnixSockets).toEqual(["/private/tmp/agent.sock"]);
    expect(sandboxPolicy({ role: "reviewer", writable: [], home, env }).allowUnixSockets).toEqual([]);
    expect(sandboxPolicy({ role: "executor", writable: [], home, env: { SSH_AUTH_SOCK: "relative.sock" } }).allowUnixSockets).toEqual([]);
  });
});

// 2026-10-28 用户：「让它读不到真正的内容，但是当他调用某些工具要用到环境变量却又可以」。
describe("secrets in the sandbox", () => {
  const home = "/Users/someone";

  it("masks a secret bound to hosts and withholds one with no host", () => {
    const env = {
      GH_TOKEN: "ghp_x", AM_API_KEY: "am", MY_SERVICE_TOKEN: "t", PATH: "/usr/bin", EMPTY_TOKEN: "",
      [SANDBOX_SECRET_HOSTS_ENV]: "MY_SERVICE_TOKEN=api.my-service.example, *.my-service.example",
    };
    const secrets = sandboxSecrets(env);
    expect(secrets.masked).toEqual([
      { name: "GH_TOKEN", injectHosts: ["github.com", "*.github.com", "*.githubusercontent.com"] },
      { name: "MY_SERVICE_TOKEN", injectHosts: ["api.my-service.example", "*.my-service.example"] },
    ]);
    // 没绑定主机：不知道该发给谁，就不给。空值没有要保护的东西。
    expect(secrets.withheld).toEqual(["AM_API_KEY"]);
  });

  it("lets the user rebind a well-known secret and drops hosts that would mean anywhere", () => {
    const bound = parseSecretHosts("GH_TOKEN=git.corp.example;BAD=*,*.com,http://x.example/a, ok.example;=x;9X=a.example");
    expect(bound.get("GH_TOKEN")).toEqual(["git.corp.example"]);
    expect(bound.get("BAD")).toEqual(["ok.example"]);
    expect(bound.has("9X")).toBe(false);
    expect(sandboxSecrets({ GH_TOKEN: "x", [SANDBOX_SECRET_HOSTS_ENV]: "GH_TOKEN=git.corp.example" }).masked)
      .toEqual([{ name: "GH_TOKEN", injectHosts: ["git.corp.example"] }]);
  });

  it("gives the read-only agent for outside requests no secrets", () => {
    const policy = sandboxPolicy({ role: "agent_task", writable: [], home, env: { GH_TOKEN: "x", AM_API_KEY: "y" } });
    expect(policy.maskedSecrets).toEqual([]);
    expect(policy.withheldSecrets).toEqual(["AM_API_KEY", "GH_TOKEN"]);
  });

  it("turns on TLS termination only when a secret is masked", () => {
    const policy = sandboxPolicy({ role: "executor", writable: [], home, env: { GH_TOKEN: "x", AM_API_KEY: "y" } });
    const claude = claudeSandboxSettings(policy) as {
      sandbox: { network: { tlsTerminate?: unknown }; credentials: { envVars: unknown[] } };
    };
    // GitHub 绑给了 GH_TOKEN，要终止；Go 模块代理这类主机不终止（gh、go 在 macOS 上不认沙箱的证书）。
    const tls = claude.sandbox.network.tlsTerminate as { excludeDomains: string[] };
    expect(tls.excludeDomains).toContain("proxy.golang.org");
    expect(tls.excludeDomains).not.toContain("github.com");
    expect(tls.excludeDomains).not.toContain("*.github.com");
    expect(claude.sandbox.credentials.envVars).toEqual([
      { name: "GH_TOKEN", mode: "mask", injectHosts: ["github.com", "*.github.com", "*.githubusercontent.com"] },
      { name: "AM_API_KEY", mode: "deny" },
    ]);
    const runtime = sandboxRuntimeConfig(policy);
    expect(runtime.network.tlsTerminate).toEqual(tls);
    expect(runtime.credentials?.envVars).toEqual(claude.sandbox.credentials.envVars);
    const withheldOnly = sandboxRuntimeConfig(sandboxPolicy({ role: "lead", writable: [], home, env: { AM_API_KEY: "y" } }));
    expect(withheldOnly.network).not.toHaveProperty("tlsTerminate");
    expect(withheldOnly.credentials?.envVars).toEqual([{ name: "AM_API_KEY", mode: "deny" }]);
  });

  it("keeps GitHub out of TLS termination when only an unrelated secret is masked", () => {
    const env = { MY_SERVICE_TOKEN: "t", [SANDBOX_SECRET_HOSTS_ENV]: "MY_SERVICE_TOKEN=api.my-service.example" };
    const runtime = sandboxRuntimeConfig(sandboxPolicy({ role: "lead", writable: [], home, env }));
    expect(runtime.network.tlsTerminate?.excludeDomains).toEqual(expect.arrayContaining(["github.com", "*.github.com"]));
  });

  it("tells the agent the names and hosts, never the values", () => {
    const note = sandboxToolNote(
      sandboxPolicy({ role: "lead", writable: [], home, env: { GH_TOKEN: "ghp_secretvalue", AM_API_KEY: "am-secret" } }),
      "临时目录",
    );
    expect(note).toContain("网络全开");
    expect(note).toContain("GH_TOKEN → github.com");
    expect(note).toContain("AM_API_KEY");
    expect(note).toContain(SANDBOX_SECRET_HOSTS_ENV);
    expect(note).toContain("连不了本机端口");
    expect(note).not.toContain("ghp_secretvalue");
    expect(note).not.toContain("am-secret");
  });
});

describe("sandboxEnv", () => {
  it("drops secret-named variables and keeps the rest", () => {
    const env = sandboxEnv({
      PATH: "/usr/bin", HOME: "/h", GH_TOKEN: "ghp_x", OPENAI_API_KEY: "sk", AM_API_KEY: "a", DB_PASSWORD: "p",
      PLC_AISH_TOKEN: "t", LANG: "C", UNSET: undefined,
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("C");
    for (const name of ["GH_TOKEN", "OPENAI_API_KEY", "AM_API_KEY", "DB_PASSWORD", "PLC_AISH_TOKEN", "UNSET"]) {
      expect(env).not.toHaveProperty(name);
    }
    // 名字像、其实不是密钥的：当前目录、ssh-agent 的 socket（去掉它就用不了 ssh-agent）。
    expect(sandboxEnv({ PWD: "/w", SSH_AUTH_SOCK: "/tmp/agent.sock" })).toMatchObject({ PWD: "/w", SSH_AUTH_SOCK: "/tmp/agent.sock" });
    expect(sandboxSecrets({ PWD: "/w", SSH_AUTH_SOCK: "/tmp/agent.sock", OLDPWD: "/x" })).toEqual({ masked: [], withheld: [] });
    // 2026-10-28 起 home 能写：缓存回到用户终端里的位置，gh 用用户自己的配置。
    expect(env).not.toHaveProperty("npm_config_cache");
    expect(env).not.toHaveProperty("GH_CONFIG_DIR");
    expect(sandboxCacheEnv()).toEqual({});
  });
});

// 沙箱里 macOS 自带的 curl 没法去系统钥匙串里补根证书（2026-10-28：example.com 报 60）。从系统钥匙串导出一份给它们用。
describe.runIf(process.platform === "darwin")("sandboxTrustEnv", () => {
  it("points curl, Python, git and Node at the system roots, and keeps what the user set", async () => {
    const { readFileSync } = await import("node:fs");
    const { sandboxTrustBundle, sandboxTrustEnv } = await import("../src/sandbox-policy.js");
    const bundle = sandboxTrustBundle();
    expect(bundle).not.toBeNull();
    expect(readFileSync(bundle!, "utf8")).toContain("BEGIN CERTIFICATE");
    const env = sandboxTrustEnv({ CURL_CA_BUNDLE: "/mine.pem" });
    expect(env).toMatchObject({ SSL_CERT_FILE: bundle, REQUESTS_CA_BUNDLE: bundle, GIT_SSL_CAINFO: bundle, NODE_EXTRA_CA_CERTS: bundle });
    expect(env).not.toHaveProperty("CURL_CA_BUNDLE");
    expect(sandboxEnv({ PATH: "/usr/bin" }).SSL_CERT_FILE).toBe(bundle);
  });
});
