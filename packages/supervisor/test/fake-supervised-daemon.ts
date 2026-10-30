import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { claimInstanceLock, daemonLockPath } from "../src/instance-lock.js";

const dataDir = process.env.PLC_DATA_DIR;
if (!dataDir) throw new Error("PLC_DATA_DIR is required");
// 和真实 daemon 一样，先拿 daemon.lock；进程退出时内核放掉它。
if (!claimInstanceLock(daemonLockPath(dataDir))) {
  console.log("daemon already running");
  process.exit(0);
}
const sockPath = join(dataDir, "plc.sock");
const activePath = join(dataDir, "fake-active-items.json");
// 启动途中退出：测试据此检查 supervisor 不再等一个已经退出的 daemon。只生效一次。
const exitOnStartPath = join(dataDir, "fake-exit-on-start");
if (existsSync(exitOnStartPath)) {
  unlinkSync(exitOnStartPath);
  process.exit(1);
}
// 启动慢：拿到 daemon.lock 以后先不监听，等测试删掉 fake-hold-start。真实 daemon 也是先拿锁、做完启动工作再监听。
const holdStartPath = join(dataDir, "fake-hold-start");
if (existsSync(holdStartPath)) {
  writeFileSync(join(dataDir, "fake-holding"), `${process.pid}\n`);
  while (existsSync(holdStartPath)) await new Promise((resolve) => setTimeout(resolve, 50));
}
if (existsSync(sockPath)) unlinkSync(sockPath);

const clients = new Set<Socket>();
// 收到的命令按先后记下来：测试据此检查 supervisor 先发 drain、等它回答，再发 shutdown。
const commandLog = join(dataDir, "fake-commands.log");
const leadBusy = (): boolean => {
  const leadBusyPath = join(dataDir, "fake-lead-busy");
  return existsSync(leadBusyPath) && readFileSync(leadBusyPath, "utf8").trim() === "1";
};
const activeItems = (): number[] => {
  if (!existsSync(activePath)) return [];
  return JSON.parse(readFileSync(activePath, "utf8")) as number[];
};

const server = createServer((socket) => {
  clients.add(socket);
  socket.write(`${JSON.stringify({ type: "hello", model: "fake", sessionId: "fake", busy: false })}\n`);
  attachJsonlReader(socket, (line) => {
    if (!line.trim()) return;
    const command = JSON.parse(line) as { type: string; id?: string; timeoutMs?: number };
    appendFileSync(commandLog, `${command.type}\n`);
    if (command.type === "drain") {
      // 和真实 daemon 一样：Lead 空着就马上回答；正在跑一轮就等它结束，最多 timeoutMs。
      const deadline = Date.now() + (command.timeoutMs ?? 12_000);
      const poll = () => {
        if (leadBusy() && Date.now() < deadline) { setTimeout(poll, 50); return; }
        const drained = !leadBusy();
        socket.write(`${JSON.stringify({ type: "response", id: command.id, success: true, data: { drained, interrupted: !drained } })}\n`);
      };
      poll();
      return;
    }
    if (command.type === "status") {
      const runningItemIds = activeItems();
      socket.write(`${JSON.stringify({
        type: "response",
        id: command.id,
        success: true,
        data: {
          model: "fake",
          // 与真实 daemon 一致（src/daemon/server.ts 的 statusData）：busy 只表示 lead 正在跑回合，
          // 在跑的工单单独放在 runningItemIds 里。
          busy: leadBusy(),
          pid: process.pid,
          clients: clients.size,
          sessionId: "fake",
          runningChildren: runningItemIds,
          runningItemIds,
          aish: null,
        },
      })}\n`);
      return;
    }
    if (command.type === "shutdown") {
      socket.write(`${JSON.stringify({ type: "response", id: command.id, success: true })}\n`);
      setImmediate(() => void close());
      return;
    }
    socket.write(`${JSON.stringify({ type: "response", id: command.id, success: false, error: "unknown" })}\n`);
  });
  socket.on("close", () => clients.delete(socket));
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(sockPath, resolve);
});

async function close(): Promise<void> {
  for (const client of clients) client.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (existsSync(sockPath)) unlinkSync(sockPath);
  process.exit(0);
}

process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());

