// daemon 构建的 external：esbuild 不把它们打进 .mjs，运行时从 node_modules 加载。
// build.ts 用它；桌面版的打包脚本（scripts/desktop/pack-runtime.ts）按同一份列表往运行包里放 node_modules。
export const DAEMON_EXTERNALS = [
  "better-sqlite3",
  // pi SDK 打包失败（transitive @mistralai/mistralai 引用未安装的 optional @opentelemetry/api），
  // 按 spec §B1 决策规则加入 external，运行时靠仓库 node_modules 解析。
  "@earendil-works/pi-coding-agent",
  // pi-ai, which pi-coding-agent depends on. Lead imports it directly (compaction-chunks.ts, model-config.ts): bundled, it
  // would be a second copy with its own provider registry, next to the one pi-coding-agent uses.
  "@earendil-works/pi-ai",
  // 沙箱（lead-tools-and-routing spec D2）：它按自己的安装位置找辅助文件（Windows 的 srt-win、代理的入口），打进包里会找错位置。
  // 运行时靠仓库 node_modules 解析；pi 子进程加载的扩展（engine 的 extension/sandbox.ts）也是这样找到它的。
  "@anthropic-ai/sandbox-runtime",
] as const;
