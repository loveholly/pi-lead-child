// plc 的入口。plc 是 daemon 的客户端，和 companion 平级：它不打开账本，不在前台跑内核。
// 命令在 commands.ts；这里只把真实的依赖接上：本机 socket、网关客户端、运维入口和终端。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { distDir } from "@pi-lead-child/core";
import type { AdminTokenResponse, CliCredentialResponse, DaemonLocalStatus } from "@pi-lead-child/protocol";
import { chatOutboxPath } from "./chat-outbox-file.js";
import { runChat } from "./chat.js";
import { buildProgram, type CliDeps, type GatewaySession } from "./commands.js";
import {
  credentialPath, loadOrMintCliCredential, readCliCredential, storedCredential, writeCliCredential,
} from "./credential-file.js";
import { daemonStatus, ensureDaemon } from "./daemon-link.js";
import { adminClient, gatewayClient } from "./gateway-client.js";
import { localRequest, plcSockPath, supervisorSockPath } from "./local-socket.js";
import { runOps } from "./ops-entry.js";

const err = (text: string) => process.stderr.write(`${text}\n`);

function daemonReady(): Promise<DaemonLocalStatus> {
  // 自动拉起不推翻 plc daemon stop，也不在维护时插手（start --auto，见 ops 入口）。
  return ensureDaemon({ request: localRequest, start: () => runOps(["start", "--auto"]), notice: err });
}

const mint = () => localRequest<CliCredentialResponse>(plcSockPath(), { type: "cli_credential", name: "plc" });

const deps: CliDeps = {
  out: (text) => process.stdout.write(`${text}\n`),
  err,
  setExitCode: (code) => { process.exitCode = code; },
  async gateway(): Promise<GatewaySession> {
    const status = await daemonReady();
    const credential = await loadOrMintCliCredential({ mint, notice: err });
    return { client: gatewayClient(credential), gatewayUrl: status.gatewayUrl, credential };
  },
  async admin() {
    await daemonReady();
    return adminClient(await localRequest<AdminTokenResponse>(plcSockPath(), { type: "admin_token" }));
  },
  async login() {
    const status = await daemonReady();
    const previous = readCliCredential();
    const credential = storedCredential(await mint());
    writeCliCredential(credential);
    return { session: { client: gatewayClient(credential), gatewayUrl: status.gatewayUrl, credential }, previous };
  },
  async proveCredential(credential) {
    try {
      return await gatewayClient(credential).getOwnBinding();
    } catch {
      return null;
    }
  },
  storedCredential: () => ({ path: credentialPath(), credential: readCliCredential() }),
  chat: (session) => runChat(gatewayClient(session.credential), {
    bindingId: session.credential.binding.id,
    gatewayUrl: async () => (await daemonStatus(localRequest))?.gatewayUrl ?? session.gatewayUrl,
    outboxPath: chatOutboxPath(),
  }),
  runOps,
  supervisor: {
    available: async () => {
      try {
        await localRequest(supervisorSockPath(), { type: "status" }, 1_000);
        return true;
      } catch {
        return false;
      }
    },
    request: (command, timeoutMs) => localRequest(supervisorSockPath(), command, timeoutMs),
  },
  daemon: {
    status: () => daemonStatus(localRequest),
  },
  renderQr: async (text) => {
    const qrcode = await import("qrcode-terminal");
    qrcode.default.generate(text, { small: true });
  },
  webBuilt: () => existsSync(join(distDir(), "web", "index.html")),
  openUrl: (url) => {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  },
};

await buildProgram(deps).parseAsync();
