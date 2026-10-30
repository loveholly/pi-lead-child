// ── 工作区内容的指纹（工单 #66 第二轮 release review N2）────────────────────────
//
// 工单对话 Run 启动前、结束后各算一次，用来判断这个 Run 自己有没有改工作区（review-currency.ts）。
// 要求：
//   · 异步：daemon 的主线程上不同步遍历整棵树（以前 reviewer 的完整性检查是同步的 walk，会进 node_modules）；
//   · git 仓库按 git 的视角算：只看 git 跟踪的文件，和没有被 .gitignore 忽略的新文件；依赖、构建产物、
//     测试缓存一般都被忽略。不看 git_worktree 标记，只看这个目录是不是在 git 仓库里；
//   · 只读：共用的工作区就是用户的主 checkout，用户和其他会话在那里提交（第三轮 F2）。所有 git 命令
//     都带 --no-optional-locks（git status 默认会拿 .git/index.lock，顺手刷新索引并写回），
//     hash-object 不带 -w、带 --no-filters，git-lfs 的 filter 被关掉（它的 clean 会往 .git/lfs 里存对象）。
//     剩下的限制：仓库自己配置的其他 clean filter，git status 比较内容时仍可能运行；
//   · 只看内容，不看 HEAD：把工作区里已有的改动提交掉，内容没变，指纹也不变；
//   · 不是 git 仓库时，有界地遍历目录，跳过常见的依赖和缓存目录；
//   · 超时或超出上限时抛错。调用方据此不判定"改过"（不让结论过期）。
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspaceTreeHashOptions {
  /** 整次计算的时限。默认 30 秒。 */
  timeoutMs?: number;
  /** 非 git 目录最多读多少个文件、多少字节。默认 20000 个、256 MB。 */
  maxFiles?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
// 一次 hash-object 最多带多少个路径，避免命令行过长。
const HASH_OBJECT_BATCH = 500;

// 非 git 目录里跳过的目录名：版本库、依赖、构建产物和缓存。
export const WALK_IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git", ".hg", ".svn",
  "node_modules", "bower_components", ".pnpm-store", ".yarn",
  "dist", "build", "out", "target", "coverage",
  ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", ".vite", ".vitest", ".gradle", ".idea",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
]);

type Remaining = () => number;

function deadline(timeoutMs: number): Remaining {
  const end = Date.now() + timeoutMs;
  return () => {
    const left = end - Date.now();
    if (left <= 0) throw new Error(`workspace hash timed out after ${timeoutMs}ms`);
    return left;
  };
}

// 每一条 git 命令都带上：不拿可选锁、不跑 git-lfs 的 filter。
const READ_ONLY_GIT_OPTIONS = [
  "--no-optional-locks",
  "-c", "filter.lfs.clean=", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false",
];

async function git(cwd: string, args: string[], remaining: Remaining): Promise<string> {
  const { stdout } = await execFileAsync("git", [...READ_ONLY_GIT_OPTIONS, "-C", cwd, ...args], {
    encoding: "utf8", timeout: remaining(), maxBuffer: GIT_MAX_BUFFER,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout;
}

// 这个目录在不在 git 工作区里，只看文件系统：它或它的上级目录有没有 .git（目录，或 worktree /
// 子模块用的 .git 文件）。以前用 `git rev-parse` 判断，git 一失败就悄悄改成遍历目录，
// 得出另一个指纹，看起来就像"改过"（第三轮 F6）。现在在仓库里 git 失败就是算不出来。
async function insideGitWorkTree(path: string): Promise<boolean> {
  for (let dir = path; ; dir = dirname(dir)) {
    if (await lstat(join(dir, ".git")).then(() => true, () => false)) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** 工作区内容的指纹。目录不存在、git 命令失败、超时或超出上限时抛错。 */
export async function workspaceTreeHash(path: string, options: WorkspaceTreeHashOptions = {}): Promise<string> {
  const remaining = deadline(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!(await lstat(path)).isDirectory()) throw new Error(`workspace ${path} is not a directory`);
  if (await insideGitWorkTree(path)) {
    const top = (await git(path, ["rev-parse", "--show-toplevel"], remaining)).trim();
    return gitTreeHash(top, path, remaining);
  }
  return walkTreeHash(path, {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  }, remaining);
}

// 仓库还没有任何提交时没有 HEAD：`rev-parse --verify -q` 以退出码 1 结束、不输出。
// 别的失败（超时、git 出错）都是"算不出来"，往上抛。
async function hasHead(path: string, remaining: Remaining): Promise<boolean> {
  try {
    await git(path, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], remaining);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

// 符号链接在 git 里是一个 blob，内容是链接的目标。改过的链接也按这个算 id，
// 提交前后才一样（ls-tree 给的就是这个 id）。
function symlinkBlobId(target: string, objectFormat: string): string {
  const content = Buffer.from(target);
  return createHash(objectFormat === "sha256" ? "sha256" : "sha1")
    .update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content]))
    .digest("hex");
}

// git 仓库：路径 → 内容的表。基础是 HEAD 里这个目录下的文件（blob id，不读文件）；
// 工作区里有改动的路径（git status，含没被忽略的新文件）用 hash-object 重算，删掉的从表里去掉。
// 表里只记内容 id，不记 HEAD：同一份内容提交前后，表是一样的。
// 子模块：干净的记 HEAD 里登记的提交；有改动的递归算它自己的内容指纹，子模块里改了文件也看得到。
async function gitTreeHash(top: string, path: string, remaining: Remaining): Promise<string> {
  const entries = new Map<string, string>();
  const objectFormat = (await git(path, ["rev-parse", "--show-object-format"], remaining)).trim();
  if (await hasHead(path, remaining)) {
    const tree = await git(path, ["ls-tree", "-r", "-z", "--full-name", "HEAD", "--", "."], remaining);
    for (const record of tree.split("\0")) {
      if (!record) continue;
      const tab = record.indexOf("\t");
      const [mode, type, id] = record.slice(0, tab).split(" ");
      entries.set(record.slice(tab + 1), type === "commit" ? `commit ${id}` : mode === "120000" ? `link ${id}` : id!);
    }
  }
  const status = await git(path, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ".",
  ], remaining);
  const files: string[] = [];
  for (const record of status.split("\0")) {
    if (record.length < 4) continue;
    const name = record.slice(3);
    const stat = await lstat(join(top, name)).catch(() => null);
    if (!stat) {
      entries.delete(name);
    } else if (stat.isDirectory()) {
      // 有改动的子模块（或没被跟踪的嵌套仓库）：递归算它自己的内容指纹。
      const nested = join(top, name);
      entries.set(name, `tree ${await gitTreeHash(nested, nested, remaining)}`);
    } else if (stat.isSymbolicLink()) {
      entries.set(name, `link ${symlinkBlobId(await readlink(join(top, name)), objectFormat)}`);
    } else {
      files.push(name);
    }
  }
  for (let index = 0; index < files.length; index += HASH_OBJECT_BATCH) {
    const batch = files.slice(index, index + HASH_OBJECT_BATCH);
    // 不带 -w：只算 id，不往对象库写东西。--no-filters：不跑任何 clean filter。
    const ids = (await git(top, ["hash-object", "--no-filters", "--", ...batch], remaining)).trim().split("\n");
    batch.forEach((name, position) => entries.set(name, ids[position]!));
  }
  const hash = createHash("sha256").update("git\n");
  for (const name of [...entries.keys()].sort()) hash.update(`${name}\0${entries.get(name)}\n`);
  return hash.digest("hex");
}

async function walkTreeHash(
  root: string,
  limits: { maxFiles: number; maxBytes: number },
  remaining: Remaining,
): Promise<string> {
  const hash = createHash("sha256").update("walk\n");
  let files = 0;
  let bytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const children = (await readdir(dir, { withFileTypes: true }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      remaining();
      const full = join(dir, child.name);
      const name = relative(root, full);
      if (child.isDirectory()) {
        if (!WALK_IGNORED_DIRECTORIES.has(child.name)) await walk(full);
      } else if (child.isSymbolicLink()) {
        hash.update(`link\0${name}\0${await readlink(full)}\n`);
      } else if (child.isFile()) {
        files += 1;
        if (files > limits.maxFiles) throw new Error(`workspace ${root} has more than ${limits.maxFiles} files`);
        // 先按大小检查上限，再读：超过上限的文件一个字节也不读。
        bytes += (await lstat(full)).size;
        if (bytes > limits.maxBytes) throw new Error(`workspace ${root} is larger than ${limits.maxBytes} bytes`);
        const content = await readFile(full);
        hash.update(`file\0${name}\0${createHash("sha256").update(content).digest("hex")}\n`);
      }
    }
  };
  await walk(root);
  return hash.digest("hex");
}
