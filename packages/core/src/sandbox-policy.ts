// 沙箱的边界（lead-tools-and-routing spec D2、D3、D4）。Lead、执行者、核查员和子 agent 跑命令时用同一套边界。
// 用户 2026-10-28：「放开：Fairy 和执行者的命令能写整个 home、能读各个 CLI 自己的登录文件，只挡绕出沙箱的路径、私钥和
// plc 自己的账本密钥」（Fairy 替用户登录 clime，凭证存不下来；「到处都是卡着，啥啥都干不了」）。
//   - 能写：整个 home、这次运行的目录（home 以外的仓库）、系统的临时目录。挡住写进去就能在沙箱外执行的地方
//     （SANDBOX_DENY_WRITE_HOME、home 下的 PATH 目录），以及 plc 的账本、配置和密钥（dataDirDenyWrite）。
//   - 不能读：私钥（SSH、GPG）、钥匙串的文件、plc 自己的配置和密钥。各个 CLI 自己的登录文件能读，命令像在用户的终端里
//     一样用它们；值不进对话靠 Lead 的输出脱敏（lead 的 credential-guard.ts）。
//   - 网络：全开（2026-10-28 用户：「难道访问 GitHub 都要配置白名单吗」）。allowedDomains 只是先放行的一批：
//     sandbox-runtime 用 ask 回调放行别的域名（engine 的 sandbox/bash.ts），Claude Code 由 auto 模式自己判断
//     （runtime 的 claude.ts）。回环、云的元数据地址照旧连不上（sandbox-runtime 自带的检查）。
//   - 密钥（2026-10-28 用户：「让它读不到真正的内容，但是调用工具要用到环境变量时又可以」）：名字像密钥的环境变量，
//     沙箱里只看到占位值；命令发往这个密钥绑定的主机时，沙箱的代理把占位值换成真值（sandbox-runtime 的
//     credentials.envVars mask）。没绑定主机的密钥沙箱里没有：不知道该发给谁，就不发。
// 这里只有边界，不调沙箱：Claude Code 用它自带的 sandbox 设置（claudeSandboxSettings），pi 和 Lead 用
// @anthropic-ai/sandbox-runtime（engine 的 sandbox/bash.ts）。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isSecretEnvName, KNOWN_SECRET_ENV_NAMES } from "@pi-lead-child/protocol";

// 先放行的域名：代码托管、包仓库。别的域名也能连（见文件头），这份清单让 Claude Code 不必为它们再判断一次。
export const SANDBOX_DEFAULT_DOMAINS: readonly string[] = [
  "github.com", "*.github.com", "*.githubusercontent.com",
  "registry.npmjs.org", "registry.yarnpkg.com",
  "pypi.org", "files.pythonhosted.org",
];

// 用户补的先放行的域名（例如公司内网），逗号分隔。写在 config.json 的 env 段里。
export const SANDBOX_EXTRA_DOMAINS_ENV = "PLC_SANDBOX_EXTRA_DOMAINS";

// 密钥绑定的主机（见文件头）。常见的密钥按名字给出它的服务；别的由用户在 config.json 的 env 段里写
// PLC_SANDBOX_SECRET_HOSTS，格式是「名字=主机,主机;名字=主机」，例如 AM_API_KEY=api.example.com。
// 绑定主机是用户的事（带密钥的设置，AGENTS.md 的 user_direct）：Lead 写不了 config.json。
export const SANDBOX_SECRET_HOSTS_ENV = "PLC_SANDBOX_SECRET_HOSTS";
const GITHUB_HOSTS = ["github.com", "*.github.com", "*.githubusercontent.com"];
export const SANDBOX_SECRET_HOSTS: Readonly<Record<string, readonly string[]>> = {
  GH_TOKEN: GITHUB_HOSTS,
  GITHUB_TOKEN: GITHUB_HOSTS,
  GITHUB_PAT: GITHUB_HOSTS,
  NPM_TOKEN: ["registry.npmjs.org"],
  OPENAI_API_KEY: ["api.openai.com"],
  ANTHROPIC_API_KEY: ["api.anthropic.com"],
  OPENROUTER_API_KEY: ["openrouter.ai"],
  TAVILY_API_KEY: ["api.tavily.com"],
  GITLAB_TOKEN: ["gitlab.com"],
};

// 不能读的（相对 home）：私钥和钥匙串的文件（见文件头）。~/.ssh 只挡私钥：ssh 要读 config 和 known_hosts（执行者经
// ssh-agent 推送）。sandbox-runtime 在 macOS 上把这些写法当通配。
export const SANDBOX_DENY_READ_HOME: readonly string[] = [
  ".ssh/id_*", ".ssh/*.pem", ".ssh/*.key", ".gnupg", "Library/Keychains",
];

// 数据目录里不能读的：config.json（env 段里可能有密钥）、plc 的 CLI 凭证、保险库的密钥、Lead 自己的 pi 授权文件。
// 账本（plc.db）能读：Lead 排查问题要用。
const DATA_DIR_DENY_READ: readonly string[] = ["config.json", "cli-credential.json", "connections.key", "agent/auth.json"];

// 能写整个 home（见文件头），挡住写进去就能在沙箱外执行的地方，等于逃出沙箱：shell 的启动文件、git 的全局配置、
// 编辑器和终端会执行的配置、LaunchAgents、Claude Code / pi / Codex / Gemini 的配置（里面有 hooks 和扩展）、
// 私钥目录。sandbox-runtime 自己也挡 .bashrc、.zshrc、.gitconfig、.git/hooks 这类，但只在命令的工作目录附近（2026-10-28
// 实测：假 home 里的 .zshrc 被写进去了），所以这里全部写明，home 下任何仓库的 .git/hooks 和 .git/config 用通配挡。
export const SANDBOX_DENY_WRITE_HOME: readonly string[] = [
  ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".gitconfig", ".ripgreprc", ".vscode", ".idea",
  "**/.git/hooks", "**/.git/config",
  ".zshenv", ".zlogin", ".zlogout", ".bash_login", ".bash_logout", ".config/fish", ".config/git", ".config/starship.toml",
  ".npmrc", ".ssh", ".gnupg", "Library/LaunchAgents", "Library/Keychains",
  ".claude", ".pi", ".codex", ".gemini", ".cli-proxy-api",
  ".config/nvim", ".vimrc", ".config/karabiner", ".hammerspoon", ".tmux.conf", ".config/tmux",
  "Library/Application Support/Code/User", "Library/Application Support/Cursor/User",
  // 应用的更新包（Squirrel 的 ShipIt）由应用在沙箱外安装；pre-commit 的环境由 git 钩子在沙箱外执行。
  "Library/Caches/*.ShipIt", ".cache/pre-commit",
];

// 数据目录里命令能写的：Lead 的临时目录和轻子 agent 的目录。别的（账本、配置、密钥、会话、备份）都不能写。
const DATA_DIR_WRITABLE: readonly string[] = ["lead-scratch", "light-tasks"];
const DATA_DIR_ALWAYS_DENY_WRITE: readonly string[] = [
  "plc.db", "plc.db-wal", "plc.db-shm", "config.json", "cli-credential.json", "connections.key", "agent", "backups",
];

// 数据目录里不能写的：已经有的条目里除了 DATA_DIR_WRITABLE 的都算，再加上一定要挡的（还没建也挡）。
function dataDirDenyWrite(dataDir: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dataDir);
  } catch {
    entries = [];
  }
  const names = new Set([...entries, ...DATA_DIR_ALWAYS_DENY_WRITE].filter((name) => !DATA_DIR_WRITABLE.includes(name)));
  return [...names].map((name) => join(dataDir, name));
}

// 路径的真实位置（macOS 上 /var 是 /private/var 的链接，系统临时目录在它下面）：挡的路径和沙箱看到的路径要一致。
// 不存在时解析它所在的目录，再接上名字；通配的路径原样留着。
function realPath(path: string): string {
  if (path.includes("*")) return path;
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

// PATH 里在 home 下面的目录：往里放一个同名的程序（例如假的 git），用户下次在沙箱外跑这个命令时它就执行了。
function homePathDirs(env: Record<string, string | undefined>, home: string): string[] {
  return (env.PATH ?? "").split(delimiter)
    .filter((dir) => isAbsolute(dir))
    .map((dir) => resolve(dir))
    .filter((dir) => dir !== home && within(dir, home));
}

function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// sandbox-runtime 自己挡的（见 SANDBOX_DENY_WRITE_HOME 的注释）：Lead 的 edit、write 不经过沙箱，按同一份挡。
const MANDATORY_DENY_NAMES: readonly string[] = [
  ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".gitconfig", ".gitmodules", ".ripgreprc", ".mcp.json",
];
const MANDATORY_DENY_DIRS: readonly string[] = [".vscode", ".idea", ".git/hooks", ".claude/commands", ".claude/agents"];

/**
 * edit、write 这类不经过沙箱的写入：按同一套边界判断能不能写。能写时为 null，否则是给 agent 看的一句话（不带句号）。
 * path 要是绝对路径。
 */
export function sandboxWriteBlocker(policy: SandboxPolicy, path: string): string | null {
  const target = realPath(resolve(path));
  if (!policy.allowWrite.some((root) => within(target, realPath(resolve(root))))) return `${target} 不在能写的范围里`;
  const denied = policy.denyWrite.find((root) => !root.includes("*") && within(target, resolve(root)));
  if (denied) return `${denied} 不能写：写进去的东西会在沙箱外执行，或者是凭证、plc 的账本和配置`;
  const parts = target.split("/");
  const name = parts.at(-1) ?? "";
  if (MANDATORY_DENY_NAMES.includes(name)) return `${name} 不能写：shell 和 git 的启动配置会在沙箱外执行`;
  if (/\/\.git\/config$/.test(target)) return "仓库的 .git/config 不能写：它能设会执行命令的选项";
  const dir = MANDATORY_DENY_DIRS.find((entry) => target.includes(`/${entry}/`));
  if (dir) return `${dir} 下面不能写：里面的东西会在沙箱外执行`;
  return null;
}

export type SandboxRole = "lead" | "executor" | "reviewer" | "agent_task";

export interface SandboxPolicyInput {
  role: SandboxRole;
  // 这次运行能写的目录（绝对路径）：worktree、检出、Lead 的临时目录。系统临时目录总是能写。
  writable: readonly string[];
  // 数据目录（~/.pi-lead-child）。不给时用缺省位置。
  dataDir?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}

export interface SandboxSecret {
  name: string;
  injectHosts: string[];
}

export interface SandboxPolicy {
  role: SandboxRole;
  allowWrite: string[];
  // 能写的范围里仍然不能写的（优先于 allowWrite）：git 的钩子和配置。
  denyWrite: string[];
  denyRead: string[];
  // 先放行的域名（见文件头：网络全开）。
  allowedDomains: string[];
  // 能在本机端口上监听、连本机端口：测试要起服务。Lead 不给：网关在本机端口上，本机网页能自动配对，
  // 沙箱里的命令连上去就能拿到用户的权限（gateway 的 isLoopbackPage）。Lead 要跑这类测试时派执行者。
  allowLocalBinding: boolean;
  // 能连的 Unix socket：执行者拿到 ssh-agent（SSH_AUTH_SOCK），能用用户的 SSH 身份推送，读不到私钥。
  allowUnixSockets: string[];
  // 沙箱里只看到占位值、发往绑定主机时换成真值的密钥；没绑定主机、沙箱里不给的密钥（见文件头）。
  maskedSecrets: SandboxSecret[];
  withheldSecrets: string[];
}

// 一个目录所在 git 仓库的目录（2026-10-28）：在隔离 worktree 里 git commit 要写 worktree 自己的 gitdir
// （<仓库>/.git/worktrees/<名字>：index、HEAD）和公共的 .git（对象、分支的 ref）。它们在 worktree 外面，不放开就提交不了。
// 但 hooks 和 config 不能写：沙箱里写一个钩子，用户下次在沙箱外跑 git 时它就会执行，等于逃出沙箱；config 能设
// core.hooksPath、core.fsmonitor 这类会执行命令的选项。不是 git 仓库时为 null。结果按目录缓存（git 的目录不会变）。
const gitDirsCache = new Map<string, { gitDir: string; commonDir: string } | null>();

export function gitDirsOf(dir: string): { gitDir: string; commonDir: string } | null {
  const key = resolve(dir);
  if (gitDirsCache.has(key)) return gitDirsCache.get(key)!;
  let found: { gitDir: string; commonDir: string } | null = null;
  try {
    const [gitDir, commonDir] = execFileSync(
      "git", ["-C", key, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
    ).trim().split("\n");
    if (gitDir && commonDir && isAbsolute(gitDir) && isAbsolute(commonDir)) found = { gitDir, commonDir };
  } catch {
    found = null;
  }
  gitDirsCache.set(key, found);
  return found;
}

function gitWriteRules(writable: readonly string[]): { allow: string[]; deny: string[] } {
  const allow = new Set<string>();
  const deny = new Set<string>();
  for (const dir of writable) {
    const dirs = gitDirsOf(dir);
    if (!dirs) continue;
    allow.add(dirs.gitDir);
    allow.add(dirs.commonDir);
    deny.add(join(dirs.commonDir, "hooks"));
    deny.add(join(dirs.commonDir, "config"));
    deny.add(join(dirs.gitDir, "config.worktree"));
  }
  return { allow: [...allow], deny: [...deny] };
}

/** 先放行的域名：缺省的，加上用户在 PLC_SANDBOX_EXTRA_DOMAINS 里补的。 */
export function sandboxAllowedDomains(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env[SANDBOX_EXTRA_DOMAINS_ENV] ?? "").split(",").map((domain) => domain.trim()).filter(Boolean);
  return [...new Set([...SANDBOX_DEFAULT_DOMAINS, ...extra])];
}

// 主机的写法：域名，或者 *. 开头、后面至少两段的通配（不收 * 和 *.com：那等于发给谁都行）。
const HOST_PATTERN = /^(\*\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validHost(host: string): boolean {
  if (!HOST_PATTERN.test(host)) return false;
  return !host.startsWith("*.") || host.slice(2).includes(".");
}

/** 用户在 PLC_SANDBOX_SECRET_HOSTS 里写的绑定。写错的主机丢掉（不猜）；一个名字写了几次，用最后一次。 */
export function parseSecretHosts(value: string | undefined): Map<string, string[]> {
  const bound = new Map<string, string[]>();
  for (const entry of (value ?? "").split(";")) {
    const at = entry.indexOf("=");
    if (at <= 0) continue;
    const name = entry.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const hosts = entry.slice(at + 1).split(",").map((host) => host.trim().toLowerCase()).filter(validHost);
    if (hosts.length) bound.set(name, [...new Set(hosts)]);
  }
  return bound;
}

// 名字像密钥、其实不是的变量（protocol 的 isSecretEnvName 按名字判断，宁可多认）：当前目录，和 ssh-agent 这类 socket 的路径。
// 去掉 SSH_AUTH_SOCK 就用不了 ssh-agent（2026-10-28 用 Claude Code 实测发现它们进了 deny）。
function notActuallySecret(name: string): boolean {
  return name === "PWD" || name === "OLDPWD" || /_SOCK(ET)?$/.test(name);
}

/** 这个环境变量是不是要按密钥处理（打码或者不给）。 */
export function isSandboxSecretName(name: string): boolean {
  if (name === SANDBOX_SECRET_HOSTS_ENV || notActuallySecret(name)) return false;
  return KNOWN_SECRET_ENV_NAMES.includes(name) || isSecretEnvName(name);
}

/**
 * 环境里的密钥怎样进沙箱：名字像密钥的变量（protocol 的 isSecretEnvName）和已知的密钥变量，有绑定主机的打码
 * （masked），没有的不给（withheld）。只看名字，不看值。
 */
export function sandboxSecrets(env: Record<string, string | undefined>): { masked: SandboxSecret[]; withheld: string[] } {
  const bound = parseSecretHosts(env[SANDBOX_SECRET_HOSTS_ENV]);
  const masked: SandboxSecret[] = [];
  const withheld: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    // 绑定本身是配置，不是密钥（名字里有 SECRET），见 isSandboxSecretName。
    if (!value || !isSandboxSecretName(name)) continue;
    const hosts = bound.get(name) ?? SANDBOX_SECRET_HOSTS[name];
    if (hosts?.length) masked.push({ name, injectHosts: [...hosts] });
    else withheld.push(name);
  }
  return {
    masked: masked.sort((a, b) => a.name.localeCompare(b.name)),
    withheld: withheld.sort(),
  };
}

/** 系统的临时目录：测试和构建都往这里写。macOS 上 /tmp 是 /private/tmp 的链接，两个都给。 */
export function sandboxTempDirs(): string[] {
  return [...new Set([tmpdir(), "/tmp", "/private/tmp"])];
}

export function sandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const home = input.home ?? homedir();
  const dataDir = input.dataDir ?? join(home, ".pi-lead-child");
  const env = input.env ?? process.env;
  // 能写整个 home（见文件头），加上 home 以外的这次运行的目录（例如别的盘上的仓库）。
  const writable = input.writable.filter((path) => isAbsolute(path)).map((path) => resolve(path));
  const git = gitWriteRules(writable);
  // 只读的子 agent（agent_task，Slack 来的活）不拿密钥：它读的是外部的话（spec D8）。
  const found = sandboxSecrets(env);
  const secrets = input.role === "agent_task"
    ? { masked: [], withheld: [...found.masked.map((secret) => secret.name), ...found.withheld].sort() }
    : found;
  const sshAgent = env.SSH_AUTH_SOCK;
  return {
    role: input.role,
    allowWrite: [...new Set([resolve(home), ...writable, ...git.allow, ...sandboxTempDirs()])],
    denyWrite: [...new Set([
      ...git.deny, ...SANDBOX_DENY_WRITE_HOME.map((path) => join(home, path)), ...dataDirDenyWrite(dataDir),
      ...homePathDirs(env, resolve(home)),
    ].map(realPath))],
    denyRead: [
      ...SANDBOX_DENY_READ_HOME.map((path) => join(home, path)),
      ...DATA_DIR_DENY_READ.map((path) => join(dataDir, path)),
    ].map(realPath),
    allowedDomains: sandboxAllowedDomains(env),
    allowLocalBinding: input.role !== "lead",
    allowUnixSockets: input.role === "executor" && sshAgent && isAbsolute(sshAgent) ? [sshAgent] : [],
    maskedSecrets: secrets.masked,
    withheldSecrets: secrets.withheld,
  };
}

/**
 * 沙箱里命令的环境变量：去掉名字像密钥的变量（*_TOKEN、*_KEY、*SECRET* 这类，见 protocol 的 isSecretEnvName）和
 * 已知的密钥变量。只按名字去掉，不看值：宁可多去一个，也不让密钥进命令的输出。打码的密钥由 sandbox-runtime 在
 * 包装后的命令里设成占位值（它的 credentials.envVars），所以这里去掉真值不影响它们能用。
 * 包管理器的缓存指到临时目录：home 下面的缓存目录不在能写的范围里。
 */
export function sandboxEnv(env: Record<string, string | undefined>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isSandboxSecretName(name)) continue;
    kept[name] = value;
  }
  return { ...kept, ...sandboxCacheEnv(), ...sandboxTrustEnv(kept) };
}

/**
 * 包管理器和构建工具的缓存。2026-10-28 起沙箱能写整个 home，缓存回到用户终端里的位置（~/.npm、~/Library/Caches 这类），
 * 不再改指到临时目录；会在沙箱外执行的缓存（ShipIt 更新包、pre-commit 的环境）由 SANDBOX_DENY_WRITE_HOME 挡。
 * 函数留着：runtime 的 claude.ts 把它加进 Claude Code 的环境，以后要改指某个缓存时只改这里。
 */
export function sandboxCacheEnv(): Record<string, string> {
  return {};
}

// 打码要 TLS 终止（代理在 TLS 里换值），而 sandbox-runtime 一开就终止所有主机。macOS 上 Go 写的工具（gh、terraform）
// 不信任沙箱的临时 CA，被终止的主机都连不上（2026-10-28 实测：x509: certificate signed by unknown authority）。
// 所以这些主机不终止，除非某个密钥绑定了它（那时 gh 这类工具用不了那个密钥，见 sandboxToolNote）。
const TLS_PASSTHROUGH_DOMAINS: readonly string[] = [
  ...GITHUB_HOSTS, "proxy.golang.org", "sum.golang.org", "registry.terraform.io", "releases.hashicorp.com",
];

// 两个主机写法有没有交集：相同，或者一个是另一个的通配。
function hostsOverlap(a: string, b: string): boolean {
  const covers = (pattern: string, host: string) => pattern.startsWith("*.")
    && (host.endsWith(pattern.slice(1)) || host === pattern.slice(2));
  return a === b || covers(a, b) || covers(b, a);
}

function tlsTerminateConfig(policy: SandboxPolicy): { excludeDomains: string[] } | null {
  if (!policy.maskedSecrets.length) return null;
  const injected = policy.maskedSecrets.flatMap((secret) => secret.injectHosts);
  return { excludeDomains: TLS_PASSTHROUGH_DOMAINS.filter((domain) => !injected.some((host) => hostsOverlap(domain, host))) };
}

// 沙箱里的根证书（2026-10-28）。macOS 自带的 curl 先用 /etc/ssl/cert.pem 验证，验不过时再去系统钥匙串里找根证书；
// 沙箱挡住了后面这一步，所以 example.com 这类证书链在 cert.pem 里不全的站点，沙箱里的 curl 报 60（证书校验失败），
// 沙箱外同一条命令是通的（2026-10-28 实测）。从系统钥匙串导出一份完整的根证书（系统自带的根，加上装进 System
// 钥匙串的，例如公司的根），用环境变量指给 curl、Python、git、Node。每个进程导出一次，放在系统临时目录。
const TRUST_KEYCHAINS = ["/System/Library/Keychains/SystemRootCertificates.keychain", "/Library/Keychains/System.keychain"];
let trustBundle: string | null | undefined;

/** 系统根证书的 PEM 文件。不是 macOS、或者导不出来时为 null。 */
export function sandboxTrustBundle(): string | null {
  if (trustBundle !== undefined) return trustBundle;
  trustBundle = null;
  if (process.platform !== "darwin") return trustBundle;
  try {
    const pem = execFileSync("security", ["find-certificate", "-a", "-p", ...TRUST_KEYCHAINS.filter((path) => existsSync(path))], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
    });
    if (!pem.includes("BEGIN CERTIFICATE")) return trustBundle;
    const path = join(tmpdir(), "plc-sandbox-ca.pem");
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current !== pem) writeFileSync(path, pem, { mode: 0o644 });
    trustBundle = path;
  } catch {
    trustBundle = null;
  }
  return trustBundle;
}

/**
 * 指向系统根证书的环境变量。env 里已经设了的不改（用户自己指定的证书优先）。
 * 打开 TLS 终止时，sandbox-runtime 在包装后的命令里设它自己的（含代理的证书），会盖过这里的。
 */
export function sandboxTrustEnv(env: Record<string, string | undefined>): Record<string, string> {
  const bundle = sandboxTrustBundle();
  if (!bundle) return {};
  const trust: Record<string, string> = {};
  for (const name of ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS"]) {
    if (!env[name]) trust[name] = bundle;
  }
  return trust;
}

/** sandbox-runtime 和 Claude Code 共用的 credentials.envVars：打码的写主机，不给的写 deny。 */
function credentialEnvVars(policy: SandboxPolicy): Array<Record<string, unknown>> {
  return [
    ...policy.maskedSecrets.map((secret) => ({ name: secret.name, mode: "mask", injectHosts: secret.injectHosts })),
    ...policy.withheldSecrets.map((name) => ({ name, mode: "deny" })),
  ];
}

/**
 * Claude Code 的设置（--settings）：开它自带的沙箱，沙箱里的 Bash 不用审批（autoAllowBashIfSandboxed），不许绕开沙箱
 * （allowUnsandboxedCommands=false）。键名按 Claude Code 2.1.311 核实（2026-10-28 在本机用 -p 试过）：
 *   - 写范围外的路径被拦。
 *   - 不在 allowedDomains 里的域名，auto 模式由 Claude Code 自己判断放行，不用人批。
 *   - credentials.envVars 打码的变量，沙箱里 echo 出来是占位值，发往 injectHosts 的请求里是真值。打码要
 *     network.tlsTerminate（代理在 TLS 里换值），所以只在有打码的密钥时打开，并且不终止 Go 工具常连的主机
 *     （tlsTerminateConfig）。
 *   - enableWeakerNetworkIsolation：gh 这类 Go 写的工具在 macOS 上要用 trustd 验证证书。它多出来的外传通道
 *     在网络全开时没有意义。
 */
export function claudeSandboxSettings(policy: SandboxPolicy): Record<string, unknown> {
  const envVars = credentialEnvVars(policy);
  const tls = tlsTerminateConfig(policy);
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      enableWeakerNetworkIsolation: true,
      network: {
        allowedDomains: policy.allowedDomains,
        allowLocalBinding: policy.allowLocalBinding,
        ...(policy.allowUnixSockets.length ? { allowUnixSockets: policy.allowUnixSockets } : {}),
        ...(tls ? { tlsTerminate: tls } : {}),
      },
      filesystem: { allowWrite: policy.allowWrite, denyWrite: policy.denyWrite, denyRead: policy.denyRead },
      ...(envVars.length ? { credentials: { envVars } } : {}),
    },
  };
}

/** @anthropic-ai/sandbox-runtime 的配置（SandboxRuntimeConfig 的形状，这里不依赖那个包）。 */
export function sandboxRuntimeConfig(policy: SandboxPolicy): {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowLocalBinding: boolean;
    allowUnixSockets?: string[];
    tlsTerminate?: { excludeDomains: string[] };
  };
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[] };
  credentials?: { envVars: Array<Record<string, unknown>> };
  enableWeakerNetworkIsolation: boolean;
} {
  const envVars = credentialEnvVars(policy);
  const tls = tlsTerminateConfig(policy);
  return {
    network: {
      allowedDomains: policy.allowedDomains,
      deniedDomains: [],
      allowLocalBinding: policy.allowLocalBinding,
      ...(policy.allowUnixSockets.length ? { allowUnixSockets: policy.allowUnixSockets } : {}),
      ...(tls ? { tlsTerminate: tls } : {}),
    },
    filesystem: { denyRead: policy.denyRead, allowWrite: policy.allowWrite, denyWrite: policy.denyWrite },
    ...(envVars.length ? { credentials: { envVars } } : {}),
    enableWeakerNetworkIsolation: true,
  };
}

/**
 * 给 agent 看的沙箱说明（bash 工具的描述、Lead 的环境说明）：能做什么，密钥怎么用。只写名字和主机，不写值。
 * writableNote 是能写的地方的一句话（例如「工作目录（/x）」）。
 */
export function sandboxToolNote(policy: SandboxPolicy, writableNote: string): string {
  const lines = [
    `命令在沙箱里跑，像在用户的终端里：能写${writableNote}和系统临时目录。各个 CLI 自己的登录、配置能读能写，`
      + "所以能替用户登录 CLI（设备码登录时盯着进程的输出，用户授权完就继续，不用等他回话）。读不到私钥和 plc 自己的密钥；"
      + "登录文件里的值不要贴进对话。网络全开，任何域名都能连"
      + (policy.allowLocalBinding ? "，也能起本机服务、连本机端口。" : "；连不了本机端口（要起本机服务跑测试，派执行者）。"),
  ];
  if (policy.maskedSecrets.length) {
    lines.push("环境变量里的密钥是占位值：命令发往它绑定的主机时，沙箱的代理换成真值。所以直接用 $名字 调工具就行，"
      + "echo 出来只是占位值。绑定："
      + policy.maskedSecrets.map((secret) => `${secret.name} → ${secret.injectHosts.join("、")}`).join("；") + "。"
      + "gh 这类 Go 写的工具在 macOS 上不认沙箱代理的证书，用不了打码的密钥（连那些主机会报证书错误）：换 curl、"
      + "Python、Node，或者用连接工具。");
  }
  if (policy.withheldSecrets.length) {
    lines.push(`没绑定主机、沙箱里没有的密钥：${policy.withheldSecrets.join("、")}。要用时请用户在 config.json 的 env 段里`
      + `写 ${SANDBOX_SECRET_HOSTS_ENV}（例如 名字=api.example.com），这是用户的设置。`);
  }
  if (policy.allowUnixSockets.length) lines.push("能用用户的 ssh-agent：git 经 SSH 推送自己的分支不用审批（读不到私钥）。");
  return lines.join("\n");
}
