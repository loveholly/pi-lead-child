// 用 tempDir 新建目录，不自己删除。setup 文件在文件结束时删除它，文件通过。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { tempDir } from "../../../testing/temp-dirs.js";

it("makes its folder with tempDir", () => {
  const dir = tempDir("plc-temp-dirs-tidy-");
  writeFileSync(join(dir, "data.txt"), "kept until the file ends\n");
  writeFileSync(join(process.env.PLC_TEMP_DIRS_FIXTURE_OUT!, "tidy.json"), JSON.stringify({ dir }));
});
