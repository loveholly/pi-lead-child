import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cacheWarmingConfigured, leadCacheWarmingExtension } from "../src/cache-warming.js";

function harness(configured: boolean) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown) => unknown) => void handlers.set(name, handler) };
  leadCacheWarmingExtension(() => configured)(pi as unknown as ExtensionAPI);
  const fire = (name: string, event: unknown = { type: name }) => handlers.get(name)?.(event);
  const decide = () => fire("cache_warming_decision", {
    type: "cache_warming_decision", warmCost: 0.01, missCost: 1, continuationProbability: 0.15, action: "warm",
  });
  return { fire, decide };
}

// pi 1.5.2 warms the prompt cache between runs by default ("idle"). Lead keeps the earlier "streaming" behavior.
describe("Lead prompt cache warming", () => {
  it("leaves pi's decision alone while a run is going and stops warming once the run settles", () => {
    const { fire, decide } = harness(false);
    expect(decide()).toEqual({ action: "stop" });
    fire("agent_start");
    expect(decide()).toBeUndefined();
    fire("agent_settled", { type: "agent_settled", aborted: false });
    expect(decide()).toEqual({ action: "stop" });
  });

  it("leaves pi's decision alone between runs when Lead's pi settings set cacheWarming", () => {
    const { fire, decide } = harness(true);
    fire("agent_start");
    fire("agent_settled", { type: "agent_settled", aborted: false });
    expect(decide()).toBeUndefined();
  });

  it("counts cacheWarming as set only when the global settings name it", () => {
    expect(cacheWarmingConfigured({ getGlobalSettings: () => ({}) })).toBe(false);
    expect(cacheWarmingConfigured({ getGlobalSettings: () => ({ cacheWarming: "idle" }) })).toBe(true);
  });
});
