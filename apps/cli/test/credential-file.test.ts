// plc 的网关凭证文件：第一次需要时在 plc.sock 上签发，之后复用。权限 0600，token 从不打印。
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { credentialPath, loadOrMintCliCredential, readCliCredential } from "../src/credential-file.js";

let dir: string;
beforeEach(() => { dir = tempDir("plc-credential-"); });

const issued = {
  accessToken: "tok_secret",
  binding: { id: 9, kind: "cli", name: "plc", scopes: ["chat" as const, "admin" as const] },
  gatewayUrl: "http://127.0.0.1:47130",
};

describe("the plc credential file", () => {
  it("mints a credential once, stores it with mode 0600, and reuses it", async () => {
    let mints = 0;
    const notices: string[] = [];
    const path = credentialPath(dir);
    const deps = { path, mint: async () => { mints += 1; return issued; }, notice: (line: string) => notices.push(line) };
    const first = await loadOrMintCliCredential(deps);
    const second = await loadOrMintCliCredential(deps);
    expect(mints).toBe(1);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ version: 1, accessToken: "tok_secret", binding: issued.binding });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("binding #9");
    expect(notices[0]).not.toContain("tok_secret");
    // 网关地址不进文件：端口可能随重启变化，每次都从 plc.sock 拿。
    expect(readFileSync(path, "utf8")).not.toContain("47130");
  });

  it("tightens a credential file that others can read", () => {
    const path = credentialPath(dir);
    writeFileSync(path, JSON.stringify({ version: 1, accessToken: "t", binding: issued.binding, issuedAt: "x" }));
    chmodSync(path, 0o644);
    expect(readCliCredential(path)?.accessToken).toBe("t");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("mints a new credential when the file is corrupt", async () => {
    const path = credentialPath(dir);
    writeFileSync(path, "{ not json");
    const credential = await loadOrMintCliCredential({ path, mint: async () => issued, notice: () => {} });
    expect(credential.accessToken).toBe("tok_secret");
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });
});
