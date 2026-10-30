// 用电脑上的默认程序打开一个文件（工单 07，spec 5.4、D7）。网页从 http://localhost 打开，浏览器拦住 file:// 链接，
// 所以由 daemon 在这台 Mac 上执行 open <绝对路径>。哪个文件能打开、打开哪一份，由 delivery-open.ts 决定；这里只管怎么打开。
//
// - execFile('/usr/bin/open', ['--', 绝对路径])，不经过 shell：路径里的 $()、;、空格都只是文件名的一部分。
//   `--` 以后的参数 open 不当成选项；路径又必须以 / 开头，不会被当成 URL。
// - 用绝对路径 /usr/bin/open，不按 PATH 找（审查 M5）。环境变量只给 PATH=/usr/bin:/bin 和 HOME、LANG、USER、TMPDIR，
//   不继承 daemon 的环境：里面有 Slack 令牌、OAuth 的 client secret（DAEMON_ONLY_ENV_NAMES），open 和它拉起的程序都不该拿到（审查 L1）。
// - 只有 macOS 有 open。别的系统 supported=false，操作层说「这台电脑不支持」，这里也不执行任何命令。
// - daemon 注入 daemonFileOpener()（TicketActionHost.openFile）。测试注入假的 opener，不真的打开文件。
import { posix } from "node:path";
import { execFileAsync } from "./delivery-source.js";

// default：这种文件的默认程序。text_editor：默认的文本编辑器（open -t）。
export type FileOpenApp = "default" | "text_editor";

export interface FileOpener {
  // 这台电脑能不能用默认程序打开文件。
  readonly supported: boolean;
  // absolutePath 是 realpath 以后的绝对路径。打开失败时抛错；错误里可能有路径，调用方不能把它转给客户端。
  open(absolutePath: string, app: FileOpenApp): Promise<void>;
}

export const FILE_OPEN_TIMEOUT_MS = 15_000;
export const OPEN_COMMAND = "/usr/bin/open";

// open 只拿到这几个环境变量。PATH 固定，不用 daemon 的。
const OPEN_ENV_NAMES = ["HOME", "LANG", "USER", "TMPDIR"] as const;

type ExecFile = (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => Promise<unknown>;

function openEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
  for (const name of OPEN_ENV_NAMES) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  return env;
}

export function systemFileOpener(
  options: { platform?: NodeJS.Platform; execFile?: ExecFile; env?: NodeJS.ProcessEnv } = {},
): FileOpener {
  const platform = options.platform ?? process.platform;
  const run: ExecFile = options.execFile ?? ((file, args, execOptions) => execFileAsync(file, args, execOptions));
  return {
    supported: platform === "darwin",
    async open(absolutePath, app) {
      if (platform !== "darwin") throw new Error("only macOS can open files with the default program");
      if (!absolutePath.startsWith("/") || !posix.isAbsolute(absolutePath)) throw new Error("open needs an absolute path");
      await run(OPEN_COMMAND, [...(app === "text_editor" ? ["-t"] : []), "--", absolutePath], {
        timeout: FILE_OPEN_TIMEOUT_MS,
        env: openEnvironment(options.env ?? process.env),
      });
    },
  };
}

// 测试起的 daemon 不真的打开文件（审查 L3）。根 vitest 配置设置 PLC_OPEN_FILES=off：它是环境变量，子进程里的 daemon 也收到，
// 和 PLC_DESKTOP_NOTIFY=off 一样。这时缺省的 opener 一律拒绝，不执行任何命令。
const REFUSING_FILE_OPENER: FileOpener = {
  supported: true,
  async open() { throw new Error("opening files is turned off (PLC_OPEN_FILES=off)"); },
};

/** daemon 缺省用的 opener：PLC_OPEN_FILES=off 时一律拒绝，否则是 systemFileOpener。 */
export function daemonFileOpener(env: NodeJS.ProcessEnv = process.env): FileOpener {
  return env.PLC_OPEN_FILES === "off" ? REFUSING_FILE_OPENER : systemFileOpener();
}

// 用默认程序打开的类型（审查 M2）。交付里的文件是 agent 写的，「打开」不能变成「运行」。macOS 的 open 会运行一些文件，
// 而不是打开给你看：有执行权限的文件在终端里运行，.command 在终端里执行，.py 可能交给 Python Launcher，.webloc 打开任意地址，
// .pkg 弹出安装……这样的类型列不全，所以反过来只列已知安全的：文档、图片、音视频、常见的源码和配置。
// 名单以外的一律用文本编辑器打开。网页（html、htm、xhtml）和 svg 不在名单里：浏览器会运行 agent 写的脚本。
// .py、.sh 这类脚本也不在名单里。老的 Office 格式（doc、xls、ppt）和 OpenDocument 能带宏，也不在名单里。
// 只按扩展名判断，不看内容。
export const DEFAULT_PROGRAM_EXTENSIONS: ReadonlySet<string> = new Set([
  // 文档和数据
  "md", "markdown", "txt", "text", "rtf", "log", "csv", "tsv", "pdf", "docx", "xlsx", "pptx", "pages", "numbers",
  // 图片（不含 svg）
  "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "ico",
  // 音频和视频
  "mp3", "m4a", "wav", "aac", "flac", "aiff", "mp4", "m4v", "mov", "webm",
  // 配置
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf",
  // 源码（不含 py、sh 这类会被直接运行的脚本）
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "rs", "java", "kt", "kts", "swift", "rb",
  "c", "h", "cc", "cpp", "hpp", "m", "mm", "cs", "scala", "dart", "lua", "sql", "graphql", "proto", "gradle",
  "css", "scss", "sass", "less", "vue", "svelte",
]);

/** 用什么程序打开这个文件。mode 是 stat 的 mode：有任何一位执行权限的文件，open 会在终端里运行它。 */
export function opensWith(path: string, mode: number): FileOpenApp {
  if ((mode & 0o111) !== 0) return "text_editor";
  const name = posix.basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 && DEFAULT_PROGRAM_EXTENSIONS.has(name.slice(dot + 1)) ? "default" : "text_editor";
}
