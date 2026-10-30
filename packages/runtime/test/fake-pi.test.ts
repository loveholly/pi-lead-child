import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { attachJsonlReader } from "../src/jsonl.js";

describe("fake-pi", () => {
  it("answers prompt with agent_start..agent_end", async () => {
    const proc = spawn(resolve("node_modules/.bin/tsx"), [resolve("packages/runtime/testing/fake-pi.ts")]);
    const seen: string[] = [];
    const done = new Promise<void>((resolve) => {
      attachJsonlReader(proc.stdout, (line) => {
        const msg = JSON.parse(line);
        seen.push(msg.type);
        if (msg.type === "agent_end") { proc.kill(); resolve(); }
      });
    });
    proc.stdin.write(JSON.stringify({ type: "prompt", message: "hi", id: "1" }) + "\n");
    await done;
    expect(seen).toEqual(["response", "agent_start", "message_end", "agent_end"]);
  });
});
