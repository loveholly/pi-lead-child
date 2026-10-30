import { describe, it, expect, beforeEach } from "vitest";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../testing/index.js";
import {
  dataDir,
  ARTIFACT_ORPHAN_GRACE_MS_DEFAULT,
  loadArtifactStorageConfig,
  loadEnvConfig,
} from "../src/config.js";

let dir: string;
beforeEach(() => { dir = tempDir("plc-"); });

describe("loadEnvConfig", () => {
  it("config value 优先于已有环境变量", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { AM_API_KEY: { value: "from-config" } } }));
    const env: Record<string, string | undefined> = { AM_API_KEY: "from-env" };
    expect(loadEnvConfig(dir, env)).toEqual(["AM_API_KEY"]);
    expect(env.AM_API_KEY).toBe("from-config");
  });

  it("fromEnv 从指定环境变量间接取值", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { TAVILY_API_KEY: { fromEnv: "MY_TAVILY" } } }));
    const env: Record<string, string | undefined> = { MY_TAVILY: "indirect" };
    loadEnvConfig(dir, env);
    expect(env.TAVILY_API_KEY).toBe("indirect");
  });

  it("config 未覆盖的 key 回退环境变量原值；fromEnv 源缺失不清空已有值", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { A: { fromEnv: "MISSING" } } }));
    const env: Record<string, string | undefined> = { A: "keep", B: "untouched" };
    expect(loadEnvConfig(dir, env)).toEqual([]);
    expect(env.A).toBe("keep");
    expect(env.B).toBe("untouched");
  });

  it("无 config.json 静默返回空", () => {
    expect(loadEnvConfig(dir, {})).toEqual([]);
  });

  it("config.json 损坏时抛出带路径的错误", () => {
    writeFileSync(join(dir, "config.json"), "{broken");
    expect(() => loadEnvConfig(dir, {})).toThrow(/config\.json/);
  });

  it("config.json 顶层不是对象（如 null）时抛出友好错误", () => {
    writeFileSync(join(dir, "config.json"), "null");
    expect(() => loadEnvConfig(dir, {})).toThrow(/顶层必须是对象/);
  });
});

describe("artifact storage environment", () => {
  it("defaults orphan cleanup grace to one day and accepts a positive safe integer override", () => {
    expect(ARTIFACT_ORPHAN_GRACE_MS_DEFAULT).toBe(86_400_000);
    expect(loadArtifactStorageConfig({})).toEqual({ orphanGraceMs: 86_400_000 });
    expect(loadArtifactStorageConfig({ PLC_ARTIFACT_ORPHAN_GRACE_MS: "12345" }))
      .toEqual({ orphanGraceMs: 12_345 });
  });

  it.each(["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992", ""])(
    "rejects invalid PLC_ARTIFACT_ORPHAN_GRACE_MS=%s",
    (value) => {
      expect(() => loadArtifactStorageConfig({ PLC_ARTIFACT_ORPHAN_GRACE_MS: value }))
        .toThrow(/PLC_ARTIFACT_ORPHAN_GRACE_MS.*positive integer/i);
    },
  );
});

describe("dataDir", () => {
  it("creates a missing data directory that only this user can enter", () => {
    const dir = join(tempDir("plc-data-"), "nested", "data");
    const previous = process.env.PLC_DATA_DIR;
    process.env.PLC_DATA_DIR = dir;
    try {
      expect(dataDir()).toBe(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    } finally {
      if (previous === undefined) delete process.env.PLC_DATA_DIR;
      else process.env.PLC_DATA_DIR = previous;
    }
  });
});
