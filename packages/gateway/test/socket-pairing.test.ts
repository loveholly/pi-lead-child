import { join } from "node:path";
import WebSocket from "ws";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PairAcceptedSchema,
  PairChallengeSchema,
  PairSocketErrorSchema,
  PROTOCOL_VERSION,
  bytesToHex,
  createPairingKeyPair,
  derivePairingSessionKey,
  hashPairingSecret,
  openPairingPayload,
  sealPairingPayload,
} from "@pi-lead-child/protocol";
import { Value } from "typebox/value";
import { tempDir } from "@pi-lead-child/core/testing";
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { createPairing, getOrCreateGatewayIdentity } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-socket-pair-"), "plc.db"));
});

function runtime() {
  return {
    model: "stub/model", sessionId: "stub-session", busy: false,
    runningItemIds: [], aish: null,
  };
}

function collect(ws: WebSocket) {
  const messages: unknown[] = [];
  ws.on("message", (raw) => messages.push(JSON.parse(String(raw))));
  return messages;
}

describe("encrypted socket pairing", () => {
  it("pairs once over WebSocket and returns credentials encrypted to the QR client", async () => {
    const invitation = createPairing(db, { name: "Pixel Expo Go", kind: "companion" });
    const daemonIdentity = getOrCreateGatewayIdentity(db);
    const controlPlane = createControlPlaneService(db, { runtime });
    const server = await startPairedServer({
      db, controlPlane, hello: runtime, chat: () => "started", addClient: () => () => {}, log: () => {},
    }, { port: 0 });
    const clientPair = createPairingKeyPair(new Uint8Array(32).fill(11));
    const sessionKey = derivePairingSessionKey(
      clientPair.secretKey,
      daemonIdentity.publicKey,
      hashPairingSecret(invitation.socketSecret),
    );
    const lanHost = `172.16.9.13:${server.port}`;
    const foreignOriginStatus = await new Promise<number>((resolve, reject) => {
      const foreign = new WebSocket(`ws://127.0.0.1:${server.port}/v1/paired/connect`, {
        headers: { host: lanHost, origin: "http://evil.test" },
      });
      foreign.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      foreign.once("open", () => reject(new Error("foreign origin unexpectedly connected")));
      foreign.once("error", () => {});
    });
    expect(foreignOriginStatus).toBe(403);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/v1/paired/connect`, {
      headers: { host: lanHost, origin: `http://${lanHost}` },
    });
    const messages = collect(ws);

    try {
      await new Promise<void>((resolve) => ws.once("open", () => resolve()));
      ws.send(JSON.stringify({
        type: "pair.hello",
        protocolVersion: PROTOCOL_VERSION,
        pairingId: invitation.pairingId,
        clientPublicKey: bytesToHex(clientPair.publicKey),
      }));

      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
      const challengeMessage = messages[0];
      expect(Value.Check(PairChallengeSchema, challengeMessage)).toBe(true);
      expect(challengeMessage).toMatchObject({ daemonPublicKey: bytesToHex(daemonIdentity.publicKey) });
      const challenge = openPairingPayload((challengeMessage as any).envelope, sessionKey) as any;
      expect(challenge).toMatchObject({
        type: "pair.challenge",
        pairingId: invitation.pairingId,
        challenge: expect.stringMatching(/^[0-9a-f]{48}$/),
      });

      ws.send(JSON.stringify({
        type: "pair.confirm",
        protocolVersion: PROTOCOL_VERSION,
        envelope: sealPairingPayload({
          type: "pair.confirm",
          pairingId: invitation.pairingId,
          challenge: challenge.challenge,
        }, sessionKey, new Uint8Array(24).fill(13)),
      }));

      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(1));
      const acceptedMessage = messages[1];
      expect(Value.Check(PairAcceptedSchema, acceptedMessage)).toBe(true);
      const accepted = openPairingPayload((acceptedMessage as any).envelope, sessionKey) as any;
      expect(accepted).toMatchObject({
        type: "pair.accepted",
        binding: { kind: "companion", name: "Pixel Expo Go" },
        access_token: expect.any(String),
      });

      const tickets = await fetch(`http://127.0.0.1:${server.port}/v1/tickets`, {
        headers: { authorization: `Bearer ${accepted.access_token}` },
      });
      expect(tickets.status).toBe(200);

      const replay = new WebSocket(`ws://127.0.0.1:${server.port}/v1/paired/connect`);
      const replayMessages = collect(replay);
      await new Promise<void>((resolve) => replay.once("open", () => resolve()));
      replay.send(JSON.stringify({
        type: "pair.hello",
        protocolVersion: PROTOCOL_VERSION,
        pairingId: invitation.pairingId,
        clientPublicKey: bytesToHex(clientPair.publicKey),
      }));
      await vi.waitFor(() => expect(replayMessages.length).toBeGreaterThan(0));
      expect(Value.Check(PairSocketErrorSchema, replayMessages[0])).toBe(true);
      expect(replayMessages[0]).toMatchObject({ error: { code: "invalid_pairing" } });
      replay.close();
    } finally {
      ws.close();
      await server.close();
    }
  });
});
