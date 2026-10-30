import { describe, expect, it } from "vitest";
import {
  buildSocketPairingUri,
  createPairingKeyPair,
  derivePairingSessionKey,
  hashPairingSecret,
  openPairingPayload,
  parseSocketPairingUri,
  sealPairingPayload,
} from "../src/index.js";

describe("socket pairing crypto contract", () => {
  it("round-trips a strict LAN pairing URI", () => {
    const daemon = createPairingKeyPair(new Uint8Array(32).fill(7));
    const uri = buildSocketPairingUri({
      endpoint: "ws://172.16.9.13:47130",
      pairingId: 42,
      pairingSecret: "0123456789abcdef0123456789abcdef0123456789abcdef",
      daemonPublicKey: daemon.publicKey,
    });

    expect(parseSocketPairingUri(uri)).toEqual({
      endpoint: "ws://172.16.9.13:47130/v1/paired/connect",
      pairingId: 42,
      pairingSecret: "0123456789abcdef0123456789abcdef0123456789abcdef",
      daemonPublicKey: daemon.publicKey,
    });
    expect(() => parseSocketPairingUri(uri.replace("ws%3A", "https%3A"))).toThrow("ws or wss");
    expect(() => parseSocketPairingUri(uri.replace("pairing_id=42", "pairing_id=0"))).toThrow("pairing id");
  });

  it("derives the same key and rejects tampered encrypted payloads", () => {
    const daemon = createPairingKeyPair(new Uint8Array(32).fill(3));
    const client = createPairingKeyPair(new Uint8Array(32).fill(9));
    const secretHash = hashPairingSecret("0123456789abcdef0123456789abcdef0123456789abcdef");
    const daemonKey = derivePairingSessionKey(daemon.secretKey, client.publicKey, secretHash);
    const clientKey = derivePairingSessionKey(client.secretKey, daemon.publicKey, secretHash);
    expect(clientKey).toEqual(daemonKey);

    const envelope = sealPairingPayload(
      { type: "pair.challenge", pairingId: 42, challenge: "challenge-1" },
      daemonKey,
      new Uint8Array(24).fill(5),
    );
    expect(openPairingPayload(envelope, clientKey)).toEqual({
      type: "pair.challenge",
      pairingId: 42,
      challenge: "challenge-1",
    });

    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -2)}00`,
    };
    expect(() => openPairingPayload(tampered, clientKey)).toThrow("decrypt");
  });
});
