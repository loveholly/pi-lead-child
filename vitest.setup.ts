// 根 vitest 配置的 setup 文件：每个测试文件结束时，检查它没有留下垫片、fake CLI 或 fake daemon，也没有留下 plc-* 临时目录。
// 起因：重启接管的测试每次全量运行都留下垫片和 fake CLI，三天里积累了 82 个孤儿进程，测试照样通过。
// 启动真实垫片的几个测试文件自己按测试目录检查每个用例（expectNoTestProcesses），检查失败时停止进程。
// 这里是兜底，覆盖所有测试文件，只报告，不停止进程。
//
// 认法（scriptProcesses）：node 运行的脚本是本 checkout 的垫片或某个 fake 脚本，这个测试文件开始时还不存在，
// 并且在本进程名下或者已经成了孤儿。再加上它们的子孙进程。
// 别的 vitest 或者源码模式的 daemon 正在看管的进程不算。这些进程也可能运行同样的脚本，所以这里不停止任何进程：
// 认错时，最坏的结果是一个测试文件误报失败。
//
// 临时目录：测试用 tempDir（@pi-lead-child/core/testing）新建目录，这里在文件结束时删除。进程检查通过以后才删除：
// 测试启动的进程还在时，它们可能还在用这些目录，所以留下目录，以后的测试文件也不删除它们。
// 然后检查本进程在这个文件里新建的 plc-* 目录（watchTempDirs）都已经删除。没有删除时，这个文件失败。
// 这个检查只报告，不删除目录。2026-10-13 的 TMPDIR 里积累了约 149,000 个 plc-* 目录，共 167 GiB。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll } from "vitest";
import { expectTempDirsRemoved, keepTempDirs, removeTempDirs, watchTempDirs } from "./packages/core/testing/temp-dirs.js";
import { expectProcessesGone, scriptProcesses, type TestProcess } from "./packages/runtime/testing/process-leaks.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const fakes = (dir: string) => readdirSync(join(ROOT, dir))
  .filter((name) => /^fake-.*\.ts$/.test(name))
  .map((name) => join(ROOT, dir, name));
const SCRIPTS = [
  join(ROOT, "packages/runtime/src/launcher-shim.mjs"),
  ...fakes("packages/runtime/testing"),
  ...fakes("apps/daemon/test"),
];

// 测试可能跑在一个 PLC 的 pi 执行器里，那时环境里有 daemon 设置的 PLC_SOL_PI_ENTRY。
// 测试里起的 Lead 和 pi 会话不能加载真实的 SoL-Pi，所以清掉它。需要它的测试（engine 的 sol-pi.test.ts）自己设置。
delete process.env.PLC_SOL_PI_ENTRY;
// 同理，用户在设置里停用的 runtime（PLC_DISABLED_RUNTIMES）会被 plc 的执行器继承。测试不能跟着用户的开关变：
// 设了 codex 以后，runtime-disabled.test.ts 有两条失败（2026-10-19 发布评审）。要它的测试自己用 vi.stubEnv 设置。
delete process.env.PLC_DISABLED_RUNTIMES;

const key = (target: TestProcess) => `${target.pid} ${target.command}`;
let existing = new Set<string>();

// 测试文件在收集阶段（模块顶层）就可能新建目录，那时 beforeAll 还没有运行，所以在这里就开始记录。
const tempDirs = watchTempDirs();

beforeAll(() => {
  existing = new Set(scriptProcesses(SCRIPTS).map(key));
});

afterAll(async () => {
  const failures: string[] = [];
  try {
    await expectProcessesGone(
      () => scriptProcesses(SCRIPTS).filter((target) => !existing.has(key(target))),
      { owner: "this test file", kill: false },
    );
  } catch (error) {
    failures.push((error as Error).message);
  }
  const kept = failures.length ? keepTempDirs() : [];
  if (!failures.length) removeTempDirs();
  try {
    expectTempDirsRemoved(tempDirs, { owner: "this test file", kept });
  } catch (error) {
    failures.push((error as Error).message);
  } finally {
    tempDirs.stop();
  }
  if (failures.length) throw new Error(failures.join("\n\n"));
});
