// supervisor 从 Keychain 注入 daemon 环境的变量（KEYCHAIN_ENV_KEYS）一定是密钥：记录 child 的事件和会话时，
// 它们的值不看长相就盖掉（protocol 的 KNOWN_SECRET_ENV_NAMES）。两份清单要一致。
import { describe, expect, it } from "vitest";
import { KNOWN_SECRET_ENV_NAMES } from "@pi-lead-child/protocol";
import { sandboxSecrets } from "@pi-lead-child/core";
import { KEYCHAIN_ENV_KEYS } from "../src/deploy/keychain.js";

describe("the Keychain-injected keys", () => {
  it("are all known secrets for redaction", () => {
    expect([...KNOWN_SECRET_ENV_NAMES].sort()).toEqual([...KEYCHAIN_ENV_KEYS].sort());
  });

  // 2026-10-29：~/.npmrc 用 ${NPM_TOKEN} 认证，值在钥匙串里。沙箱读不了钥匙串，npm、pnpm 读 .npmrc 就报错（#159）。
  // supervisor 把它注入 daemon 的环境，沙箱里只看到占位值，发往 registry.npmjs.org 时代理换成真值。
  it("bring NPM_TOKEN into the sandbox only as a placeholder bound to the npm registry", () => {
    expect(KEYCHAIN_ENV_KEYS).toContain("NPM_TOKEN");
    expect(sandboxSecrets({ NPM_TOKEN: "npm_1234567890abcdefABCDEF" }).masked).toEqual([{ name: "NPM_TOKEN", injectHosts: ["registry.npmjs.org"] }]);
  });
});
