import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const FIDELITY_PROTOTYPE_SHA256 =
  "246337627a539e859330447ab3415b94a8d6cf206b9996b2e8368ebd37c6b3a9";

export function verifyPrototypeFile(file, expectedSha256 = FIDELITY_PROTOTYPE_SHA256) {
  const resolved = resolve(file);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error(`prototype path is not a file: ${resolved}`);
  const sha256 = createHash("sha256").update(readFileSync(resolved)).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(`prototype SHA-256 mismatch: expected ${expectedSha256}, received ${sha256}`);
  }
  return { file: resolved, sha256, byteLength: stat.size };
}

export function createPrototypeServer(input) {
  const verified = verifyPrototypeFile(input.file, input.sha256);
  return createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET" && pathname === "/healthz") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: true, sha256: verified.sha256 }));
      return;
    }
    if ((request.method === "GET" || request.method === "HEAD")
      && (pathname === "/" || pathname === "/index.html")) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": String(verified.byteLength),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(verified.file).pipe(response);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
  });
}

function parseArgs(argv) {
  const parsed = { port: 0, host: "127.0.0.1", file: "", sha256: "" };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--port") parsed.port = Number(value);
    else if (name === "--host") parsed.host = value;
    else if (name === "--file") parsed.file = value;
    else if (name === "--sha256") parsed.sha256 = value;
    else throw new Error(`unknown argument '${name}'`);
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  if (!parsed.file) throw new Error("--file is required");
  if (parsed.sha256 !== FIDELITY_PROTOTYPE_SHA256) {
    throw new Error(`--sha256 must equal ${FIDELITY_PROTOTYPE_SHA256}`);
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const server = createPrototypeServer(args);
    server.listen(args.port, args.host, () => {
      console.log(JSON.stringify({
        ok: true,
        url: `http://${args.host}:${args.port}`,
        file: resolve(args.file),
        sha256: args.sha256,
      }));
    });
    const stop = () => server.close(() => process.exit(0));
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
