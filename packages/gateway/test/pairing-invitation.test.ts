import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  bytesToHex,
  hashPairingSecret,
  parseSocketPairingUri,
} from "@pi-lead-child/protocol";
import { tempDir } from "@pi-lead-child/core/testing";
import { createGatewayPairingInvitation } from "../src/pairing-invitation.js";
import { openDb, type Db } from "@pi-lead-child/store";
import { getPendingPairingById } from "@pi-lead-child/store";

let db: Db;

beforeEach(() => {
  db = openDb(join(tempDir("plc-pairing-invitation-"), "plc.db"));
});

describe("gateway pairing invitation", () => {
  it("creates a reusable protocol URI backed by one pending pairing", () => {
    const invitation = createGatewayPairingInvitation(db, {
      endpoint: "ws://172.16.9.13:47130",
      name: "Pixel Expo Go",
      kind: "companion",
    });
    const parsed = parseSocketPairingUri(invitation.uri);
    const pending = getPendingPairingById(db, invitation.pairingId);

    expect(parsed).toEqual({
      endpoint: "ws://172.16.9.13:47130/v1/paired/connect",
      pairingId: invitation.pairingId,
      pairingSecret: invitation.socketSecret,
      daemonPublicKey: invitation.daemonPublicKey,
    });
    expect(pending).toMatchObject({ name: "Pixel Expo Go", kind: "companion" });
    expect(pending?.socketSecretHash).toBe(bytesToHex(hashPairingSecret(invitation.socketSecret)));
  });

  it("uses the daemon's stable X25519 identity across invitations", () => {
    const first = createGatewayPairingInvitation(db, {
      endpoint: "ws://192.168.1.20:47130",
      name: "phone-a",
      kind: "companion",
    });
    const second = createGatewayPairingInvitation(db, {
      endpoint: "ws://192.168.1.20:47130",
      name: "phone-b",
      kind: "companion",
    });

    expect(bytesToHex(second.daemonPublicKey)).toBe(bytesToHex(first.daemonPublicKey));
    expect(second.pairingId).not.toBe(first.pairingId);
  });
});
