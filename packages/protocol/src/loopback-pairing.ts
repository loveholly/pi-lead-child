// 本机网页给手机发扫码配对邀请（设置 → 设备 → 添加手机）。
// 这几条路由（生成、查状态、作废）只开在回环上，检查和回环自动配对（POST /v1/paired/loopback）一样：socket 来自回环地址，
// Origin 是网关自己的网页或允许列表里的回环 origin。另外要带有效的凭证。
// 它们不要 admin，也换不到 admin：邀请只生成 kind=companion 的配对，兑换后只有缺省的 scope。
import { Type, type Static, type TProperties } from "typebox";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

// POST /v1/paired/loopback/invitations
export const LoopbackInvitationRequestSchema = StrictObject({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  // 必须是网关给出的局域网地址之一（响应里的 endpoints）。不填时用第一个。
  endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
});
export type LoopbackInvitationRequest = Static<typeof LoopbackInvitationRequestSchema>;

// 二维码的点阵，不含四周的静区。rows[y] 的第 x 个字符是 "1" 时，那个模块是深色。
export const QrMatrixSchema = StrictObject({
  size: Type.Integer({ minimum: 21, maximum: 177 }),
  rows: Type.Array(Type.String({ pattern: "^[01]+$", minLength: 21, maxLength: 177 }), { minItems: 21, maxItems: 177 }),
});
export type QrMatrix = Static<typeof QrMatrixSchema>;

export const LoopbackInvitationSchema = StrictObject({
  pairingId: Type.Integer({ minimum: 1 }),
  expiresAt: Type.String(),
  // plc-pair:// 邀请，和 qr 编码的是同一段文字。它是凭证：不写进日志，页面上也不明文显示。
  uri: Type.String({ minLength: 1 }),
  qr: QrMatrixSchema,
  // 这份邀请用的地址，例如 ws://192.168.1.20:47130。
  endpoint: Type.String({ minLength: 1 }),
  // 网关现在能在局域网上接受连接的全部地址。endpoint 是其中之一。
  endpoints: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});
export type LoopbackInvitation = Static<typeof LoopbackInvitationSchema>;

export const PairingInvitationStateSchema = Type.Union([
  Type.Literal("pending"), Type.Literal("redeemed"), Type.Literal("expired"), Type.Literal("revoked"),
]);
export type PairingInvitationState = Static<typeof PairingInvitationStateSchema>;

// POST /v1/paired/loopback/invitations/:id/status。用 POST 而不用 GET：浏览器的同源 GET 请求不带 Origin，
// 网关自己提供的网页就过不了回环检查。
// POST /v1/paired/loopback/invitations/:id/cancel 作废还没兑换的邀请（state 变成 revoked），也回这个形状。
export const LoopbackInvitationStatusSchema = StrictObject({
  pairingId: Type.Integer({ minimum: 1 }),
  state: PairingInvitationStateSchema,
  expiresAt: Type.String(),
});
export type LoopbackInvitationStatus = Static<typeof LoopbackInvitationStatusSchema>;
