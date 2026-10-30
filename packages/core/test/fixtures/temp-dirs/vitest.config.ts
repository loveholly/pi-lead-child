// temp-dirs.test.ts 另起的 vitest 用这个配置。setup 文件就是根 vitest.setup.ts，所以这里的测试文件
// 结束时，经过和根测试一样的检查。这些 fixture 不在根配置的 include 里，平常不运行。
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const ROOT = fileURLToPath(new URL("../../../../..", import.meta.url));

export default defineConfig({
  root: ROOT,
  test: {
    include: ["packages/core/test/fixtures/temp-dirs/*.fixture.ts"],
    setupFiles: ["./vitest.setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    reporters: ["json"],
    outputFile: { json: process.env.PLC_TEMP_DIRS_FIXTURE_REPORT ?? "report.json" },
  },
});
