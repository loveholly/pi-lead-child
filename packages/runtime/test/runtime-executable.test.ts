import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  findRuntimeExecutable,
  runtimeBinDirectories,
  runtimeSearchPath,
} from "../src/executable.js";

describe("runtime executable discovery", () => {
  it("resolves executables from an explicit PATH even when launchd supplies a minimal environment", () => {
    const dir = tempDir("plc-runtime-bin-");
    const executable = join(dir, "codex");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);

    expect(findRuntimeExecutable("codex", dir)).toBe(executable);
  });

  it("adds package, user-local, Homebrew and Node directories to the daemon PATH", () => {
    const dirs = runtimeBinDirectories("/usr/bin:/bin");
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/usr/local/bin");
    expect(dirs).toContain(join(process.env.HOME!, ".local", "bin"));
    expect(runtimeSearchPath("/usr/bin:/bin").split(delimiter)).toEqual(dirs);
  });
});

