// 决策边界（工单 07，spec D3）：成果规范化对输入宽松，对输出严格。
// 已知近义值做映射，未知枚举值降级，每一处改动都记一条诊断。
import { describe, expect, it } from "vitest";
import { normalizeOutcomePayload } from "../src/outcomes.js";

function validation(outcome: unknown, command = "npm test") {
  return { command, outcome, exitCode: 0, summary: "ran", evidenceRef: null };
}

function envelope(validations: unknown[]) {
  return {
    summary: "Implemented the change",
    changes: [{ kind: "file", ref: "src/a.ts", summary: "Changed" }],
    deliverables: [{ kind: "path", ref: "src/a.ts", label: "Source" }],
    validations,
  };
}

describe("outcome normalization", () => {
  it("maps skipped, pass and fail and records one diagnostic for each", () => {
    const outcome = normalizeOutcomePayload(envelope([
      validation("skipped", "npm run e2e"),
      validation("pass", "npm test"),
      validation("fail", "npm run lint"),
    ]));

    expect(outcome.validations.map((entry) => entry.outcome)).toEqual(["not_run", "passed", "failed"]);
    expect(outcome.missingFields).toEqual([]);
    expect(outcome.diagnostics).toEqual([
      { field: "outcome.validations[0].outcome", code: "synonym_mapped", received: "skipped", normalized: "not_run", reason: null },
      { field: "outcome.validations[1].outcome", code: "synonym_mapped", received: "pass", normalized: "passed", reason: null },
      { field: "outcome.validations[2].outcome", code: "synonym_mapped", received: "fail", normalized: "failed", reason: null },
    ]);
    expect(outcome.completeness).toBe("complete");
  });

  it("degrades an unknown validation outcome to not_run with a diagnostic", () => {
    const outcome = normalizeOutcomePayload(envelope([validation("success"), validation(7)]));

    expect(outcome.validations.map((entry) => entry.outcome)).toEqual(["not_run", "not_run"]);
    expect(outcome.diagnostics).toEqual([
      { field: "outcome.validations[0].outcome", code: "unknown_value", received: "success", normalized: "not_run", reason: null },
      { field: "outcome.validations[1].outcome", code: "unknown_value", received: "7", normalized: "not_run", reason: null },
    ]);
  });

  it("adds no diagnostics to an envelope that needs no normalization", () => {
    const outcome = normalizeOutcomePayload(envelope([validation("passed"), validation("not_run")]));

    // 规范的输入得到和以前完全相同的对象：ticket_update 的请求指纹因此保持不变。
    expect(outcome).not.toHaveProperty("diagnostics");
    expect(outcome.validations.map((entry) => entry.outcome)).toEqual(["passed", "not_run"]);
  });

  it("drops or clears only the broken field and keeps the rest of the envelope", () => {
    const outcome = normalizeOutcomePayload({
      summary: "Implemented the change",
      notes: "free text the schema does not know",
      changes: [
        { kind: "file", ref: "src/a.ts", summary: "Changed", lines: 12 },
        { kind: "file", ref: "../../outside.ts", summary: "Escapes" },
        { kind: "folder", ref: "docs/", summary: "New docs" },
        { kind: "commit", ref: "abc123", summary: "token=abcdef1234567890" },
      ],
      deliverables: [
        { kind: "url", ref: "not a url", label: "Broken link" },
        { kind: "path", ref: "src/a.ts", label: "Source" },
      ],
      validations: [
        { command: "npm test", outcome: "passed", exitCode: -1, summary: "ran", evidenceRef: null },
        { outcome: "passed", summary: "no command" },
      ],
    }, { workdir: "/work/item" });

    expect(outcome).toMatchObject({
      summary: "Implemented the change",
      changes: [
        { kind: "file", ref: "src/a.ts", summary: "Changed" },
        { kind: "other", ref: "docs/", summary: "New docs" },
        { kind: "commit", ref: "abc123", summary: null },
      ],
      deliverables: [{ kind: "path", ref: "src/a.ts", label: "Source" }],
      validations: [{ command: "npm test", outcome: "passed", exitCode: null, summary: "ran", evidenceRef: null }],
      // 对输出严格：列表丢了记录，这个字段就不完整，成果因此是 partial。置空可选字段和映射枚举值不算丢记录。
      completeness: "partial",
      missingFields: ["changes", "deliverables", "validations"],
    });
    expect(outcome.diagnostics).toEqual([
      { field: "outcome", code: "unknown_field", received: "notes", normalized: null, reason: null },
      { field: "outcome.changes[0]", code: "unknown_field", received: "lines", normalized: null, reason: null },
      {
        field: "outcome.changes[1]", code: "invalid_entry", received: null, normalized: null,
        reason: "outcome.changes[1].ref must not contain empty, '.', or '..' segments",
      },
      { field: "outcome.changes[2].kind", code: "unknown_value", received: "folder", normalized: "other", reason: null },
      {
        field: "outcome.changes[3].summary", code: "invalid_field", received: null, normalized: null,
        reason: "outcome.changes[3].summary appears to contain secret-bearing data",
      },
      {
        field: "outcome.deliverables[0]", code: "invalid_entry", received: null, normalized: null,
        reason: "outcome.deliverables[0].ref must be a valid URL",
      },
      {
        field: "outcome.validations[0].exitCode", code: "invalid_field", received: null, normalized: null,
        reason: "outcome.validations[0].exitCode must be a non-negative integer or null",
      },
      {
        field: "outcome.validations[1]", code: "invalid_entry", received: null, normalized: null,
        reason: "outcome.validations[1].command must be a non-empty string",
      },
    ]);
    expect(JSON.stringify(outcome)).not.toContain("abcdef1234567890");
  });

  it("registers an unusable list as empty and keeps at most 50 entries", () => {
    const outcome = normalizeOutcomePayload({
      summary: "Implemented the change",
      changes: "see the commit",
      deliverables: Array.from({ length: 52 }, (_, index) => ({ kind: "other", ref: `r${index}`, label: `L${index}` })),
      validations: [],
    });

    expect(outcome.changes).toEqual([]);
    expect(outcome.deliverables).toHaveLength(50);
    expect(outcome).toMatchObject({ completeness: "partial", missingFields: ["changes", "deliverables"] });
    expect(outcome.diagnostics).toEqual([
      {
        field: "outcome.changes", code: "invalid_field", received: "see the commit", normalized: null,
        reason: "outcome.changes must be an array",
      },
      {
        field: "outcome.deliverables", code: "too_many_entries", received: "52", normalized: "50",
        reason: "outcome.deliverables may contain at most 50 entries",
      },
    ]);
  });

  it("still refuses an envelope without a usable summary", () => {
    expect(() => normalizeOutcomePayload({ ...envelope([]), summary: "  " }, { allowPartial: true }))
      .toThrow("outcome.summary must be a non-empty string");
    expect(() => normalizeOutcomePayload({ changes: [] }, { allowPartial: true }))
      .toThrow("outcome.summary is required");
    expect(() => normalizeOutcomePayload(["not", "an", "object"])).toThrow("outcome must be an object");
  });

  it("never echoes a secret-bearing value into a diagnostic", () => {
    const outcome = normalizeOutcomePayload(envelope([validation("api_key=sk_live_abcdefghijklmnop")]));

    expect(outcome.validations[0]?.outcome).toBe("not_run");
    expect(outcome.diagnostics).toEqual([
      expect.objectContaining({ code: "unknown_value", received: "[redacted]" }),
    ]);
  });

  // 对象和数组的内容不进诊断，只记类型和大小：JSON 形式的凭据（"password":"…"）不一定能被识别出来。
  it("records only the type of a structured value", () => {
    const outcome = normalizeOutcomePayload({
      summary: "Implemented the change",
      changes: { password: "hunter2hunter2" },
      deliverables: [],
      validations: [validation({ token: "abcdef1234567890" }), validation(["pass", "fail"])],
    });

    expect(outcome.diagnostics?.map((diagnostic) => diagnostic.received)).toEqual(["object", "object", "array(2)"]);
    expect(JSON.stringify(outcome)).not.toMatch(/hunter2|abcdef1234567890/);
  });
});
