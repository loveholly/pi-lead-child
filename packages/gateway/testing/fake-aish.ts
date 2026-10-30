// 进程内假 aish 服务器（botfather protocol v1 的最小服务端），仅测试用。
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import type { AddressInfo } from "node:net";

export interface FakeAish {
  url: string;
  received: any[];                 // 所有客户端消息（含 auth/ping）
  connections: number;
  dispatchEvent(text: string, channel?: string, thread?: string): void;
  sendRaw(obj: unknown): void;
  close(): Promise<void>;
}

export function startFakeAish(opts?: {
  token?: string;
  rejectAuth?: boolean;
  authErrorCode?: "AUTH_FAILED" | "AUTH_TIMEOUT"; // 拒绝鉴权时回的错误码，缺省 AUTH_FAILED
  silent?: boolean; // 不回 ping/pong（测 pong 超时重连）
}): Promise<FakeAish> {
  const token = opts?.token ?? "bf_test";
  const wss = new WebSocketServer({ port: 0 });
  const received: any[] = [];
  let connections = 0;
  let current: WsSocket | null = null;

  wss.on("connection", (ws) => {
    connections += 1;
    current = ws;
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      received.push(msg);
      switch (msg.type) {
        case "auth":
          if (opts?.rejectAuth || msg.token !== token) {
            ws.send(JSON.stringify({ type: "error", code: opts?.authErrorCode ?? "AUTH_FAILED", message: "Invalid token" }));
            ws.close();
          } else {
            ws.send(JSON.stringify({
              type: "connected", bot_id: "bot_1", bot_name: "plc-lead", protocol_version: 1,
            }));
          }
          break;
        case "ping":
          if (!opts?.silent) ws.send(JSON.stringify({ type: "pong" }));
          break;
        case "stream_start":
          ws.send(JSON.stringify({ type: "action_result", request_id: msg.request_id, ok: true, stream_ts: "st_1" }));
          break;
        case "send_message":
        case "update_message":
        case "add_reaction":
        case "stream_append":
        case "stream_stop":
        case "approval_request":
          ws.send(JSON.stringify({ type: "action_result", request_id: msg.request_id, ok: true, message_ts: "mt_1" }));
          break;
      }
    });
  });

  return new Promise((resolve) => {
    wss.on("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        received,
        get connections() { return connections; },
        dispatchEvent(text, channel = "C123", thread = "1712.001") {
          current?.send(JSON.stringify({
            type: "event", event_id: `ev_${Date.now()}`, event_type: "message", bot_id: "bot_1",
            channel_id: channel, thread_ts: thread,
            sender: { user_id: "U_BWEN", username: "U_BWEN" },
            text, timestamp: new Date().toISOString(),
          }));
        },
        sendRaw(obj) { current?.send(JSON.stringify(obj)); },
        close: () => new Promise<void>((r) => { wss.close(() => r()); }),
      });
    });
  });
}
