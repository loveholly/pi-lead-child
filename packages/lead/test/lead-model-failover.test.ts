// Lead 的模型切换（spec D9）。以前 Lead 只用 lead.models[0]：2026-10-16 16:57 的心跳巡检遇到 429（21 秒里试了 4 次，
// 140 秒后才恢复），Lead 只能等，第二个模型一直没用上。
// 现在：Lead 的一轮遇到限流，或者连续两轮上下文溢出时，按 lead.models 的顺序换下一个模型；服务端给了恢复时间时，
// 到时间后用回第一个模型；所有模型都失败时不再换（交给 daemon 现有的停摆流程）。
// 2026-10-19：09:06–09:41 Lead 连续失败 35 分钟（先 DNS，后 503 auth_unavailable），只用了第一个模型。
// 现在授权、额度、模型不可用也换模型；网络类不换；额度用尽的一类模型在重置以前跳过；没有恢复时间时 30 分钟后再试第一个。
import { describe, expect, it } from "vitest";
import {
  createLeadModelFailover, DEFAULT_LEAD_MODEL_RESTORE_MS, isLeadContextOverflow, leadModelFailureCause, leadModelRetryAfterMs,
  nextWeeklyReset, type LeadModelQuotaStore,
} from "../src/model-failover.js";

const RATE_LIMIT = "429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit";
const OVERFLOW = "prompt is too long: 213462 tokens > 200000 maximum";

describe("which Lead failures switch the model", () => {
  it("counts rate limits, quota, auth, an unavailable or unknown model, and a context overflow; not the network", () => {
    expect(leadModelFailureCause(RATE_LIMIT)).toBe("rate_limit");
    expect(leadModelFailureCause('529 {"type":"overloaded_error"}')).toBe("rate_limit");
    expect(leadModelFailureCause(OVERFLOW)).toBe("context_overflow");
    expect(leadModelFailureCause("Your input exceeds the context window of this model")).toBe("context_overflow");
    // 2026-10-19 09:2x 的那一种：代理的 503 auth_unavailable。
    expect(leadModelFailureCause('503: {"message":"auth_unavailable: no auth available"}')).toBe("unavailable");
    expect(leadModelFailureCause("503 Service Unavailable")).toBe("unavailable");
    expect(leadModelFailureCause("401 Unauthorized")).toBe("auth");
    expect(leadModelFailureCause('404 {"error":{"type":"not_found_error","message":"model: claude-x"}}')).toBe("model");
    expect(leadModelFailureCause("429 You have exceeded your weekly limit. Usage limit reached.")).toBe("quota");
    expect(leadModelFailureCause('{"error":{"code":"insufficient_quota"}}')).toBe("quota");
    // 网络断了（09:06 的 DNS）：不换，等网络恢复。认不出的错误也不换。
    expect(leadModelFailureCause("getaddrinfo ENOTFOUND api.anthropic.com")).toBeNull();
    // 2026-11-06：到模型服务的路被拦了（403 "Request not allowed"）。所有模型走同一条路，换一个就让代理多冷却一个账号：不换。
    expect(leadModelFailureCause('403: {"type":"forbidden","message":"Request not allowed"}')).toBeNull();
    expect(leadModelFailureCause("lookup api.anthropic.com: no such host")).toBeNull();
    expect(leadModelFailureCause("something odd happened")).toBeNull();
    // Bedrock 的限流写着 too many tokens：是限流，不是溢出。
    expect(isLeadContextOverflow("ThrottlingException: Too many tokens, please wait before trying again. rate limit")).toBe(false);
  });

  it("reads the recovery time the service gave", () => {
    expect(leadModelRetryAfterMs(`Server requested 140s retry delay (max: 60s). ${RATE_LIMIT}`)).toBe(140_000);
    expect(leadModelRetryAfterMs("You have hit your ChatGPT usage limit (plus plan). Try again in ~5 min.")).toBe(300_000);
    expect(leadModelRetryAfterMs("Rate limit reached. Please try again in 20s.")).toBe(20_000);
    expect(leadModelRetryAfterMs('429 {"error":{"code":"rate_limit_exceeded","resets_in_seconds":90}}')).toBe(90_000);
    expect(leadModelRetryAfterMs("429 Too Many Requests; retry-after: 30")).toBe(30_000);
    expect(leadModelRetryAfterMs(RATE_LIMIT)).toBeNull();
  });
});

describe("the Lead model failover", () => {
  it("moves to the next model on a rate limit, and back to the first once the service's recovery time has passed", () => {
    const failover = createLeadModelFailover({ models: ["p/a", "p/b", "p/c"] });
    expect(failover.desired()).toBe("p/a");

    const decision = failover.turnFailed(`Server requested 140s retry delay (max: 60s). ${RATE_LIMIT}`, 1_000);
    expect(decision).toMatchObject({ kind: "switch", from: "p/a", to: "p/b", cause: "rate_limit", restoreAt: 141_000 });
    expect(failover.desired()).toBe("p/b");

    expect(failover.restore(100_000)).toBeNull();
    expect(failover.restore(141_000)).toMatchObject({ kind: "switch", from: "p/b", to: "p/a", cause: "recovered" });
    expect(failover.desired()).toBe("p/a");
    expect(failover.restore(200_000)).toBeNull();
  });

  // daemon 的长退避不等过这个时间（第二轮审阅 4）：在备用模型上时是换回第一个模型的时间，还有额度封禁时取更早的到期时间。
  it("says when it may switch models next: the switch-back time, or a quota block ending", () => {
    let now = 1_000_000;
    const failover = createLeadModelFailover({ models: ["a/x", "b/y"], now: () => now });
    expect(failover.returnAt()).toBeNull();
    failover.turnFailed("401 Unauthorized");
    expect(failover.desired()).toBe("b/y");
    expect(failover.returnAt()).toBe(now + DEFAULT_LEAD_MODEL_RESTORE_MS);
    const blocked = createLeadModelFailover({
      models: ["a/x", "b/y"], now: () => now, quotaStore: { load: () => ({ "a/x": now + 5_000 }), save: () => {} },
    });
    expect(blocked.returnAt()).toBe(now + 5_000);
    // 封禁到期了、还没换回（只在一轮开始时换）：给的是已经过去的换回时间，daemon 马上叫醒 Lead。
    now += 6_000;
    expect(blocked.returnAt()).toBe(now - 1_000);
  });

  it("tries the first model again after a cool-down when the service gave no recovery time", () => {
    const failover = createLeadModelFailover({ models: ["p/a", "p/b"] });
    expect(failover.turnFailed(RATE_LIMIT, 0)).toMatchObject({ kind: "switch", to: "p/b", restoreAt: DEFAULT_LEAD_MODEL_RESTORE_MS });
    expect(failover.restore(DEFAULT_LEAD_MODEL_RESTORE_MS - 1)).toBeNull();
    expect(failover.desired()).toBe("p/b");
    expect(failover.restore(DEFAULT_LEAD_MODEL_RESTORE_MS)).toMatchObject({ kind: "switch", from: "p/b", to: "p/a" });
  });

  it("does not reuse an old recovery time", () => {
    const failover = createLeadModelFailover({ models: ["p/a", "p/b"] });
    failover.turnFailed(`Server requested 100s retry delay (max: 60s). ${RATE_LIMIT}`, 0);
    failover.turnSucceeded();
    // 第二个模型也限流，绕回第一个：不再等那个旧的恢复时间。
    expect(failover.turnFailed(RATE_LIMIT, 1_000)).toMatchObject({ kind: "switch", to: "p/a", restoreAt: null });
    failover.turnSucceeded();
    // 第一个模型又限流，这次没给恢复时间：按冷却时间算，不按旧的时间换回去。
    expect(failover.turnFailed(RATE_LIMIT, 2_000)).toMatchObject({ kind: "switch", to: "p/b", restoreAt: 2_000 + DEFAULT_LEAD_MODEL_RESTORE_MS });
    expect(failover.restore(200_000)).toBeNull();
  });

  it("switches after two context overflows in a row, not after one", () => {
    const failover = createLeadModelFailover({ models: ["p/a", "p/b"] });
    expect(failover.turnFailed(OVERFLOW, 0)).toEqual({ kind: "none" });
    expect(failover.turnFailed(OVERFLOW, 0)).toMatchObject({ kind: "switch", to: "p/b", cause: "context_overflow" });

    const other = createLeadModelFailover({ models: ["p/a", "p/b"] });
    expect(other.turnFailed(OVERFLOW, 0)).toEqual({ kind: "none" });
    other.turnSucceeded();
    expect(other.turnFailed(OVERFLOW, 0)).toEqual({ kind: "none" });
    expect(other.turnFailed("something odd happened", 0)).toEqual({ kind: "none" });
    expect(other.turnFailed(OVERFLOW, 0)).toEqual({ kind: "none" });
  });

  // 2026-10-19 09:06–09:41：先 DNS（不换，等网络），后 503 auth_unavailable（连续两次以后换下一个）。
  it("waits out a network failure and moves on when the model service keeps saying auth_unavailable", () => {
    const failover = createLeadModelFailover({ models: ["vibeproxy/gemini", "vibeproxy/claude-sonnet", "vibeproxy/claude-opus"] });
    expect(failover.turnFailed("getaddrinfo ENOTFOUND api.example.com", 0)).toEqual({ kind: "none" });
    expect(failover.desired()).toBe("vibeproxy/gemini");
    // 一次不换：可能只是一次抖动（2026-10-19 审查）。
    expect(failover.turnFailed('503: {"message":"auth_unavailable: no auth available"}', 1_000)).toEqual({ kind: "none" });
    expect(failover.turnFailed('503: {"message":"auth_unavailable: no auth available"}', 2_000))
      .toMatchObject({ kind: "switch", from: "vibeproxy/gemini", to: "vibeproxy/claude-sonnet", cause: "unavailable" });
    expect(failover.desired()).toBe("vibeproxy/claude-sonnet");
  });

  it("does not switch for one timeout, and starts counting again after a turn succeeds", () => {
    const failover = createLeadModelFailover({ models: ["p/a", "p/b"] });
    expect(failover.turnFailed("fetch failed", 0)).toEqual({ kind: "none" });
    failover.turnSucceeded();
    expect(failover.turnFailed("socket hang up", 0)).toEqual({ kind: "none" });
    expect(failover.turnFailed("ETIMEDOUT", 0)).toMatchObject({ kind: "switch", to: "p/b" });
  });

  it("skips every Claude model until the weekly reset once Claude's quota runs out, and remembers it across restarts", () => {
    // 周三 10:00（本机时区）。下一次重置：周一 16:00。
    const now = new Date(2026, 9, 21, 10, 0, 0).getTime();
    const reset = new Date(2026, 9, 26, 16, 0, 0).getTime();
    expect(nextWeeklyReset(now, { weekday: 1, time: "16:00" })).toBe(reset);
    let saved: Record<string, number> = {};
    const store: LeadModelQuotaStore = { load: () => saved, save: (blocked) => { saved = blocked; } };
    const models = ["vibeproxy/claude-sonnet-5-5", "vibeproxy/gemini-3.8", "vibeproxy/claude-sonnet-5"];
    const failover = createLeadModelFailover({ models, quotaStore: store, now: () => now });
    const decision = failover.turnFailed("429 You have reached your usage limit for this week", now);
    // 第二个 Claude 模型也跳过，直接换到 gemini；重置时间到了才换回第一个。
    expect(decision).toMatchObject({ kind: "switch", from: models[0], to: models[1], cause: "quota", restoreAt: reset });
    expect(saved).toEqual({ [models[0]!]: reset, [models[2]!]: reset });
    failover.turnSucceeded();
    // gemini 也失败了：不去试第三个（额度没重置的 Claude），所有能用的都失败了。
    expect(failover.turnFailed("401 Unauthorized", now + 1_000)).toMatchObject({ kind: "exhausted" });
    expect(failover.restore(reset - 1)).toBeNull();
    expect(failover.restore(reset)).toMatchObject({ kind: "switch", to: models[0] });

    // daemon 重启（重置以前）：从第一个没被跳过的模型开始。
    const restarted = createLeadModelFailover({ models, quotaStore: store, now: () => now + 60_000 });
    expect(restarted.desired()).toBe(models[1]);
    expect(restarted.restore(reset)).toMatchObject({ kind: "switch", to: models[0] });
  });

  // 2026-10-19 审查：一条「resets in 3 hours」曾经让两个 Claude 模型被封到下周一，写进 kv，重启后也不解除。
  it("uses the recovery time the service gave before any weekly rule", () => {
    const now = new Date(2026, 9, 21, 10, 0, 0).getTime();
    let saved: Record<string, number> = {};
    const store: LeadModelQuotaStore = { load: () => saved, save: (blocked) => { saved = blocked; } };
    const models = ["vibeproxy/claude-sonnet-5-5", "vibeproxy/gemini-3.8", "vibeproxy/claude-sonnet-5"];
    const failover = createLeadModelFailover({ models, quotaStore: store, now: () => now });
    const threeHours = now + 3 * 3_600_000;
    expect(failover.turnFailed("429 usage limit reached, resets in 3 hours", now))
      .toMatchObject({ kind: "switch", to: models[1], cause: "quota", restoreAt: threeHours });
    expect(saved).toEqual({ [models[0]!]: threeHours, [models[2]!]: threeHours });
  });

  it("does not apply the weekly rule when the error does not say the quota is weekly", () => {
    const failover = createLeadModelFailover({ models: ["vibeproxy/claude-sonnet-5-5", "vibeproxy/gemini-3.8"] });
    expect(failover.turnFailed('{"error":{"code":"insufficient_quota"}}', 0))
      .toMatchObject({ kind: "switch", cause: "quota", restoreAt: DEFAULT_LEAD_MODEL_RESTORE_MS });
  });

  it("lets a block be cleared by hand, and goes back to the first model in the next turn", () => {
    const now = new Date(2026, 9, 21, 10, 0, 0).getTime();
    let saved: Record<string, number> = {};
    const store: LeadModelQuotaStore = { load: () => saved, save: (blocked) => { saved = blocked; } };
    const models = ["vibeproxy/claude-sonnet-5-5", "vibeproxy/gemini-3.8"];
    const failover = createLeadModelFailover({ models, quotaStore: store, now: () => now });
    failover.turnFailed("429 You have reached your usage limit for this week", now);
    expect(failover.blockedModels(now)).toEqual([{ model: models[0], until: new Date(2026, 9, 26, 16, 0, 0).getTime() }]);
    expect(failover.clearBlocked("vibeproxy/other")).toEqual([]);
    expect(failover.clearBlocked()).toEqual([models[0]]);
    expect(saved).toEqual({});
    expect(failover.restore(now)).toMatchObject({ kind: "switch", to: models[0], reason: expect.stringContaining("手动清掉") });
  });

  it("blocks only the failing model when its quota has no weekly reset rule", () => {
    const failover = createLeadModelFailover({ models: ["p/a", "p/b"], quotaResets: [] });
    expect(failover.turnFailed('{"error":{"code":"insufficient_quota"}}', 0))
      .toMatchObject({ kind: "switch", to: "p/b", cause: "quota", restoreAt: DEFAULT_LEAD_MODEL_RESTORE_MS });
  });

  it("gives up when every model has failed, and starts over after a success", () => {
    const failover = createLeadModelFailover({ models: ["p/a", "p/b"] });
    expect(failover.turnFailed(RATE_LIMIT, 0)).toMatchObject({ kind: "switch", to: "p/b" });
    expect(failover.turnFailed(RATE_LIMIT, 0)).toMatchObject({ kind: "exhausted", cause: "rate_limit", tried: ["p/a", "p/b"] });
    expect(failover.desired()).toBe("p/b");

    failover.turnSucceeded();
    expect(failover.turnFailed(RATE_LIMIT, 0)).toMatchObject({ kind: "switch", from: "p/b", to: "p/a" });
  });

  it("skips a model the session could not switch to", () => {
    const failover = createLeadModelFailover({ models: ["p/a", "p/b", "p/c"] });
    failover.turnFailed(RATE_LIMIT, 0);
    expect(failover.unusable("p/b", "no auth configured")).toMatchObject({ kind: "switch", from: "p/a", to: "p/c" });
    expect(failover.desired()).toBe("p/c");
    // 都换不到：daemon 留在原来的模型上，之后不再每一轮去试。
    expect(failover.unusable("p/c", "no auth configured")).toMatchObject({ kind: "exhausted" });
    failover.stayOn("p/a");
    expect(failover.desired()).toBe("p/a");
  });

  it("never switches with only one model", () => {
    const failover = createLeadModelFailover({ models: ["p/a"] });
    expect(failover.turnFailed(RATE_LIMIT, 0)).toMatchObject({ kind: "exhausted" });
    expect(failover.desired()).toBe("p/a");
  });

  // 回归（2026-10-31，北京时间 00:16 起约 7 个半小时）：两个 Claude 账号都返回 503 auth_unavailable。顺序是 a、b、c（能用）。
  // a 坏了换 b，b 坏了本该换 c，可 a 的 30 分钟从 a 坏的那一刻算，下一轮开始前已经到了，又换回 a；一整夜在 a、b 之间来回，
  // 只有一次轮到 c，16 分钟后又被拉回坏掉的 a。
  it("stays on the model that works and backs off, instead of pulling Lead back to a first model that is still broken", () => {
    // 当时上游回的是 403 "Request not allowed"，现在它算路被拦了（不换模型）。这里用上游的 401，测的仍是换模型的顺序。
    const AUTH_503 = '503: {"message":"auth_unavailable: no auth available (providers=claude, model=a; last upstream error: '
      + '{\\"error\\": {\\"type\\": \\"authentication_error\\", \\"message\\": \\"invalid x-api-key\\"}})"}';
    const minutes = (value: number) => value * 60_000;
    const failover = createLeadModelFailover({ models: ["p/a", "p/b", "p/c"] });
    failover.turnSucceeded();

    expect(failover.turnFailed(AUTH_503, 0)).toMatchObject({ kind: "switch", from: "p/a", to: "p/b" });
    expect(failover.turnFailed(AUTH_503, minutes(18))).toMatchObject({ kind: "switch", from: "p/b", to: "p/c" });
    // 下一轮在 16 分钟后开始：c 还一轮都没跑，不换回 a。等待从最近一次切换算。
    expect(failover.restore(minutes(34))).toBeNull();
    expect(failover.desired()).toBe("p/c");
    failover.turnSucceeded();

    // 换到 c 满 30 分钟：试一次 a。
    expect(failover.restore(minutes(48))).toMatchObject({ kind: "switch", from: "p/c", to: "p/a", cause: "recovered" });
    // a 还是坏的：回到刚才能用的 c，不按顺序换到同样坏着的 b；下次多等一倍。
    expect(failover.turnFailed(AUTH_503, minutes(49))).toMatchObject({ kind: "switch", from: "p/a", to: "p/c", restoreAt: minutes(49 + 60) });
    failover.turnSucceeded();
    expect(failover.restore(minutes(49 + 59))).toBeNull();
    expect(failover.restore(minutes(49 + 60))).toMatchObject({ kind: "switch", to: "p/a" });
    expect(failover.turnFailed(AUTH_503, minutes(110))).toMatchObject({ kind: "switch", to: "p/c", restoreAt: minutes(110 + 120) });
    failover.turnSucceeded();
    // 等待最长 4 小时。
    expect(failover.restore(minutes(230))).toMatchObject({ to: "p/a" });
    expect(failover.turnFailed(AUTH_503, minutes(231))).toMatchObject({ to: "p/c", restoreAt: minutes(231 + 240) });
    failover.turnSucceeded();
    expect(failover.restore(minutes(471))).toMatchObject({ to: "p/a" });
    expect(failover.turnFailed(AUTH_503, minutes(472))).toMatchObject({ to: "p/c", restoreAt: minutes(472 + 240) });
    failover.turnSucceeded();

    // a 好了：用成功一轮以后，下次出事又从 30 分钟算起。
    expect(failover.restore(minutes(712))).toMatchObject({ to: "p/a" });
    failover.turnSucceeded();
    expect(failover.turnFailed(AUTH_503, minutes(800))).toMatchObject({ kind: "switch", from: "p/a", to: "p/b", restoreAt: minutes(830) });
  });
});
