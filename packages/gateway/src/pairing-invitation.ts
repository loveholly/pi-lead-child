import { buildSocketPairingUri, type PairingOrigin, type QrMatrix } from "@pi-lead-child/protocol";
import type { Db } from "@pi-lead-child/store";
import { createPairing, getOrCreateGatewayIdentity } from "@pi-lead-child/store";
import QRCode from "qrcode";

export interface GatewayPairingInvitation {
  pairingId: number;
  code: string;
  socketSecret: string;
  expiresAt: string;
  daemonPublicKey: Uint8Array;
  uri: string;
}

export function createGatewayPairingInvitation(
  db: Db,
  args: {
    endpoint: string;
    name: string;
    kind: "desktop" | "companion" | "cli";
    scopes?: string[];
    // 谁建的配对：本机网页的扫码邀请写 web_invitation，管理路由（临时 admin）用缺省的 admin。
    origin?: PairingOrigin;
  },
): GatewayPairingInvitation {
  const pairing = createPairing(db, args);
  const daemonIdentity = getOrCreateGatewayIdentity(db);
  const uri = buildSocketPairingUri({
    endpoint: args.endpoint,
    pairingId: pairing.pairingId,
    pairingSecret: pairing.socketSecret,
    daemonPublicKey: daemonIdentity.publicKey,
  });
  return {
    ...pairing,
    daemonPublicKey: daemonIdentity.publicKey,
    uri,
  };
}

// 把文字编码成二维码点阵（不含静区），本机网页用组件库的 QrMatrix 画出来。纠错等级 M：
// 屏幕上的码不会被弄脏，M 比 Q、H 的模块少，手机在一臂远处也扫得清。
export function encodeQrMatrix(text: string): QrMatrix {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  const rows: string[] = [];
  for (let y = 0; y < modules.size; y += 1) {
    let row = "";
    for (let x = 0; x < modules.size; x += 1) row += modules.get(y, x) ? "1" : "0";
    rows.push(row);
  }
  return { size: modules.size, rows };
}
