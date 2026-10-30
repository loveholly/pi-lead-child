// 披露署名（spec D8；用户 2026-10-21：英文写；2026-10-22 起助手名缺省跟 Lead 的名字（Paimon），样式像 Slack 的小号灰字）：署名的文字，和 Slack 适配器
// 把署名排成 context block、正文切成 section 的规则（转义、3000 字一段、50 个 block 以内）。
import { describe, expect, it } from "vitest";
import {
  autoReplyDisclosure, confirmedDraftDisclosure, defaultHandlingVerb, disclosureAssistantName, handlingNotice,
  createSlackChannelAdapter, SLACK_MESSAGE_BLOCKS_MAX, SLACK_TEXT_OBJECT_MAX, slackDisclosureBlocks, slackEmojiCode, slackMessageText,
} from "../src/index.js";
import { FakeSlack } from "../testing/index.js";

describe("the disclosure bylines", () => {
  it("names the assistant on every line and keeps the body apart", () => {
    expect(handlingNotice("Paimon", "reviewing")).toEqual({
      text: "Paimon (Assistant) is reviewing…", parts: { byline: "Paimon (Assistant) is reviewing…", body: null },
    });
    expect(handlingNotice("Paimon", "looking_into").text).toBe("Paimon (Assistant) is looking into this…");
    expect(autoReplyDisclosure("Paimon", "Leo", "查到了。")).toEqual({
      text: "Paimon (Assistant) · auto-reply for Leo\n查到了。",
      parts: { byline: "Paimon (Assistant) · auto-reply for Leo", body: "查到了。" },
    });
    expect(confirmedDraftDisclosure("Paimon", "Leo", "查到了。").text).toBe("Paimon (Assistant) · confirmed by Leo\n查到了。");
  });

  it("falls back to Paimon and to the playbook's word", () => {
    expect(disclosureAssistantName(null)).toBe("Paimon");
    expect(disclosureAssistantName("   ")).toBe("Paimon");
    expect(disclosureAssistantName(" Nova\n Bot ")).toBe("Nova Bot");
    expect(disclosureAssistantName("x".repeat(80))).toHaveLength(40);
    expect(defaultHandlingVerb("review")).toBe("reviewing");
    expect(defaultHandlingVerb("lookup")).toBe("checking");
  });
});

describe("the Slack mark before the assistant's name", () => {
  it("is :robot_face: by default, can be changed or turned off, and only takes an emoji short code", () => {
    const api = new FakeSlack().api;
    expect(createSlackChannelAdapter({ api }).disclosureMark).toBe(":robot_face:");
    expect(createSlackChannelAdapter({ api, assistantEmoji: ":sparkles:" }).disclosureMark).toBe(":sparkles:");
    expect(createSlackChannelAdapter({ api, assistantEmoji: "" }).disclosureMark).toBeNull();
    expect(slackEmojiCode(" :robot_face: ")).toBe(":robot_face:");
    for (const bad of ["fairy_zz", ":Paimon:", ":two words:", "<!channel>", ":x: <!here>", "::"]) expect(slackEmojiCode(bad)).toBeNull();
  });
});

describe("Slack blocks for a disclosed message", () => {
  it("puts the byline in a context block, escaped, and the body in a section", () => {
    expect(slackDisclosureBlocks({ byline: "Paimon (Assistant) · confirmed by <!channel> & Co", body: "看 <https://x.test|这里>" })).toEqual([
      { type: "context", elements: [{ type: "mrkdwn", text: "Paimon (Assistant) · confirmed by &lt;!channel&gt; &amp; Co" }] },
      // 正文照旧当 mrkdwn：和以前只发 text 时一样，链接照样能点。
      { type: "section", text: { type: "mrkdwn", text: "看 <https://x.test|这里>" } },
    ]);
    expect(slackDisclosureBlocks({ byline: "Paimon (Assistant) is checking…", body: null })).toEqual([
      { type: "context", elements: [{ type: "mrkdwn", text: "Paimon (Assistant) is checking…" }] },
    ]);
  });

  it("splits a long body into sections of at most 3000 characters, at line ends, without breaking a character", () => {
    const line = "行".repeat(1_800);
    const blocks = slackDisclosureBlocks({ byline: "b", body: `${line}\n${line}\n${"😀".repeat(2_000)}` });
    const sections = blocks.slice(1).map((block) => (block.text as { text: string }).text);
    expect(sections.every((text) => text.length <= SLACK_TEXT_OBJECT_MAX)).toBe(true);
    expect(sections.slice(0, 2)).toEqual([line, line]);
    expect(sections.slice(2).join("")).toBe("😀".repeat(2_000));
    expect(sections.slice(2).every((text) => !/[\uD800-\uDBFF]$/.test(text))).toBe(true);
    const huge = slackDisclosureBlocks({ byline: "b", body: "x".repeat(SLACK_TEXT_OBJECT_MAX * 80) });
    expect(huge).toHaveLength(SLACK_MESSAGE_BLOCKS_MAX);
  });
});

// 用户 2026-10-21：Google Calendar 的提醒判断时拿到的是空字符串。应用的正文常在 block 或附件里：按结构取出来。
describe("the text of an app's Slack message", () => {
  it("is the text when there is one, otherwise the words in the blocks and attachments", () => {
    expect(slackMessageText({ text: "普通消息", attachments: [{ text: "不看" }] })).toBe("普通消息");
    expect(slackMessageText({
      text: "",
      blocks: [
        { type: "header", text: { type: "plain_text", text: "周会提醒" } },
        { type: "section", text: { type: "mrkdwn", text: "*10:00* 开始" }, fields: [{ type: "mrkdwn", text: "会议室 A" }] },
        { type: "context", elements: [{ type: "mrkdwn", text: "来自 Google Calendar" }, { type: "image", image_url: "x" }] },
        { type: "rich_text", elements: [{ type: "rich_text_section", elements: [
          { type: "text", text: "议程见 " }, { type: "link", url: "https://cal.test/1" }, { type: "emoji", name: "calendar" },
        ] }] },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "加入" } }] },
      ],
    })).toBe("周会提醒\n*10:00* 开始\n会议室 A\n来自 Google Calendar\n议程见 https://cal.test/1:calendar:");
    expect(slackMessageText({
      attachments: [
        { pretext: "提醒", title: "周会", text: "10:00", fields: [{ title: "地点", value: "A" }], footer: "Google Calendar" },
        { fallback: "只有 fallback" },
      ],
    })).toBe("提醒\n周会\n10:00\n地点: A\nGoogle Calendar\n只有 fallback");
    expect(slackMessageText({ text: "  " })).toBe("");
  });
});
