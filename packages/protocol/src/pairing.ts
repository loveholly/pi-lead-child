import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import nacl from "tweetnacl";
import { Type, type Static } from "typebox";

import { PROTOCOL_VERSION } from "./version.ts";

const StrictObject = <T extends Record<string, any>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const HEX_24_BYTES = Type.String({ pattern: "^[0-9a-f]{48}$" });
const HEX_32_BYTES = Type.String({ pattern: "^[0-9a-f]{64}$" });

export const PairingEnvelopeSchema = StrictObject({
  nonce: HEX_24_BYTES,
  ciphertext: Type.String({ pattern: "^(?:[0-9a-f]{2})+$" }),
});
export type PairingEnvelope = Static<typeof PairingEnvelopeSchema>;

export const PairHelloSchema = StrictObject({
  type: Type.Literal("pair.hello"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  pairingId: Type.Integer({ minimum: 1 }),
  clientPublicKey: HEX_32_BYTES,
});
export type PairHello = Static<typeof PairHelloSchema>;

export const PairChallengeSchema = StrictObject({
  type: Type.Literal("pair.challenge"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  daemonPublicKey: HEX_32_BYTES,
  envelope: PairingEnvelopeSchema,
});
export type PairChallenge = Static<typeof PairChallengeSchema>;

export const PairConfirmSchema = StrictObject({
  type: Type.Literal("pair.confirm"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  envelope: PairingEnvelopeSchema,
});
export type PairConfirm = Static<typeof PairConfirmSchema>;

export const PairAcceptedSchema = StrictObject({
  type: Type.Literal("pair.accepted"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  envelope: PairingEnvelopeSchema,
});
export type PairAccepted = Static<typeof PairAcceptedSchema>;

export const PairSocketErrorSchema = StrictObject({
  type: Type.Literal("pair.error"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  error: StrictObject({ code: Type.String(), message: Type.String() }),
});
export type PairSocketError = Static<typeof PairSocketErrorSchema>;

export interface SocketPairingInvitation {
  endpoint: string;
  pairingId: number;
  pairingSecret: string;
  daemonPublicKey: Uint8Array;
}

export interface PairingKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function decodeUtf8(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return decodeURIComponent(escape(binary));
}

function normalizeSocketEndpoint(input: string): string {
  const endpoint = new URL(input.trim());
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new Error("pairing endpoint must use ws or wss");
  }
  if (endpoint.username || endpoint.password) throw new Error("pairing endpoint must not contain credentials");
  endpoint.search = "";
  endpoint.hash = "";
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/v1/paired/connect`.replace(
    /\/v1\/paired\/connect\/v1\/paired\/connect$/,
    "/v1/paired/connect",
  );
  return endpoint.toString();
}

function normalizePairingSecret(input: string): string {
  const secret = input.trim().toLowerCase();
  if (!/^[0-9a-f]{48}$/.test(secret)) throw new Error("invalid socket pairing secret");
  return secret;
}

export function buildSocketPairingUri(invitation: SocketPairingInvitation): string {
  if (!Number.isSafeInteger(invitation.pairingId) || invitation.pairingId < 1) {
    throw new Error("invalid pairing id");
  }
  if (invitation.daemonPublicKey.length !== nacl.box.publicKeyLength) {
    throw new Error("invalid daemon public key");
  }
  const uri = new URL("plc-pair://connect");
  uri.searchParams.set("v", String(PROTOCOL_VERSION));
  uri.searchParams.set("endpoint", normalizeSocketEndpoint(invitation.endpoint));
  uri.searchParams.set("pairing_id", String(invitation.pairingId));
  uri.searchParams.set("secret", normalizePairingSecret(invitation.pairingSecret));
  uri.searchParams.set("daemon_key", bytesToHex(invitation.daemonPublicKey));
  return uri.toString();
}

export function parseSocketPairingUri(input: string): SocketPairingInvitation {
  const uri = new URL(input.trim());
  if (uri.protocol !== "plc-pair:" || uri.hostname !== "connect") {
    throw new Error("invalid socket pairing URI");
  }
  if (uri.searchParams.get("v") !== String(PROTOCOL_VERSION)) {
    throw new Error("unsupported pairing protocol version");
  }
  const pairingId = Number(uri.searchParams.get("pairing_id"));
  if (!Number.isSafeInteger(pairingId) || pairingId < 1) throw new Error("invalid pairing id");
  const daemonKeyHex = uri.searchParams.get("daemon_key") ?? "";
  if (!/^[0-9a-f]{64}$/.test(daemonKeyHex)) throw new Error("invalid daemon public key");
  return {
    endpoint: normalizeSocketEndpoint(uri.searchParams.get("endpoint") ?? ""),
    pairingId,
    pairingSecret: normalizePairingSecret(uri.searchParams.get("secret") ?? ""),
    daemonPublicKey: hexToBytes(daemonKeyHex),
  };
}

export function createPairingKeyPair(secretKey: Uint8Array): PairingKeyPair {
  if (secretKey.length !== nacl.box.secretKeyLength) throw new Error("invalid pairing secret key");
  const pair = nacl.box.keyPair.fromSecretKey(secretKey);
  return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

export function hashPairingSecret(secret: string): Uint8Array {
  return sha256(utf8ToBytes(normalizePairingSecret(secret)));
}

export function derivePairingSessionKey(
  secretKey: Uint8Array,
  peerPublicKey: Uint8Array,
  codeHash: Uint8Array,
): Uint8Array {
  if (secretKey.length !== nacl.box.secretKeyLength || peerPublicKey.length !== nacl.box.publicKeyLength) {
    throw new Error("invalid pairing key material");
  }
  if (codeHash.length !== 32) throw new Error("invalid pairing code hash");
  const shared = nacl.box.before(peerPublicKey, secretKey);
  return sha256(concatBytes(shared, codeHash, utf8ToBytes("pi-lead-child/socket-pairing/v2")));
}

export function sealPairingPayload(
  payload: unknown,
  key: Uint8Array,
  nonce: Uint8Array,
): PairingEnvelope {
  if (key.length !== nacl.secretbox.keyLength || nonce.length !== nacl.secretbox.nonceLength) {
    throw new Error("invalid pairing envelope key material");
  }
  const ciphertext = nacl.secretbox(utf8ToBytes(JSON.stringify(payload)), nonce, key);
  return { nonce: bytesToHex(nonce), ciphertext: bytesToHex(ciphertext) };
}

export function openPairingPayload(envelope: PairingEnvelope, key: Uint8Array): unknown {
  if (key.length !== nacl.secretbox.keyLength) throw new Error("invalid pairing envelope key");
  let nonce: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    nonce = hexToBytes(envelope.nonce);
    ciphertext = hexToBytes(envelope.ciphertext);
  } catch {
    throw new Error("failed to decrypt pairing payload");
  }
  const opened = nacl.secretbox.open(ciphertext, nonce, key);
  if (!opened) throw new Error("failed to decrypt pairing payload");
  try {
    return JSON.parse(decodeUtf8(opened));
  } catch {
    throw new Error("invalid encrypted pairing payload");
  }
}

export { bytesToHex, hexToBytes };
