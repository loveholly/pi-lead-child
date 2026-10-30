// plc 的网关客户端：和 companion 用同一个 @pi-lead-child/client。
// 网关地址不缓存：每次请求、每次（重新）连接前都在 plc.sock 上问一次 status。端口可能随 daemon
// 重启变化（缺省端口被占用时用随机端口）；沿用旧地址，token 可能发给后来占了那个端口的别的进程。
import { ControlPlaneClient, ControlPlaneClientError, type ControlPlaneCredentials } from "@pi-lead-child/client";
import type { AdminTokenResponse, BindingDto } from "@pi-lead-child/protocol";
import type { StoredCliCredential } from "./credential-file.js";
import { CliError, daemonStatus } from "./daemon-link.js";
import { localRequest, type LocalRequest } from "./local-socket.js";

export interface GatewayClientOptions {
  request?: LocalRequest;
  dataDir?: string;
}

function clientWith(accessToken: string, binding: BindingDto, options: GatewayClientOptions): ControlPlaneClient {
  const request = options.request ?? localRequest;
  // 游标 -1：事件流只收连上之后的新事件，不回放历史（plc chat 不需要旧消息）。
  // 游标只留在内存里，不写回文件。baseUrl 不会被用到：地址由 resolveBaseUrl 给出。
  let record: ControlPlaneCredentials = { baseUrl: "http://127.0.0.1", accessToken, binding, lastSeq: -1 };
  return new ControlPlaneClient({
    credentials: {
      load: async () => record,
      save: async (value) => { record = value; },
      clear: async () => {},
    },
    resolveBaseUrl: async () => {
      const status = await daemonStatus(request, options.dataDir);
      if (!status) throw new CliError("daemon 未运行。运行 plc daemon start。");
      return status.gatewayUrl;
    },
  });
}

// 存在数据目录里的 plc 凭证（缺省 scope）。
export function gatewayClient(credential: Pick<StoredCliCredential, "accessToken" | "binding">, options: GatewayClientOptions = {}): ControlPlaneClient {
  return clientWith(credential.accessToken, credential.binding, options);
}

// plc.sock 上换来的临时 admin token：只开管理路由，只在这一次命令的内存里。
export function adminClient(issued: AdminTokenResponse, options: GatewayClientOptions = {}): ControlPlaneClient {
  return clientWith(issued.accessToken, { id: 0, kind: "cli", name: "plc（临时 admin）", scopes: ["admin"] }, options);
}

// 网关的错误换成给人看的一句话。凭证被拒时说明怎样重新签发。
export function explainClientError(error: unknown): CliError | null {
  if (error instanceof CliError) return error;
  if (!(error instanceof ControlPlaneClientError)) return null;
  if (error.status === 401) {
    return new CliError("网关拒绝了 plc 的凭证（可能已被撤销）。重新签发：plc auth login");
  }
  return new CliError(error.message);
}
