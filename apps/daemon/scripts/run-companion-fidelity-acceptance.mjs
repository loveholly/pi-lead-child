import { execFile } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";

export const FIDELITY_PROTOTYPE_SHA256 =
  "246337627a539e859330447ab3415b94a8d6cf206b9996b2e8368ebd37c6b3a9";
export const ACCEPTANCE_PORTS = Object.freeze({ daemon: 47140, expo: 49161, prototype: 49162 });
export const ACCEPTANCE_SCENARIOS = Object.freeze([
  "populated",
  "first-use",
  "all-completed",
  "no-results",
]);

const READY_URLS = Object.freeze({
  daemon: `http://127.0.0.1:${ACCEPTANCE_PORTS.daemon}/v1/health`,
  expo: `http://localhost:${ACCEPTANCE_PORTS.expo}`,
  prototype: `http://127.0.0.1:${ACCEPTANCE_PORTS.prototype}/healthz`,
});

export function createProcessSpecs(input) {
  const repoRoot = resolve(input.repoRoot);
  const dataDir = resolve(input.dataDir);
  const prototypePath = resolve(input.prototypePath);
  return {
    daemon: {
      command: process.execPath,
      args: [
        "--import", "tsx",
        "apps/daemon/scripts/serve-companion-fidelity-gateway.ts",
        "--data-dir", dataDir,
        "--port", String(ACCEPTANCE_PORTS.daemon),
        "--host", "127.0.0.1",
        "--origin", `http://localhost:${ACCEPTANCE_PORTS.expo}`,
      ],
      cwd: repoRoot,
      env: {
        PLC_DATA_DIR: dataDir,
        PLC_GATEWAY_PORT: String(ACCEPTANCE_PORTS.daemon),
        PLC_GATEWAY_HOST: "127.0.0.1",
        PLC_ALLOW_LOOPBACK_AUTO_PAIR: "1",
        PLC_LOOPBACK_AUTO_PAIR_ORIGINS: `http://localhost:${ACCEPTANCE_PORTS.expo}`,
      },
      logPath: join(dataDir, "daemon.log"),
      readinessUrl: READY_URLS.daemon,
    },
    expo: {
      command: "npx",
      args: ["expo", "start", "--web", "--port", String(ACCEPTANCE_PORTS.expo), "--clear"],
      cwd: join(repoRoot, "apps", "companion"),
      env: {
        CI: "1",
        EXPO_PUBLIC_PLC_GATEWAY_URL: `http://127.0.0.1:${ACCEPTANCE_PORTS.daemon}`,
      },
      logPath: join(dataDir, "expo.log"),
      readinessUrl: READY_URLS.expo,
    },
    prototype: {
      command: process.execPath,
      args: [
        "apps/daemon/scripts/serve-companion-prototype.mjs",
        "--port", String(ACCEPTANCE_PORTS.prototype),
        "--file", prototypePath,
        "--sha256", FIDELITY_PROTOTYPE_SHA256,
      ],
      cwd: repoRoot,
      env: {},
      logPath: join(dataDir, "prototype.log"),
      readinessUrl: READY_URLS.prototype,
    },
  };
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function readSession(path) {
  const session = JSON.parse(readFileSync(path, "utf8"));
  if (session?.version !== 1 || session?.fixture !== "companion-fidelity") {
    throw new Error("invalid Companion fidelity session record");
  }
  return session;
}

function writeSession(path, session) {
  atomicWriteJson(path, session);
  atomicWriteJson(join(session.dataDir, "pids.json"), {
    version: session.version,
    scenario: session.scenario,
    state: session.state,
    processes: Object.fromEntries(Object.entries(session.processes).map(([name, process]) => [
      name,
      { pid: process.pid, state: process.state, startedAt: process.startedAt, stoppedAt: process.stoppedAt },
    ])),
  });
}

function execFileText(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${error.message}\n${stderr}`));
      } else {
        resolvePromise(stdout.trim());
      }
    });
  });
}

async function defaultSeed(input) {
  const stdout = await execFileText("npx", [
    "tsx",
    "apps/daemon/scripts/seed-companion-fidelity.ts",
    "--data-dir", input.dataDir,
    "--scenario", input.scenario,
  ], { cwd: input.repoRoot, env: process.env });
  return JSON.parse(stdout);
}

async function defaultSpawn(spec) {
  const logFd = openSync(spec.logPath, "a", 0o600);
  try {
    const child = nodeSpawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    await new Promise((resolvePromise, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolvePromise();
      };
      const onError = (error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    if (!child.pid) throw new Error(`managed process '${spec.command}' has no pid`);
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

async function fetchAvailable(url, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultWaitReady(spec, processRecord, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchAvailable(spec.readinessUrl)) return;
    if (!processIsAlive(processRecord.pid)) {
      throw new Error(`${processRecord.name} exited before ${spec.readinessUrl} became ready; inspect ${spec.logPath}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`timed out waiting for ${spec.readinessUrl}; inspect ${spec.logPath}`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function defaultStop(pid) {
  if (!processIsAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") process.kill(pid, "SIGTERM");
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processIsAlive(pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (!processIsAlive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") process.kill(pid, "SIGKILL");
  }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline && processIsAlive(pid)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (processIsAlive(pid)) throw new Error(`managed process ${pid} did not exit`);
}

function defaultNow() {
  return new Date().toISOString();
}

function runtimeWith(overrides = {}) {
  return {
    seed: overrides.seed ?? defaultSeed,
    spawn: overrides.spawn ?? defaultSpawn,
    waitReady: overrides.waitReady ?? defaultWaitReady,
    stop: overrides.stop ?? defaultStop,
    healthAvailable: overrides.healthAvailable ?? fetchAvailable,
    now: overrides.now ?? defaultNow,
  };
}

function processRecord(name, spec, pid, now) {
  return {
    name,
    pid,
    state: "running",
    startedAt: now,
    stoppedAt: null,
    spec,
  };
}

export async function startAcceptanceSession(input, overrides = {}) {
  if (!ACCEPTANCE_SCENARIOS.includes(input.scenario)) {
    throw new Error(`unknown acceptance scenario '${input.scenario}'`);
  }
  const runtime = runtimeWith(overrides);
  const repoRoot = resolve(input.repoRoot);
  const dataDir = input.dataDir
    ? resolve(input.dataDir)
    : mkdtempSync(join(tmpdir(), `plc-companion-fidelity-${input.scenario}-`));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const prototypePath = resolve(input.prototypePath);
  const sessionPath = resolve(input.sessionPath);
  const seed = await runtime.seed({ scenario: input.scenario, dataDir, repoRoot });
  const specs = createProcessSpecs({ repoRoot, dataDir, prototypePath });
  const processes = {};
  const session = {
    version: 1,
    fixture: "companion-fidelity",
    scenario: input.scenario,
    state: "starting",
    createdAt: runtime.now(),
    updatedAt: runtime.now(),
    repoRoot,
    dataDir,
    sessionPath,
    seed,
    urls: {
      daemon: READY_URLS.daemon,
      implementation: `http://localhost:${ACCEPTANCE_PORTS.expo}`,
      prototype: `http://localhost:${ACCEPTANCE_PORTS.prototype}/#1c`,
    },
    processes,
  };
  writeSession(sessionPath, session);

  try {
    for (const name of ["daemon", "expo", "prototype"]) {
      const child = await runtime.spawn(specs[name]);
      if (!Number.isInteger(child.pid) || child.pid < 1) throw new Error(`${name} process has no valid pid`);
      processes[name] = processRecord(name, specs[name], child.pid, runtime.now());
      session.updatedAt = runtime.now();
      writeSession(sessionPath, session);
    }
    await Promise.all(Object.entries(processes).map(([name, record]) =>
      runtime.waitReady(specs[name], record)));
  } catch (error) {
    for (const record of Object.values(processes)) {
      await runtime.stop(record.pid).catch(() => {});
      record.state = "stopped";
      record.stoppedAt = runtime.now();
    }
    session.state = "stopped";
    session.updatedAt = runtime.now();
    writeSession(sessionPath, session);
    throw error;
  }

  session.state = "running";
  session.updatedAt = runtime.now();
  writeSession(sessionPath, session);
  return session;
}

export async function stopAcceptanceDaemon(sessionPath, overrides = {}) {
  const runtime = runtimeWith(overrides);
  const session = readSession(sessionPath);
  const daemon = session.processes.daemon;
  if (daemon.state !== "running") throw new Error("recorded daemon is not running");
  await runtime.stop(daemon.pid);
  if (await runtime.healthAvailable(session.urls.daemon)) {
    throw new Error("daemon health remains available after stop");
  }
  daemon.state = "stopped";
  daemon.stoppedAt = runtime.now();
  session.updatedAt = runtime.now();
  writeSession(sessionPath, session);
  return session;
}

export async function startAcceptanceDaemon(sessionPath, overrides = {}) {
  const runtime = runtimeWith(overrides);
  const session = readSession(sessionPath);
  const daemon = session.processes.daemon;
  if (daemon.state !== "stopped") throw new Error("recorded daemon must be stopped before restart");
  const child = await runtime.spawn(daemon.spec);
  if (!Number.isInteger(child.pid) || child.pid < 1) throw new Error("restarted daemon has no valid pid");
  const restarted = processRecord("daemon", daemon.spec, child.pid, runtime.now());
  try {
    await runtime.waitReady(daemon.spec, restarted);
  } catch (error) {
    await runtime.stop(child.pid).catch(() => {});
    throw error;
  }
  session.processes.daemon = restarted;
  session.state = "running";
  session.updatedAt = runtime.now();
  writeSession(sessionPath, session);
  return session;
}

export async function stopAcceptanceSession(sessionPath, overrides = {}) {
  const runtime = runtimeWith(overrides);
  const session = readSession(sessionPath);
  for (const name of ["daemon", "expo", "prototype"]) {
    const record = session.processes[name];
    if (!record) continue;
    if (record.state !== "running") continue;
    await runtime.stop(record.pid);
    record.state = "stopped";
    record.stoppedAt = runtime.now();
  }
  session.state = "stopped";
  session.updatedAt = runtime.now();
  writeSession(sessionPath, session);
  return session;
}

function parseCli(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (["--stop", "--stop-daemon", "--start-daemon"].includes(name)) {
      parsed[name.slice(2)] = true;
      continue;
    }
    const value = argv[++index];
    if (!value) throw new Error(`${name} requires a value`);
    if (name === "--scenario") parsed.scenario = value;
    else if (name === "--prototype") parsed.prototype = value;
    else if (name === "--sha256") parsed.sha256 = value;
    else if (name === "--session-out") parsed.sessionOut = value;
    else if (name === "--session") parsed.session = value;
    else throw new Error(`unknown argument '${name}'`);
  }
  return parsed;
}

async function main(argv) {
  const args = parseCli(argv);
  const modes = [args.stop, args["stop-daemon"], args["start-daemon"]].filter(Boolean).length;
  if (modes > 1) throw new Error("choose only one stop/start mode");
  if (args.stop || args["stop-daemon"] || args["start-daemon"]) {
    if (!args.session) throw new Error("--session is required for lifecycle commands");
    if (args.stop) return stopAcceptanceSession(resolve(args.session));
    if (args["stop-daemon"]) return stopAcceptanceDaemon(resolve(args.session));
    return startAcceptanceDaemon(resolve(args.session));
  }
  if (!ACCEPTANCE_SCENARIOS.includes(args.scenario)) {
    throw new Error(`--scenario must be one of ${ACCEPTANCE_SCENARIOS.join(", ")}`);
  }
  if (!args.prototype) throw new Error("--prototype is required");
  if (args.sha256 !== FIDELITY_PROTOTYPE_SHA256) {
    throw new Error(`--sha256 must equal ${FIDELITY_PROTOTYPE_SHA256}`);
  }
  if (!args.sessionOut) throw new Error("--session-out is required");
  return startAcceptanceSession({
    scenario: args.scenario,
    prototypePath: args.prototype,
    sessionPath: args.sessionOut,
    repoRoot: resolve(import.meta.dirname, "../../.."),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let activeSessionPath = null;
  let stopping = false;
  const cleanup = async () => {
    if (stopping || !activeSessionPath) return;
    stopping = true;
    try { await stopAcceptanceSession(activeSessionPath); } finally { process.exit(130); }
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  try {
    const parsed = parseCli(process.argv.slice(2));
    activeSessionPath = parsed.sessionOut ? resolve(parsed.sessionOut) : null;
    const result = await main(process.argv.slice(2));
    activeSessionPath = null;
    console.log(JSON.stringify(result));
  } catch (error) {
    if (activeSessionPath) {
      try { await stopAcceptanceSession(activeSessionPath); } catch { /* startup may not have a record yet */ }
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
