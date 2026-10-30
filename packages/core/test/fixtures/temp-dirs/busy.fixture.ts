// 启动一个 fake CLI，不停止它。setup 文件的进程检查失败，tempDir 新建的目录不删除，因为进程可能还在用它。
// fake-pi 读 stdin，stdin 开着时不退出。测试进程退出后 stdin 关闭，fake-pi 跟着退出。
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { tempDir } from "../../../testing/temp-dirs.js";

const ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));
const FAKE_PI = join(ROOT, "packages/runtime/testing/fake-pi.ts");

it("starts a fake CLI and does not stop it", () => {
  const dir = tempDir("plc-temp-dirs-busy-");
  const child = spawn(process.execPath, ["--import", "tsx", FAKE_PI, "--mode", "rpc", "--session-dir", dir], {
    cwd: ROOT, stdio: ["pipe", "ignore", "ignore"],
  });
  writeFileSync(join(process.env.PLC_TEMP_DIRS_FIXTURE_OUT!, "busy.json"), JSON.stringify({ dir, pid: child.pid }));
});
