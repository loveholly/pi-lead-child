// 改连接的权限设置时，会话里的记录只写变了的那一项（2026-10-28 用户：系统信息行太长，换行很难看）。
import { describe, expect, it } from "vitest";

import { describeConnectionSettingsChange } from "../src/index.ts";

describe("describeConnectionSettingsChange", () => {
  it("names only the write policy when only it changed", () => {
    expect(describeConnectionSettingsChange(
      { roles: ["lead", "executor", "reviewer"], writePolicy: "confirm" },
      { roles: ["lead", "executor", "reviewer"], writePolicy: "direct" },
    )).toBe("写入从「先问我」改成「直接执行」");
  });

  it("names only who can use it when only the roles changed", () => {
    expect(describeConnectionSettingsChange(
      { roles: ["lead"], writePolicy: "confirm" },
      { roles: ["lead", "reviewer"], writePolicy: "confirm" },
    )).toBe("可以用的从「Lead」改成「Lead、评审 agent」");
  });

  it("names both when both changed, and nobody when the roles are empty", () => {
    expect(describeConnectionSettingsChange(
      { roles: ["lead"], writePolicy: "direct" },
      { roles: [], writePolicy: "confirm" },
    )).toBe("可以用的从「Lead」改成「谁都不能用」；写入从「直接执行」改成「先问我」");
  });

  it("is null when nothing changed", () => {
    expect(describeConnectionSettingsChange(
      { roles: ["lead"], writePolicy: "direct" }, { roles: ["lead"], writePolicy: "direct" },
    )).toBeNull();
  });
});
