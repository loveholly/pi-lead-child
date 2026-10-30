// config.json 的核对（2026-10-19 审查）：daemon 自己写的（设置页、Lead 换模型）不报；别的进程直接改的报一次，
// 报警里只有变了的配置项的名字，没有值。
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { envConfigPath, writePlcConfig } from "@pi-lead-child/core";
import { changedConfigKeys, createConfigWatch } from "../src/config-watch.js";

describe("the config.json watch", () => {
  it("stays quiet for the daemon's own writes, and reports a direct edit once, by name only", () => {
    const dir = tempDir("plc-config-watch-");
    writePlcConfig({ env: { GH_TOKEN: { value: "ghp_old_value_123456" } }, lead: { models: ["a/b"] } }, dir);
    const changes: string[][] = [];
    const watch = createConfigWatch(envConfigPath(dir), ({ changed }) => changes.push(changed));

    writePlcConfig({ env: { GH_TOKEN: { value: "ghp_old_value_123456" } }, lead: { models: ["a/c"] } }, dir);
    watch.check();
    expect(changes).toEqual([]);

    writeFileSync(envConfigPath(dir), JSON.stringify({
      env: { GH_TOKEN: { value: "ghp_new_value_654321" }, EXTRA: { value: "x" } }, lead: { models: ["a/c"] },
    }));
    watch.check();
    watch.check();
    expect(changes).toEqual([["env.EXTRA", "env.GH_TOKEN"]]);
    expect(JSON.stringify(changes)).not.toContain("ghp_new_value");
  });

  it("names top-level and second-level keys", () => {
    expect(changedConfigKeys({ a: 1, b: { c: 1, d: 2 } }, { a: 1, b: { c: 2, d: 2 }, e: true })).toEqual(["b.c", "e"]);
    expect(changedConfigKeys(null, { a: 1 })).toEqual(["（整个文件）"]);
  });
});
