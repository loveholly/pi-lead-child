// plc 的网关凭证：数据目录里的 cli-credential.json，权限 0600。第一次需要时在 plc.sock 上
// 换一个 kind=cli 的 binding（没有 admin，也不能做用户的决定，见 store 的 CLI_CREDENTIAL_SCOPES）。
// token 只在这个文件和请求头里，从不打印。
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@pi-lead-child/core";
import type { BindingDto, CliCredentialResponse } from "@pi-lead-child/protocol";

export const credentialPath = (dir: string = dataDir()) => join(dir, "cli-credential.json");

export interface StoredCliCredential {
  version: 1;
  accessToken: string;
  binding: BindingDto;
  issuedAt: string;
}

function isStoredCredential(value: unknown): value is StoredCliCredential {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredCliCredential>;
  return record.version === 1
    && typeof record.accessToken === "string" && record.accessToken.length > 0
    && !!record.binding && Number.isInteger(record.binding.id)
    && typeof record.binding.kind === "string" && typeof record.binding.name === "string"
    && Array.isArray(record.binding.scopes)
    && typeof record.issuedAt === "string";
}

// 文件不存在或内容不可用时返回 null。权限比 0600 宽时先收紧。
export function readCliCredential(path: string = credentialPath()): StoredCliCredential | null {
  if (!existsSync(path)) return null;
  if (statSync(path).mode & 0o077) chmodSync(path, 0o600);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isStoredCredential(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 先写临时文件再改名：写到一半中断时，旧凭证还在。
export function writeCliCredential(credential: StoredCliCredential, path: string = credentialPath()): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(credential, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function storedCredential(issued: CliCredentialResponse, now = new Date()): StoredCliCredential {
  return { version: 1, accessToken: issued.accessToken, binding: issued.binding, issuedAt: now.toISOString() };
}

export interface LoadCredentialDeps {
  path?: string;
  mint: () => Promise<CliCredentialResponse>;
  notice: (line: string) => void;
}

export async function loadOrMintCliCredential(deps: LoadCredentialDeps): Promise<StoredCliCredential> {
  const path = deps.path ?? credentialPath();
  const existing = readCliCredential(path);
  if (existing) return existing;
  const minted = storedCredential(await deps.mint());
  writeCliCredential(minted, path);
  deps.notice(`已为 plc 签发网关凭证：binding #${minted.binding.id}（kind=cli），保存在 ${path}`);
  return minted;
}
