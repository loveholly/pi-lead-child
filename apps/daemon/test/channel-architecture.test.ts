// 工单 11（spec D14）的架构测试：通道的内核里不出现具体来源的名字。先例是 runtime 的 runtime-architecture.test.ts。
// 内核是 engine 的 channels/（来源插件 sources/ 和装配处 builtin.ts 除外），以及别的包里接通道的模块：
// 投递、闸门、出站、分道、会话卡、Lead 的当前局面、网关的路由、daemon 的装配，都只认通道接口和 registry。
// 检查的对象是代码，不是注释：先用 esbuild 去掉注释和类型，再找来源的名字。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { DAEMON_ONLY_ENV_NAMES } from "@pi-lead-child/core";
import { BUILTIN_CHANNEL_SECRETS, BUILTIN_CHANNEL_SOURCES, builtinChannelAdapters, liveBuiltinChannels } from "@pi-lead-child/engine";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CHANNEL_DIR = join(ROOT, "packages/engine/src/channels");
// 允许写来源名字的地方：来源插件本身，和装配处。
const ALLOWED = new Set(["packages/engine/src/channels/builtin.ts"]);
const isPlugin = (path: string) => path.startsWith("packages/engine/src/channels/sources/");

// 别的包里接通道的模块。
const KERNEL_MODULES = [
  "packages/protocol/src/channel-policy.ts",
  "packages/protocol/src/channel-lookup.ts",
  "packages/protocol/src/channels.ts",
  "packages/protocol/src/events.ts",
  "packages/protocol/src/standing-orders.ts",
  "packages/protocol/src/standing-order-tiers.ts",
  "packages/store/src/channels.ts",
  "packages/store/src/channel-lookups.ts",
  "packages/store/src/standing-orders.ts",
  "packages/store/src/standing-order-seeds.ts",
  "packages/store/src/event-triage.ts",
  "packages/lead/src/situation.ts",
  "packages/lead/src/channel-tools.ts",
  "packages/gateway/src/channel-routes.ts",
  "apps/daemon/src/channels.ts",
  "apps/daemon/src/lead-input.ts",
  "apps/daemon/src/lookup.ts",
  // 子 agent 工单的派单器（落地计划 C1）。
  "apps/daemon/src/agent-tasks.ts",
  // 通道的凭据设置（slack-settings 工单 S1）：网关的路由、daemon 的保存和状态。契约（protocol 的 channel-settings.ts）
  // 对象字面量里的注释举了来源的例子，esbuild 留着它们，所以不在这里扫。
  "packages/gateway/src/channel-settings-routes.ts",
  "apps/daemon/src/channel-settings.ts",
];

// 冻结的文本片段：已经写进库的种子内容（改它要加种子的修订号，会给每个库写新版本），不是内核的决定。扫描前去掉。
const FROZEN_FRAGMENTS: Record<string, RegExp[]> = {
  "packages/store/src/standing-order-seeds.ts": [/外部来源（Slack、webhook 等，还没接）/g],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function runtimeCode(path: string): string {
  let code = transformSync(readFileSync(join(ROOT, path), "utf8"), { loader: "ts", format: "esm", charset: "utf8" }).code;
  for (const fragment of FROZEN_FRAGMENTS[path] ?? []) code = code.replace(fragment, "");
  return code;
}

describe("the channel kernel does not name a source (spec D14)", () => {
  const channelFiles = sourceFiles(CHANNEL_DIR).map((file) => relative(ROOT, file));
  const kernel = [...channelFiles.filter((path) => !ALLOWED.has(path) && !isPlugin(path)), ...KERNEL_MODULES];

  it("covers the hub, gates, delivery, urgency, intake, reply check, disclosure, outbound, registry and the shared inbound layer", () => {
    expect(kernel).toEqual(expect.arrayContaining([
      "packages/engine/src/channels/hub.ts", "packages/engine/src/channels/delegation-gate.ts", "packages/engine/src/channels/authority.ts",
      "packages/engine/src/channels/delivery.ts", "packages/engine/src/channels/urgency.ts", "packages/engine/src/channels/outbound.ts",
      "packages/engine/src/channels/registry.ts",
      // 请求 A、请求 B、信心模型和回复决定（落地计划 A4–A6）。
      "packages/engine/src/channels/intake.ts", "packages/engine/src/channels/reply-check.ts", "packages/engine/src/channels/reply-gate.ts",
      "packages/engine/src/channels/confidence-model.ts", "packages/engine/src/channels/reply-decision.ts",
      "packages/engine/src/channels/disclosure.ts", "packages/engine/src/channels/self-reply.ts",
      "packages/engine/src/channels/lookup-dto.ts",
      // 外部通道共用的入站层（统一消息事件 spec D2，工单 03）和上下文包（spec D5，工单 04）。
      "packages/engine/src/channels/inbound.ts", "packages/engine/src/channels/context-pack.ts",
    ]));
    expect(channelFiles.filter(isPlugin).length).toBeGreaterThan(0);
  });

  it("has no built-in source's name in its code", () => {
    const names = new RegExp(BUILTIN_CHANNEL_SOURCES.join("|"), "i");
    const found = kernel.flatMap((path) => names.test(runtimeCode(path)) ? [path] : []);
    expect(found).toEqual([]);
  });
});

// slack-takeover 工单 02：内置来源声明的密钥只给 daemon 用（child 继承 daemon 的环境，DAEMON_ONLY_ENV_NAMES 里的名字被去掉）；
// 生产入口接上的适配器声明的就是这些名字，daemon 按名字通用地取。
describe("the built-in sources' secrets are daemon-only", () => {
  it("lists every declared secret name in DAEMON_ONLY_ENV_NAMES", () => {
    const names = Object.values(BUILTIN_CHANNEL_SECRETS).flat();
    expect(names.length).toBeGreaterThan(0);
    expect(DAEMON_ONLY_ENV_NAMES).toEqual(expect.arrayContaining(names));
    const live = liveBuiltinChannels(() => "present");
    expect(live.missing).toEqual([]);
    for (const adapter of builtinChannelAdapters(live.sources)) {
      expect(adapter.auth.secrets).toEqual(BUILTIN_CHANNEL_SECRETS[adapter.id as keyof typeof BUILTIN_CHANNEL_SECRETS]);
      expect(adapter.transport).toBeDefined();
    }
    // 缺密钥时照样接上（传输等用户在设置页存了密钥再启动），给出缺的名字。设置页的密钥就是声明的那几个。
    const none = liveBuiltinChannels(() => null);
    expect(none.missing).toEqual(
      Object.entries(BUILTIN_CHANNEL_SECRETS).map(([source, secrets]) => ({ source, names: [...secrets] })),
    );
    const unconfigured = builtinChannelAdapters(none.sources);
    expect(unconfigured.map((adapter) => adapter.id)).toEqual([...BUILTIN_CHANNEL_SOURCES]);
    for (const adapter of unconfigured) {
      expect(adapter.settings?.secrets.map((secret) => secret.name)).toEqual(adapter.auth.secrets);
    }
  });
});
