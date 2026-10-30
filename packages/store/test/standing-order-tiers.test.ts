// 常设指令修改的三档（工单 10，spec D4）：classifyStandingOrderChange 是纯函数，这里用代码里的种子当作「现在生效的指令」，
// 每类修改各有用例：更保守、更放开、硬性规则拒绝，以及无法判断时按更放开。
import { describe, expect, it } from "vitest";
import {
  classifyStandingOrderChange, conditionImplies, conditionsMayOverlap, fieldTestImplies,
  type StandingOrderCondition, type StandingOrderState,
} from "@pi-lead-child/protocol";
import { SYSTEM_STANDING_ORDERS } from "../src/index.js";

const seeds: StandingOrderState[] = SYSTEM_STANDING_ORDERS.map(({ seedRevision: _revision, status, ...definition }) =>
  ({ ...definition, status: status ?? "active" }));
const seed = (id: string): StandingOrderState => {
  const found = seeds.find((order) => order.id === id);
  if (!found) throw new Error(id);
  return structuredClone(found);
};

function classify(after: StandingOrderState, options: { before?: StandingOrderState | null; active?: StandingOrderState[] } = {}) {
  const before = options.before !== undefined ? options.before : seeds.find((order) => order.id === after.id) ?? null;
  return classifyStandingOrderChange({ active: options.active ?? seeds, before, after: { ...after, reason: "测试" } });
}
const tierOf = (after: StandingOrderState, options?: Parameters<typeof classify>[1]) => classify(after, options).tier;

const withLevel = (order: StandingOrderState, level: string): StandingOrderState => ({
  ...order,
  action: order.action.type === "level" ? { type: "level", level: level as never } : { ...order.action, level: level as never },
});

const withParams = (id: string, params: Record<string, unknown>): StandingOrderState => {
  const order = seed(id);
  if (order.action.type !== "rule") throw new Error(id);
  return { ...order, action: { ...order.action, params: { ...order.action.params, ...params } } };
};

const newLevelOrder = (id: string, condition: StandingOrderCondition, level: string, priority = 90): StandingOrderState => ({
  id, title: `新指令 ${id}`, priority, condition, action: { type: "level", level: level as never }, limits: null, escalateTo: null,
  reason: "测试", status: "active",
});

describe("level orders: the level itself", () => {
  it("is conservative when the level goes up, and permissive when it goes down", () => {
    expect(tierOf(withLevel(seed("inbox.no_wake"), "tell"))).toBe("conservative");
    expect(tierOf(withLevel(seed("inbox.no_wake"), "record"))).toBe("permissive");
    expect(tierOf(withLevel(seed("notification.immediate"), "digest"))).toBe("permissive");
  });

  it("treats a new automatic action as permissive and removing one as conservative", () => {
    // digest → auto：交给人的一样多，自动做的更多。
    expect(tierOf(withLevel(seed("inbox.no_wake"), "auto"))).toBe("permissive");
    const auto = newLevelOrder("run.finished_auto", { kinds: ["run.finished"] }, "auto");
    const active = [...seeds, auto];
    expect(tierOf({ ...auto, action: { type: "level", level: "digest" } }, { before: auto, active })).toBe("conservative");
    expect(tierOf({ ...auto, action: { type: "level", level: "tell" } }, { before: auto, active })).toBe("conservative");
    // auto → record：去掉了自动动作，但是交给人的也更少。
    expect(tierOf({ ...auto, action: { type: "level", level: "record" } }, { before: auto, active })).toBe("permissive");
  });

  it("compares where an event ends up after the deadline too", () => {
    // 到时限升到 auto：自动做的更多。
    expect(tierOf({ ...seed("inbox.no_wake"), escalateTo: "auto" })).toBe("permissive");
    // 不写 escalateTo 时按 ladder（digest → tell），结果不变。
    const same = classify({ ...seed("inbox.no_wake"), escalateTo: null });
    expect(same.tier).toBe("conservative");
    expect(same.findings[0]!.detail).toContain("和以前一样");
  });
});

describe("level orders: which events they match", () => {
  it("is conservative to create an order that raises events above their source default", () => {
    // run.failed 现在按来源 run 的默认级别只记录。
    expect(tierOf(newLevelOrder("run.failed_tell", { kinds: ["run.failed"] }, "tell"), { before: null })).toBe("conservative");
    expect(tierOf(newLevelOrder("run.failed_digest", { kinds: ["run.failed"] }, "digest"), { before: null })).toBe("conservative");
  });

  it("is permissive to create an order that takes events away from a higher order", () => {
    const quiet = newLevelOrder("inbox.quiet", { kinds: ["inbox.attention"] }, "record", 5);
    const result = classify(quiet, { before: null });
    expect(result.tier).toBe("permissive");
    expect(result.findings.map((item) => item.detail).join("\n")).toContain("inbox.wake_lead");
    expect(tierOf(newLevelOrder("run.finished_auto", { kinds: ["run.finished"] }, "auto"), { before: null })).toBe("permissive");
  });

  it("is conservative to widen a tell order: the events it takes over were told or less", () => {
    const widened = { ...seed("notification.immediate"), condition: { kinds: ["notification.created"] } };
    const result = classify(widened);
    expect(result.tier).toBe("conservative");
  });

  it("is permissive to narrow a tell order: the events it lets go fall to a lower level", () => {
    const narrowed = {
      ...seed("notification.immediate"),
      condition: { kinds: ["notification.created"], fields: { "payload.urgency": "immediate", "payload.itemId": { exists: true } } },
    };
    expect(tierOf(narrowed)).toBe("permissive");
  });

  it("is conservative to narrow or disable a record order, and permissive to disable a tell order", () => {
    expect(tierOf({ ...seed("inbox.lead_followup_set"), status: "disabled" })).toBe("conservative");
    const narrowed = {
      ...seed("inbox.lead_followup_set"),
      condition: { kinds: ["inbox.attention"], fields: { "payload.inboxKind": "lead_followup" } },
    };
    expect(tierOf(narrowed)).toBe("conservative");
    expect(tierOf({ ...seed("notification.immediate"), status: "disabled" })).toBe("permissive");
  });

  it("is permissive to move a digest order in front of a tell order that matches the same events", () => {
    expect(tierOf({ ...seed("inbox.no_wake"), priority: 25 })).toBe("permissive");
    // 挪到更后面，中间没有会接手的指令：结果不变。
    expect(tierOf({ ...seed("notification.batchable"), priority: 55 })).toBe("conservative");
  });

  it("is conservative to enable a disabled order that raises events, and says a change to a disabled order does nothing now", () => {
    const disabled = { ...newLevelOrder("run.failed_tell", { kinds: ["run.failed"] }, "tell"), status: "disabled" as const };
    const active = seeds;
    expect(tierOf({ ...disabled, status: "active" }, { before: disabled, active })).toBe("conservative");
    const edited = classify({ ...disabled, action: { type: "level", level: "record" } }, { before: disabled, active });
    expect(edited.tier).toBe("conservative");
    expect(edited.findings[0]!.detail).toContain("停用着");
  });
});

describe("rule orders: parameters and limits", () => {
  const withLimits = (id: string, limits: Record<string, number>) => ({ ...seed(id), limits: { ...seed(id).limits, ...limits } });

  it("fuse: opening later is conservative, opening sooner is permissive", () => {
    expect(tierOf(withLimits("inbox.fuse_blockers", { count: 5 }))).toBe("conservative");
    expect(tierOf(withLimits("inbox.fuse_blockers", { count: 2 }))).toBe("permissive");
    expect(tierOf(withLimits("inbox.fuse_blockers", { windowMs: 30 * 60_000 }))).toBe("conservative");
    expect(tierOf(withLimits("inbox.fuse_blockers", { windowMs: 2 * 3_600_000 }))).toBe("permissive");
  });

  it("transient retry: fewer automatic retries is conservative, more is permissive, other timing cannot be judged", () => {
    expect(tierOf(withLimits("run.transient_retry", { count: 0 }))).toBe("conservative");
    expect(tierOf(withLimits("run.transient_retry", { count: 8 }))).toBe("permissive");
    expect(tierOf(withParams("run.transient_retry", { baseMs: 60_000 }))).toBe("permissive");
  });

  it("wake_lead: waking Lead for more rows is conservative, for fewer is permissive", () => {
    const order = seed("inbox.wake_lead");
    const wakeWhen = (order.action as unknown as { params: { wakeWhen: StandingOrderCondition } }).params.wakeWhen;
    expect(tierOf(withParams("inbox.wake_lead", {
      wakeWhen: { anyOf: [...wakeWhen.anyOf!, { fields: { "payload.inboxKind": "model_catalog_changed" } }] },
    }))).toBe("conservative");
    expect(tierOf(withParams("inbox.wake_lead", { wakeWhen: { anyOf: [wakeWhen.anyOf![0]!] } }))).toBe("permissive");
  });

  // 工单 09 加的 triage.jev：打开更多事件类型的 Jev 分诊更放开，关掉更保守，别的参数无法判断。
  it("the Jev triage switch: enabling more kinds is looser, disabling is more conservative", () => {
    expect(tierOf(withParams("triage.jev", { enabledKinds: ["run.failed"] }))).toBe("permissive");
    const enabled = withParams("triage.jev", { enabledKinds: ["run.failed", "stage.changed"] });
    expect(tierOf(withParams("triage.jev", { enabledKinds: ["run.failed"] }), { before: enabled })).toBe("conservative");
    expect(tierOf(withParams("triage.jev", { minConfidence: 0.5 }))).toBe("permissive");
  });

  it("model catalog, reminders, digests and escalation follow their own direction", () => {
    expect(tierOf(withParams("model_catalog.announce", { wakeLead: true }))).toBe("conservative");
    expect(tierOf(withParams("model_catalog.announce", { refreshOnFailureScopes: ["runtime"] }))).toBe("permissive");
    // 去抖（工单 14）：要更多次相同的刷新才说，告诉 Lead 的更少，更放开；更少次更保守。没写按 1。
    expect(tierOf(withParams("model_catalog.announce", { stableRefreshes: 3 }))).toBe("permissive");
    expect(tierOf(withParams("model_catalog.announce", { stableRefreshes: 1 }))).toBe("conservative");
    const { stableRefreshes: _dropped, ...withoutDebounce } = (seed("model_catalog.announce").action as { params: Record<string, unknown> }).params;
    const before = { ...seed("model_catalog.announce"), action: { type: "rule" as const, rule: "model_catalog.announce" as const, level: "digest" as const, params: withoutDebounce } };
    expect(tierOf(withParams("model_catalog.announce", { stableRefreshes: 2 }), { before })).toBe("permissive");
    expect(tierOf(withParams("model_catalog.announce", { stableRefreshes: 1 }), { before })).toBe("conservative");
    expect(tierOf(withParams("reminder.fire", { urgency: "batchable" }))).toBe("permissive");
    expect(tierOf(withParams("reminder.fire", { titlePrefix: "到点：" }))).toBe("conservative");
    expect(tierOf(withParams("events.digest_batch", { maxWaitMs: 10 * 60_000 }))).toBe("conservative");
    expect(tierOf(withParams("events.digest_batch", { onUserReturn: false }))).toBe("permissive");
    // 原来 auto 级的事件到时限不升，现在升到 tell。
    const overdue = withParams("events.escalate_overdue", { ladder: { digest: "tell" } });
    expect(tierOf(withParams("events.escalate_overdue", { ladder: { digest: "tell", auto: "tell" } }), { before: overdue })).toBe("conservative");
    expect(tierOf(withParams("events.escalate_overdue", { ladder: { auto: "tell" } }))).toBe("permissive");
    expect(tierOf(withLimits("events.escalate_overdue", { windowMs: 20 * 60_000 }))).toBe("conservative");
  });

  it("root-cause merging: merging less is conservative, merging more is permissive", () => {
    const order = seed("events.merge_root_cause");
    expect(tierOf({ ...order, condition: { ...order.condition, anyOf: [order.condition.anyOf![0]!] } })).toBe("conservative");
    expect(tierOf({ ...order, condition: { fields: order.condition.fields } })).toBe("permissive");
    expect(tierOf(withLimits("events.merge_root_cause", { windowMs: 10 * 60_000 }))).toBe("conservative");
  });

  it("source thresholds: raising the default or the cap is conservative, lowering is permissive", () => {
    const capped = withParams("source.ticket", { maxLevel: "digest" });
    expect(tierOf(withParams("source.ticket", { maxLevel: "tell" }), { before: capped, active: [...seeds.filter((o) => o.id !== "source.ticket"), capped] }))
      .toBe("conservative");
    expect(tierOf(withParams("source.ticket", { defaultLevel: "digest" }))).toBe("conservative");
    expect(tierOf(withParams("source.ticket", { defaultLevel: "auto" }))).toBe("permissive");
    expect(tierOf(withParams("source.ticket", { maxLevel: "digest" }))).toBe("permissive");
    const slack: StandingOrderState = {
      ...seed("source.external"), id: "source.slack", title: "Slack",
      action: { type: "rule", rule: "source.threshold", params: { source: "slack", defaultLevel: "tell", maxLevel: "tell" } },
    };
    expect(tierOf(slack, { before: null })).toBe("conservative");
    expect(tierOf({ ...slack, action: { ...slack.action, params: { source: "slack", defaultLevel: "record", maxLevel: "tell" } } as never },
      { before: null })).toBe("permissive");
  });
});

// 审查后加的一条：任何让事件升到 interrupt 的修改都要用户批准（interrupt 会推送到用户手机，也会打断 Lead 的回合）。
// 两个维度的比较不变，升到 tell 及以下照旧。
describe("raising events to interrupt always needs the user's approval", () => {
  const interruptDetails = (after: StandingOrderState, options?: Parameters<typeof classify>[1]) => {
    const result = classify(after, options);
    expect(result.tier).toBe("permissive");
    return result.findings.filter((item) => item.aspect === "interrupt").map((item) => item.detail);
  };

  it("a level order whose level or escalate_to becomes interrupt", () => {
    expect(interruptDetails(withLevel(seed("notification.immediate"), "interrupt"))).toHaveLength(1);
    expect(interruptDetails({ ...seed("inbox.no_wake"), escalateTo: "interrupt" })[0]).toContain("interrupt");
  });

  it("a source threshold whose cap or default level goes up to interrupt", () => {
    expect(interruptDetails(withParams("source.ticket", { maxLevel: "interrupt" }))[0]).toContain("打断上限");
    expect(interruptDetails(withParams("source.ticket", { defaultLevel: "interrupt", maxLevel: "interrupt" })).length).toBe(2);
  });

  it("a new order that sets events to interrupt, and widening one that already does", () => {
    const urgent = newLevelOrder("run.failed_urgent", { kinds: ["run.failed"] }, "interrupt");
    expect(interruptDetails(urgent, { before: null })).toHaveLength(1);
    const active = [...seeds, urgent];
    expect(interruptDetails({ ...urgent, condition: { kinds: ["run.*"] } }, { before: urgent, active })[0]).toContain("更多事件");
  });

  it("a new step in the overdue ladder that ends at interrupt", () => {
    expect(interruptDetails(withParams("events.escalate_overdue", { ladder: { digest: "tell", auto: "tell", tell: "interrupt" } }))[0])
      .toContain("tell 级的事件到时限会升到 interrupt");
  });

  it("raising to tell is still conservative", () => {
    expect(tierOf({ ...withLevel(seed("notification.batchable"), "tell"), escalateTo: null })).toBe("conservative");
    expect(tierOf(newLevelOrder("run.failed_tell", { kinds: ["run.failed"] }, "tell"), { before: null })).toBe("conservative");
    expect(tierOf(withParams("source.ticket", { defaultLevel: "tell" }))).toBe("conservative");
  });
});

describe("hard rules", () => {
  const hardRules = (after: StandingOrderState, options?: Parameters<typeof classify>[1]) => {
    const result = classify(after, options);
    expect(result.tier).toBe("forbidden");
    return result.findings.map((item) => item.hardRule);
  };

  it("refuses orders aimed at approvals", () => {
    const order = newLevelOrder("inbox.approvals_quiet",
      { kinds: ["inbox.blocker"], fields: { "payload.payload.authorityType": "approval" } }, "record", 5);
    expect(hardRules(order, { before: null })).toEqual(["approval_reaches_user"]);
  });

  it("refuses interrupt for external sources, in a level order or a threshold", () => {
    expect(hardRules(newLevelOrder("slack.urgent", { sources: ["slack"] }, "interrupt", 5), { before: null }))
      .toEqual(["external_never_interrupts"]);
    const external = seed("source.external");
    expect(hardRules({ ...external, action: { ...external.action, params: { source: "*", defaultLevel: "digest", maxLevel: "interrupt" } } as never }))
      .toContain("external_never_interrupts");
  });

  it("refuses to turn off a rule, and names the reminder rule", () => {
    expect(hardRules({ ...seed("run.transient_retry"), status: "disabled" })).toEqual(["rules_stay_on"]);
    expect(hardRules({ ...seed("reminder.fire"), status: "disabled" })).toEqual(["reminder_always_fires"]);
  });

  it("refuses to change what a rule order is", () => {
    const retry = seed("run.transient_retry");
    expect(hardRules({ ...retry, action: { type: "rule", rule: "inbox.merge_attention", params: {} } })).toEqual(["rule_identity_fixed"]);
    expect(hardRules({ ...retry, action: { type: "level", level: "digest" } })).toEqual(["rule_identity_fixed"]);
    expect(hardRules({ ...retry, id: "run.transient_retry_two" }, { before: null })).toEqual(["rule_identity_fixed"]);
  });
});

describe("changes that cannot be judged, and changes that do not change behaviour", () => {
  it("treats a field the order does not use as permissive", () => {
    expect(tierOf({ ...seed("inbox.no_wake"), limits: { count: 3 } })).toBe("permissive");
    expect(tierOf({ ...seed("events.digest_batch"), condition: { kinds: ["inbox.attention"] } })).toBe("permissive");
    expect(tierOf({ ...seed("inbox.merge_attention"), priority: 5 })).toBe("permissive");
  });

  it("puts a title-only change in the conservative tier and reports no change when only the reason differs", () => {
    expect(classify({ ...seed("inbox.no_wake"), title: "不叫醒 Lead 的 inbox 进摘要" })).toMatchObject({ tier: "conservative", changed: true });
    expect(classify(seed("inbox.no_wake"))).toMatchObject({ changed: false });
  });

  it("takes the worst finding: one permissive part makes the whole change permissive", () => {
    const order = seed("inbox.fuse_blockers");
    expect(tierOf({ ...order, limits: { count: 5, windowMs: 2 * 3_600_000 } })).toBe("permissive");
  });
});

describe("condition helpers prove only what they can", () => {
  it("knows which field tests imply others", () => {
    expect(fieldTestImplies("a", { in: ["a", "b"] })).toBe(true);
    expect(fieldTestImplies({ in: ["a"] }, { not: "b" })).toBe(true);
    expect(fieldTestImplies({ in: ["a", "b"] }, "a")).toBe(false);
    expect(fieldTestImplies({ notIn: ["a", "b"] }, { not: "a" })).toBe(true);
    expect(fieldTestImplies({ not: "a" }, { notIn: ["a", "b"] })).toBe(false);
    expect(fieldTestImplies({ exists: true }, { not: null })).toBe(true);
    expect(fieldTestImplies({ exists: false }, { not: "a" })).toBe(true);
    expect(fieldTestImplies({ exists: true }, "a")).toBe(false);
  });

  it("checks that one condition is a subset of another, with prefixes and anyOf", () => {
    expect(conditionImplies({ kinds: ["inbox.blocker"] }, { kinds: ["inbox.*"] })).toBe(true);
    expect(conditionImplies({ kinds: ["inbox.*"] }, { kinds: ["inbox.blocker"] })).toBe(false);
    expect(conditionImplies({ kinds: ["inbox.blocker"], fields: { severity: "blocker" } }, { kinds: ["inbox.blocker"] })).toBe(true);
    expect(conditionImplies({ anyOf: [{ fields: { a: 1 } }] }, { anyOf: [{ fields: { a: 1 } }, { fields: { b: 2 } }] })).toBe(true);
    expect(conditionImplies({ anyOf: [{ fields: { a: 1 } }, { fields: { b: 2 } }] }, { anyOf: [{ fields: { a: 1 } }] })).toBe(false);
    expect(conditionImplies({}, { kinds: ["x"] })).toBe(false);
  });

  it("rules out overlap only when kinds, sources or field values cannot meet", () => {
    expect(conditionsMayOverlap({ kinds: ["run.failed"] }, { kinds: ["timer.fired"] })).toBe(false);
    expect(conditionsMayOverlap({ kinds: ["inbox.*"] }, { kinds: ["inbox.attention"] })).toBe(true);
    expect(conditionsMayOverlap({ kinds: ["run.failed"] }, { sources: ["system"] })).toBe(false);
    expect(conditionsMayOverlap({ fields: { k: "a" } }, { fields: { k: { in: ["b"] } } })).toBe(false);
    expect(conditionsMayOverlap({ fields: { k: "a" } }, { fields: { j: "b" } })).toBe(true);
  });
});

// 设置 → 消息通道 → 自动代你处理（2026-10-23）：开关和信心模型的参数存在 channel.authority 里。
describe("channel.authority: the auto-handling switch and the confidence model", () => {
  const model = (patch: Record<string, unknown>) => ({
    tiers: [0.6, 0.75, 0.9, 0.95], noReplyBelow: 0.3, weights: { needs_reply: 0.5, fulfills: 0.5 }, priorStrength: 10, coldStartTiers: 0,
    lockMode: "hard", tuning: { topicStep: 0.2, draftRiskStep: 0.4, verifiedFloor: 0.2, groundedFloor: 0.6, understoodFloor: 0.9 },
    ...patch,
  });

  it("treats turning auto-handling off as conservative and turning it on as permissive; unset means on", () => {
    expect(tierOf(withParams("channel.authority", { autoReply: false }))).toBe("conservative");
    expect(tierOf(withParams("channel.authority", { autoReply: true }), { before: withParams("channel.authority", { autoReply: false }) }))
      .toBe("permissive");
  });

  it("an unset model is the defaults: writing them out with a tightening is still conservative", () => {
    const changed = classify(withParams("channel.authority", { autoReply: false, model: model({}) }));
    expect(changed.tier).toBe("conservative");
    expect(changed.findings.map((item) => item.detail)).toEqual(["autoReply（自动代你处理）从 true 改为 false"]);
  });

  it("judges each parameter of the model by the direction that lets Lead do less", () => {
    const tier = (patch: Record<string, unknown>) => tierOf(withParams("channel.authority", { model: model(patch) }));
    expect(tier({ tiers: [0.6, 0.75, 0.9, 0.97] })).toBe("conservative");
    expect(tier({ tiers: [0.6, 0.75, 0.9, 0.9] })).toBe("permissive");
    expect(tier({ weights: { needs_reply: 0.8, fulfills: 0.5 } })).toBe("conservative");
    expect(tier({ weights: { needs_reply: 0.5, fulfills: 0.3 } })).toBe("permissive");
    expect(tier({ coldStartTiers: 1 })).toBe("conservative");
    expect(tier({ lockMode: "weighted" })).toBe("permissive");
    expect(tier({ tuning: { topicStep: 0.1, draftRiskStep: 0.4, verifiedFloor: 0.2, groundedFloor: 0.6, understoodFloor: 0.9 } })).toBe("conservative");
    expect(tier({ tuning: { topicStep: 0.2, draftRiskStep: 0.4, verifiedFloor: 0.2, groundedFloor: 0.8, understoodFloor: 0.9 } })).toBe("permissive");
    // 不打扰线调高：更多消息只记录，按放开算；校准的先验无法判断，按放开算。
    expect(tier({ noReplyBelow: 0.4 })).toBe("permissive");
    expect(tier({ noReplyBelow: 0.2 })).toBe("conservative");
    expect(tier({ priorStrength: 20 })).toBe("permissive");
  });
});
