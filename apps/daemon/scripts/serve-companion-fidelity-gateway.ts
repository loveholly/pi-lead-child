import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import { PairedCommandError, startPairedServer } from "@pi-lead-child/gateway";
import { openDb } from "@pi-lead-child/store";

export const FIDELITY_GATEWAY_HOST = "127.0.0.1";
export const FIDELITY_LOOPBACK_ORIGIN = "http://localhost:49161";
export const FIDELITY_CONTROL_PLANE_NOW = "2026-07-25T07:44:12.000Z";

function fidelityRuntime() {
  return {
    model: "companion-fidelity",
    sessionId: "companion-fidelity",
    busy: false,
    runningItemIds: [],
    aish: null,
  };
}

export async function startCompanionFidelityGateway(input: {
  dataDir: string;
  port: number;
  host?: string;
  loopbackAutoPairOrigins?: string[];
  // 导出的 web UI（npm run build:web 的产物）。给了它，网关就在 / 下提供页面，页面以网关自己的 origin 自动配对。
  webRoot?: string;
  log?: (line: string) => void;
}) {
  const dataDir = resolve(input.dataDir);
  const db = openDb(join(dataDir, "plc.db"));
  try {
    const paired = await startPairedServer({
      db,
      controlPlane: createControlPlaneService(db, {
        dataDir,
        runtime: fidelityRuntime,
        now: () => new Date(FIDELITY_CONTROL_PLANE_NOW),
      }),
      hello: fidelityRuntime,
      chat: () => "steered",
      chatV2: () => {
        throw new PairedCommandError("forbidden", "Companion fidelity gateway is read-only");
      },
      addClient: () => () => {},
      log: input.log ?? ((line) => console.log(line)),
    }, {
      port: input.port,
      host: input.host ?? FIDELITY_GATEWAY_HOST,
      allowLoopbackAutoPair: true,
      loopbackAutoPairOrigins: input.loopbackAutoPairOrigins ?? [FIDELITY_LOOPBACK_ORIGIN],
      ...(input.webRoot ? { webRoot: resolve(input.webRoot) } : {}),
    });
    let closed = false;
    return {
      port: paired.port,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await paired.close();
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function parseCliArgs(argv: string[]): {
  dataDir: string;
  port: number;
  host: string;
  loopbackAutoPairOrigins: string[];
  webRoot?: string;
} {
  let dataDir = "";
  let webRoot: string | undefined;
  let port = 0;
  let host = FIDELITY_GATEWAY_HOST;
  const loopbackAutoPairOrigins: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--data-dir") dataDir = value;
    else if (name === "--port") port = Number(value);
    else if (name === "--host") host = value;
    else if (name === "--origin") loopbackAutoPairOrigins.push(value);
    else if (name === "--web-root") webRoot = value;
    else throw new Error(`unknown argument '${name}'`);
  }
  if (!dataDir) throw new Error("--data-dir is required");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  if (!host.trim()) throw new Error("--host must not be empty");
  return {
    dataDir,
    port,
    host,
    loopbackAutoPairOrigins: loopbackAutoPairOrigins.length
      ? loopbackAutoPairOrigins
      : [FIDELITY_LOOPBACK_ORIGIN],
    ...(webRoot ? { webRoot } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const gateway = await startCompanionFidelityGateway(parseCliArgs(process.argv.slice(2)));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void gateway.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
