// daemon 的运维入口（apps/daemon 构建出的 dist/ops.mjs）。安装、卸载、首次启动、doctor 和
// lead 模型配置要用 daemon 这一侧的包，plc 不引用它们，只按 distDir() 运行这个入口，输出原样转给用户。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { distDir, packageSource, projectRoot } from "@pi-lead-child/core";

// 构建产物优先（与 launchd 同一份代码），PLC_DEV=1 或没有构建时回退 tsx 源码。
export function opsCommand(): { bin: string; args: string[] } {
  const dist = join(distDir(), "ops.mjs");
  if (existsSync(dist) && !process.env.PLC_DEV) return { bin: process.execPath, args: [dist] };
  return { bin: join(projectRoot(), "node_modules", ".bin", "tsx"), args: [packageSource("daemon", "ops.ts")] };
}

export type RunOps = (args: string[]) => Promise<number>;

export const runOps: RunOps = (args) => new Promise((resolve, reject) => {
  const { bin, args: entry } = opsCommand();
  const child = spawn(bin, [...entry, ...args], { stdio: "inherit", env: process.env });
  child.once("error", reject);
  child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
