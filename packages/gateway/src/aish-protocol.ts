// aish botfather protocol v1 消息类型。
// 逐字复制自 slack-to-agents/src/protocol/types.ts（参考客户端），与
// pltf-copilot-aish/src/surface/botfather/ws_protocol.py（服务端）互相校验一致。
export const PROTOCOL_VERSION = 1;

export interface Sender { user_id: string; username: string; avatar_url?: string }

// ---- Server → Client ----
export interface ConnectedMessage {
  type: "connected"; bot_id: string; bot_name: string;
  protocol_version: number; system_prompt?: string;
}
export interface EventMessage {
  type: "event"; event_id: string; event_type: string; bot_id: string;
  channel_id: string; thread_ts?: string;
  channel_type?: "channel" | "group" | "im" | "mpim";
  sender: Sender; text: string; timestamp: string; system_prompt?: string;
}
export interface ActionResultMessage {
  type: "action_result"; request_id: string; ok: boolean;
  message_ts?: string; stream_ts?: string; error?: string;
}
export interface ErrorMessage { type: "error"; code: string; message: string }
export interface ApprovalResultMessage {
  type: "approval_result"; approval_id: string;
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
  user_id: string; channel_id?: string; thread_ts?: string; message_ts?: string;
}
export type ServerMessage =
  | ConnectedMessage | EventMessage | ActionResultMessage | ErrorMessage
  | { type: "ping" } | { type: "pong" }
  | ApprovalResultMessage
  | { type: "approval_retry"; approval_id: string; user_id: string }
  | { type: "disconnected"; reason: string }
  | { type: "thread_messages_result"; request_id: string; ok: boolean; messages?: unknown[]; error?: string };

// ---- Client → Server ----
export interface StreamStartAction {
  type: "stream_start"; request_id: string; channel_id: string; thread_ts?: string;
}
export interface StreamAppendAction {
  type: "stream_append"; request_id: string; channel_id: string; stream_ts: string; text: string;
}
export interface StreamStopAction {
  type: "stream_stop"; request_id: string; channel_id: string; stream_ts: string; text?: string;
}
export interface SendMessageAction {
  type: "send_message"; request_id: string; channel_id: string; thread_ts?: string;
  text?: string; blocks?: unknown;
}
export interface AddReactionAction {
  type: "add_reaction"; request_id: string; channel_id: string; message_ts: string; emoji: string;
}
export interface ApprovalRequestAction {
  type: "approval_request"; request_id: string; channel_id: string; thread_ts?: string;
  approval_id: string; tool: string; description: string; text: string; blocks?: unknown;
}
export type ClientMessage =
  | { type: "auth"; token: string } | { type: "ping" } | { type: "pong" }
  | SendMessageAction | AddReactionAction
  | StreamStartAction | StreamAppendAction | StreamStopAction
  | ApprovalRequestAction;

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg === "object" && msg !== null && typeof msg.type === "string") {
      return msg as ServerMessage;
    }
    return null;
  } catch {
    return null;
  }
}
