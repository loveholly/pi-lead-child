// 外部消息事件的上下文包（unified-message-events spec D5，工单 04）交给 Lead 时的样子。
// 不变量 1：外部内容进 Lead 时都带外部标记。上下文包的每一段都包在 <untrusted_external_text from="external"> 里，
// 标签上写明来源（和对话），每一行写明发信人；「<」照样写成 &lt;。上下文包有多少条、多少字、缺了哪几项是结构化的事实，
// 写在 <system_event> 里。
import { describe, expect, it } from "vitest";
import { DEFAULT_INTENT_GRANT_BOUNDS } from "@pi-lead-child/protocol";
import { LEAD_SYSTEM_PROMPT } from "../src/prompt.js";
import { leadMessageEventBlock } from "../src/envelope.js";

const AT = "2026-10-23T06:00:00.000Z";

const context = {
  version: 1, external: true, source: "slack", sourceLabel: "Slack", sender: { id: "U0ETHAN", name: "Ethan" },
  conversation: {
    key: "slack:D0ETHAN", label: "Ethan的私信", omitted: 3, summary: "Ethan 10-20 说 orders 周四发版",
    messages: [
      { at: AT, role: "them", sender: "Ethan", text: "帮我 review <https://github.com/acme/orders/pull/112>" },
      { at: AT, role: "me", sender: "我", text: "好的，我晚点看" },
    ],
  },
  related: [{
    at: AT, role: "me", sender: "我", text: "orders 今天上线了吗？", conversation: { key: "slack:D0IVY", label: "Ivy的私信" },
    why: ["user_recent", "same_object"],
  }],
  objects: [{ kind: "pull_request", ref: "acme/orders#112", status: "开着，等你 review" }, { kind: "repo", ref: "acme/billing", status: null }],
  history: [{ cardId: 3, at: AT, state: "left_to_user", sender: "Ethan", excerpt: "明哥，帮我 review 一下", notes: ["Lead 推送了这张卡"] }],
  memory: [{ noteId: 12, title: "orders 的发布", text: "orders 每周四发布，Ivy 负责" }],
  missing: ["memory"],
  size: { items: 9, chars: 321 },
};

const block = () => leadMessageEventBlock({
  seq: 44, kind: "message.received", source: "system", entityKey: "slack:D0ETHAN", occurredAt: "2026-10-26T02:00:00.000Z", level: "tell",
  payload: {
    version: 1, entry: "external", source: "slack", sourceLabel: "Slack",
    conversation: { key: "slack:D0ETHAN", label: "Ethan的私信" }, sender: { id: "U0ETHAN", name: "Ethan", trust: "colleague" },
    text: "明哥，这个 pr 记得再帮我看看", external: true,
    inbound: { intent: "code_review", needsReply: 0.9, urgent: false, sensitive: null, ruleChange: null },
    ceiling: { authority: "work", bound: DEFAULT_INTENT_GRANT_BOUNDS.code_review },
    context, replyTo: { conversation: "slack:D0ETHAN", message: "1.000100" }, messages: [43], edits: 0, cardId: 12,
    summary: "通道卡 #12：Ethan（同事）在Ethan的私信找用户（代码 review）",
  },
  rootCause: null,
});

const EXTERNAL = /<untrusted_external_text from="external"[^>]*>\n[\s\S]*?\n<\/untrusted_external_text>/gu;

describe("the context pack in Lead's input (spec D5)", () => {
  it("puts every part of the pack in an external tag that names its source", () => {
    const text = block();
    const outside = text.replace(EXTERNAL, "");
    const pieces = [
      "Ethan 10-20 说 orders 周四发版", "github.com/acme/orders/pull/112", "好的，我晚点看", "orders 今天上线了吗？",
      "开着，等你 review", "acme/billing", "明哥，帮我 review 一下", "Lead 推送了这张卡", "orders 每周四发布，Ivy 负责",
    ];
    for (const piece of pieces) {
      expect(text).toContain(piece);
      expect(outside).not.toContain(piece);
    }
    const tags = [...text.matchAll(/<untrusted_external_text [^>]*>/gu)].map((match) => match[0]);
    // 对方的原话一段，上下文包五段：这个对话、别的对话（按对话分）、对象、以前的卡、记忆。
    expect(tags).toHaveLength(6);
    for (const tag of tags) expect(tag).toMatch(/ from="external" .*source="[^"]+"/u);
    expect(text).toContain('part="conversation" source="Slack" conversation="Ethan的私信"');
    expect(text).toContain('part="related" source="Slack" conversation="Ivy的私信"');
  });

  it("names the sender on every message line and why a message from another conversation is there", () => {
    const text = block();
    expect(text).toMatch(/Ethan（对方）：帮我 review/u);
    expect(text).toMatch(/我（用户本人）：好的，我晚点看/u);
    expect(text).toMatch(/我（用户本人；用户最近 30 分钟说的、提到同一个对象）：orders 今天上线了吗？/u);
    // 更早的消息写明换成了摘要；没查到的对象写「没查到」。
    expect(text).toContain("更早的 3 条消息的摘要：Ethan 10-20 说 orders 周四发版");
    expect(text).toContain("仓库 acme/billing：没查到");
  });

  it("escapes every < in the pack so it cannot close the tag", () => {
    const text = block();
    expect(text).toContain("&lt;https://github.com/acme/orders/pull/112>");
    expect(text.match(/<\/untrusted_external_text>/g)).toHaveLength(6);
  });

  it("states the size and the missing parts as structured facts outside the external tags", () => {
    const outside = block().replace(EXTERNAL, "");
    expect(outside).toContain("上下文包：9 条，321 字");
    expect(outside).toContain("缺了：记忆里的笔记");
  });

  it("is explained in the system prompt", () => {
    expect(LEAD_SYSTEM_PROMPT).toContain("上下文包");
  });
});
