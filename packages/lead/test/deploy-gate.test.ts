// Lead 的 request_runtime_maintenance 和部署闸门：闸门在 Supervisor 的维护入口里（每条重启路径都经过）。
// Lead 的工具只做两件事：Supervisor 没有闸门时拒绝；Supervisor 拒绝时把原因原样交给 Lead。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { tempDir } from "@pi-lead-child/core/testing";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let dir: string;

beforeEach(() => {
  dir = tempDir("plc-deploy-gate-");
  db = openDb(join(dir, "plc.db"));
});

async function restart(supervisor: NonNullable<LeadDeps["supervisor"]>) {
  const tool = createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: join(dir, "data"), supervisor })
    .find((candidate: any) => candidate.name === "request_runtime_maintenance") as any;
  const result = await tool.execute("call", { action: "restart", reason: "deploy the fix" });
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

describe("request_runtime_maintenance", () => {
  it("relays the Supervisor's refusal and its reasons", async () => {
    const supervisor = {
      status: vi.fn(async () => ({ features: ["maintenance_backup", "deploy_gate"] }) as never),
      request: vi.fn(async () => {
        throw Object.assign(new Error("deploy refused:\n- 主 checkout 有没提交的改动：packages/x.ts。\n- dist 没有构建记录。"), { code: "deploy_refused" });
      }),
    };
    expect(await restart(supervisor)).toEqual({
      refused: true, action: "restart", reasons: ["主 checkout 有没提交的改动：packages/x.ts。", "dist 没有构建记录。"],
    });
  });

  it("refuses when the running Supervisor has no deploy gate, without asking it to restart", async () => {
    const supervisor = {
      status: vi.fn(async () => ({ features: ["maintenance_backup"] }) as never),
      request: vi.fn(async () => ({ id: "m-1" }) as never),
    };
    const result = await restart(supervisor);
    expect(result.refused).toBe(true);
    expect(result.reasons.join("\n")).toContain("kickstart");
    expect(supervisor.request).not.toHaveBeenCalled();
  });

  it("passes the request through when the Supervisor accepts it", async () => {
    const supervisor = {
      status: vi.fn(async () => ({ features: ["deploy_gate"], deploy: { ready: true, reasons: [], head: "abc", build: null } }) as never),
      request: vi.fn(async () => ({ id: "m-1", state: "pending" }) as never),
    };
    expect(await restart(supervisor)).toMatchObject({ id: "m-1", state: "pending", deploy: { ready: true } });
    expect(supervisor.request).toHaveBeenCalledWith({ action: "restart", reason: "deploy the fix" });
  });
});
