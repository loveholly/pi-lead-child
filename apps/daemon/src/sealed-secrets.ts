// 加密存在 kv 里的密钥（保险库，packages/connections 的 vault；连接的令牌也用它）。设置页存的密钥都在这里：
// 记忆的 key（memory-controller.ts）、外部通道的令牌（channel-settings.ts）。
//   - 一行是 kv 的 secret.<名字>，值是密文（base64）。AAD 是 plc-secret:<名字>：一个名字的密文换不到另一个名字下面。
//   - 明文不进 config.json，也不进 process.env：child 继承 daemon 的全部环境。
//   - plc doctor 只看这一行在不在（不解密），据此说「来源：设置页」。
import type { SecretVault } from "@pi-lead-child/connections";
import type { Db } from "@pi-lead-child/store";

// 一个存下的密钥和它绑定的主机。只在本机用的（例如 Hindsight 自己的 key、通道的令牌）host 是 null。
export interface StoredSecret {
  value: string;
  host: string | null;
}

/** 密钥在 kv 里的那一行的键。 */
export function sealedSecretKey(name: string): string {
  return `secret.${name}`;
}

export class SealedSecrets<Name extends string = string> {
  constructor(private readonly db: Db, private readonly vault: SecretVault) {}

  /** 解开一个密钥。没有时是 null。解不开（保险库的密钥换了、密文坏了）时抛错。 */
  get(name: Name): StoredSecret | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(sealedSecretKey(name)) as { value: string } | undefined;
    if (!row) return null;
    const opened = this.vault.open<StoredSecret | string>(Buffer.from(row.value, "base64"), `plc-secret:${name}`);
    return typeof opened === "string" ? { value: opened, host: null } : opened;
  }

  /** 这一行的密文（base64），不解密。没有时是 null。用来判断存的密钥变没变（密文每次加密都不一样）。 */
  sealed(name: Name): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(sealedSecretKey(name)) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(name: Name, secret: StoredSecret | null): void {
    if (secret === null) {
      this.db.prepare("DELETE FROM kv WHERE key = ?").run(sealedSecretKey(name));
      return;
    }
    this.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    ).run(sealedSecretKey(name), this.vault.seal(secret, `plc-secret:${name}`).toString("base64"));
  }
}
