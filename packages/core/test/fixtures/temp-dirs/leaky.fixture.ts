// 用 mkdtempSync 新建 plc-* 目录，不删除。setup 文件报告它，文件失败。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

it("leaves a plc-* folder behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "plc-temp-dirs-leaky-"));
  writeFileSync(join(process.env.PLC_TEMP_DIRS_FIXTURE_OUT!, "leaky.json"), JSON.stringify({ dir }));
});
