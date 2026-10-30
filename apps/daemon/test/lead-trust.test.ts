// 用户对 lead 的授权（store/lead-grants.ts）。
//
// 用户的原话是「如果我授权了，我的 lead agent 应该有权限做所有的操作」。这一组测试要同时
// 守住两件看起来相反的事：
//   1. 授权有效——给过之后 lead 真的能代他确认，不再一句"我没权限"顶回去；
//   2. 授权不是提示词自律——它是一条 lead 改不了、随时可收回的账本事实，撤销当场生效，
//      而权限矩阵一个字没动。
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "@pi-lead-child/store";
import { createItem, getItem, transition } from "@pi-lead-child/store";
import { listActivities } from "@pi-lead-child/store";
import { canTransition } from "@pi-lead-child/store";
import {
  activeLeadGrant, grantLeadCapability, leadHasCapability, listLeadGrants,
  revokeLeadCapability,
} from "@pi-lead-child/store";
import {
  createGrantedLeadTools, createLeadTools, GRANT_GATED_LEAD_TOOLS, type LeadDeps,
} from "@pi-lead-child/lead";
import { LEAD_ALL_BUILTIN_TOOLS, LEAD_CODEMODE_TOOLS, leadActiveToolNames } from "@pi-lead-child/lead";
import { packageSource } from "@pi-lead-child/core";
import { createPairing } from "@pi-lead-child/store";
import { startPairedServer } from "@pi-lead-child/gateway";
import { createControlPlaneService } from "@pi-lead-child/gateway";
import { tempDir } from "@pi-lead-child/core/testing";

let db: Db;
let deps: LeadDeps;

beforeEach(() => {
  const dir = tempDir("plc-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir };
});

function allTools() {
  return [...createLeadTools(deps), ...createGrantedLeadTools(deps)];
}

function activeNames() {
  return leadActiveToolNames(db, allTools());
}

function confirmTool() {
  const t = createGrantedLeadTools(deps).find((tool: any) => tool.name === "confirm_item") as any;
  if (!t) throw new Error("confirm_item tool missing");
  return t;
}

function heldRoot(): number {
  return createItem(db, { title: "总工单", brief: "b", createdBy: "lead", hold: true });
}

describe("the grant is a ledger fact the lead cannot forge", () => {
  it("starts absent — a spoken 我授权你了 grants nothing", () => {
    expect(leadHasCapability(db, "confirm_item")).toBe(false);
    expect(activeLeadGrant(db, "confirm_item")).toBeNull();
  });

  it("records who granted it through which channel, and stays idempotent", () => {
    const first = grantLeadCapability(db, { capability: "confirm_item", via: "cli", note: "私人助理" });
    const second = grantLeadCapability(db, { capability: "confirm_item", via: "control-plane" });
    // 两条同时生效的授权会让"凭哪一次"没有唯一答案，而那正是这张表存在的理由。
    expect(second.id).toBe(first.id);
    expect(first.granted_via).toBe("cli");
    expect(first.note).toBe("私人助理");
    expect(listLeadGrants(db, "confirm_item")).toHaveLength(1);
  });

  it("keeps the revoked row so 事后可查 — revocation is not deletion", () => {
    const grant = grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    expect(revokeLeadCapability(db, { capability: "confirm_item", via: "control-plane" })).toBe(1);
    expect(leadHasCapability(db, "confirm_item")).toBe(false);
    const history = listLeadGrants(db, "confirm_item");
    expect(history).toHaveLength(1);
    expect(history[0]!.id).toBe(grant.id);
    expect(history[0]!.revoked_at).not.toBeNull();
    expect(history[0]!.revoked_via).toBe("control-plane");
    // 幂等：本来就没有生效的授权，撤销是成功的 0，不是错误。
    expect(revokeLeadCapability(db, { capability: "confirm_item", via: "cli" })).toBe(0);
  });

  it("re-granting after a revoke opens a new numbered grant, not a resurrected one", () => {
    const first = grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    revokeLeadCapability(db, { capability: "confirm_item", via: "cli" });
    const second = grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    expect(second.id).toBeGreaterThan(first.id);
    expect(listLeadGrants(db, "confirm_item").map((g) => g.id)).toEqual([second.id, first.id]);
  });

  it("has no lead tool that can write the grant table", () => {
    // 结构性判据，不是"调用会被拒"：授权若能自授，它就退化成 lead 的固有权限。
    const source = readFileSync(packageSource("lead", "tools.ts"), "utf8");
    expect(source).not.toMatch(/grantLeadCapability|revokeLeadCapability/);
    for (const name of allTools().map((t: any) => t.name)) {
      expect(name).not.toMatch(/trust|grant/i);
    }
  });
});

describe("without a grant the tool is absent, not merely erroring", () => {
  it("keeps confirm_item out of the default lead tool set entirely", () => {
    // createLeadTools 是 lead 的**缺省**权限面：授权与否都不该出现在这里。
    expect(createLeadTools(deps).map((t: any) => t.name)).not.toContain("confirm_item");
    grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    expect(createLeadTools(deps).map((t: any) => t.name)).not.toContain("confirm_item");
  });

  it("omits it from the active tool list until the user grants it", () => {
    expect(activeNames()).not.toContain("confirm_item");
    grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    expect(activeNames()).toContain("confirm_item");
    revokeLeadCapability(db, { capability: "confirm_item", via: "cli" });
    expect(activeNames()).not.toContain("confirm_item");
  });

  it("never drops an ungated tool or the builtins while toggling", () => {
    // 放进 codemode 的工具（2026-10-28，按需加载方案）从不激活：激活就会声明给模型。它们在 codemode 脚本里照样能调。
    const ungated = createLeadTools(deps).map((t: any) => t.name).filter((name: string) => !LEAD_CODEMODE_TOOLS.has(name));
    for (const granted of [false, true]) {
      if (granted) grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
      const names = activeNames();
      // 内置工具包括沙箱里的 bash、edit、write 和 codemode（lead-tools-and-routing spec D5），授权的开关不影响它们。
      for (const name of [...ungated, ...LEAD_ALL_BUILTIN_TOOLS]) expect(names).toContain(name);
      for (const name of LEAD_CODEMODE_TOOLS) expect(names).not.toContain(name);
    }
  });

  it("still refuses at execute time if the grant was revoked after the tool list was built", async () => {
    // 工具表是同步时刻的快照；账本才是权威。撤销必须立刻生效，哪怕这一轮还没刷新。
    grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    const tool = confirmTool();
    const id = heldRoot();
    revokeLeadCapability(db, { capability: "confirm_item", via: "cli" });
    await expect(tool.execute("t", { ticket_id: id })).rejects.toThrow(/没有给你确认待办的授权|已撤销/);
    expect(getItem(db, id)!.stage).toBe("draft");
  });
});

// 长期授权算托管（用户 2026-10-22，ui-action-parity plan.md P03）：confirm_item 和页面的「确认开跑」是同一个工单操作 confirm，
// 授权范围内账本写 Lead 做的，并写明凭哪一份授权；以前写成 actor='user'。
describe("a granted confirmation is Lead's act under the user's standing authority", () => {
  it("moves the held root to ready as Lead, and names the grant in the transition", async () => {
    const grant = grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    const id = heldRoot();
    await confirmTool().execute("t", { ticket_id: id, reason: "用户说按你说的来" });
    expect(getItem(db, id)!.stage).toBe("ready");

    const activities = listActivities(db, id);
    const move = activities.find((a) => a.kind === "transition" && a.payload.includes('"to":"ready"'))!;
    expect(move.actor).toBe("lead");
    expect(JSON.parse(move.payload)).toMatchObject({
      onBehalfOf: "user", underGrant: { grantId: grant.id, capability: "confirm_item" },
      reason: expect.stringContaining(`user grant #${grant.id}`),
    });
  });

  it("also records a lead decision naming the grant, so 为什么这条会跑起来 is answerable", async () => {
    const grant = grantLeadCapability(db, { capability: "confirm_item", via: "control-plane" });
    const id = heldRoot();
    await confirmTool().execute("t", { ticket_id: id, reason: "用户说按你说的来" });

    const decision = listActivities(db, id)
      .find((a) => a.actor === "lead" && a.kind === "decision")!;
    expect(decision).toBeDefined();
    const payload = JSON.parse(decision.payload);
    expect(payload.grantId).toBe(grant.id);
    expect(payload.capability).toBe("confirm_item");
    expect(payload.grantedAt).toBe(grant.granted_at);
    expect(payload.authority).toContain("control-plane");
  });

  // 2026-10-28（用户：「工单操作让 Lead 自己判断」）：矩阵本来就给 lead 确认开跑，和授权无关。授权只决定账本怎样记
  // （凭哪一份授权，见上一条）；撤销授权以后 Lead 照样能凭自己的判断确认，记成它自己做的。
  it("gives lead the edge with or without the grant", async () => {
    expect(canTransition("task", "draft", "ready", "lead")).toBe(true);
    const id = heldRoot();
    transition(db, { itemId: id, to: "ready", actor: "lead", reason: "r" });
    expect(getItem(db, id)!.stage).toBe("ready");
  });

  it("grants confirm only — not the rest of the user-only surface", () => {
    grantLeadCapability(db, { capability: "confirm_item", via: "cli" });
    const names = activeNames();
    // 授权的是一项能力，不是"信任 lead"这个开关。验收（complete）、返工、撤回确认、
    // 开跑、暂停/恢复都不在其中——理由见 docs 与 commit message：确认是**事前**的
    // "可以开始了"，而验收是**事后**的"这份东西让我满意"，后者不可代劳。
    for (const forbidden of [
      "complete_item", "rework_item", "unconfirm_item", "start_item",
      "pause_run", "resume_run", "restore_item",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    expect(Object.keys(GRANT_GATED_LEAD_TOOLS)).toEqual(["confirm_item"]);
  });
});

describe("the control plane is a user-only entrance to the grant", () => {
  async function start() {
    const grants: { capability: string; via: string; note?: string }[] = [];
    const revokes: { capability: string; via: string }[] = [];
    const server = await startPairedServer({
      db,
      controlPlane: createControlPlaneService(db, {
        runtime: () => ({ model: "m", sessionId: "s", busy: false, runningItemIds: [], aish: null }),
      }),
      leadTrust: {
        grant(capability, via, note) {
          grants.push({ capability, via, ...(note === undefined ? {} : { note }) });
          return grantLeadCapability(db, { capability, via, ...(note === undefined ? {} : { note }) });
        },
        revoke(capability, via) {
          revokes.push({ capability, via });
          return revokeLeadCapability(db, { capability, via });
        },
        status: (capability) => activeLeadGrant(db, capability),
      },
      hello: () => ({ model: "m", sessionId: "s", busy: false }),
      chat: () => "started",
      addClient: () => () => {},
      log: () => {},
    }, { port: 0 });
    return { ...server, base: `http://127.0.0.1:${server.port}`, grants, revokes };
  }

  async function token(base: string, scopes: string[]): Promise<string> {
    const { code } = createPairing(db, { name: "phone", kind: "companion", scopes });
    const res = await fetch(`${base}/v1/paired/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: code }),
    });
    return (await res.json() as { access_token: string }).access_token;
  }

  it("grants, reports and revokes through POST/GET /v1/lead/trust", async () => {
    const server = await start();
    try {
      const access = await token(server.base, ["chat", "tickets:view", "tickets:create"]);
      const headers = { authorization: `Bearer ${access}`, "content-type": "application/json" };

      const before = await (await fetch(`${server.base}/v1/lead/trust`, { headers })).json() as any;
      expect(before.grant).toBeNull();

      const granted = await fetch(`${server.base}/v1/lead/trust`, {
        method: "POST", headers,
        body: JSON.stringify({ capability: "confirm_item", granted: true, note: "私人助理" }),
      });
      expect(granted.status).toBe(200);
      expect(server.grants).toEqual([{ capability: "confirm_item", via: "control-plane", note: "私人助理" }]);
      expect(activeNames()).toContain("confirm_item");

      const after = await (await fetch(`${server.base}/v1/lead/trust`, { headers })).json() as any;
      expect(after.grant.granted_via).toBe("control-plane");

      const revoked = await fetch(`${server.base}/v1/lead/trust`, {
        method: "POST", headers,
        body: JSON.stringify({ capability: "confirm_item", granted: false }),
      });
      expect(revoked.status).toBe(200);
      expect(await revoked.json()).toMatchObject({ granted: false, revoked: 1, grant: null });
      expect(activeNames()).not.toContain("confirm_item");
    } finally {
      await server.close();
    }
  });

  it("refuses a binding that is not the owner, and refuses acting as another actor", async () => {
    const server = await start();
    try {
      // 只读设备（无 tickets:create）不能授权：授权是主人的动作。
      const viewer = await token(server.base, ["chat", "tickets:view"]);
      const forbidden = await fetch(`${server.base}/v1/lead/trust`, {
        method: "POST",
        headers: { authorization: `Bearer ${viewer}`, "content-type": "application/json" },
        body: JSON.stringify({ capability: "confirm_item", granted: true }),
      });
      expect(forbidden.status).toBe(403);

      const owner = await token(server.base, ["chat", "tickets:view", "tickets:create"]);
      const impersonation = await fetch(`${server.base}/v1/lead/trust`, {
        method: "POST",
        headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
        body: JSON.stringify({ capability: "confirm_item", granted: true, actor: "lead" }),
      });
      expect(impersonation.status).toBe(403);

      const unknown = await fetch(`${server.base}/v1/lead/trust`, {
        method: "POST",
        headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" },
        body: JSON.stringify({ capability: "pause_run", granted: true }),
      });
      expect(unknown.status).toBe(400);

      expect(server.grants).toEqual([]);
      expect(leadHasCapability(db, "confirm_item")).toBe(false);
    } finally {
      await server.close();
    }
  });
});
