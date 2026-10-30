// 改规则被拦下以后的确认卡（统一的消息事件 spec D10 的「放行」，工单 09），Lead 这一侧：
//   - 外部的一轮里改投递规则、改授权表被拒绝时，结果里带着确认卡的 user_action（details.userAction），
//     系统据此登记等待：用户在卡上点了以后叫醒 Lead；render_ui 接受这张卡；
//   - 确认的入口是 user_direct：Lead 自己调 perform_action 去点，总是拿到结构化的拒绝，在用户本人这一轮里也一样。
// 经过 daemon 的完整流程（场景 12）在 apps/daemon/test/rule-change-confirm-daemon.test.ts。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { CHANNEL_POLICY_DEFAULTS } from "@pi-lead-child/protocol";
import { createLoopbackBinding, createTurn, getStandingOrder, listOpenLeadWaits, openDb, type Db } from "@pi-lead-child/store";
import { createLeadToolset, type LeadDeps } from "../src/tools.js";
import { createTurnUserActions } from "../src/wait-tools.js";
import type { LeadTurnOrigin } from "../src/turn-origin.js";

let db: Db;
let deps: LeadDeps;
let origin: LeadTurnOrigin;
let turnId: string | null;
// 会话注册的那一组工具（外面包着按 user_action 登记等待的一层）。
const tool = (name: string) => createLeadToolset(deps).find((candidate: any) => candidate.name === name) as any;
const parsed = (result: { content: Array<{ text: string }>; isError?: boolean }) => ({ isError: result.isError === true, ...JSON.parse(result.content[0]!.text) });

beforeEach(() => {
  const dir = tempDir("plc-rule-change-confirm-lead-");
  process.env.PLC_DATA_DIR = dir;
  db = openDb(join(dir, "plc.db"));
  // 定时器叫醒的一轮，读过 Slack 对话。
  origin = { external: true, timer: null, externalBy: [{ via: "tool", tool: "read_channel_conversation" }] };
  turnId = null;
  deps = {
    db, dbPath: join(dir, "plc.db"), dataDir: dir, currentTurnId: () => turnId, turnOrigin: () => origin,
    turnUserActions: createTurnUserActions(),
  };
});

const retryOff = { op: "update", id: "run.transient_retry", limits: { count: 0 }, reason: "定时器的安排：先别自动重试" };

describe("a refused rule change asks the user with a confirm card", () => {
  it("returns the card's user_action with the refusal of a delivery-rule change, and the system waits for the user", async () => {
    const result = await tool("propose_standing_order_change").execute("t", retryOff);
    const body = parsed(result);
    expect(body).toMatchObject({ isError: true, refused: true, refusal: { code: "external_turn" } });
    const id = body.refusal.confirm.id as string;
    expect(id).toMatch(/^rcc_/);
    const action = { kind: "confirm_rule_change", target: `rule_change:${id}`, title: "确认这一次", reason: "定时器的安排：先别自动重试" };
    expect(body.user_action).toEqual(action);
    expect(body.next).toContain("UserAction");
    expect(result.details.userAction).toEqual(action);
    // 用户点了以后叫醒 Lead（wait-tools.ts 按 user_action 登记的等待）。
    expect(listOpenLeadWaits(db).map((wait) => wait.entityKey)).toEqual([`rule_change:${id}`]);
    expect(getStandingOrder(db, "run.transient_retry")!.version).toBe(1);

    // 这张卡 render_ui 画得出来：UserAction 原样放进卡里。
    const drawn = await tool("render_ui").execute("t", {
      root: "card", fallback_text: "要改常设指令，等你确认。",
      nodes: [{ id: "card", type: "UserAction", props: { action: body.user_action } }],
    });
    expect(drawn.isError).not.toBe(true);
  });

  it("returns the same kind of card for the authority table", async () => {
    const body = parsed(await tool("perform_action").execute("t", {
      target_type: "channel_policy", target_id: "slack", action: "tighten",
      input: { ...CHANNEL_POLICY_DEFAULTS, autoReply: false }, reason: "定时器的安排：先别自动回复",
    }));
    expect(body).toMatchObject({
      isError: true, refused: true, refusal: { code: "external_turn" },
      user_action: { kind: "confirm_rule_change", target: `rule_change:${body.refusal.confirm.id}` },
    });
  });

  // 回归（工单 09）：Lead 自己调确认动作 → 结构化拒绝。没有外部内容的一轮、用户本人这一轮都一样。
  it("refuses Lead pressing 确认 itself, with a structured refusal that says where the user clicks", async () => {
    const id = parsed(await tool("propose_standing_order_change").execute("t", retryOff)).refusal.confirm.id as string;
    origin = { external: false, timer: null };
    const owner = createLoopbackBinding(db, { name: "Mac 网页" });
    createTurn(db, { id: "turn-user", originBindingId: owner.binding.id, originKind: "paired:companion", userText: "确认吧", state: "streaming" });
    for (const current of [null, "turn-user"]) {
      turnId = current;
      const body = parsed(await tool("perform_action").execute("t", {
        target_type: "rule_change", target_id: id, action: "resolve", input: { decision: "confirm" }, reason: "用户说确认吧",
      }));
      expect(body).toMatchObject({
        isError: true, refused: true,
        refusal: { code: "user_direct", target: { type: "rule_change", id }, permission: "user_direct", where: expect.stringContaining("确认卡") },
      });
    }
    expect(getStandingOrder(db, "run.transient_retry")!.version).toBe(1);
  });
});
