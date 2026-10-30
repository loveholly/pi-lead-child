// launchd 任务 com.pi-lead-child.hindsight 的入口（supervisor 的 deploy/hindsight.ts）。
// 解开 daemon 写的 secrets.sealed（保险库的密钥在 Keychain 里），按 service.json 算出 Hindsight 的环境变量，
// 再用 uvx 启动固定版本的 hindsight-api。子进程的环境只有白名单里的变量和我们算的这些（hindsightEnvironment）：
// 这里不读 config.json 的 env 段，也不把 Keychain 读进环境。LLM 的 key 由 daemon 解析好放在 secrets.sealed 里。
// 密钥只在这个进程和它的子进程里，不进 plist。收到 SIGTERM/SIGINT 时转给 hindsight-api，它会停掉 pg0 再退出。
// hindsight-api 的输出一行一行经过 maskSecrets 再写进日志：它在 info 级别会打印带密码的 pg0 地址（2026-10-16 发布评审）。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@pi-lead-child/core";
import { defaultKeySource, lazyVault } from "@pi-lead-child/connections";
import {
  hindsightDir, hindsightEnvironment, hindsightSecretValues, hindsightUvxArgs, maskSecrets, readServiceFile, type HindsightSecrets,
} from "@pi-lead-child/supervisor";
import { HINDSIGHT_SECRETS_AAD, hindsightSecretsPath } from "./memory-controller.js";

const dir = dataDir();
const service = readServiceFile(dir);
if (!service) {
  console.error(`[hindsight] ${hindsightDir(dir)}/service.json is missing; the daemon writes it on start`);
  process.exit(1);
}
const sealedPath = hindsightSecretsPath(dir);
if (!existsSync(sealedPath)) {
  // 没有 key 时不启动：服务不能没有认证。
  console.error(`[hindsight] ${sealedPath} is missing; the daemon writes it on start`);
  process.exit(1);
}
// 和 daemon 用同一个保险库密钥（server.ts 的 connections.key / Keychain）。
const secrets = lazyVault(defaultKeySource(join(dir, "connections.key"))).open<HindsightSecrets>(readFileSync(sealedPath), HINDSIGHT_SECRETS_AAD);
const { env, notes } = hindsightEnvironment({ service, secrets, env: process.env });
for (const note of notes) console.log(`[hindsight] ${note}`);
console.log(`[hindsight] starting hindsight-api ${service.version} on 127.0.0.1:${service.port} (database: ${service.database.kind})`);

const child = spawn(service.uvx, [
  ...hindsightUvxArgs(service.resolvedBefore),
  `hindsight-api@${service.version}`, "--host", "127.0.0.1", "--port", String(service.port),
], { env, cwd: hindsightDir(dir), stdio: ["ignore", "pipe", "pipe"] });

// launchd 把这个进程的 stdout/stderr 写进 hindsight.out.log / hindsight.err.log。
const secretValues = hindsightSecretValues(secrets);
for (const [from, to] of [[child.stdout!, process.stdout], [child.stderr!, process.stderr]] as const) {
  createInterface({ input: from, crlfDelay: Infinity }).on("line", (line) => {
    to.write(`${maskSecrets(line, secretValues)}\n`);
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`[hindsight] cannot start ${service.uvx}: ${error.message}`);
  process.exit(1);
});
// close 在 stdout/stderr 读完以后才来：最后几行日志不会丢。
child.on("close", (code, signal) => {
  console.log(`[hindsight] hindsight-api exited (${signal ?? code})`);
  process.exit(code ?? 1);
});
