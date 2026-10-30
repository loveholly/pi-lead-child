// 通道派给子 agent 的工单的契约（landing.md C1、C4）：派单的请求、子 agent 交的结果、交回发起方的结局。
import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  AgentTaskOutcomeSchema, AgentTaskRequestSchema, AgentTaskResultSchema, computeRunGrant,
} from "../src/index.ts";

const PR = { owner: "Acme", repo: "x", number: 101 };

describe("agent task contract", () => {
  it("takes a structured request with the raw message kept apart as untrusted text", () => {
    const request = {
      intent: "code_review", request: { source: "slack", requester: "王小明", summary: "review 这个 PR" },
      untrusted: { message: "帮我看看" }, scope: { pullRequest: PR }, callback: { kind: "channel", ref: "card-3" },
    };
    expect(Value.Check(AgentTaskRequestSchema, request)).toBe(true);
    expect(Value.Check(AgentTaskRequestSchema, { ...request, intent: "merge" })).toBe(false);
    expect(Value.Check(AgentTaskRequestSchema, { ...request, scope: { pullRequest: PR, reviewEvents: ["REQUEST_CHANGES"] } })).toBe(false);
    expect(Value.Check(AgentTaskRequestSchema, { ...request, rawText: "x" })).toBe(false);
  });

  it("accepts file sources and connection sources in a result, and nothing the code fills in", () => {
    const result = {
      found: "yes", answer: "a", checked: [], caveats: [], replyDraft: "r",
      sources: [
        { via: "github", repo: "Acme/x", path: "a.ts", startLine: 1, endLine: 1, quote: "q" },
        { via: "connection", connection: "cdp", tool: "search_audiences", quote: "q" },
      ],
    };
    expect(Value.Check(AgentTaskResultSchema, result)).toBe(true);
    expect(Value.Check(AgentTaskResultSchema, { ...result, actions: [] })).toBe(false);
    expect(Value.Check(AgentTaskResultSchema, { ...result, sources: [{ via: "connection", connection: "cdp", quote: "q" }] })).toBe(false);
  });

  it("describes the outcome handed back to the originator", () => {
    const { grant } = computeRunGrant({ intent: "code_review", scope: { pullRequest: PR }, resolveLocalRepo: () => null });
    expect(Value.Check(AgentTaskOutcomeSchema, {
      runId: 9, itemId: 3, callback: { kind: "channel", ref: "card-3" }, status: "finished",
      result: { found: "yes", answer: "a", sources: [], checked: [], caveats: [], replyDraft: "r" },
      actions: [{ connection: "github", tool: "pull_request_review_write", summary: "s", target: "Acme/x#101", url: null, visible: true, at: "t" }],
      reads: [], error: null, grant,
    })).toBe(true);
  });
});
