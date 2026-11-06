// 直觉的鉴权头（2026-11-06）：头名的校验、缺省、请求带哪个头。
import { describe, expect, it } from "vitest";
import { fastModelAuthHeaderProblem, fastModelAuthHeaders, normalizeFastModelAuthHeader } from "../src/fast-model-auth.ts";

describe("fast model auth header", () => {
  it("treats empty, null and Authorization as the default Bearer header", () => {
    for (const raw of [undefined, null, "", "  ", "Authorization", "AUTHORIZATION"]) {
      expect(normalizeFastModelAuthHeader(raw)).toBeNull();
      expect(fastModelAuthHeaders(raw, "k-1")).toEqual({ Authorization: "Bearer k-1" });
    }
  });

  it("puts the raw key in a custom header and nowhere else", () => {
    expect(normalizeFastModelAuthHeader(" x-gateway-key ")).toBe("x-gateway-key");
    expect(fastModelAuthHeaders("x-gateway-key", "k-1")).toEqual({ "x-gateway-key": "k-1" });
    expect(normalizeFastModelAuthHeader("x_api_key")).toBe("x_api_key");
  });

  it.each([
    ["am api key", "invalid"], ["1-key", "invalid"], ["x".repeat(65), "invalid"], ["key:x", "invalid"],
    ["Content-Type", "reserved"], ["host", "reserved"], ["Cookie", "reserved"], ["Proxy-Authorization", "reserved"],
  ])("refuses %j as %s", (raw, problem) => {
    expect(fastModelAuthHeaderProblem(raw)).toBe(problem);
    expect(normalizeFastModelAuthHeader(raw)).toBeNull();
  });
});
