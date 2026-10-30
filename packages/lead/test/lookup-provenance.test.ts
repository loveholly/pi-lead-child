// 出处核实（slack-takeover spec D5）：纯函数，单独测试。
import { describe, expect, it } from "vitest";
import type { LookupResult, LookupScope } from "@pi-lead-child/protocol";
import { parseUnifiedDiff, verifyLookupResult, type LookupReadContent } from "../src/lookup/index.js";

const scope: LookupScope = {
  local: [{ repo: "acme/widgets", root: "/repos/widgets" }],
  github: [{ owner: "acme", repo: "service" }],
  pullRequest: { owner: "acme", repo: "service", number: 7 },
};

const reads: LookupReadContent = {
  files: [
    { via: "local", repo: "acme/widgets", path: "src/retry.ts", ref: "f".repeat(40), lines: {
      10: "export function retryDelay(attempt: number): number {",
      11: "  return Math.min(30_000 * 2 ** attempt,   600_000);",
      12: "}",
    } },
    { via: "github", repo: "acme/service", path: "lib/limits.ts", lines: { 3: "export const MAX = 40;" } },
  ],
  diffLines: [
    { repo: "acme/service", path: "lib/limits.ts", side: "RIGHT", line: 3 },
    { repo: "acme/service", path: "lib/limits.ts", side: "LEFT", line: 3 },
  ],
};

function result(overrides: Partial<LookupResult> = {}): LookupResult {
  return {
    found: "yes", answer: "退避从 30 秒开始，每次翻倍，最多 10 分钟。", checked: ["acme/widgets src/"], caveats: [], replyDraft: "30s doubling, capped at 10 min.",
    sources: [{
      via: "local", repo: "acme/widgets", path: "./src/retry.ts", startLine: 10, endLine: 11,
      quote: "return Math.min(30_000 * 2 ** attempt, 600_000);",
    }],
    ...overrides,
  };
}

describe("verifyLookupResult", () => {
  it("verifies a quote that appears in the read lines it cites, ignoring extra whitespace, and fills the ref", () => {
    const checked = verifyLookupResult({ result: result(), scope, reads });
    expect(checked.sources.map((source) => source.verified)).toEqual([true]);
    expect(checked.result.sources[0]).toMatchObject({ verified: true, ref: "f".repeat(40) });
    expect(checked.result.caveats).toEqual([]);
  });

  it("fails sources outside the scope, files never read, lines not read and quotes that do not match", () => {
    const base = result().sources[0]!;
    const checked = verifyLookupResult({
      scope, reads,
      result: result({
        sources: [
          { ...base, repo: "acme/secret-repo" },
          { ...base, path: "src/other.ts" },
          { ...base, startLine: 9, endLine: 11 },
          { ...base, quote: "return 42;" },
          { ...base, via: "github", repo: "acme/widgets" },
          { via: "github", repo: "acme/service", path: "lib/limits.ts", startLine: 3, endLine: 3, quote: "MAX = 40" },
        ],
      }),
    });
    expect(checked.sources.map((source) => [source.verified, source.reason])).toEqual([
      [false, "仓库不在这次代查的作用域里"],
      [false, "这次代查没有读过这个文件"],
      [false, "第 9 行没有读过"],
      [false, "引用的原文和读到的这几行对不上"],
      [false, "仓库不在这次代查的作用域里"],
      [true, null],
    ]);
    expect(checked.result.sources.map((source) => source.verified)).toEqual([false, false, false, false, false, true]);
    expect(checked.result.caveats).toHaveLength(5);
    expect(checked.result.caveats[0]).toContain("出处没有通过核实");
  });

  it("keeps the agent's caveats and caps the total at the contract's limit", () => {
    const base = result().sources[0]!;
    const own = Array.from({ length: 10 }, (_, index) => `自己的说明 ${index}`);
    const checked = verifyLookupResult({
      scope, reads,
      result: result({ caveats: own, sources: [{ ...base, quote: "not in the file" }, { ...base, quote: "made up" }] }),
    });
    expect(checked.result.caveats).toHaveLength(10);
    expect(checked.result.caveats.slice(0, 9)).toEqual(own.slice(0, 9));
    expect(checked.result.caveats[9]).toBe("另有 2 处出处或评论没有通过核实");
  });

  it("drops review comments on lines outside the read diff and says so", () => {
    const checked = verifyLookupResult({
      scope, reads,
      result: result({
        review: {
          summary: "小改动。",
          comments: [
            { path: "lib/limits.ts", line: 3, side: "RIGHT", body: "40 是从哪里来的？" },
            { path: "lib/limits.ts", line: 99, side: "RIGHT", body: "编造的行" },
            { path: "lib/other.ts", line: 3, side: "RIGHT", body: "不在 diff 里的文件" },
          ],
        },
      }),
    });
    expect(checked.result.review?.comments.map((comment) => comment.line)).toEqual([3]);
    expect(checked.comments.map((comment) => comment.kept)).toEqual([true, false, false]);
    expect(checked.result.caveats.filter((caveat) => caveat.startsWith("评论已去掉"))).toHaveLength(2);
  });
});

describe("parseUnifiedDiff", () => {
  it("numbers both sides and does not take removed lines that look like file headers for headers", () => {
    const diff = [
      "diff --git a/lib/limits.ts b/lib/limits.ts",
      "index 1..2 100644",
      "--- a/lib/limits.ts",
      "+++ b/lib/limits.ts",
      "@@ -1,4 +1,3 @@",
      " // limits",
      "--- old banner",
      "+++ new banner",
      " export const MIN = 1;",
      "-export const MAX = 30;",
      "\\ No newline at end of file",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -10 +10,2 @@",
      " text",
      "+more",
      "",
    ].join("\n");
    const lines = parseUnifiedDiff(diff);
    const at = (path: string, side: string) => lines.filter((line) => line.path === path && line.side === side)
      .map((line) => `${line.line}:${line.text}`);
    expect(at("lib/limits.ts", "LEFT")).toEqual(["1:// limits", "2:-- old banner", "3:export const MIN = 1;", "4:export const MAX = 30;"]);
    expect(at("lib/limits.ts", "RIGHT")).toEqual(["1:// limits", "2:++ new banner", "3:export const MIN = 1;"]);
    expect(at("README.md", "RIGHT")).toEqual(["10:text", "11:more"]);
  });
});
