// plc 的命令和网关之间的映射：每条客户端命令调哪条网关路由、怎样打印结果。
// 网关客户端是假的，只记下调用；所以这里不需要 daemon。真实网关的行为由 packages/gateway 和
// apps/daemon 的契约测试覆盖。
import { describe, expect, it } from "vitest";
import { ControlPlaneClientError } from "@pi-lead-child/client";
import type { TicketSummary } from "@pi-lead-child/protocol";
import { buildProgram, type CliDeps, type GatewayClient, type GatewaySession } from "../src/commands.js";
import type { StoredCliCredential } from "../src/credential-file.js";

const credential: StoredCliCredential = {
  version: 1,
  accessToken: "tok_never_printed",
  binding: { id: 9, kind: "cli", name: "plc", scopes: ["chat", "tickets:view", "tickets:create", "admin"] },
  issuedAt: "2026-10-13T04:00:00.000Z",
};

const ticket: TicketSummary = {
  id: 42, title: "写周报", summary: "", kind: "task", stage: "ready", status: "ready", hasRun: false,
  priority: "high", project: "home", dueAt: null, deferUntil: null, updatedAt: "2026-10-13T04:00:00.000Z",
  runtime: { state: "idle", lastActivityAt: null, activeAttemptId: null },
  attention: { pendingApprovalCount: 0, blockerCount: 0 },
};

// 管理命令（配对、binding、aish、重检）用临时 admin token 的客户端；它的调用记成 "admin:方法名"。
const ADMIN_METHODS = new Set(["createPairing", "listBindings", "revokeBinding", "getAishStatus", "forgetAish", "recheckRuntimes"]);

function harness(client: Partial<GatewayClient> = {}, overrides: Partial<CliDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Array<[string, ...unknown[]]> = [];
  let exitCode = 0;
  let gatewayCalls = 0;
  const recorder = (prefix: string) => new Proxy(client, {
    get(target, name: string) {
      // 不是 thenable：await 一个客户端不能把它当成 Promise。
      if (name === "then") return undefined;
      const implementation = (target as Record<string, unknown>)[name];
      return async (...args: unknown[]) => {
        calls.push([`${prefix}${name}`, ...args]);
        if (typeof implementation === "function") return implementation(...args);
        return undefined;
      };
    },
  }) as GatewayClient;
  const recording = recorder("");
  const session: GatewaySession = { client: recording, gatewayUrl: "http://127.0.0.1:47130", credential };
  const deps: CliDeps = {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    setExitCode: (code) => { exitCode = code; },
    gateway: async () => { gatewayCalls += 1; return session; },
    admin: async () => { gatewayCalls += 1; return recorder("admin:"); },
    login: async () => ({ session, previous: null }),
    proveCredential: async () => null,
    storedCredential: () => ({ path: "/data/cli-credential.json", credential }),
    chat: async () => {},
    runOps: async (args) => { calls.push(["runOps", args]); return 0; },
    supervisor: {
      available: async () => true,
      request: async (command) => { calls.push(["supervisor", command]); return { ok: true } as never; },
    },
    daemon: { status: async () => null },
    renderQr: async (text) => { out.push(`[qr ${text}]`); },
    webBuilt: () => true,
    openUrl: () => {},
    ...overrides,
  };
  const program = buildProgram(deps).exitOverride();
  return {
    out, err, calls,
    exitCode: () => exitCode,
    gatewayCalls: () => gatewayCalls,
    run: (...args: string[]) => program.parseAsync(["node", "plc", ...args]),
  };
}

describe("ticket commands go through the gateway", () => {
  it("creates a ticket as the user", async () => {
    const h = harness({ createTicket: async () => ({ id: 31 }) as never });
    await h.run("create", "写周报", "--brief", "整理本周进展", "--project", "home");
    expect(h.calls).toEqual([["createTicket", { title: "写周报", brief: "整理本周进展", priority: "normal", project: "home" }]]);
    expect(h.out).toEqual(["created item #31"]);
  });

  it("lists the tasks view by default, and refuses an unknown view without contacting the daemon", async () => {
    const h = harness({ listTickets: async () => [ticket] });
    await h.run("list");
    expect(h.calls).toEqual([["listTickets", { view: "tasks" }]]);
    expect(h.out).toEqual(["#42\t[ready]\t(high, home)\t写周报"]);

    const bad = harness();
    await bad.run("list", "--view", "everything");
    expect(bad.exitCode()).toBe(1);
    expect(bad.err.join("\n")).toContain("unknown view 'everything'");
    expect(bad.gatewayCalls()).toBe(0);
  });

  it("maps item and run actions to the user control plane", async () => {
    const h = harness();
    await h.run("item", "confirm", "18");
    await h.run("item", "cancel", "18", "--reason", "不做了");
    await h.run("run", "pause", "7");
    await h.run("run", "stop", "7", "--reason", "换方案");
    expect(h.calls).toEqual([
      ["performTicketAction", 18, "confirm"],
      ["performTicketAction", 18, "cancel", { reason: "不做了" }],
      ["performAttemptAction", 7, "pause", {}],
      ["performAttemptAction", 7, "stop", { reason: "换方案" }],
    ]);
    expect(h.out).toEqual(["item #18 confirm 已执行", "item #18 cancel 已执行", "run #7 pause 已执行", "run #7 stop 已执行"]);
  });

  it("shows a refused action as an error and exits 1", async () => {
    const h = harness({
      performTicketAction: async () => { throw new ControlPlaneClientError("actor 'user' may not transition done -> ready", "conflict", 409); },
    });
    await h.run("item", "confirm", "18");
    expect(h.exitCode()).toBe(1);
    expect(h.err).toEqual(["actor 'user' may not transition done -> ready"]);
  });

  it("tells the user how to get a new credential when the gateway rejects it", async () => {
    const h = harness({ listTickets: async () => { throw new ControlPlaneClientError("authentication required", "unauthorized", 401); } });
    await h.run("list");
    expect(h.exitCode()).toBe(1);
    expect(h.err.join("\n")).toContain("plc auth login");
  });
});

describe("trust, delegate and recheck", () => {
  it("reads, grants and revokes the lead trust", async () => {
    const grant = {
      id: 2, capability: "confirm_item" as const, granted_at: "2026-10-13 04:00:00", granted_via: "cli",
      revoked_at: null, revoked_via: null, note: null,
    };
    const h = harness({
      getLeadTrust: async () => ({ capability: "confirm_item", grant: null }),
      setLeadTrust: async (granted: boolean) => granted
        ? { capability: "confirm_item", granted: true, grant }
        : { capability: "confirm_item", granted: false, revoked: 1, grant: null },
    });
    await h.run("trust", "lead");
    await h.run("trust", "lead", "--confirm", "--note", "私人助理");
    await h.run("trust", "lead", "--revoke");
    expect(h.calls).toEqual([["getLeadTrust"], ["setLeadTrust", true, { note: "私人助理" }], ["setLeadTrust", false, {}]]);
    expect(h.out[0]).toBe("lead 没有 confirm_item 授权");
    expect(h.out[1]).toContain("已授权 lead 使用 confirm_item（授权 #2");
    expect(h.out[2]).toBe("已撤销 lead 的 confirm_item 授权（1 条）");
  });

  it("refuses --confirm with --revoke", async () => {
    const h = harness();
    await h.run("trust", "lead", "--confirm", "--revoke");
    expect(h.exitCode()).toBe(1);
    expect(h.gatewayCalls()).toBe(0);
  });

  it("prints the preflight blockers when a delegation is refused", async () => {
    const refused = new ControlPlaneClientError("HTTP 409", "http_error", 409, {
      error: { code: "delegation_preflight_failed", message: "x" },
      preflight: { blockers: ["没有结构化 continuation", "预算为 0"] },
    });
    const h = harness({ setLeadDelegation: async () => { throw refused; } });
    await h.run("delegate", "lead", "5", "--require-continuation");
    expect(h.exitCode()).toBe(1);
    expect(h.err).toEqual(["无法接受无人值守委托：没有结构化 continuation；预算为 0"]);
    expect(h.calls[0]).toEqual(["setLeadDelegation", 5, true, { requireContinuation: true }]);
  });

  it("grants a delegation and reports the active policy", async () => {
    const h = harness({
      setLeadDelegation: async () => ({ policy: { id: 3, max_rework_cycles: 2 }, preflight: { status: "ready", warnings: [] } }),
      getLeadDelegation: async () => ({ ticketId: 5, active: { id: 3 }, history: [] }),
    });
    await h.run("delegate", "lead", "5", "--max-rework-cycles", "2", "--until", "2026-10-20T00:00:00Z");
    expect(h.calls[0]).toEqual(["setLeadDelegation", 5, true, { maxReworkCycles: 2, effectiveUntil: "2026-10-20T00:00:00.000Z" }]);
    expect(h.out[0]).toContain("delegation policy #3，max_rework_cycles=2");
    expect(h.out[0]).toContain("当前生效：3");
  });

  it("rechecks with a temporary admin token", async () => {
    const h = harness({ recheckRuntimes: async () => [] });
    await h.run("recheck", "codex");
    expect(h.calls).toEqual([["admin:recheckRuntimes", "codex"]]);
  });

  it("rechecks a runtime, and says so when nothing is open", async () => {
    const h = harness({
      recheckRuntimes: async (runtime?: string) => runtime === "codex"
        ? [{ incidentId: 4, runtime: "codex", outcome: "canary_armed", summary: "Codex 认证失败（故障 #4）：重检通过" }]
        : [],
    });
    await h.run("recheck", "codex");
    await h.run("recheck", "pi");
    await h.run("recheck");
    expect(h.out).toEqual(["Codex 认证失败（故障 #4）：重检通过", "pi 没有未关闭的故障。", "没有未关闭的 runtime 故障。"]);
  });

  it("refuses an unknown runtime without contacting the daemon", async () => {
    const h = harness();
    await h.run("recheck", "gemini");
    expect(h.exitCode()).toBe(1);
    expect(h.err.join("\n")).toContain("pi | codex | claude");
    expect(h.gatewayCalls()).toBe(0);
  });
});

describe("admin commands", () => {
  it("creates a pairing code and a socket invitation", async () => {
    const h = harness({
      createPairing: async (input) => ({
        pairingId: 1, code: "PLC-ABCD", expiresAt: "2026-10-13T04:15:00.000Z",
        uri: input.endpoint ? "plc-pair://connect?v=2" : null,
      }),
    });
    await h.run("pair", "new", "--name", "phone");
    await h.run("pair", "new", "--name", "phone", "--endpoint", "ws://192.168.1.10:47130");
    expect(h.calls).toEqual([
      ["admin:createPairing", { name: "phone", kind: "companion" }],
      ["admin:createPairing", { name: "phone", kind: "companion", endpoint: "ws://192.168.1.10:47130" }],
    ]);
    expect(h.out.join("\n")).toContain("配对码: PLC-ABCD");
    expect(h.out).toContain("[qr plc-pair://connect?v=2]");
  });

  it("lists and revokes bindings", async () => {
    const binding = {
      id: 3, kind: "companion", name: "phone", status: "active", scopes: ["chat" as const],
      lastSeenAt: null, createdAt: "2026-10-13T04:00:00.000Z",
    };
    const h = harness({ listBindings: async () => [binding], revokeBinding: async () => ({ ...binding, status: "revoked" }) });
    await h.run("pair", "list");
    await h.run("pair", "revoke", "3");
    expect(h.out).toEqual(["#3\t[active]\tcompanion\tphone\tlast_seen=-", "binding #3 revoked"]);
  });

  it("shows the aish credential status and never a token", async () => {
    const h = harness({
      getAishStatus: async () => ({
        stored: true, url: "wss://aish.example/ws/agent",
        failure: { reason: "AUTH_FAILED: Invalid token", at: "2026-10-13T04:00:00.000Z" }, envToken: "marked_failed",
      }),
    });
    await h.run("aish", "status");
    const text = h.out.join("\n");
    expect(text).toContain("已保存的凭证：有");
    expect(text).toContain("鉴权失败标记：有。AUTH_FAILED: Invalid token");
    expect(text).toContain("这个 token 已被标记为鉴权失败");
  });

  it("asks for --yes before forgetting the aish credential", async () => {
    const h = harness({ forgetAish: async () => ({ removed: true, envTokenSet: true }) });
    await h.run("aish", "forget");
    expect(h.exitCode()).toBe(1);
    expect(h.gatewayCalls()).toBe(0);
    await h.run("aish", "forget", "--yes");
    expect(h.out.join("\n")).toContain("已删除保存的 aish 凭证");
    expect(h.out.join("\n")).toContain("PLC_AISH_TOKEN");
  });

  // 临时 admin token 只在 daemon 的内存里：过期或 daemon 重启后作废。换一个再试一次，不要让用户去 auth login。
  it("mints a new temporary admin token once when the gateway rejects it", async () => {
    let calls = 0;
    const h = harness({
      listBindings: async () => {
        calls += 1;
        if (calls === 1) throw new ControlPlaneClientError("authentication required", "unauthorized", 401);
        return [];
      },
    });
    await h.run("pair", "list");
    expect(h.exitCode()).toBe(0);
    expect(h.gatewayCalls()).toBe(2);
    expect(h.err).toEqual([]);
  });

  it("does not send the user to auth login when a fresh admin token is rejected again", async () => {
    const h = harness({ listBindings: async () => { throw new ControlPlaneClientError("authentication required", "unauthorized", 401); } });
    await h.run("pair", "list");
    expect(h.exitCode()).toBe(1);
    expect(h.err.join("\n")).not.toContain("auth login");
    expect(h.err.join("\n")).toContain("临时 admin token");
  });

  it("shows a refused admin request as an error", async () => {
    const h = harness({ listBindings: async () => { throw new ControlPlaneClientError("missing scope: admin", "forbidden", 403); } });
    await h.run("pair", "list");
    expect(h.exitCode()).toBe(1);
    expect(h.err).toEqual(["missing scope: admin"]);
  });
});

describe("auth", () => {
  it("shows the binding of the stored credential without the token", async () => {
    const h = harness();
    await h.run("auth", "status");
    const text = h.out.join("\n");
    expect(text).toContain("binding #9（kind=cli，plc）");
    expect(text).not.toContain("tok_never_printed");
  });

  it("revokes the previous binding only after the old token proves it is that kind=cli binding", async () => {
    const fresh = { ...credential, accessToken: "tok_new", binding: { ...credential.binding, id: 12 } };
    const proved: StoredCliCredential[] = [];
    const h = harness({}, {
      login: async () => ({ session: { client: {} as never, gatewayUrl: "http://127.0.0.1:47130", credential: fresh }, previous: credential }),
      proveCredential: async (old) => { proved.push(old); return { id: 9, kind: "cli", name: "plc", scopes: ["chat"] }; },
    });
    await h.run("auth", "login");
    expect(proved).toEqual([credential]);
    expect(h.calls).toEqual([["admin:revokeBinding", 9]]);
    expect(h.out).toEqual(["已签发新的 plc 凭证：binding #12（kind=cli）", "已撤销旧凭证 binding #9"]);
  });

  // 账本重置之后 binding 编号会复用：文件里记的 #9 可能已经是手机。旧 token 证明不了自己时不撤销。
  it("does not revoke anything when the old token no longer proves its binding", async () => {
    const fresh = { ...credential, accessToken: "tok_new", binding: { ...credential.binding, id: 12 } };
    for (const proof of [null, { id: 9, kind: "companion", name: "phone", scopes: ["chat" as const] }, { id: 4, kind: "cli", name: "plc", scopes: [] }]) {
      const h = harness({}, {
        login: async () => ({ session: { client: {} as never, gatewayUrl: "http://127.0.0.1:47130", credential: fresh }, previous: credential }),
        proveCredential: async () => proof,
      });
      await h.run("auth", "login");
      expect(h.calls).toEqual([]);
      expect(h.out.join("\n")).toContain("没有撤销");
    }
  });
});

describe("ops commands", () => {
  it("run the daemon's ops entry and pass its exit code through", async () => {
    const h = harness({}, { runOps: async (args) => { h.calls.push(["runOps", args]); return args[0] === "doctor" ? 1 : 0; } });
    await h.run("doctor");
    expect(h.exitCode()).toBe(1);
    await h.run("daemon", "install");
    await h.run("lead", "use", "local/qwen");
    await h.run("lead", "model");
    expect(h.calls).toEqual([["runOps", ["doctor"]], ["runOps", ["install"]], ["runOps", ["lead-use", "local/qwen"]], ["runOps", ["lead-model"]]]);
    expect(h.gatewayCalls()).toBe(0);
  });

  // 部署闸门（审查 2026-10-20 B）：plc daemon start 也经过闸门，--force 是显式的绕过。
  it("start passes --force to the ops entry only when it is given", async () => {
    const h = harness();
    await h.run("daemon", "start");
    await h.run("daemon", "start", "--force");
    expect(h.calls).toEqual([["runOps", ["start"]], ["runOps", ["start", "--force"]]]);
  });

  it("restart goes to supervisor.sock", async () => {
    const h = harness();
    await h.run("daemon", "restart", "--reason", "update aish token");
    expect(h.calls).toEqual([["supervisor", { type: "request_maintenance", action: "restart", reason: "update aish token" }]]);
  });

  it("stop without a supervisor goes through the ops entry, which also records the stop", async () => {
    const h = harness({}, {
      supervisor: { available: async () => false, request: async () => ({}) as never },
    });
    await h.run("daemon", "stop");
    expect(h.calls).toEqual([["runOps", ["stop"]]]);
    expect(h.gatewayCalls()).toBe(0);
  });
});

describe("removed commands", () => {
  it("has no plc work: a foreground run would bypass the scheduler and the supervisor", async () => {
    const h = harness();
    await expect(h.run("work", "3")).rejects.toMatchObject({ code: "commander.unknownCommand" });
  });
});
