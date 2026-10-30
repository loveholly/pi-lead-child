// Hindsight 记忆服务的托管（2026-10-16 用户决定：先接 Hindsight，由 daemon 负责初始化好它）。
// - 它是一个独立的 launchd 任务（com.pi-lead-child.hindsight），不是 daemon 或 supervisor 的子进程。
//   所以 daemon 重启、升级，supervisor 重装，都不会重启它。daemon 只在期望状态变了时重启它（热重载）：
//   版本、端口、数据库、embedding、reranker、LLM，或者密钥换了。
// - 用什么模型由 daemon 决定（apps/daemon 的 memory-controller.ts，用户在设置页选）。这里只接收决定好的配置：
//   embedding 是本地模型或者 OpenAI 兼容的远程接口；reranker 是决策模型（TypeSafe 协议）、本地模型或者不用。
//   本地模型由 daemon 预先下载好（hindsight-models.ts）。Hindsight 离线运行（HF_HUB_OFFLINE），自己不下载任何东西：
//   它的模型初始化有 300 秒的超时，第一次下载 2.3 GB 的 bge-m3 会超时，服务起不来（2026-10-16 实测）。
// - 认证：daemon 第一次初始化时生成一个 randomUUID 作为 key，加密存进保险库（不进 config.json 的明文，
//   也不进 process.env：child 继承 daemon 的全部环境）。服务只监听 127.0.0.1。
// - 数据库：第一次安装时检查本机已有的 Postgres（15 以上，带 pgvector，127.0.0.1 上在跑）。能用就在里面建库，
//   不重复安装；不能用就用 Hindsight 自带的嵌入式 Postgres（pg0，数据在 ~/.pg0）。选定之后不再变，
//   免得以后装了 Postgres 时，Hindsight 换到一个空库上。
//   同一个库里不能混用两个 embedding（向量维度和向量空间都不同），所以库名带上 embedding 的指纹：
//   换了 embedding 就是一个新库，notes 从头同步一遍（engine 的 NotesMemory），旧库留着，可以删。
// - 密钥不进 plist（spec §B3）。daemon 把密钥加密写进 <dataDir>/hindsight/secrets.sealed，launchd 运行的
//   hindsight-main（apps/daemon）用保险库的密钥解开，算出环境变量，再用 uvx 启动固定版本的 hindsight-api。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { launchctl } from "./launchd.js";

export const HINDSIGHT_LABEL = "com.pi-lead-child.hindsight";
// 升级：改这里，重启 daemon。plist 跟着变，launchd 重启服务；Hindsight 启动时自己做数据库迁移。
export const HINDSIGHT_VERSION = "1.0.0";
export const HINDSIGHT_DEFAULT_PORT = 47188;
// uvx 只固定了 hindsight-api 本身的版本。它的依赖（torch、sentence-transformers 等）每次安装时重新解析，
// 所以再固定一个时间点：只用这个时间之前发布的版本（uv 的 --exclude-newer）。之后发布的依赖进不来，
// 解析结果可以复现。2026-10-16 用这个时间点实测过离线解析。升级 Hindsight 时一起改。
export const HINDSIGHT_RESOLVED_BEFORE = "2026-10-16T09:00:00Z";

// uvx 运行 Hindsight 的参数前缀：launchd 任务（hindsight-main）和模型下载（hindsight-models.ts）用同一组，
// 共用同一个环境。
export function hindsightUvxArgs(resolvedBefore: string = HINDSIGHT_RESOLVED_BEFORE): string[] {
  return ["--exclude-newer", resolvedBefore];
}
// 内嵌 pg0 的端口和监听地址。pg0 缺省监听 localhost（::1 和 127.0.0.1），端口自动选，第一次会占 5432：
// 用户以后装的 Postgres 就起不来。所以固定一个端口，只监听 127.0.0.1（2026-10-16 实测 lsof）。
export const HINDSIGHT_PG0_PORT = 47189;
const MIN_POSTGRES = 15;

export function hindsightDir(dataDir: string): string {
  return join(dataDir, "hindsight");
}

export function hindsightPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${HINDSIGHT_LABEL}.plist`);
}

const sha = (value: unknown, length: number) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, length);

// 决定好的 embedding。它决定索引：换了它就是一个新库。
// 本地模型：Hugging Face 的 repo、固定的 commit（revision），和下载好的快照目录（path）。
// Hindsight 从 path 离线加载，所以用的一定是这个 revision。
export type HindsightEmbedding =
  | { provider: "local"; model: string; revision: string; path: string }
  | { provider: "openai"; baseUrl: string; model: string; dimensions: number | null };

// 决定好的 reranker。typesafe 是决策模型的协议（POST <baseUrl>/v1/systemone），Jev 或者用户自建的兼容端点。
export type HindsightReranker =
  | { provider: "local"; model: string; revision: string; path: string }
  // maxCandidates：每次召回最多交给外部 reranker 多少条候选（Hindsight 缺省 300）。
  | { provider: "typesafe"; baseUrl: string; model: string; maxCandidates: number }
  | { provider: "none" };

// hindsight-main 需要的密钥。只以密文落盘（secrets.sealed）。
// databasePassword：内嵌 pg0 的密码。pg0 缺省的 hindsight/hindsight 人人都知道，本机任何进程都能读写全部记忆。
// llmApiKey：Hindsight 摘要模型（缺省槽）的 Lead provider 的 key。consolidationLlmApiKey：整理观察单独选了模型时，它的 provider 的 key。
// daemon 解析好放进来，hindsight-main 不读 config.json 和 Keychain。
export interface HindsightSecrets {
  apiKey: string;
  databasePassword: string;
  embeddingApiKey?: string;
  decisionApiKey?: string;
  llmApiKey?: string;
  consolidationLlmApiKey?: string;
}

// embedding 的指纹，决定库名。本地模型只看 repo 和 revision，不看本机的目录。
export function embeddingFingerprint(embedding: HindsightEmbedding): string {
  return sha(embedding.provider === "local"
    ? { provider: "local", model: embedding.model, revision: embedding.revision }
    : embedding, 8);
}

// Hindsight 用哪个数据库。选定之后不再变（见文件开头）。
export type HindsightDatabase =
  | { kind: "pg0" }
  | { kind: "postgres"; binDir: string; port: string };

// Hindsight 的整理目标（2026-10-29 用户：「我们不是只针对代码任务的」，spec D16 之后的补充）。Hindsight 缺省的说法偏写代码，
// 这里改成个人助理的场景。都是服务级的配置（configuration.mdx）：
// - retain：引导提取事实，不替换提取规则（HINDSIGHT_API_RETAIN_MISSION）。
// - observations：替换整理观察的内置规则（HINDSIGHT_API_OBSERVATIONS_MISSION），所以「新的取代旧的时写明取代关系」要写在这里。
//   它管用户本人的范围（origin:user）。
// - external：外部来源的范围（origin:external，engine 的 hindsight.ts 按来源分范围整理）另一条规则
//   （HINDSIGHT_API_CONSOLIDATION_STRATEGIES）：记的是别人说的话，不写成用户的偏好。
// 改了这些文字，service.json 跟着变，服务重启后用新的。
export interface HindsightMissions {
  retain: string;
  observations: string;
  external: string;
}

export const HINDSIGHT_MISSIONS: HindsightMissions = {
  retain: "This bank is the long-term memory of a personal assistant that works for one user across all of their work and life, "
    + "not only coding. Pay attention to the user's own preferences, standing agreements, decisions, commitments, routines, "
    + "people and relationships, projects, tools, and schedules. Keep who said each thing and when. "
    + "When the content is a summary of a conversation among other people, record it as what those people said, "
    + "never as the user's own wish or instruction.",
  observations: "Observations are durable beliefs about the user that a personal assistant should act on: the user's current "
    + "preferences, standing agreements and decisions, routines, and lasting facts about the people, projects, and tools they work with. "
    + "Ground every observation in its source memories. Skip passing state, such as a one-off task or what is happening right now. "
    + "When a newer memory changes or replaces an older one (a new request from the user, or a change in how the system now behaves), "
    + "keep one observation that states what is true now and what it replaced, with dates, for example "
    + "'Since 2026-10-28 the user wants X; before that they wanted Y'. Do not keep both as if both were current, "
    + "and do not drop the history silently. Merge near-duplicates.",
  external: "These memories summarize conversations among other people in a team chat. Each observation records what those people "
    + "said or decided and names who said it. Never phrase an observation here as the user's own preference, agreement, or instruction.",
};

// 一个摘要模型在 service.json 里的样子：不含 key。
export interface HindsightLlmTarget {
  provider: string;
  baseUrl: string;
  model: string;
}

// <dataDir>/hindsight/service.json：服务的期望状态。不含密钥。
export interface HindsightServiceFile {
  version: string;
  // 依赖解析的时间点（HINDSIGHT_RESOLVED_BEFORE）。改了它，服务按新的解析重启。
  resolvedBefore: string;
  port: number;
  database: HindsightDatabase;
  // 按 embedding 的指纹算出的库地址。hindsight-main 直接用它。
  databaseUrl: string;
  embedding: HindsightEmbedding;
  reranker: HindsightReranker;
  // Hindsight 的摘要模型（缺省槽：提取事实，整理观察没单独选时也用它）：Lead 的 provider、它的地址和模型 id。key 在 secrets.sealed 里。
  llm: HindsightLlmTarget | null;
  // 整理观察单独选的模型（.scratch/hindsight-primary-memory/spec.md D16）。没有或者 null 时跟缺省一样。
  consolidationLlm?: HindsightLlmTarget | null;
  // 打开观察整理（2026-10-29 用户决定）。早先的 service.json 没有它：按关着读。有 LLM 时才打开。
  observations?: boolean;
  // 整理目标（HINDSIGHT_MISSIONS）。早先的 service.json 没有它：用 Hindsight 缺省的说法。
  missions?: HindsightMissions | null;
  // 密钥的版本。密钥换了它就变，plist 跟着变，服务重启后用新密钥。
  secretsVersion: number;
  // 用户在 daemon 的环境里设的日志调优项（HINDSIGHT_API_LOG_LEVEL、HINDSIGHT_API_LOG_FORMAT）。
  // hindsight-main 跑在 launchd 的环境里，读不到 daemon 的环境，所以经 service.json 带过去。没设时日志级别是 warning。
  tuning: HindsightTuning;
  uvx: string;
}

export function readServiceFile(dataDir: string): HindsightServiceFile | null {
  const path = join(hindsightDir(dataDir), "service.json");
  if (!existsSync(path)) return null;
  try {
    const service = JSON.parse(readFileSync(path, "utf8")) as Partial<HindsightServiceFile>;
    return service.database && service.embedding && typeof service.databaseUrl === "string" ? service as HindsightServiceFile : null;
  } catch {
    return null;
  }
}

function writeServiceFile(dataDir: string, service: HindsightServiceFile): void {
  mkdirSync(hindsightDir(dataDir), { recursive: true, mode: 0o700 });
  writeFileSync(join(hindsightDir(dataDir), "service.json"), `${JSON.stringify(service, null, 2)}\n`, { mode: 0o600 });
}

export type CommandRunner = (bin: string, args: string[]) => Promise<{ ok: boolean; out: string }>;

const runCommand: CommandRunner = (bin, args) => new Promise((resolve) => {
  execFile(bin, args, { timeout: 15_000 }, (error, stdout, stderr) =>
    resolve({ ok: !error, out: `${stdout}${stderr}`.trim() }));
});

// 可能装着 Postgres 的 bin 目录：PATH 上的、Homebrew 的、Postgres.app 的。
export function postgresBinDirs(env: Record<string, string | undefined> = process.env): string[] {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    for (const name of ["postgresql@18", "postgresql@17", "postgresql@16", "postgresql@15", "postgresql"]) {
      dirs.push(join(prefix, name, "bin"));
    }
  }
  dirs.push("/Applications/Postgres.app/Contents/Versions/latest/bin");
  return [...new Set(dirs)].filter((dir) => existsSync(join(dir, "pg_config")));
}

export interface PostgresDetection {
  found: { binDir: string; port: string } | null;
  // 每个候选为什么不能用。没有候选时是空的。
  reasons: string[];
}

// 检查本机已有的 Postgres 能不能给 Hindsight 用：版本、pgvector、服务在跑、当前用户能连上。
export async function findPostgres(opts: {
  env?: Record<string, string | undefined>;
  run?: CommandRunner;
  exists?: (path: string) => boolean;
  binDirs?: string[];
} = {}): Promise<PostgresDetection> {
  const env = opts.env ?? process.env;
  const run = opts.run ?? runCommand;
  const exists = opts.exists ?? existsSync;
  const port = /^\d{1,5}$/.test(env.PGPORT ?? "") ? env.PGPORT! : "5432";
  const reasons: string[] = [];
  for (const dir of opts.binDirs ?? postgresBinDirs(env)) {
    const bin = (name: string) => join(dir, name);
    const version = await run(bin("pg_config"), ["--version"]);
    const major = Number(/PostgreSQL (\d+)/.exec(version.out)?.[1] ?? 0);
    if (!version.ok || major < MIN_POSTGRES) {
      reasons.push(`${dir}: PostgreSQL ${major || "?"} is older than ${MIN_POSTGRES}`);
      continue;
    }
    const share = await run(bin("pg_config"), ["--sharedir"]);
    if (!share.ok || !exists(join(share.out, "extension", "vector.control"))) {
      reasons.push(`${dir}: pgvector is not installed (brew install pgvector)`);
      continue;
    }
    const conn = ["-h", "127.0.0.1", "-p", port];
    if (!(await run(bin("pg_isready"), conn)).ok) {
      reasons.push(`${dir}: no server is accepting connections on 127.0.0.1:${port}`);
      continue;
    }
    const connect = await run(bin("psql"), [...conn, "-d", "postgres", "-tAc", "SELECT 1"]);
    if (!connect.ok) {
      reasons.push(`${dir}: cannot connect as ${userInfo().username}: ${connect.out.slice(0, 160)}`);
      continue;
    }
    return { found: { binDir: dir, port }, reasons };
  }
  return { found: null, reasons };
}

// 在已有的 Postgres 里建好 Hindsight 的库和 vector 扩展。库已经在时不重建。
export async function preparePostgresDatabase(
  server: { binDir: string; port: string }, name: string, run: CommandRunner = runCommand,
): Promise<string> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`not a safe database name: ${name}`);
  const bin = (tool: string) => join(server.binDir, tool);
  const conn = ["-h", "127.0.0.1", "-p", server.port];
  const listed = await run(bin("psql"), [...conn, "-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${name}'`]);
  if (!listed.ok) throw new Error(`cannot reach Postgres on 127.0.0.1:${server.port}: ${listed.out.slice(0, 160)}`);
  if (listed.out !== "1") {
    const created = await run(bin("createdb"), [...conn, name]);
    if (!created.ok) throw new Error(`cannot create database ${name}: ${created.out.slice(0, 160)}`);
  }
  const vector = await run(bin("psql"), [...conn, "-d", name, "-c", "CREATE EXTENSION IF NOT EXISTS vector"]);
  if (!vector.ok) throw new Error(`cannot create the vector extension in ${name}: ${vector.out.slice(0, 160)}`);
  return `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:${server.port}/${name}`;
}

// uvx 的位置。launchd 的 PATH 很短，所以记绝对路径。
export function findUvx(env: Record<string, string | undefined> = process.env): string | null {
  if (env.PLC_UVX && existsSync(env.PLC_UVX)) return env.PLC_UVX;
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    join(homedir(), ".local", "bin"), join(homedir(), ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin",
  ];
  return dirs.map((dir) => join(dir, "uvx")).find((path) => existsSync(path)) ?? null;
}

const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// launchd 的 plist。环境变量里只有数据目录、PATH 和期望状态的指纹，没有密钥。
// 指纹随 service.json 和启动命令变化，所以期望状态一变，plist 就变，daemon 才会重启服务。
export function hindsightPlist(o: {
  programArguments: string[]; dataDir: string; logDir: string; service: HindsightServiceFile;
}): string {
  const fingerprint = sha({ service: o.service, program: o.programArguments }, 16);
  const path = [dirname(o.service.uvx), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  const args = o.programArguments.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${HINDSIGHT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PLC_DATA_DIR</key><string>${xmlEscape(o.dataDir)}</string>
    <key>PATH</key><string>${xmlEscape(path)}</string>
    <key>PLC_HINDSIGHT_SPEC</key><string>${fingerprint}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xmlEscape(hindsightDir(o.dataDir))}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xmlEscape(join(o.logDir, "hindsight.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(o.logDir, "hindsight.err.log"))}</string>
</dict>
</plist>
`;
}

export interface EnsureHindsightOptions {
  dataDir: string;
  // launchd 运行的命令：node 和 hindsight-main 的入口（构建产物或者经 tsx 的源码）。
  programArguments: string[];
  embedding: HindsightEmbedding;
  reranker: HindsightReranker;
  // Hindsight 提取事实用的模型。null 时 Hindsight 只召回，不提取新的事实。
  llm: HindsightServiceFile["llm"];
  // 整理观察单独选的模型。null 时跟 llm 一样。
  consolidationLlm?: HindsightLlmTarget | null;
  // 打开观察整理。有 llm 时才生效。
  observations?: boolean;
  secretsVersion: number;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  // 测试注入。
  plistPath?: string;
  launchctl?: (args: string[]) => Promise<{ ok: boolean; out: string }>;
  sleep?: (ms: number) => Promise<void>;
  findPostgres?: () => Promise<PostgresDetection>;
  preparePostgres?: (server: { binDir: string; port: string }, name: string) => Promise<string>;
  uvx?: string | null;
}

export interface HindsightEndpoint {
  url: string;
  // 记忆索引的身份：库地址的指纹。换库（换了 embedding 或者数据库）时它跟着变，
  // engine 的 NotesMemory 就从头同步一遍 notes。
  index: string;
  // 这一次调用有没有（重新）启动服务。
  restarted: boolean;
}

type Launchctl = (args: string[]) => Promise<{ ok: boolean; out: string }>;

// launchctl bootout 发出停止信号就返回。Hindsight 下面挂着 uvx、Python 和 Postgres，要几秒才卸载完；
// 卸载完之前 bootstrap 会失败（Bootstrap failed: 5: Input/output error，2026-10-26）。
const UNLOAD_POLL_MS = 250;
const UNLOAD_TIMEOUT_MS = 30_000;
const BOOTSTRAP_ATTEMPTS = 5;
const BOOTSTRAP_RETRY_MS = 1_000;

// 等 bootout 卸载完：print 找不到这个任务为止。超时也接着 bootstrap，由它的重试和报错说明原因。
async function waitUntilUnloaded(ctl: Launchctl, target: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  for (let waited = 0; waited < UNLOAD_TIMEOUT_MS; waited += UNLOAD_POLL_MS) {
    if (!(await ctl(["print", target])).ok) return;
    await sleep(UNLOAD_POLL_MS);
  }
}

// bootstrap 失败时先等任务卸载完，再重试，最多 BOOTSTRAP_ATTEMPTS 次。
async function bootstrap(ctl: Launchctl, target: string, plist: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  let out = "";
  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt += 1) {
    const r = await ctl(["bootstrap", `gui/${process.getuid!()}`, plist]);
    if (r.ok) return;
    out = r.out;
    if (attempt < BOOTSTRAP_ATTEMPTS) {
      await sleep(BOOTSTRAP_RETRY_MS);
      await waitUntilUnloaded(ctl, target, sleep);
    }
  }
  throw new Error(`launchctl bootstrap ${HINDSIGHT_LABEL} failed after ${BOOTSTRAP_ATTEMPTS} attempts: ${out}`);
}

// 让服务处在期望状态。期望状态没变、任务在跑时什么也不做。不等服务就绪：客户端用 /health 判断它能不能用。
// 不能托管时（没有 uv）返回 null。
export async function ensureHindsightService(o: EnsureHindsightOptions): Promise<HindsightEndpoint | null> {
  const env = o.env ?? process.env;
  const log = o.log ?? ((line: string) => console.error(line));
  const uvx = o.uvx === undefined ? findUvx(env) : o.uvx;
  if (!uvx) {
    log("[hindsight] uvx not found; install uv (https://docs.astral.sh/uv/) to run Hindsight. Lead memory uses notes only");
    return null;
  }
  const portRaw = env.PLC_HINDSIGHT_PORT?.trim();
  const port = portRaw && /^\d{2,5}$/.test(portRaw) && Number(portRaw) < 65536 ? Number(portRaw) : HINDSIGHT_DEFAULT_PORT;
  const fingerprint = embeddingFingerprint(o.embedding);

  const previous = readServiceFile(o.dataDir);
  let database: HindsightDatabase;
  if (previous && (previous.database.kind === "pg0" || previous.database.kind === "postgres")) {
    database = previous.database;
  } else {
    const pg = await (o.findPostgres ?? (() => findPostgres({ env })))();
    for (const reason of pg.reasons) log(`[hindsight] existing Postgres not used: ${reason}`);
    database = pg.found ? { kind: "postgres", ...pg.found } : { kind: "pg0" };
    log(`[hindsight] database: ${pg.found ? `existing Postgres in ${pg.found.binDir}` : "embedded pg0 (~/.pg0)"}`);
  }
  const databaseUrl = database.kind === "pg0" ? pg0Url(fingerprint)
    : await (o.preparePostgres ?? preparePostgresDatabase)(database, `plc_hindsight_${fingerprint}`);
  const tuning = hindsightTuning(env, log);
  const service: HindsightServiceFile = {
    version: HINDSIGHT_VERSION, resolvedBefore: HINDSIGHT_RESOLVED_BEFORE, port, database, databaseUrl, embedding: o.embedding, reranker: o.reranker,
    llm: o.llm, consolidationLlm: o.llm ? o.consolidationLlm ?? null : null, observations: Boolean(o.llm && o.observations),
    missions: o.llm ? HINDSIGHT_MISSIONS : null,
    secretsVersion: o.secretsVersion, tuning, uvx,
  };
  writeServiceFile(o.dataDir, service);

  const logDir = join(o.dataDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const plist = o.plistPath ?? hindsightPlistPath();
  const content = hindsightPlist({ programArguments: o.programArguments, dataDir: o.dataDir, logDir, service });
  const ctl = o.launchctl ?? launchctl;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const target = `gui/${process.getuid!()}/${HINDSIGHT_LABEL}`;
  const installed = existsSync(plist) ? readFileSync(plist, "utf8") : null;
  const loaded = (await ctl(["print", target])).ok;
  let restarted = false;
  if (installed !== content) {
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, content);
    if (loaded) {
      await ctl(["bootout", target]);
      await waitUntilUnloaded(ctl, target, sleep);
    }
    await bootstrap(ctl, target, plist, sleep);
    restarted = true;
    log(`[hindsight] ${installed === null ? "installed" : "updated and restarted"} ${HINDSIGHT_LABEL} `
      + `(hindsight-api ${HINDSIGHT_VERSION}, port ${port}, embedding ${describeEmbedding(o.embedding)}, reranker ${describeReranker(o.reranker)})`);
  } else if (!loaded) {
    await bootstrap(ctl, target, plist, sleep);
    restarted = true;
    log(`[hindsight] started ${HINDSIGHT_LABEL}`);
  }
  return { url: `http://127.0.0.1:${port}`, index: sha(databaseUrl, 8), restarted };
}

// pg0 的 URL：查询串里的设置会变成 postgresql.conf 的 -c 参数（hindsight_api/pg0.py 的 parse_pg0_url）。
export function pg0Url(fingerprint: string): string {
  return `pg0://plc-hindsight-${fingerprint}:${HINDSIGHT_PG0_PORT}?listen_addresses=127.0.0.1`;
}

// 给人看的说明。设置页原样显示它（「语义检索已开 · 本地 BAAI/bge-m3」），切换卡片的摘要也用它。
export function describeEmbedding(embedding: HindsightEmbedding): string {
  return embedding.provider === "local" ? `本地 ${embedding.model}` : `远程 ${embedding.model}（${urlHost(embedding.baseUrl)}）`;
}

function urlHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return "地址不合法";
  }
}

export function describeReranker(reranker: HindsightReranker): string {
  return reranker.provider === "none" ? "不用" : reranker.provider === "local" ? `本地 ${reranker.model}` : `决策模型 ${reranker.model}`;
}

// 停掉服务（例如用户把 embedding 关掉了），删掉 plist。数据和密钥留着。plc daemon uninstall 也用它。
export async function uninstallHindsightService(opts: {
  plistPath?: string; launchctl?: (args: string[]) => Promise<{ ok: boolean; out: string }>;
} = {}): Promise<void> {
  const ctl = opts.launchctl ?? launchctl;
  await ctl(["bootout", `gui/${process.getuid!()}/${HINDSIGHT_LABEL}`]);
  rmSync(opts.plistPath ?? hindsightPlistPath(), { force: true });
}

// hindsight-api 子进程从 daemon 的环境里只拿这些（2026-10-16 发布评审：白名单，不是黑名单）。
// 系统和网络代理需要的变量，加上 uv 和 Hugging Face 的缓存位置（模型由 daemon 下载到同一个缓存里）。
// AM_API_KEY、TAVILY_API_KEY、config.json 的 env 段这一类都不给：Hindsight 是第三方的 Python 进程。
export const HINDSIGHT_INHERITED_ENV = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "UV_CACHE_DIR", "HF_HOME",
] as const;

// 用户可以调的 HINDSIGHT_API_* 只有日志的级别和格式。其余的（MCP_AUTH_TOKEN、RETAIN_/REFLECT_/CONSOLIDATION_LLM_*、
// READ_/MIGRATION_DATABASE_URL、WEBHOOK_URL、OTEL_*……）会绕过认证或者把笔记发到别处，一律不传。
// 缺省的级别是 warning，不是 Hindsight 的 info：它在 info 级别打印带密码的 pg0 地址（hindsight_api/pg0.py
// 的 "PostgreSQL started: {uri}"，2026-10-16 发布评审）。用户调成 info 或 debug 时，hindsight-main 照样会盖掉
// 输出里的密钥（maskSecrets）。
export interface HindsightTuning {
  logLevel: "debug" | "info" | "warning" | "error" | "critical" | null;
  logFormat: "text" | "json" | null;
}

const LOG_LEVELS = new Set(["debug", "info", "warning", "error", "critical"]);
const LOG_FORMATS = new Set(["text", "json"]);

// 从 daemon 的环境里读调优项。不认识的值不用，并说一句。
export function hindsightTuning(env: Record<string, string | undefined>, log: (line: string) => void = () => {}): HindsightTuning {
  const level = env.HINDSIGHT_API_LOG_LEVEL?.trim().toLowerCase() || null;
  const format = env.HINDSIGHT_API_LOG_FORMAT?.trim().toLowerCase() || null;
  if (level && !LOG_LEVELS.has(level)) log(`[hindsight] HINDSIGHT_API_LOG_LEVEL must be one of ${[...LOG_LEVELS].join(", ")}; using warning`);
  if (format && !LOG_FORMATS.has(format)) log(`[hindsight] HINDSIGHT_API_LOG_FORMAT must be text or json; using Hindsight's default`);
  return {
    logLevel: level && LOG_LEVELS.has(level) ? level as HindsightTuning["logLevel"] : null,
    logFormat: format && LOG_FORMATS.has(format) ? format as HindsightTuning["logFormat"] : null,
  };
}

// 子进程输出里要盖掉的值：secrets.sealed 里的每个密钥，pg0 的密码再加上它在 URL 里的写法。太短的值不算（会误伤普通文字）。
export function hindsightSecretValues(secrets: HindsightSecrets): string[] {
  const values = [
    secrets.apiKey, secrets.databasePassword, encodeURIComponent(secrets.databasePassword),
    secrets.embeddingApiKey, secrets.decisionApiKey, secrets.llmApiKey, secrets.consolidationLlmApiKey,
  ].filter((value): value is string => typeof value === "string" && value.length >= 8);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

// 盖掉一行里出现的密钥。hindsight-main 把 hindsight-api 的每一行输出都过一遍再写进日志。
export function maskSecrets(text: string, values: readonly string[]): string {
  let masked = text;
  for (const value of values) masked = masked.split(value).join("[REDACTED]");
  return masked;
}

// pg0 的地址加上用户名和密码。service.json 里的地址不带密码，只有 hindsight-main 在这里拼上。
export function pg0UrlWithPassword(url: string, password: string): string {
  if (!url.startsWith("pg0://")) return url;
  return `pg0://plc:${encodeURIComponent(password)}@${url.slice("pg0://".length)}`;
}

// hindsight-main 启动 hindsight-api 用的环境变量：白名单里的系统变量，加上我们算好的这些。
// 监听地址、端口、数据库、认证、embedding、reranker、LLM 总是我们的；MCP 和 observation 关掉。
export function hindsightEnvironment(input: {
  service: HindsightServiceFile;
  secrets: HindsightSecrets;
  env: Record<string, string | undefined>;
}): { env: Record<string, string>; notes: string[] } {
  const { service, secrets } = input;
  const notes: string[] = [];
  const env: Record<string, string> = {};
  for (const name of HINDSIGHT_INHERITED_ENV) {
    const value = input.env[name];
    if (value !== undefined) env[name] = value;
  }
  // 日志的调优项只从 service.json 来（daemon 写的）；launchd 环境里的 HINDSIGHT_API_* 一律不传。
  const ignored = Object.keys(input.env).filter((name) => name.startsWith("HINDSIGHT_API_"));
  if (ignored.length) notes.push(`ignored ${ignored.length} HINDSIGHT_API_* variable(s): ${ignored.sort().join(", ")}`);
  const tuning = service.tuning ?? { logLevel: null, logFormat: null };
  env.HINDSIGHT_API_LOG_LEVEL = tuning.logLevel ?? "warning";
  if (tuning.logFormat) env.HINDSIGHT_API_LOG_FORMAT = tuning.logFormat;
  Object.assign(env, {
    HINDSIGHT_API_HOST: "127.0.0.1",
    HINDSIGHT_API_PORT: String(service.port),
    HINDSIGHT_API_DATABASE_URL: pg0UrlWithPassword(service.databaseUrl, secrets.databasePassword),
    HINDSIGHT_API_TENANT_EXTENSION: "hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension",
    HINDSIGHT_API_TENANT_API_KEY: secrets.apiKey,
    // MCP 接口有自己的 token，不走上面的 API key。我们不用它。
    HINDSIGHT_API_MCP_ENABLED: "false",
    // observation 是 Hindsight 整理多条事实得出的观察，要额外的 LLM 调用。2026-10-29 用户决定打开（service.observations），
    // 有 LLM 时才开：没有 LLM 时整理只会失败。
    HINDSIGHT_API_ENABLE_OBSERVATIONS: service.observations && service.llm ? "true" : "false",
    // Python 在 launchd 下会把输出攒在缓冲区里：2026-10-26 日志 15 小时没有一行（spec D13）。
    PYTHONUNBUFFERED: "1",
    // 任务归属看 worker id。缺省是主机名，Mac 的主机名会变，变了之后旧任务就没人认领了。
    HINDSIGHT_API_WORKER_ID: "plc-hindsight",
    // LLM 代理开机时可能还没起来。启动时的验证调用失败会让服务退出，launchd 再拉起，循环下去。
    HINDSIGHT_API_SKIP_LLM_VERIFICATION: "true",
    // 本地模型由 daemon 预先下载并校验过。Hindsight 从快照目录离线加载，不自己下载。
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
  });
  if (service.embedding.provider === "local") {
    Object.assign(env, {
      HINDSIGHT_API_EMBEDDINGS_PROVIDER: "local",
      HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL: service.embedding.path,
      // 上游的 Node 启动器在 macOS 上设置它，避免后台模式下 Metal/MPS 崩溃。
      HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU: "1",
    });
  } else {
    Object.assign(env, {
      HINDSIGHT_API_EMBEDDINGS_PROVIDER: "openai",
      HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL: service.embedding.baseUrl,
      HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL: service.embedding.model,
      HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY: secrets.embeddingApiKey ?? "not-needed",
      ...(service.embedding.dimensions ? { HINDSIGHT_API_EMBEDDINGS_OPENAI_DIMENSIONS: String(service.embedding.dimensions) } : {}),
    });
  }
  if (service.reranker.provider === "local") {
    Object.assign(env, {
      HINDSIGHT_API_RERANKER_PROVIDER: "local",
      HINDSIGHT_API_RERANKER_LOCAL_MODEL: service.reranker.path,
      HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU: "1",
    });
  } else if (service.reranker.provider === "typesafe" && secrets.decisionApiKey) {
    Object.assign(env, {
      HINDSIGHT_API_RERANKER_PROVIDER: "typesafe",
      HINDSIGHT_API_RERANKER_TYPESAFE_BASE_URL: service.reranker.baseUrl,
      HINDSIGHT_API_RERANKER_TYPESAFE_MODEL: service.reranker.model,
      HINDSIGHT_API_RERANKER_TYPESAFE_API_KEY: secrets.decisionApiKey,
      HINDSIGHT_API_RERANKER_MAX_CANDIDATES: String(service.reranker.maxCandidates),
    });
  } else {
    // 不用 reranker：Hindsight 的 rrf 只按各路检索的名次融合，不加载模型，也不往外发数据。
    env.HINDSIGHT_API_RERANKER_PROVIDER = "rrf";
  }
  notes.push(`embedding ${describeEmbedding(service.embedding)}, reranker ${describeReranker(service.reranker)}`);
  const llm = service.llm;
  if (!llm) {
    env.HINDSIGHT_API_LLM_PROVIDER = "none";
    notes.push("no LLM configured; Hindsight recalls but does not extract new facts");
    return { env, notes };
  }
  // Lead 的 provider 都是 OpenAI 兼容的接口（lead 的 model-config.ts）。
  env.HINDSIGHT_API_LLM_PROVIDER = "openai";
  env.HINDSIGHT_API_LLM_BASE_URL = llm.baseUrl;
  env.HINDSIGHT_API_LLM_MODEL = llm.model;
  env.HINDSIGHT_API_LLM_API_KEY = secrets.llmApiKey ?? "not-needed";
  notes.push(`LLM ${llm.provider}/${llm.model}`);
  // 整理观察单独选的模型（configuration.mdx 的 Per-Operation LLM Configuration）。没选时 Hindsight 用上面的缺省。
  const consolidation = service.consolidationLlm;
  if (consolidation && service.observations) {
    env.HINDSIGHT_API_CONSOLIDATION_LLM_PROVIDER = "openai";
    env.HINDSIGHT_API_CONSOLIDATION_LLM_BASE_URL = consolidation.baseUrl;
    env.HINDSIGHT_API_CONSOLIDATION_LLM_MODEL = consolidation.model;
    env.HINDSIGHT_API_CONSOLIDATION_LLM_API_KEY = secrets.consolidationLlmApiKey ?? "not-needed";
    notes.push(`consolidation LLM ${consolidation.provider}/${consolidation.model}`);
  }
  if (service.observations) notes.push("observations on");
  // 整理目标：个人助理的场景（HINDSIGHT_MISSIONS）。外部来源的范围单独一条规则。
  const missions = service.missions;
  if (missions) {
    env.HINDSIGHT_API_RETAIN_MISSION = missions.retain;
    if (service.observations) {
      env.HINDSIGHT_API_OBSERVATIONS_MISSION = missions.observations;
      env.HINDSIGHT_API_CONSOLIDATION_STRATEGIES = JSON.stringify([
        { scopes: [{ tags: ["origin:external"], tags_match: "exact" }], observations_mission: missions.external },
      ]);
    }
    notes.push("personal-assistant missions");
  }
  return { env, notes };
}
