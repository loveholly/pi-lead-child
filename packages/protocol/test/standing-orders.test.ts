// 常设指令的条件匹配和校验（Lead 事件主干 spec D4，工单 05）。
import { describe, expect, it } from "vitest";

import {
  capTriageLevel, matchesStandingOrderCondition, triageLevelRank, validateStandingOrderDefinition,
  type StandingOrderCondition, type StandingOrderDefinition,
} from "../src/index.ts";

const event = {
  source: "system", kind: "inbox.blocker", entityKey: "ticket:7",
  payload: { severity: "blocker", wakeLead: true, payload: { authorityType: "approval" } },
  rootCause: { code: "auth_required", scope: "account" },
};

const order: StandingOrderDefinition = {
  id: "inbox.example", title: "例子", priority: 10, condition: { kinds: ["inbox.*"] },
  action: { type: "level", level: "digest" }, limits: null, escalateTo: "tell", reason: "测试",
};

describe("matching a standing order's condition", () => {
  it("matches kinds by name or by prefix, and sources by name", () => {
    expect(matchesStandingOrderCondition({ kinds: ["inbox.blocker"] }, event)).toBe(true);
    expect(matchesStandingOrderCondition({ kinds: ["inbox.*"] }, event)).toBe(true);
    expect(matchesStandingOrderCondition({ kinds: ["run.*", "inbox.attention"] }, event)).toBe(false);
    expect(matchesStandingOrderCondition({ sources: ["system"] }, event)).toBe(true);
    expect(matchesStandingOrderCondition({ sources: ["slack"] }, event)).toBe(false);
    expect(matchesStandingOrderCondition({}, event)).toBe(true);
  });

  it("tests fields by dotted path: equal, in, notIn, not, exists", () => {
    const fields = (tests: Record<string, unknown>) => matchesStandingOrderCondition({ fields: tests as never }, event);
    expect(fields({ "payload.wakeLead": true })).toBe(true);
    expect(fields({ "payload.wakeLead": "true" })).toBe(false);
    expect(fields({ "rootCause.scope": { in: ["attempt", "account"] } })).toBe(true);
    expect(fields({ "rootCause.scope": { notIn: ["account"] } })).toBe(false);
    expect(fields({ "payload.payload.wakeLead": { not: false } })).toBe(true);
    expect(fields({ "payload.payload.authorityType": { exists: true } })).toBe(true);
    expect(fields({ "payload.missing.deeper": { exists: false } })).toBe(true);
    expect(fields({ "payload.missing": null })).toBe(false);
  });

  it("needs its own tests and one branch of anyOf", () => {
    const condition: StandingOrderCondition = {
      kinds: ["inbox.*"],
      anyOf: [{ fields: { "rootCause.scope": "task" } }, { fields: { "payload.severity": "blocker" } }],
    };
    expect(matchesStandingOrderCondition(condition, event)).toBe(true);
    expect(matchesStandingOrderCondition({ ...condition, kinds: ["run.*"] }, event)).toBe(false);
    expect(matchesStandingOrderCondition({ anyOf: [{ fields: { "rootCause.scope": "task" } }] }, event)).toBe(false);
  });
});

describe("validating a standing order", () => {
  it("accepts a well-formed order", () => {
    expect(validateStandingOrderDefinition(order)).toEqual([]);
  });

  it("rejects a level order without kinds or sources, a conversation level, and an escalation that is not higher", () => {
    expect(validateStandingOrderDefinition({ ...order, condition: {} })).toEqual(["定级别的指令要写 kinds 或 sources"]);
    expect(validateStandingOrderDefinition({ ...order, action: { type: "level", level: "conversation" as never } })[0])
      .toMatch(/动作/);
    expect(validateStandingOrderDefinition({ ...order, escalateTo: "digest" })).toEqual(["escalateTo digest 要比级别 digest 高"]);
  });

  it("only allows rules from the whitelist, with parameters that fit the rule", () => {
    expect(validateStandingOrderDefinition({ ...order, action: { type: "rule", rule: "shell.run" as never, params: {} } })[0])
      .toMatch(/白名单/);
    expect(validateStandingOrderDefinition({
      ...order, condition: {}, escalateTo: null, action: { type: "rule", rule: "events.digest_batch", params: { maxWaitMs: 1, onUserReturn: true } },
    })).toEqual([]);
    expect(validateStandingOrderDefinition({
      ...order, condition: {}, escalateTo: null, action: { type: "rule", rule: "events.digest_batch", params: { maxWaitMs: 0 } },
    })).toEqual(["规则 events.digest_batch 的参数不符合 schema"]);
  });
});

describe("level ranks", () => {
  it("orders record < digest < auto < tell < interrupt and caps a level", () => {
    expect(["record", "digest", "auto", "tell", "interrupt"].map((level) => triageLevelRank(level as never))).toEqual([0, 1, 2, 3, 4]);
    expect(triageLevelRank("conversation")).toBe(-1);
    expect(capTriageLevel("interrupt", "tell")).toBe("tell");
    expect(capTriageLevel("digest", "tell")).toBe("digest");
  });
});
