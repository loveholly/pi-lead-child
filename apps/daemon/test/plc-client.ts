// plc 的那条路，给 daemon 的集成测试用：在 plc.sock 上换一个 kind=cli 的凭证（和 plc 发的是同一条命令），
// 再用 @pi-lead-child/client 调网关。daemon 不依赖 cli 包，这里按协议直接说话。
import { connect } from "node:net";
import { ControlPlaneClient, type ControlPlaneCredentials } from "@pi-lead-child/client";
import type { AdminTokenResponse, CliCredentialResponse, LocalSocketResponse } from "@pi-lead-child/protocol";

export function requestCliCredential(sockPath: string): Promise<CliCredentialResponse> {
  return localRequest(sockPath, { type: "cli_credential", id: "c", name: "plc" });
}

export function requestAdminToken(sockPath: string): Promise<AdminTokenResponse> {
  return localRequest(sockPath, { type: "admin_token", id: "a" });
}

function localRequest<T>(sockPath: string, command: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = connect(sockPath);
    let buffer = "";
    socket.once("error", reject);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline)) as LocalSocketResponse<T>;
      socket.end();
      if (message.success) resolve(message.data!);
      else reject(new Error(message.error));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
  });
}

export async function plcClient(daemon: { sockPath: string }): Promise<ControlPlaneClient> {
  const issued = await requestCliCredential(daemon.sockPath);
  let record: ControlPlaneCredentials = {
    baseUrl: issued.gatewayUrl, accessToken: issued.accessToken, binding: issued.binding, lastSeq: -1,
  };
  return new ControlPlaneClient({
    credentials: { load: async () => record, save: async (value) => { record = value; }, clear: async () => {} },
  });
}

// plc 的管理命令那条路：在 plc.sock 上换一个临时 admin token，只用于管理路由。
export async function plcAdminClient(daemon: { sockPath: string }): Promise<ControlPlaneClient> {
  const issued = await requestAdminToken(daemon.sockPath);
  const record: ControlPlaneCredentials = {
    baseUrl: issued.gatewayUrl, accessToken: issued.accessToken,
    binding: { id: 0, kind: "cli", name: "plc（临时 admin）", scopes: ["admin"] }, lastSeq: -1,
  };
  return new ControlPlaneClient({
    credentials: { load: async () => record, save: async () => {}, clear: async () => {} },
  });
}
