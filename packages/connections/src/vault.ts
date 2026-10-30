// 令牌保险库：连接的令牌只以密文进账本。AES-256-GCM，每次加密一个随机的 12 字节 nonce，
// 附加数据（AAD）绑定连接 id 和密文版本号，所以一行的旧密文搬不到别的行，也换不回同一行的旧版本。
//
// 为什么要加密：同一个系统用户的进程本来就隔离不了（README 的「凭证和信任边界」）。加密防的是副本：
// 部署前的备份和预览用的快照会复制整个数据库，没有 Keychain 里的密钥，副本里的令牌没有用。
//
// 密钥是 32 个随机字节。macOS 上存在 Keychain，写入时命令走 `security -i` 的标准输入，密钥不进 argv。
// 其他系统上退回到数据目录里一个 0600 的文件。密钥不进 process.env：child 继承 daemon 的全部环境。
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { userInfo } from "node:os";

const FORMAT = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface VaultKeySource {
  // 返回 32 字节的密钥。没有时创建一个并保存。
  load(): Buffer;
}

// hub 只需要这两个操作。lazyVault 在第一次用到时才读密钥：没用过连接的 daemon 不碰 Keychain。
export interface SecretVault {
  seal(value: unknown, aad: string): Buffer;
  open<T>(sealed: Buffer, aad: string): T;
}

export function lazyVault(source: VaultKeySource): SecretVault {
  let vault: Vault | null = null;
  const get = () => (vault ??= new Vault(source.load()));
  return {
    seal: (value, aad) => get().seal(value, aad),
    open: <T>(sealed: Buffer, aad: string) => get().open<T>(sealed, aad),
  };
}

export class Vault implements SecretVault {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) throw new Error(`vault key must be ${KEY_BYTES} bytes`);
    this.#key = Buffer.from(key);
  }

  seal(value: unknown, aad: string): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT]), nonce, cipher.getAuthTag(), body]);
  }

  open<T>(sealed: Buffer, aad: string): T {
    if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES || sealed[0] !== FORMAT) throw new Error("vault: unknown secret format");
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
    const tag = sealed.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
    const body = sealed.subarray(1 + NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.#key, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8")) as T;
  }
}

// 一行连接的密文的 AAD。version 是写入后这一行的 secret_version。
export function connectionSecretAad(connectionId: number, version: number): string {
  return `connection:${connectionId}:v${version}`;
}

// 一行连接的权限设置（roles、write_policy）的封印的 AAD。封印绑定连接 id、清单的 epoch 和版本：搬不到别的行，
// 旧版本的封印、上一代清单下的封印都换不回来（epoch 和版本记在清单里）。
export function connectionSettingsAad(connectionId: number, epoch: string, version: number): string {
  return `connection-settings:${connectionId}:${epoch}:v${version}`;
}

export const CONNECTION_SETTINGS_MANIFEST_AAD = "connection-settings-manifest";

export function oauthClientSecretAad(issuer: string, redirectUri: string): string {
  return `oauth-client:${issuer}:${redirectUri}`;
}

export const KEYCHAIN_VAULT_SERVICE = "pi-lead-child:connections-vault";
const SAFE_KEYCHAIN_NAME = /^[A-Za-z0-9._:@-]{1,128}$/;

// macOS Keychain 里的密钥。读和写都用 /usr/bin/security，和 supervisor 的 keychain.ts 一样，
// 所以读的时候不弹授权框。
export function keychainKeySource(account = userInfo().username, service = KEYCHAIN_VAULT_SERVICE): VaultKeySource {
  return {
    load() {
      try {
        const hex = execFileSync("security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        const key = Buffer.from(hex, "hex");
        if (key.length === KEY_BYTES) return key;
      } catch {
        // 还没有密钥：下面创建一个。
      }
      // 账号名和服务名会拼进 `security -i` 的命令行，所以只接受不需要转义的字符。密钥是十六进制。
      if (!SAFE_KEYCHAIN_NAME.test(account) || !SAFE_KEYCHAIN_NAME.test(service)) {
        throw new Error("vault: the Keychain account or service name has characters that are not allowed");
      }
      const key = randomBytes(KEY_BYTES);
      // 命令走标准输入，不进 argv。
      const result = spawnSync("security", ["-i"], {
        input: `add-generic-password -U -a "${account}" -s "${service}" -w ${key.toString("hex")}\n`,
        stdio: ["pipe", "ignore", "ignore"],
      });
      if (result.status !== 0) throw new Error("vault: could not save the key to the Keychain");
      return key;
    },
  };
}

// 数据目录里的密钥文件（0600）。给没有 Keychain 的系统和测试用。
export function fileKeySource(path: string): VaultKeySource {
  return {
    load() {
      if (existsSync(path)) {
        const key = Buffer.from(readFileSync(path, "utf8").trim(), "hex");
        if (key.length !== KEY_BYTES) throw new Error(`vault: key file ${path} is not ${KEY_BYTES} bytes`);
        chmodSync(path, 0o600);
        return key;
      }
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const key = randomBytes(KEY_BYTES);
      writeFileSync(path, key.toString("hex"), { mode: 0o600, flag: "wx" });
      return key;
    },
  };
}

// 缺省：macOS 用 Keychain，其他系统用数据目录里的文件。
export function defaultKeySource(keyFilePath: string): VaultKeySource {
  return process.platform === "darwin" ? keychainKeySource() : fileKeySource(keyFilePath);
}
