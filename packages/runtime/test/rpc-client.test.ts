import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { RpcClient } from "../src/rpc-client.js";

describe("RpcClient", () => {
  it("correlates responses by id and emits events separately", async () => {
    const proc = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/runtime/testing/fake-pi.ts")]);
    const rpc = new RpcClient(proc);
    const events: string[] = [];
    rpc.on("event", (e: any) => events.push(e.type));

    const state = await rpc.send({ type: "get_state" });
    expect(state.success).toBe(true);
    expect(state.data.sessionId).toBe("fake-session-1");

    const agentEnd = new Promise<void>((r) =>
      rpc.on("event", (e: any) => e.type === "agent_end" && r()),
    );
    const resp = await rpc.send({ type: "prompt", message: "hello" });
    expect(resp.success).toBe(true);

    await agentEnd;
    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
    expect(events).not.toContain("response");
    proc.kill();
  });
});
