// 转述改成引用（2026-10-19，.scratch/lead-credibility/spec.md D3）。2026-10-19 16:55，Lead 把 #98 子 agent 的报告
// 重新打了一遍，多出 3 个不存在的文件。SourceQuote 里没有一个字是 Lead 打的：render_ui 从账本取原文写进卡片，
// Lead 自己写的 text 被换掉；不能显示卡片的地方（plc、Slack、推送）看到的也是原文。
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { appendBody, createItem, openDb, type Db } from "@pi-lead-child/store";
import { partialUiSurface } from "@pi-lead-child/protocol";
import { createLeadTools, type LeadDeps } from "../src/tools.js";

let db: Db;
let deps: LeadDeps;
let ticket: number;

const REPORT = [
  "## 执行记录", "改了 identity.ts。", "",
  "【独立核查报告】", "1. Wrapper 参数绕过：extensions/aish-guard/index.ts 的 shellEnv 没有转义。", "", "2. Token 过期误报未连接。",
  "【其他】", "无。",
].join("\n");

beforeEach(() => {
  const dir = tempDir("plc-source-quote-");
  db = openDb(join(dir, "plc.db"));
  deps = { db, dbPath: join(dir, "plc.db"), dataDir: dir } as LeadDeps;
  ticket = createItem(db, { title: "评审 PR #101", brief: "b", createdBy: "lead" });
  appendBody(db, ticket, REPORT);
});

const renderUi = () => createLeadTools(deps).find((candidate: any) => candidate.name === "render_ui") as any;
const card = (props: Record<string, unknown>) => ({
  root: "q", fallback_text: "#98 的核查报告原文如下。",
  nodes: [{ id: "q", type: "SourceQuote", props: { ticket, source: "body", ...props } }],
});
const quoteOf = (result: any) => result.details.surface.nodes.find((node: any) => node.id === "q").props;

describe("SourceQuote", () => {
  it("quotes a section of the ticket body from the ledger and replaces whatever Lead typed", async () => {
    const result = await renderUi().execute("c1", card({ heading: "【独立核查报告】", text: "Lead 打的：src/auth/session.ts 有问题" }));
    const props = quoteOf(result);
    expect(props.text).toBe("【独立核查报告】\n1. Wrapper 参数绕过：extensions/aish-guard/index.ts 的 shellEnv 没有转义。\n\n2. Token 过期误报未连接。");
    expect(props.label).toBe(`工单 #${ticket} 正文 ·「【独立核查报告】」`);
    expect(props.truncated).toBe(false);
    expect(result.details.surface.fallbackText).toContain("> 1. Wrapper 参数绕过");
    expect(JSON.stringify(result.details.surface)).not.toContain("src/auth/session.ts");
  });

  it("quotes the paragraph that contains an exact sentence, and a checkpoint of the ticket", async () => {
    expect(quoteOf(await renderUi().execute("c2", card({ contains: "Token 过期误报" }))).text).toBe("2. Token 过期误报未连接。");
    const checkpoint = Number(db.prepare(
      `INSERT INTO checkpoints (item_id, run_id, source, kind, title, summary, content_hash) VALUES (?, NULL, 'agent_reported', 'completed', ?, ?, 'h')`,
    ).run(ticket, "完成 PR #101 评审", "发现 3 项 Blocking Issues。").lastInsertRowid);
    const props = quoteOf(await renderUi().execute("c3", card({ source: "checkpoint", checkpoint })));
    expect(props).toMatchObject({ text: "完成 PR #101 评审\n发现 3 项 Blocking Issues。", label: `工单 #${ticket} · checkpoint #${checkpoint}` });
  });

  it("refuses a location the ledger does not have, so Lead finds the real one", async () => {
    await expect(renderUi().execute("c4", card({ heading: "【复核】" }))).rejects.toThrow(/原文里没有含「【复核】」的一行/);
    await expect(renderUi().execute("c5", card({ contains: "src/auth/session.ts" }))).rejects.toThrow(/逐字抄原文/);
    await expect(renderUi().execute("c6", card({ source: "checkpoint", checkpoint: 999 }))).rejects.toThrow(/没有 checkpoint #999/);
  });

  it("does not show Lead-typed quote text while the card is still being generated", () => {
    const partial = partialUiSurface(card({ heading: "【独立核查报告】", text: "Lead 打的" }), "call-9");
    expect(partial!.nodes[0]!.props).toEqual({ ticket, source: "body", heading: "【独立核查报告】" });
  });
});
