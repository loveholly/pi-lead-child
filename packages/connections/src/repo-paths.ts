// 本地仓库的路径检查（slack-takeover spec D5；2026-10-22 挪到连接中心，代查和连接中心的本地读取共用）。
// agent 给的路径是不可信的输入：
// 先按文本规则拒绝（控制字符、绝对路径、`..`），再 realpath，结果必须留在作用域仓库的根目录里，
// 最后按禁止名单检查规范化以后的路径。符号链接按它指向的地方判断：指到根目录外面、或者指到 .env 都被拒绝。
// 写法照 store 的 artifacts.ts（validateRelativePath、openCanonicalSource）：打开时不跟随符号链接，
// 打开以后再核对一次，防止检查和打开之间文件被换掉。
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

// 个人数据和凭据的禁止名单（spec D5，landing.md 第 5 节的硬性底线）。这些文件不列出、不读、不搜。名字按小写比较。
// 日志（*.log、*.log.1）也在里面：日志里常有令牌和请求原文。
const ENV_ALLOWED = new Set([".env.example", ".env.sample", ".env.template"]);
const DENIED_EXACT = new Set(["id_rsa", "id_ed25519", "id_ecdsa"]);
const DENIED_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

/** 一个文件名或目录名在不在禁止名单里。 */
export function isDeniedName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === ".env") return true;
  if (lower.startsWith(".env.")) return !ENV_ALLOWED.has(lower);
  if (DENIED_EXACT.has(lower)) return true;
  if (DENIED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true;
  if (lower.startsWith("credentials")) return true;
  if (lower.startsWith("secrets.")) return true;
  if (/\.log(?:\.\d+)?$/.test(lower)) return true;
  return false;
}

/** 相对路径（用 / 或系统分隔符）里有没有被拒绝的一段：禁止名单，或者 .git 目录（远端地址里可能有令牌）。 */
export function deniedSegment(relPath: string): string | null {
  for (const segment of relPath.split(/[\\/]/)) {
    if (!segment) continue;
    if (segment.toLowerCase() === ".git") return segment;
    if (isDeniedName(segment)) return segment;
  }
  return null;
}

/** 搜索时跳过的目录。 */
export const SEARCH_SKIPPED_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);

export type ScopedPath =
  | { ok: true; root: string; absolute: string; relative: string }
  | { ok: false; reason: string };

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/**
 * 把代查 agent 给的相对路径解析到作用域的仓库根目录里。路径必须存在。
 * 拒绝时 reason 是给 agent 看的一句话（也写进审计的 refused）。
 */
export function resolveScopedPath(root: string, input: string, options: { deniedRoots?: readonly string[] } = {}): ScopedPath {
  const raw = input.trim() === "" ? "." : input.trim();
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: "路径里有控制字符" };
  if (isAbsolute(raw) || raw.startsWith("\\") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) {
    return { ok: false, reason: "只接受仓库根目录下的相对路径" };
  }
  if (raw.split(/[\\/]/).some((segment) => segment === "..")) return { ok: false, reason: "路径不能用 .. 离开仓库" };
  const lexical = normalize(raw);
  const deniedLexical = deniedSegment(lexical);
  if (deniedLexical) return { ok: false, reason: `${deniedLexical} 在禁止名单里，不能读` };
  let canonicalRoot: string;
  let canonical: string;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: "作用域里的仓库目录不存在" };
  }
  try {
    canonical = realpathSync(resolve(canonicalRoot, lexical));
  } catch {
    return { ok: false, reason: "路径不存在" };
  }
  if (!isContained(canonicalRoot, canonical)) return { ok: false, reason: "路径（经过符号链接以后）在仓库外面" };
  // 助手自己的数据目录（~/.pi-lead-child：账本、凭据、日志）：仓库在它里面、或者路径经过符号链接落进它里面，都拒绝。
  for (const denied of options.deniedRoots ?? []) {
    let canonicalDenied: string;
    try {
      canonicalDenied = realpathSync(denied);
    } catch {
      continue;
    }
    if (isContained(canonicalDenied, canonical)) return { ok: false, reason: "这个位置是助手自己的数据目录，不能读" };
  }
  const rel = toPosix(relative(canonicalRoot, canonical)) || ".";
  const denied = rel === "." ? null : deniedSegment(rel);
  if (denied) return { ok: false, reason: `${denied} 在禁止名单里，不能读` };
  return { ok: true, root: canonicalRoot, absolute: canonical, relative: rel };
}

export type ScopedFileRead =
  | { ok: true; text: string; bytes: number; truncated: boolean }
  | { ok: false; reason: string };

/** 读作用域里的一个普通文件，最多 maxBytes 字节。不跟随符号链接打开，打开以后再核对一次。 */
export function readScopedFile(path: Extract<ScopedPath, { ok: true }>, maxBytes: number): ScopedFileRead {
  let fd: number;
  try {
    fd = openSync(path.absolute, constants.O_RDONLY | NO_FOLLOW);
  } catch {
    return { ok: false, reason: "文件打不开" };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { ok: false, reason: "不是普通文件" };
    const after = realpathSync(path.absolute);
    if (!isContained(path.root, after)) return { ok: false, reason: "文件在打开时离开了仓库" };
    const afterStat = statSync(after);
    if (afterStat.dev !== opened.dev || afterStat.ino !== opened.ino) return { ok: false, reason: "文件在打开时被换掉了" };
    const size = Math.min(opened.size, maxBytes);
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    const content = buffer.subarray(0, read);
    if (content.includes(0)) return { ok: false, reason: "二进制文件，不读" };
    return { ok: true, text: content.toString("utf8"), bytes: read, truncated: opened.size > maxBytes };
  } finally {
    closeSync(fd);
  }
}
