// 判定边界上的小单元：保险库的 AAD 绑定、WWW-Authenticate 的解析、资源元数据的冒充检查、PKCE、SSE 响应、账号名。
import { randomBytes } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { Vault, connectionSecretAad, fileKeySource } from "../src/vault.js";
import { discover, exchangeCode, parseBearerChallenge, requestedScope, OAuthError } from "../src/oauth.js";
import { McpHttpClient } from "../src/mcp-client.js";
import { backoffMs, pickAccount } from "../src/hub.js";
import { loadConnectionsConfig, normalizeCustomServerUrl } from "../src/catalog.js";
import { FakeVendor } from "../testing/fake-vendor.js";

describe("the vault", () => {
  it("opens only with the same row and version it was sealed for", () => {
    const vault = new Vault(randomBytes(32));
    const sealed = vault.seal({ accessToken: "secret" }, connectionSecretAad(1, 2));
    expect(vault.open(sealed, connectionSecretAad(1, 2))).toEqual({ accessToken: "secret" });
    expect(() => vault.open(sealed, connectionSecretAad(1, 1))).toThrow();
    expect(() => vault.open(sealed, connectionSecretAad(2, 2))).toThrow();
    expect(() => new Vault(randomBytes(32)).open(sealed, connectionSecretAad(1, 2))).toThrow();
  });

  it("keeps a file key at mode 0600 and returns the same key next time", () => {
    const path = join(tempDir("plc-vault-"), "keys", "connections.key");
    const first = fileKeySource(path).load();
    expect(fileKeySource(path).load().equals(first)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("OAuth discovery", () => {
  it("parses the resource metadata URL, scope and error from a Bearer challenge", () => {
    expect(parseBearerChallenge('Bearer resource_metadata="https://x.test/.well-known/oauth-protected-resource", scope="a b", error="insufficient_scope"'))
      .toEqual({ resourceMetadata: "https://x.test/.well-known/oauth-protected-resource", scope: "a b", error: "insufficient_scope" });
    expect(parseBearerChallenge("Basic realm=x")).toEqual({ resourceMetadata: null, scope: null, error: null });
  });

  it("rejects resource metadata that names a different resource", async () => {
    const vendor = new FakeVendor(() => Date.now());
    const fetchImpl: typeof vendor.fetch = async (input, init) => {
      if (input.includes("oauth-protected-resource")) {
        return new Response(JSON.stringify({ resource: "https://other.test/mcp", authorization_servers: [vendor.issuer] }), { status: 200 });
      }
      return vendor.fetch(input, init);
    };
    await expect(discover(fetchImpl, vendor.mcpUrl)).rejects.toThrow(/not https:\/\/mcp.fake.test\/mcp/);
  });

  // MCP 服务器在 /mcp。401 的 resource_metadata 指向 hint（null 时不带，走 well-known 回退）；只有 at 这个地址返回元数据。
  function metadataAt(vendor: FakeVendor, input: { hint: string | null; at: string; resource: string }): typeof vendor.fetch {
    return async (url, init) => {
      if (url === vendor.mcpUrl && init?.method === "POST" && !new Headers(init.headers).has("authorization")) {
        return new Response(null, { status: 401, headers: input.hint ? { "www-authenticate": `Bearer resource_metadata="${input.hint}"` } : {} });
      }
      if (url === input.at) return new Response(JSON.stringify({ resource: input.resource, authorization_servers: [vendor.issuer] }), { status: 200 });
      if (url.includes("oauth-protected-resource")) return new Response(null, { status: 404 });
      return vendor.fetch(url, init);
    };
  }

  it("accepts the origin as resource when the metadata comes from the origin's own well-known address (Slack's shape)", async () => {
    const vendor = new FakeVendor(() => Date.now());
    const root = "https://mcp.fake.test/.well-known/oauth-protected-resource";
    for (const hint of [root, null]) {
      const discovery = await discover(metadataAt(vendor, { hint, at: root, resource: "https://mcp.fake.test" }), vendor.mcpUrl);
      expect(discovery.resource?.resource).toBe("https://mcp.fake.test");
    }
  });

  it("rejects a parent resource from any other metadata document (RFC 9728 §3.3)", async () => {
    const vendor = new FakeVendor(() => Date.now());
    for (const at of ["https://mcp.fake.test/.well-known/oauth-protected-resource/mcp", "https://mcp.fake.test/mcp/metadata.json"]) {
      await expect(discover(metadataAt(vendor, { hint: at, at, resource: "https://mcp.fake.test" }), vendor.mcpUrl)).rejects.toThrow(/resource metadata is for/);
    }
  });

  it("rejects resource metadata for a sibling path, a lookalike prefix, another scheme or another port", async () => {
    const vendor = new FakeVendor(() => Date.now());
    for (const resource of ["https://mcp.fake.test/mcp2", "https://mcp.fake.test/m", "https://mcp.fake.test/other", "https://mcp.fake.test.evil.test", "http://mcp.fake.test", "https://mcp.fake.test:8443"]) {
      const fetchImpl: typeof vendor.fetch = async (input, init) => {
        if (input.includes("oauth-protected-resource")) {
          return new Response(JSON.stringify({ resource, authorization_servers: [vendor.issuer] }), { status: 200 });
        }
        return vendor.fetch(input, init);
      };
      await expect(discover(fetchImpl, vendor.mcpUrl)).rejects.toThrow(/resource metadata is for/);
    }
  });

  it("finds the metadata of an issuer with a path at the RFC 8414 address", async () => {
    const vendor = new FakeVendor(() => Date.now(), { issuer: "https://auth.fake.test/tenant-1" });
    const discovery = await discover(vendor.fetch, vendor.mcpUrl);
    expect(discovery.server).toMatchObject({ issuer: "https://auth.fake.test/tenant-1", token_endpoint: "https://auth.fake.test/tenant-1/token" });
  });

  it("asks for the challenge scope plus offline_access", async () => {
    const vendor = new FakeVendor(() => Date.now());
    const discovery = await discover(vendor.fetch, vendor.mcpUrl);
    expect(requestedScope(discovery)).toBe("read write offline_access");
  });

  it("refuses plain HTTP to anything but loopback", async () => {
    await expect(discover(async () => new Response(null), "http://mcp.example.test/mcp")).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("token exchange", () => {
  const server = { issuer: "https://auth.fake.test", authorization_endpoint: "https://auth.fake.test/authorize", token_endpoint: "https://auth.fake.test/token", token_endpoint_auth_methods_supported: ["client_secret_post"] };
  const input = { code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1/oauth/callback", resource: "https://mcp.fake.test/mcp" };

  it("reports the error code of a 200 response that carries ok:false and no token", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error: "bad_redirect_uri" }), { status: 200 });
    await expect(exchangeCode(fetchImpl, server, { clientId: "id", clientSecret: "s" }, input)).rejects.toThrow(/no access_token \(the server says: bad_redirect_uri\)/);
  });

  it("never echoes the response body into the message", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error: "x y z", refresh_token: "secret-refresh" }), { status: 200 });
    await expect(exchangeCode(fetchImpl, server, { clientId: "id", clientSecret: "s" }, input)).rejects.toThrow(/^token response has no access_token$/);
  });
});

describe("the MCP client", () => {
  it("reads the reply out of an SSE stream and skips notifications", async () => {
    const vendor = new FakeVendor(() => Date.now(), { sse: true });
    vendor.access.set("token", { expiresAt: Number.MAX_SAFE_INTEGER, grant: { id: "g", clientId: "c", revoked: false } });
    const client = new McpHttpClient({ url: vendor.mcpUrl, fetch: vendor.fetch, token: async () => "token" });
    expect((await client.listTools()).map((tool) => tool.name)).toEqual(["search_pages", "update_page", "get_self"]);
    expect((await client.callTool("search_pages", { query: "x" })).content[0]).toMatchObject({ type: "text" });
    expect(vendor.calls.map((call) => call.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  });
});

describe("small rules", () => {
  it("backs off from 15 s, doubling, up to 5 min", () => {
    expect([1, 2, 3, 5, 9].map(backoffMs)).toEqual([15_000, 30_000, 60_000, 240_000, 300_000]);
  });

  it("picks an account name from a whoami result", () => {
    expect(pickAccount(JSON.stringify({ user: { name: "You", email: "you@acme.test" } }))).toBe("you@acme.test");
    expect(pickAccount(JSON.stringify({ login: "octo" }))).toBe("@octo");
    expect(pickAccount("Signed in as you@acme.test")).toBe("you@acme.test");
    expect(pickAccount("nothing here")).toBeNull();
  });

  it("accepts only HTTPS custom servers", () => {
    expect(normalizeCustomServerUrl(" https://mcp.example.com/mcp#x ")).toBe("https://mcp.example.com/mcp");
    expect(() => normalizeCustomServerUrl("http://mcp.example.com/mcp")).toThrow(/https/);
    expect(() => normalizeCustomServerUrl("https://user:pw@mcp.example.com")).toThrow(/user name/);
    // 设置页显示这个错误：按用户选的语言写。
    expect(() => normalizeCustomServerUrl("https://user:pw@mcp.example.com", "zh")).toThrow(/用户名/);
    expect(() => normalizeCustomServerUrl("mcp.example.com", "zh")).toThrow("请输入一个完整的地址");
  });

  it("reads pre-registered client IDs from config.json and lets the environment win", () => {
    const dir = tempDir("plc-conn-config-");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ connections: { slack: { clientId: "123.456" } } }));
    expect(loadConnectionsConfig(dir, {}).clients.slack).toEqual({ clientId: "123.456", secretName: "PLC_SLACK_CLIENT_SECRET" });
    expect(loadConnectionsConfig(dir, { PLC_SLACK_CLIENT_ID: "999.1" }).clients.slack?.clientId).toBe("999.1");
    expect(loadConnectionsConfig(dir, { PLC_GITHUB_CLIENT_ID: "bad id!" }).clients.github).toBeUndefined();
  });
});
