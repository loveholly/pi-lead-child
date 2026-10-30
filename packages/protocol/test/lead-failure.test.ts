// Lead 调模型失败时给人看的一句话，按原始错误分类。原文只放进「技术详情」。
import { describe, expect, it } from "vitest";

import {
  classifyLeadModelError, isLeadTransportFailure, LEAD_RESTART_INTERRUPTED_ERROR, leadModelFailureNeedsUser, leadModelFailureReason,
  leadOutageCause, leadTurnFailureSentence, leadTurnWaitingSentence, markUpstreamFailure,
} from "../src/index.ts";

// 用户实际遇到的失败：代理返回 503 auth_unavailable，里面包着上游的 403 forbidden "Request not allowed"。
const LIVE_AUTH = '503: {"message":"auth_unavailable: no auth available (providers=claude, model=claude-sonnet-5-5; '
  + 'last upstream error: {\\n  \\"error\\": {\\n    \\"type\\": \\"forbidden\\",\\n    '
  + '\\"message\\": \\"Request not allowed\\"}}","type":"server_error"}';

describe("classifyLeadModelError", () => {
  it("treats the proxy's 503 auth_unavailable around an upstream 403 forbidden as an auth failure", () => {
    expect(classifyLeadModelError(LIVE_AUTH)).toBe("auth");
    expect(leadModelFailureNeedsUser(classifyLeadModelError(LIVE_AUTH))).toBe(true);
    expect(classifyLeadModelError('403 {"error":{"type":"forbidden","message":"Request not allowed"}}')).toBe("auth");
    // 没有认证字样的 503 仍然是连不上，系统会自己再试。
    expect(classifyLeadModelError("503 Service Unavailable: upstream connect error")).toBe("unavailable");
    expect(leadModelFailureReason("unavailable")).toBe("Paimon 的模型服务暂时连不上");
  });

  // 发布评审（Lead 信任修复留下的一项）：代理在所有账号都在冷却、或者上游暂时 5xx 时也回 503 auth_unavailable。
  // 只凭 auth_unavailable 就判成认证失败，短暂的 5xx 会被说成「要检查账号」，系统也不再自己重试。
  // 只有里面真的带着上游的 401、403（forbidden、unauthorized、Request not allowed）才是认证失败。
  it("treats a proxy auth_unavailable without an upstream 401/403 as a passing outage, not an auth failure", () => {
    expect(classifyLeadModelError("503: auth_unavailable")).toBe("unavailable");
    expect(classifyLeadModelError('503: {"message":"auth_unavailable: no auth available (providers=claude, model=claude-sonnet-5-5)"}'))
      .toBe("unavailable");
    expect(classifyLeadModelError('503: {"message":"auth_unavailable: no auth available; last upstream error: 502 Bad Gateway"}'))
      .toBe("unavailable");
    expect(classifyLeadModelError('503: {"message":"auth_unavailable: no auth available; last upstream error: 429 rate_limit_error"}'))
      .toBe("busy");
    expect(classifyLeadModelError(LIVE_AUTH)).toBe("auth");
    expect(classifyLeadModelError('503: {"message":"auth_unavailable; last upstream error: 401 Unauthorized"}')).toBe("auth");
  });

  // 2026-10-28：上下文满了，压缩写不下摘要。pi 的原文里有 503、timeout 一类的字样时也不能分成连不上：再试也一样，要先压缩。
  it("knows a full context whose compaction failed", () => {
    expect(classifyLeadModelError("Context overflow recovery failed: Summarization failed: generation hit the token cap and the summary is incomplete"))
      .toBe("context");
    expect(classifyLeadModelError("上下文压缩失败：Context overflow recovery failed: 503 upstream")).toBe("context");
    expect(leadModelFailureReason("context", "Fairy")).toBe("Fairy 的上下文满了，压缩没有成功");
    expect(leadModelFailureNeedsUser("context")).toBe(false);
    expect(leadOutageCause("context")).toBe("上下文满了，压缩没有成功");
  });

  it("separates rate limits, auth failures, network errors and the rest", () => {
    expect(classifyLeadModelError("429 Too Many Requests")).toBe("busy");
    expect(classifyLeadModelError('529 {"type":"overloaded_error"}')).toBe("busy");
    expect(classifyLeadModelError("401 Unauthorized")).toBe("auth");
    expect(classifyLeadModelError("Invalid API key")).toBe("auth");
    expect(classifyLeadModelError("fetch failed: ECONNREFUSED 127.0.0.1:8317")).toBe("unavailable");
    expect(classifyLeadModelError("the model refused the tool schema")).toBe("unknown");
    expect(classifyLeadModelError('404 {"error":"model not found: claude-sonnet-9"}')).toBe("config");
    expect(classifyLeadModelError("400 Unknown model: gpt-9")).toBe("config");
  });
});

describe("leadTurnFailureSentence", () => {
  it("does not ask to retry, or promise a retry, when the model account needs checking", () => {
    for (const raw of [LIVE_AUTH, "401 Unauthorized", "Lead 模型连接认证失败，请重试。"]) {
      const user = leadTurnFailureSentence(raw, { system: false })!;
      expect(user).toBe("Paimon 的模型账号认证失败，这条消息没有得到回答；请先检查 Paimon 的模型账号，再发一次。");
      const system = leadTurnFailureSentence(raw, { system: true })!;
      expect(system).toBe("Paimon 的模型账号认证失败；系统没法自己恢复，请检查 Paimon 的模型账号。");
    }
  });

  it("says a retry happens only where the system really retries", () => {
    const raw = "503 Service Unavailable: upstream connect error";
    expect(leadTurnFailureSentence(raw, { system: true })).toBe("Paimon 的模型服务暂时连不上；系统会自动再试，你不需要操作。");
    expect(leadTurnFailureSentence(raw, { system: false }))
      .toBe("Paimon 的模型服务暂时连不上，这条消息没有得到回答；系统不会自动重发，你可以再发一次。");
    expect(leadTurnFailureSentence("the model refused the tool schema", { system: false })).toBeNull();
  });
});

// 2026-10-15 19:11–20:07 和 2026-10-16 09:29：Mac 睡眠、DarkWake 时 DNS 解析不了，代理报
// "500 … lookup api.anthropic.com: no such host"。这是网络断了，不是模型的问题：网络恢复以后系统接着做。
describe("network failures", () => {
  it("are told apart from model and provider failures", () => {
    for (const raw of [
      '500 Internal Server Error: {"error":"dial tcp: lookup api.anthropic.com: no such host"}',
      "getaddrinfo ENOTFOUND api.anthropic.com",
      "getaddrinfo EAI_AGAIN api.anthropic.com",
      "connect ENETUNREACH 34.36.0.1:443",
      "connect ECONNREFUSED 34.36.0.1:443",
      "read ECONNRESET",
      "net::ERR_INTERNET_DISCONNECTED",
    ]) expect(classifyLeadModelError(raw), raw).toBe("network");
    // 本机的模型代理没开：网络是好的，是模型服务连不上。
    expect(classifyLeadModelError("fetch failed: ECONNREFUSED 127.0.0.1:8317")).toBe("unavailable");
    expect(classifyLeadModelError("503 Service Unavailable")).toBe("unavailable");
    expect(leadModelFailureNeedsUser("network")).toBe(false);
    expect(leadModelFailureReason("network")).toBe("网络不可用");
  });

  it("are said as an outage the system resumes from", () => {
    const raw = "getaddrinfo ENOTFOUND api.anthropic.com";
    expect(leadTurnFailureSentence(raw, { system: true })).toBe("网络不可用，Paimon 这次没能调用模型；网络恢复后系统会继续，你不需要操作。");
    expect(leadTurnFailureSentence(raw, { system: false })).toBe("网络不可用，这条消息没有得到回答；你可以再发一次。");
  });
});

// 发布评审 f796c1c 的 B1：连接被拒或重置，本机网络却是通的（DNS 探测通过）：是模型服务或它的代理的问题，
// 按"模型服务连不上"走正常的降级和兜底，不当断网。本机代理在 IPv6 回环上没开，也是模型服务连不上。
describe("refused and reset connections", () => {
  it("count as the model service, not the network, when the local proxy is down on IPv6", () => {
    expect(classifyLeadModelError("connect ECONNREFUSED ::1:8317")).toBe("unavailable");
    expect(classifyLeadModelError("connect ECONNREFUSED [::1]:8317")).toBe("unavailable");
    expect(classifyLeadModelError("fetch failed: connect ECONNREFUSED localhost:8317")).toBe("unavailable");
    // fe80::1 不是回环地址。
    expect(classifyLeadModelError("connect ECONNREFUSED fe80::1:443")).toBe("network");
  });

  it("count as the model service once the daemon has checked that the network works", () => {
    const marked = markUpstreamFailure("read ECONNRESET");
    expect(classifyLeadModelError(marked)).toBe("unavailable");
    expect(markUpstreamFailure(marked)).toBe(marked);
  });
});

// 被 daemon 重启打断的一轮（2026-10-16 提醒 #83）：不是模型的问题，不叫人重发。
describe("a Lead turn interrupted by a daemon restart", () => {
  it("says the restart interrupted it, never that Lead gave no answer", () => {
    expect(leadTurnWaitingSentence(LEAD_RESTART_INTERRUPTED_ERROR, "model")).toBe("Paimon 正在重启，这条消息还没有得到回答。重启后会自动再答一次。");
    expect(leadTurnFailureSentence(LEAD_RESTART_INTERRUPTED_ERROR, { system: false }))
      .toBe("Paimon 的回复被重启打断；已经做完的事不会重做，重启后 Paimon 会接着回复你。");
    expect(leadTurnFailureSentence(LEAD_RESTART_INTERRUPTED_ERROR, { system: true }))
      .toBe("Paimon 的这一轮被重启打断；重启后系统会继续，你不需要操作。");
  });
});

// 2026-10-19 审查：超时、连接断开、fetch failed 没拿到模型服务的回答，可能只是本机网络在抖。daemon 先探网络再决定换不换模型。
describe("a failure that never reached the model service", () => {
  it("is told apart from an answer the service gave", () => {
    for (const raw of ["TypeError: fetch failed", "ETIMEDOUT", "socket hang up", "request timed out", "ECONNRESET"]) {
      expect(isLeadTransportFailure(raw), raw).toBe(true);
    }
    for (const raw of ["503 Service Unavailable", '503: {"message":"auth_unavailable"}', "connect ECONNREFUSED 127.0.0.1:8317",
      "模型服务连不上（本机网络正常）：fetch failed"]) {
      expect(isLeadTransportFailure(raw), raw).toBe(false);
    }
  });
});
