// NetworkMonitor 怎么认「到模型服务的路被拦了」（2026-11-06）：休眠中短暂唤醒时 DNS 通了，流量却没有走 VPN，
// Anthropic 按来源地区回 403 "Request not allowed"。DNS 探测看不出这一种，要发一个不带 key 的请求：
// 回 401 说明路是通的（只是缺 key），回 403 说明来源还被拦着。
import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkMonitor } from "../src/network.js";

const ROUTE_BLOCKED = '403: {"type":"forbidden","message":"Request not allowed"}';
const DNS_DOWN = "getaddrinfo ENOTFOUND api.anthropic.com";

function monitor(state: { dns: string | null; route: string | null }, routeMaxWaitMs?: number) {
  const restored: string[] = [];
  const down: string[] = [];
  const probed: string[] = [];
  const instance = new NetworkMonitor({
    probe: async () => { probed.push("dns"); return state.dns; },
    routeProbe: async () => { probed.push("route"); return state.route; },
    onDown: (detail) => down.push(detail),
    onRestored: (how) => restored.push(how),
    retryBaseMs: 60_000,
    ...(routeMaxWaitMs === undefined ? {} : { routeMaxWaitMs }),
  });
  monitors.push(instance);
  return { instance, restored, down, probed };
}

const monitors: NetworkMonitor[] = [];
afterEach(() => {
  for (const instance of monitors.splice(0)) instance.stop();
  vi.useRealTimers();
});

describe("a blocked route to the model service", () => {
  it("is confirmed by the keyless probe, even while DNS works", async () => {
    const { instance, down, probed } = monitor({ dns: null, route: "blocked" });
    expect(await instance.confirmOutage(ROUTE_BLOCKED)).toBe(true);
    expect(instance.online).toBe(false);
    expect(down).toEqual([ROUTE_BLOCKED]);
    expect(probed).toEqual(["route"]);
  });

  it("is the model service's problem when the keyless probe gets through", async () => {
    const { instance, down } = monitor({ dns: null, route: null });
    expect(await instance.confirmOutage(ROUTE_BLOCKED)).toBe(false);
    expect(instance.online).toBe(true);
    expect(down).toEqual([]);
  });

  it("stays down until the keyless probe gets through, not until DNS answers", async () => {
    const state = { dns: null as string | null, route: "blocked" as string | null };
    const { instance, restored } = monitor(state);
    await instance.confirmOutage(ROUTE_BLOCKED);
    expect(await instance.check()).toBe(false);
    expect(restored).toEqual([]);

    state.route = null;
    expect(await instance.check()).toBe(true);
    expect(restored).toEqual(["probe"]);
  });

  // 代理和 daemon 可能走不同的路（代理配了自己的上游代理）：daemon 的探测一直被拦，代理那边已经好了。
  // 最多等 routeMaxWaitMs，然后放一次模型调用过去，不让 Lead 一直等。
  it("lets one model call through after the longest wait, then waits again if the route is still blocked", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const { instance, restored } = monitor({ dns: null, route: "blocked" }, 1_000);
    await instance.confirmOutage(ROUTE_BLOCKED);

    vi.setSystemTime(999);
    expect(await instance.check()).toBe(false);
    vi.setSystemTime(1_000);
    expect(await instance.check()).toBe(true);
    expect(restored).toEqual(["waited"]);

    // 放过去的那一次又被拦：重新等满一段。
    expect(await instance.confirmOutage(ROUTE_BLOCKED)).toBe(true);
    vi.setSystemTime(1_500);
    expect(await instance.check()).toBe(false);
  });

  it("does not change how other network failures are checked", async () => {
    const state = { dns: null as string | null, route: "blocked" as string | null };
    const { instance, probed } = monitor(state);
    // DNS 是通的：连接被重置是模型服务的问题，不看不带 key 的探测。
    expect(await instance.confirmOutage("read ECONNRESET")).toBe(false);
    state.dns = DNS_DOWN;
    expect(await instance.confirmOutage(DNS_DOWN)).toBe(true);
    state.dns = null;
    expect(await instance.check()).toBe(true);
    expect(probed).toEqual(["dns", "dns", "dns"]);
  });
});
