// Lead 的只读工具的凭证防护（2026-10-19 审查）。
// 事故：10-18 Lead 用 read 读了 ~/.cli-proxy-api/antigravity-<邮箱>.json，access_token 和 refresh_token 进了模型上下文，
// 也存进了 lead-sessions 的会话记录。
// 规则（用户 2026-10-19）：数据目录里的日志、runtime-events、sessions、plc.db 照常可以读；凭证文件拦住，结果里的密钥盖掉。
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import {
  credentialGuardExtension, credentialPathReason, dropCredentialLines, guardLeadToolCall, knownSecretValues,
  redactTokenLikeRuns, scrubLeadToolText,
} from "../src/credential-guard.js";

const home = "/Users/someone";
const dataDir = `${home}/.pi-lead-child`;
const context = { home, cwd: dataDir };

describe("which paths are credentials", () => {
  it("blocks the 10-18 OAuth file and the listed credential locations", () => {
    for (const path of [
      "~/.cli-proxy-api/antigravity-someone@example.com.json",
      `${home}/.ssh/id_ed25519`, "~/.ssh", "~/.aws/credentials", "~/.config/gcloud/application_default_credentials.json",
      "/repo/certs/server.pem", "/repo/tls.key", "/repo/client.p12", "/repo/client.pfx", "/repo/id_rsa.pub",
      "/repo/credentials.json", "/repo/secrets.yaml", "/repo/.env", "/repo/.env.production",
      "~/.codex/auth.json", "~/.pi/agent/auth.json", "~/.docker/config.json", "~/.netrc",
      // 数据目录里的凭证：CLI 凭证、保险库的密钥文件、Lead 自己的 agent/auth.json（相对路径按数据目录解析）。
      "cli-credential.json", "connections.key", "agent/auth.json",
    ]) {
      expect(credentialPathReason(path, context), path).not.toBeNull();
    }
  });

  it("lets Lead read the data directory's logs, events, sessions and ledger, and example env files", () => {
    for (const path of [
      "logs/daemon.log", "runtime-events/run-109.jsonl", "sessions/item-96/2026-10-19.jsonl", "plc.db", "config.json",
      "/repo/.env.example", "/repo/.env.sample", "/repo/.env.template", "/repo/src/index.ts", "~/notes.md",
    ]) {
      expect(credentialPathReason(path, context), path).toBeNull();
    }
  });

  it("resolves paths the way pi does: file:// URLs, @ prefixes, odd spaces (review finding 6)", () => {
    for (const path of [
      `file://${home}/.config/gh/hosts.yml`, `file://${home}/.kube/config`, `file://${home}/.docker/config.json`,
      "@~/.ssh/id_ed25519", "\u00A0~/.aws/config",
    ]) {
      expect(credentialPathReason(path, context), path).not.toBeNull();
    }
    expect(guardLeadToolCall("read", { path: `file://${home}/.config/gh/hosts.yml` }, context)).toMatch(/不能读凭证/);
  });

  it("blocks credentials* names including backups, but not source files like credentialStore.ts (review round 3, finding 5)", () => {
    for (const path of ["/repo/credentials", "/repo/credentials.toml", "/repo/credentials.bak.json", "/repo/credentials_old", "/repo/credentials-2026.json"]) {
      expect(credentialPathReason(path, context), path).not.toBeNull();
    }
    for (const path of ["/repo/packages/client/src/credentialStore.ts", "/repo/credentials-helper.md", "/repo/src/credentials.ts", "/repo/credentialsManager.py"]) {
      expect(credentialPathReason(path, context), path).toBeNull();
    }
  });

  it("only guards the four file tools, and says what to do instead", () => {
    expect(guardLeadToolCall("read", { path: "~/.cli-proxy-api/a.json" }, context)).toMatch(/不能读凭证/);
    expect(guardLeadToolCall("grep", { pattern: "token", path: "~/.aws" }, context)).toMatch(/凭证目录/);
    expect(guardLeadToolCall("ls", {}, context)).toBeNull();
    expect(guardLeadToolCall("query_tickets", { path: "~/.ssh" }, context)).toBeNull();
  });
});

describe("tool results", () => {
  it("drops grep and find lines that point into credential files when the search starts above them", () => {
    const grep = [
      ".cli-proxy-api/antigravity-a@b.com.json:3:   \"refresh_token\": \"1//0gAbC\"",
      ".ssh/config-2- Host github.com",
      "Workspace/app/src/token.ts:12: export const name = 'x';",
    ].join("\n");
    const filtered = dropCredentialLines("grep", grep, home, context);
    expect(filtered).toEqual({ text: "Workspace/app/src/token.ts:12: export const name = 'x';", dropped: 2 });
    const find = dropCredentialLines("find", ".aws/credentials\nWorkspace/app/package.json\nrepo/.env", home, context);
    expect(find).toEqual({ text: "Workspace/app/package.json", dropped: 2 });
    // ls 列名字：凭证目录的名字可以看到，凭证文件不行。
    expect(dropCredentialLines("ls", ".ssh/\n.zshrc\nid_rsa", home, context)).toEqual({ text: ".ssh/\n.zshrc", dropped: 1 });
  });

  it("masks token-shaped strings but keeps commit ids, UUIDs, paths and identifiers", () => {
    const token = "ya29a0AfB_byC8kQ2xLm9Zp4Rt7Vw1Ns6Jd3Hg5Fk0Pq8Ue2Yi4To6Ar1Sb3Dc";
    expect(redactTokenLikeRuns(`access ${token} end`)).toBe("access [REDACTED] end");
    for (const keep of [
      "28390d7777a10ec926af4f3102b1f3f415b90754",
      "0194f0b2-7c1e-7a3b-9f2e-1d2c3b4a5f60",
      "-Users-b-wen-Workspace-AI-pi-lead-child--claude-worktrees-clever-blackburn-3a459b",
      "createGrantedLeadToolsForTheSessionWithAllCapabilities",
    ]) {
      expect(redactTokenLikeRuns(keep)).toBe(keep);
    }
  });

  it("masks known secret values, OAuth fields and config.json env values", () => {
    const dir = tempDir("plc-credential-guard-");
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ env: {
      CUSTOM_ENDPOINT_TOKEN: { value: "cfg-9f8e7d6c5b4a3f2e1d0c" }, LEAD_MODEL: { value: "antigravity/gemini-3-pro-2026" },
    } }));
    const values = knownSecretValues({
      AM_API_KEY: "am-live-0123456789abcdef", SSH_AUTH_SOCK: "/private/tmp/agent.sock", HOME: home,
      // 名字像密钥、值不像（审查发现 7）：不盖，否则 antigravity/gemini-3 会变成 [REDACTED]/gemini-3。
      PI_MODEL_KEY: "antigravity/gemini-3", LEAD_MODEL: "antigravity/gemini-3-pro-2026",
    }, config);
    expect(values).toEqual(expect.arrayContaining(["am-live-0123456789abcdef", "cfg-9f8e7d6c5b4a3f2e1d0c"]));
    expect(values).not.toContain("/private/tmp/agent.sock");
    expect(values).not.toContain("antigravity/gemini-3");
    expect(values).not.toContain("antigravity/gemini-3-pro-2026");
    const text = [
      "AM_API_KEY=am-live-0123456789abcdef",
      "seen again: am-live-0123456789abcdef",
      "{\"access_token\": \"abc.def\", \"refresh_token\": \"1//xyz\", \"expiry\": 3600}",
      "config value cfg-9f8e7d6c5b4a3f2e1d0c",
    ].join("\n");
    const clean = scrubLeadToolText(text, values);
    expect(clean).not.toContain("am-live-0123456789abcdef");
    expect(clean).not.toContain("cfg-9f8e7d6c5b4a3f2e1d0c");
    expect(clean).not.toContain("1//xyz");
    expect(clean).toContain("\"expiry\": 3600");
  });
});

describe("the pi extension", () => {
  type Handler = (event: any) => any;
  function load(cwd: string, secrets: string[] = []) {
    const handlers = new Map<string, Handler>();
    const pi = { on: (name: string, handler: Handler) => { handlers.set(name, handler); return () => {}; } };
    credentialGuardExtension({ cwd, home, secretValues: () => secrets })(pi as never);
    return { call: handlers.get("tool_call")!, result: handlers.get("tool_result")! };
  }

  it("blocks the read, and scrubs what the read tools return", () => {
    const { call, result } = load(dataDir, ["am-live-0123456789abcdef"]);
    expect(call({ toolName: "read", input: { path: "~/.cli-proxy-api/antigravity-a@b.com.json" } }))
      .toMatchObject({ block: true, reason: expect.stringContaining("凭证") });
    expect(call({ toolName: "read", input: { path: "runtime-events/run-109.jsonl" } })).toBeUndefined();
    const out = result({
      toolName: "read", input: { path: "runtime-events/run-109.jsonl" },
      content: [{ type: "text", text: "{\"output\":\"AM_API_KEY=am-live-0123456789abcdef\"}" }],
    });
    expect(out.content[0].text).not.toContain("am-live-0123456789abcdef");
    // 别的工具只盖已知的值。
    expect(result({ toolName: "get_ticket", input: {}, content: [{ type: "text", text: "nothing secret" }] })).toBeUndefined();
    expect(result({ toolName: "get_ticket", input: {}, content: [{ type: "text", text: "key am-live-0123456789abcdef" }] })
      .content[0].text).toBe("key [REDACTED]");
  });

  it("follows a symlink that points into a credential directory", () => {
    const root = tempDir("plc-credential-guard-link-");
    const fakeHome = join(root, "home");
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    writeFileSync(join(fakeHome, ".ssh", "config"), "Host x");
    symlinkSync(join(fakeHome, ".ssh"), join(root, "innocent"));
    expect(credentialPathReason(join(root, "innocent", "config"), { home: fakeHome, cwd: root })).not.toBeNull();
  });
});
