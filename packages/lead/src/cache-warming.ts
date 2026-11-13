import type { ExtensionFactory, SettingsManager } from "@earendil-works/pi-coding-agent";

// Prompt cache warming between runs (pi 1.5.2 changed the `cacheWarming` default from "streaming" to "idle").
// With "idle", pi keeps sending cache refresh requests for up to 30 minutes after each run when it expects them to pay
// off. Lead is always on, so that would add paid background requests on its session after every turn. Lead keeps the
// previous behavior: pi may warm the cache while a run is going, and stops warming once the run settles. A user who sets
// `cacheWarming` in Lead's pi settings (agent/settings.json in the data directory) gets what they set.

/** Whether Lead's pi settings set `cacheWarming` themselves. */
export function cacheWarmingConfigured(settingsManager: Pick<SettingsManager, "getGlobalSettings">): boolean {
  return settingsManager.getGlobalSettings().cacheWarming !== undefined;
}

/** Stops cache warming between runs, unless the settings set `cacheWarming`. */
export function leadCacheWarmingExtension(configured: () => boolean): ExtensionFactory {
  return (pi) => {
    let running = false;
    pi.on("agent_start", () => {
      running = true;
    });
    pi.on("agent_settled", () => {
      running = false;
    });
    pi.on("cache_warming_decision", () => (running || configured() ? undefined : { action: "stop" }));
  };
}
