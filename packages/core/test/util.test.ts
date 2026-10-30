import { describe, it, expect } from "vitest";
import { localIso } from "../src/util.js";

describe("localIso", () => {
  it("emits local wall-clock with tz offset (not UTC Z)", () => {
    const s = localIso(new Date("2026-07-21T07:07:45Z"));
    // 格式：YYYY-MM-DDTHH:MM:SS±HH:MM，绝不带 Z（消除 UTC 歧义）
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(s).not.toContain("Z");
    // 往返：本地 ISO 解析回同一时刻
    expect(new Date(s).toISOString()).toBe("2026-07-21T07:07:45.000Z");
  });
});
