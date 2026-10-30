// 配对网关顺带提供 companion 的 web UI：`npm run build:web` 把 Expo 静态导出写到 dist/web，
// 网关在 / 下原样提供这些文件，/v1/* 仍然只是 API。这样用户只需要打开网关自己的地址，
// 不需要 dev server、.env.local 或 origin 白名单。
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { distDir } from "@pi-lead-child/core";

// 与 launcher 垫片、mcp-server 一样，跟随同一个仓库里 daemon 包的 dist/。
export function defaultWebRoot(): string {
  return join(distDir(), "web");
}

// 本机客户端该连的网关地址（不带结尾的 /），也是 plc web 打印的 web UI 地址。
// 网关绑在通配或回环地址上时用 127.0.0.1：只有回环页面能自动配对。
export function gatewayBaseUrl(host: string | undefined, port: number): string {
  const trimmed = host?.trim();
  const local = !trimmed || ["0.0.0.0", "::", "localhost"].includes(trimmed) || trimmed.startsWith("127.");
  const shown = local ? "127.0.0.1" : trimmed.includes(":") ? `[${trimmed}]` : trimmed;
  return `http://${shown}:${port}`;
}

export function isApiPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

export type WebLookup =
  | { kind: "file"; path: string; status: 200 | 404 }
  // 路径解码失败，或解码后含有 ..、点开头的段、反斜杠、NUL：一律拒绝，不去文件系统里找。
  | { kind: "invalid" }
  // web UI 没有构建，或者既没有匹配的文件也没有 +not-found.html。
  | { kind: "missing" };

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Expo Router 的动态段导出成 [id].html / [id]/ 这样的文件名。
function dynamicEntry(dir: string, wantFile: boolean): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  return entries.find((name) => {
    const base = wantFile ? (name.endsWith(".html") ? name.slice(0, -5) : "") : name;
    return /^\[[^.\]][^\]]*\]$/.test(base) && (wantFile ? isFile(join(dir, name)) : isDirectory(join(dir, name)));
  });
}

// 先找字面量的文件、目录；找不到时再找同一层的动态段。
function routeFile(root: string, segments: string[]): string | undefined {
  let dir = root;
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (last) {
      for (const candidate of [join(dir, segment), join(dir, `${segment}.html`), join(dir, segment, "index.html")]) {
        if (isFile(candidate)) return candidate;
      }
      const dynamicFile = dynamicEntry(dir, true);
      if (dynamicFile) return join(dir, dynamicFile);
      const dynamicDir = dynamicEntry(dir, false);
      if (dynamicDir && isFile(join(dir, dynamicDir, "index.html"))) return join(dir, dynamicDir, "index.html");
      return undefined;
    }
    if (isDirectory(join(dir, segment))) {
      dir = join(dir, segment);
      continue;
    }
    const dynamicDir = dynamicEntry(dir, false);
    if (!dynamicDir) return undefined;
    dir = join(dir, dynamicDir);
  }
  return isFile(join(dir, "index.html")) ? join(dir, "index.html") : undefined;
}

export function resolveWebFile(webRoot: string, pathname: string): WebLookup {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "invalid" };
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return { kind: "invalid" };
  const segments = decoded.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment.startsWith("."))) return { kind: "invalid" };

  const root = resolve(webRoot);
  if (!isDirectory(root)) return { kind: "missing" };
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { kind: "missing" };
  }

  const contained = (path: string | undefined): string | undefined => {
    if (!path || !inside(root, resolve(path))) return undefined;
    try {
      // 符号链接也不能把请求带出 web 根目录。
      return inside(realRoot, realpathSync(path)) ? path : undefined;
    } catch {
      return undefined;
    }
  };

  const found = contained(routeFile(root, segments));
  if (found) return { kind: "file", path: found, status: 200 };
  const notFound = contained(join(root, "+not-found.html"));
  if (notFound && isFile(notFound)) return { kind: "file", path: notFound, status: 404 };
  return { kind: "missing" };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

export function webContentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// 导出时 _expo/static 与 assets 下的文件名都带内容哈希，可以长期缓存；HTML 每次都要重新验证。
function cacheControl(pathname: string): string {
  return pathname.startsWith("/_expo/static/") || pathname.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function plain(res: ServerResponse, status: number, text: string, head: boolean): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(head ? undefined : text);
}

export function serveWebFile(req: IncomingMessage, res: ServerResponse, webRoot: string, pathname: string): void {
  const head = req.method === "HEAD";
  const lookup = resolveWebFile(webRoot, pathname);
  if (lookup.kind === "invalid") {
    plain(res, 400, "invalid path", head);
    return;
  }
  if (lookup.kind === "missing") {
    plain(
      res,
      404,
      existsSync(webRoot)
        ? "not found"
        : "web UI 未构建：在仓库根目录运行 npm run build:web，daemon 无需重启。",
      head,
    );
    return;
  }
  const contentType = webContentType(lookup.path);
  const html = contentType.startsWith("text/html");
  res.writeHead(lookup.status, {
    "content-type": contentType,
    "content-length": String(statSync(lookup.path).size),
    "cache-control": lookup.status === 200 ? cacheControl(pathname) : "no-cache",
    "x-content-type-options": "nosniff",
    // 这个页面能代表用户操作 daemon，不允许被别的站点嵌进 frame。
    ...(html ? {
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
    } : {}),
  });
  if (head) {
    res.end();
    return;
  }
  const stream = createReadStream(lookup.path);
  stream.once("error", () => res.destroy());
  stream.pipe(res);
}
