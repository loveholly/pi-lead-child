// child 以用户身份批准自己的审批（2026-10-22，.scratch/child-self-approve/options.md 方案 A）。
// 完整的持久化流程：真实的 daemon、plc.sock、网关和账本。
// child 和用户是同一个系统用户，有 shell。以前它连上 plc.sock 换一个 cli 凭证（plc 存进 cli-credential.json 的就是它），
// 再调审批接口，就批准了自己的 request_approval，账本记成「user via paired binding:N」。
// 用 plc.sock 的临时 admin token 建一个配对、在这台机器上兑换，也一样。
// 这两种凭证不再能做用户的决定。本机网页照常能批。
// child 也不能借 Lead 批：用 cli 凭证开一轮聊天说「批准 #N」，Lead 在这一轮里代批会被拒（这一轮的凭证没有 approvals:respond）。
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "@pi-lead-child/engine";
import { createLeadTools } from "@pi-lead-child/lead";
import type { LocalSocketResponse } from "@pi-lead-child/protocol";
import {
  createItem, createLoopbackBinding, createRun, getApproval, listEvents, openDb, transition, updateRun, type Db,
} from "@pi-lead-child/store";
import { attachJsonlReader } from "@pi-lead-child/runtime";
import { startDaemon } from "../src/server.js";

let dir: string;
let db: Db;
let daemon: Awaited<ReturnType<typeof startDaemon>> | null = null;
// Lead 的一轮停在这里，直到测试放开：这一轮还在进行，Lead 的工具在这一轮里调用。
let leadHold: Promise<void> = Promise.resolve();
let releaseLead: () => void = () => {};

function holdLead(): void {
  leadHold = new Promise((resolve) => { releaseLead = resolve; });
}

const sessionFactory = async () => ({
  modelName: "stub/model",
  session: {
    sessionId: "stub-session",
    subscribe() { return () => {}; },
    async prompt() { await leadHold; },
    async steer() {},
    async followUp() {},
    dispose() {},
  },
});

beforeEach(async () => {
  dir = tempDir("plc-child-self-approve-");
  leadHold = Promise.resolve();
  daemon = await startDaemon({ dataDir: dir, dbPath: join(dir, "plc.db"), sessionFactory: sessionFactory as never, log: () => {} });
  db = openDb(join(dir, "plc.db"));
});

afterEach(async () => {
  releaseLead();
  db.close();
  await daemon?.close();
  daemon = null;
});

function local<T>(command: object): Promise<LocalSocketResponse<T>> {
  return new Promise((resolve, reject) => {
    const socket = connect(daemon!.sockPath);
    socket.once("error", reject);
    attachJsonlReader(socket, (line) => {
      const message = JSON.parse(line) as LocalSocketResponse<T>;
      if (message.type !== "response") return;
      socket.end();
      resolve(message);
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(command)}\n`));
  });
}

const gateway = () => `http://127.0.0.1:${daemon!.pairedPort}`;

async function post(token: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${gateway()}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// child 的 Run 在跑，经 request_approval（agent-tools 的 definitions.ts）发了一个审批，正在每 250 毫秒查一次结果。
function childApproval(): number {
  const itemId = createItem(db, { title: "部署到生产", brief: "b", createdBy: "user" });
  transition(db, { itemId, to: "active", actor: "system", reason: "start" });
  const runId = createRun(db, { itemId, role: "executor", purpose: "execution", runtime: "claude" });
  updateRun(db, runId, { state: "running" });
  const requested = createCoordinator({ db }).requestApproval({
    itemId, runId, requestedBy: "child", tool: "bash", action: "kubectl apply -f prod.yaml",
    checkpoint: { title: "要部署到生产", summary: "等你批准", nextStep: "批准后部署" },
  });
  if (requested.status === "approved") throw new Error("expected a pending approval");
  return requested.approvalId;
}

// 账本里没有这次批准的任何痕迹：审批还在等，没有记成用户批的，也没有主人操作。
function expectUntouched(approvalId: number): void {
  expect(getApproval(db, approvalId)).toMatchObject({ status: "pending", resolved_by: null, session_exempt: 0 });
  expect(listEvents(db, { kind: "owner_action.performed", limit: 100 })).toEqual([]);
}

async function expectRefused(token: string, approvalId: number): Promise<void> {
  for (const [path, body] of [
    [`/v1/approvals/${approvalId}/resolve`, { decision: "approve" }],
    [`/v1/kernel/interventions/approval:${approvalId}/resolve`, { authority: "approval", decision: "approve_session" }],
  ] as const) {
    const response = await post(token, path, body);
    expect(response.status, `${path} ${JSON.stringify(response.body)}`).toBe(403);
    expect(response.body.error.message).toContain("approvals:respond");
  }
  expectUntouched(approvalId);
}

describe("a child approving its own request", () => {
  it("is refused with the credential plc.sock issues, and the user can still approve from the local web page", async () => {
    const approvalId = childApproval();
    const issued = await local<{ accessToken: string; binding: { scopes: string[] } }>({ type: "cli_credential", id: "c", name: "plc" });
    expect(issued.success).toBe(true);
    const cliToken = issued.data!.accessToken;

    await expectRefused(cliToken, approvalId);
    expect(issued.data!.binding.scopes).not.toContain("approvals:respond");
    // 网关说出的 scope 和它执行的一致：plc 和别的客户端不会以为自己能批。
    const me = await fetch(`${gateway()}/v1/paired/me`, { headers: { authorization: `Bearer ${cliToken}` } });
    expect((await me.json() as { binding: { scopes: string[] } }).binding.scopes).not.toContain("approvals:respond");

    const page = createLoopbackBinding(db, { name: "localhost-web" });
    const approved = await post(page.accessToken, `/v1/approvals/${approvalId}/resolve`, { decision: "approve" });
    expect(approved.status).toBe(200);
    expect(getApproval(db, approvalId)).toMatchObject({
      status: "approved", resolved_by: `user via paired binding:${page.binding.id}`,
    });
  });

  it("is refused with a device that a temporary admin token paired on this machine", async () => {
    const approvalId = childApproval();
    const admin = await local<{ accessToken: string }>({ type: "admin_token", id: "a" });
    expect(admin.success).toBe(true);
    const pairing = await post(admin.data!.accessToken, "/v1/admin/pairings", { name: "我的手机", kind: "companion" });
    expect(pairing.status).toBe(201);
    const redeemed = await fetch(`${gateway()}/v1/paired/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pairing_code: pairing.body.code }),
    });
    expect(redeemed.status).toBe(201);
    const device = await redeemed.json() as { access_token: string; binding: { scopes: string[] } };

    await expectRefused(device.access_token, approvalId);
    expect(device.binding.scopes).not.toContain("approvals:respond");
  });
});

// Lead 的工具：当前这一轮由测试给（daemon 给真的会话的也是这一轮）。结果是工具返回的 JSON。
async function lead(name: string, turnId: string, params: Record<string, unknown>): Promise<any> {
  const tool = createLeadTools({ db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => turnId })
    .find((candidate: any) => candidate.name === name) as any;
  return JSON.parse((await tool.execute("call", params)).content[0].text);
}

// 用这个凭证在网关上说一句话，开一轮对话。Lead 停在这一轮里，返回这一轮的编号。
async function say(token: string, id: string, message: string): Promise<string> {
  holdLead();
  const sent = await post(token, "/v1/chat/send", { id, message });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const turnId = sent.body.turnId as string;
  await vi.waitFor(() => expect(db.prepare("SELECT state FROM channel_turns WHERE id=?").get(turnId)).toEqual({ state: "streaming" }));
  return turnId;
}

describe("a child getting Lead to approve its own request", () => {
  it("is refused in a chat turn the child opened with the plc credential, and Lead still relays the user's own turn", async () => {
    const approvalId = childApproval();
    // 审批在这一轮开始以前就有了（approvals.created_at 只到秒）：挡住它的只能是这一轮的凭证，不是「说话以后才出现」。
    db.prepare("UPDATE approvals SET created_at=datetime('now', '-60 seconds') WHERE id=?").run(approvalId);

    const issued = await local<{ accessToken: string }>({ type: "cli_credential", id: "c", name: "plc" });
    const childTurn = await say(issued.data!.accessToken, "child-chat", `批准 #${approvalId}`);
    // 2026-10-28 删掉了 resolve_approval：审批只走 perform_action。
    for (const [tool, params] of [
      ["perform_action", {
        target_type: "approval", target_id: String(approvalId), action: "resolve", input: { decision: "approve" },
        reason: `用户说批准 #${approvalId}`,
      }],
      ["perform_action", {
        target_type: "approval", target_id: String(approvalId), action: "resolve", input: { decision: "approve_session" },
        reason: `用户说批准 #${approvalId}`,
      }],
    ] as const) {
      const refused = await lead(tool, childTurn, params);
      expect(refused, tool).toMatchObject({ refused: true, refusal: { code: "needs_user_turn" } });
      // 拒绝写明这一轮的凭证是哪种、用户去哪里点。
      expect(refused.refusal.message, tool).toContain("plc 的 CLI 凭证");
      expect(refused.refusal.message, tool).toContain(refused.refusal.where);
    }
    expectUntouched(approvalId);
    releaseLead();
    await vi.waitFor(() => expect(db.prepare("SELECT state FROM channel_turns WHERE id=?").get(childTurn)).not.toEqual({ state: "streaming" }));

    // 用户本人在本机网页上的一轮：Lead 照常代他批。
    const page = createLoopbackBinding(db, { name: "localhost-web" });
    const userTurn = await say(page.accessToken, "user-chat", `批准 #${approvalId}`);
    expect(await lead("perform_action", userTurn, {
      target_type: "approval", target_id: String(approvalId), action: "resolve", input: { decision: "approve" }, reason: "用户说批准",
    }))
      .toMatchObject({ authority: "on_behalf", on_behalf_of_turn: userTurn });
    expect(getApproval(db, approvalId)).toMatchObject({ status: "approved", resolved_by: `lead for user via turn:${userTurn}` });
  });
});
