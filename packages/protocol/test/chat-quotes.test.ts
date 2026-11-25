import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";

import {
  CHAT_QUOTE_MAX_COUNT, CHAT_QUOTE_TEXT_MAX_LENGTH, ChatSendCommandSchema, ConversationTurnSchema, chatQuoteAppearsIn, chatQuoteMatchKey,
} from "../src/index.js";

const command = { type: "chat.send", id: "cmd-1", protocolVersion: 2, message: "这两处一起看下" };
const leadQuote = { source: { kind: "turn", turnId: "turn_1", role: "assistant" }, text: "空闲时到 0.7 倍就会提前压缩", note: "能调到 0.5 吗？" };
const cardQuote = { source: { kind: "card", cardId: 12 }, text: "明天能上线吗" };

describe("chat quotes on the wire", () => {
  it("lets chat.send carry 1 to 10 quotes from a turn or an external message card", () => {
    expect(Value.Check(ChatSendCommandSchema, { ...command, quotes: [leadQuote, cardQuote] })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, { ...command, quotes: [{ ...leadQuote, anchor: "s0:b2:0-15" }] })).toBe(true);
    expect(Value.Check(ChatSendCommandSchema, { ...command, quotes: [] })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, {
      ...command, quotes: Array.from({ length: CHAT_QUOTE_MAX_COUNT + 1 }, () => leadQuote),
    })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, { ...command, quotes: [{ ...leadQuote, text: "" }] })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, {
      ...command, quotes: [{ ...leadQuote, text: "字".repeat(CHAT_QUOTE_TEXT_MAX_LENGTH + 1) }],
    })).toBe(false);
  });

  it("does not let the client name the author: the daemon decides it from the source", () => {
    expect(Value.Check(ChatSendCommandSchema, { ...command, quotes: [{ ...leadQuote, author: "user" }] })).toBe(false);
    expect(Value.Check(ChatSendCommandSchema, {
      ...command, quotes: [{ ...leadQuote, source: { kind: "turn", turnId: "turn_1", role: "system" } }],
    })).toBe(false);
  });

  it("allows a message with only quotes: the text may be empty", () => {
    expect(Value.Check(ChatSendCommandSchema, { ...command, message: "", quotes: [leadQuote] })).toBe(true);
  });

  it("carries quotes on a conversation turn with the author the daemon wrote", () => {
    const turn = {
      id: "turn-2", originBindingId: 1, originKind: "paired:companion", ticketId: null, state: "completed",
      userText: "", assistantText: "", error: null, createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z",
      quotes: [{ ...leadQuote, author: "lead" }, { ...cardQuote, author: "external" }],
    };
    expect(Value.Check(ConversationTurnSchema, turn)).toBe(true);
  });
});

describe("checking a quote against its source", () => {
  it("ignores the markdown syntax and spacing that rendering removes or adds", () => {
    const markdown = "压缩完成。上下文从 **32.5 万**降到 11.5 万 token。\n\n- 空闲时到 `0.7` 倍就会提前压缩";
    expect(chatQuoteAppearsIn("32.5 万降到 11.5 万", [markdown])).toBe(true);
    expect(chatQuoteAppearsIn("空闲时到 0.7 倍就会提前压缩", [markdown])).toBe(true);
    expect(chatQuoteAppearsIn("[链接文字](https://example.com)", ["看 链接文字"])).toBe(false);
    expect(chatQuoteAppearsIn("链接文字", ["看 [链接文字](https://example.com)"])).toBe(true);
  });

  // 选区跨过链接：会话里只显示链接文字，地址（plc:ticket/12、https://…）不显示，原文里的地址不能挡住核对。
  it("matches a selection that runs across a link, an image or a link definition", () => {
    const markdown = "三张单的核查都通过了：\n- **[#12](plc:ticket/12)**（收不到机器人回复）：新加的 27 条全部通过。\n"
      + "- 详情见 [PR #11](https://github.com/acme/x/pull/11 \"标题\") 和 ![截图](https://example.com/a(1).png)。\n"
      + "看 [这份说明][doc] 就行。\n\n[doc]: https://example.com/doc";
    expect(chatQuoteAppearsIn("三张单的核查都通过了：\n•\n#12（收不到机器人回复）", [markdown])).toBe(true);
    expect(chatQuoteAppearsIn("新加的 27 条全部通过。\n•\n详情见 PR #11 和 截图。", [markdown])).toBe(true);
    expect(chatQuoteAppearsIn("看 这份说明 就行", [markdown])).toBe(true);
    // 地址本身不显示，选不到，也不算在原文里。
    expect(chatQuoteAppearsIn("#12 plc ticket 12", [markdown])).toBe(false);
    // 没有说明的图片显示的是地址：地址留着。
    expect(chatQuoteAppearsIn("见 https://example.com/b.png", ["见 ![](https://example.com/b.png)"])).toBe(true);
  });

  it("refuses words that are not in the source, and a selection of punctuation only", () => {
    expect(chatQuoteAppearsIn("空闲时到 0.5 倍就会提前压缩", ["空闲时到 0.7 倍就会提前压缩"])).toBe(false);
    expect(chatQuoteAppearsIn("。，！", ["好的。，！"])).toBe(false);
  });

  it("looks at every message of an external card", () => {
    expect(chatQuoteAppearsIn("明天能上线吗", ["收到", "明天能上线吗？"])).toBe(true);
  });

  it("folds full-width characters and letter case", () => {
    expect(chatQuoteMatchKey("ＡＢＣ 12")).toBe(chatQuoteMatchKey("abc12"));
  });
});
