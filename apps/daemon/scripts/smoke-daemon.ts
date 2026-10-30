// 构建后的 daemon 冒烟：起 dist/coordinatord.mjs，在 plc.sock 上换一个 plc 凭证（和 plc 发的是同一条命令），
// 再用它调网关建单、读快照。它不运行 plc：daemon 和 cli 是两个互不依赖的 app。
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const dataDir = mkdtempSync(join(tmpdir(), "plc-daemon-smoke-"));
const env = {
  ...process.env,
  PLC_DATA_DIR: dataDir,
  PLC_GATEWAY_PORT: "0",
  PLC_GATEWAY_HOST: "127.0.0.1",
};
const daemon = spawn(process.execPath, ["apps/daemon/dist/coordinatord.mjs"], {
  cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
daemon.stdout.setEncoding("utf8");
daemon.stderr.setEncoding("utf8");
daemon.stdout.on("data", (chunk) => { output += chunk; });
daemon.stderr.on("data", (chunk) => { output += chunk; });

function waitForPort(timeoutMs = 30_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const match = output.match(/paired plane listening on [^:]+:(\d+)/);
      if (match) return resolve(Number(match[1]));
      if (daemon.exitCode !== null) return reject(new Error(`daemon exited ${daemon.exitCode}: ${output}`));
      if (Date.now() - started >= timeoutMs) return reject(new Error(`daemon start timeout: ${output}`));
      setTimeout(poll, 100);
    };
    poll();
  });
}

function requestCliCredential(): Promise<{ accessToken: string; gatewayUrl: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(join(dataDir, "plc.sock"));
    let buffer = "";
    socket.once("error", reject);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      socket.end();
      if (message.success) resolve(message.data);
      else reject(new Error(`cli_credential failed: ${message.error}`));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "cli_credential", name: "daemon-smoke" })}\n`));
  });
}

try {
  const port = await waitForPort();
  const { accessToken: token, gatewayUrl: base } = await requestCliCredential();
  if (base !== `http://127.0.0.1:${port}`) throw new Error(`gateway URL mismatch: ${base} vs port ${port}`);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const created = await fetch(`${base}/v1/tickets`, {
    method: "POST", headers,
    body: JSON.stringify({
      title: "built daemon smoke", brief: "verify Coordinator-backed API",
      project: "daemon-smoke", runtime: "codex",
    }),
  });
  if (created.status !== 201) throw new Error(`create failed ${created.status}: ${await created.text()}`);
  const item = await created.json() as { id: number; projectId: number | null; requestedRuntime: string | null };
  const [v2, kernel] = await Promise.all([
    fetch(`${base}/v1/tickets/${item.id}`, { headers }),
    fetch(`${base}/v1/kernel/tickets/${item.id}`, { headers }),
  ]);
  if (!v2.ok || !kernel.ok) throw new Error(`snapshot failed: v2=${v2.status} kernel=${kernel.status}`);
  const v2Body = await v2.json() as any;
  const kernelBody = await kernel.json() as any;
  if (v2Body.ticket.id !== item.id || kernelBody.id !== item.id || kernelBody.requestedRuntime !== "codex") {
    throw new Error("snapshot identity/runtime mismatch");
  }
  console.log(JSON.stringify({
    ok: true, pid: daemon.pid, port, dataDir, itemId: item.id,
    v2Keys: Object.keys(v2Body).sort(), kernelRuntime: kernelBody.requestedRuntime,
  }));
} finally {
  daemon.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (daemon.exitCode !== null) resolve();
    else daemon.once("exit", () => resolve());
  });
  // daemon 退出以后才删除数据目录：它在退出前还会写这个目录。
  rmSync(dataDir, { recursive: true, force: true });
}
