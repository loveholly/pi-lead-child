// Slack 正文里的标记换成人看得懂的字（slackDisplayText）：卡片、动态、Lead 和模型读到的都是它（用户 2026-10-23：
// 动态里显示了 <@U0FAKEUSR1>）。纯函数；经过适配器和 hub 的整条路在 channel-slack-inbound.test.ts。
import { describe, expect, it } from "vitest";
import { slackDisplayText, slackMarkupIds, slackMentionsFromNames } from "../src/index.js";

const names: Record<string, string> = { U0SELF: "Sean Lee", U0LI: "李四" };
const channels: Record<string, string> = { C0PROJ: "proj-x" };
const shown = (text: string) => slackDisplayText(text, { user: (id) => names[id] ?? null, channel: (id) => channels[id] ?? null });

describe("Slack markup for people and models", () => {
  it("names people, channels, groups and special mentions", () => {
    expect(shown("<@U0SELF> <@U0LI> 看一下")).toBe("@Sean Lee @李四 看一下");
    expect(shown("<@U0GONE> 在吗")).toBe("@U0GONE 在吗");
    expect(shown("<@U0LI|lisi> 好的")).toBe("@lisi 好的");
    expect(shown("见 <#C0PROJ> 和 <#C0OTHER|ops>，还有 <#C0NONE>")).toBe("见 #proj-x 和 #ops，还有 #C0NONE");
    expect(shown("<!here> <!channel> <!everyone>")).toBe("@here @channel @everyone");
    expect(shown("<!subteam^S0FE|@fe-team> 请看")).toBe("@fe-team 请看");
    expect(shown("<!date^1792720000^{date}|10月23日> 开会")).toBe("10月23日 开会");
  });

  it("keeps links readable, and unescapes the three escaped characters last", () => {
    expect(shown("<https://github.com/acme/orders/pull/12|这个 PR>")).toBe("这个 PR（https://github.com/acme/orders/pull/12）");
    expect(shown("<https://example.test/a>")).toBe("https://example.test/a");
    expect(shown("<mailto:a@example.test|a@example.test>")).toBe("a@example.test");
    expect(shown("&lt;重要&gt; A &amp;amp; B")).toBe("<重要> A &amp; B");
    // 转义以后才像标记的字不当成标记。
    expect(shown("&lt;@U0LI&gt;")).toBe("<@U0LI>");
  });

  it("lists the people and channels it needs names for, and skips the ones that carry a label", () => {
    expect(slackMarkupIds("<@U0SELF> <@U0LI|lisi> <#C0PROJ> <#C0OTHER|ops> <!here> <https://x.test>")).toEqual({
      users: ["U0SELF"], channels: ["C0PROJ"],
    });
  });
});

// 发出去的方向：助手写的「@名字」换回 <@U…>（2026-11-20：纯文字的 @ 不通知对方）。
describe("slackMentionsFromNames", () => {
  const people = [
    { id: "U0NINA", name: "nina", realName: "Nina Wang", displayName: "Nina Wang (ENG - SRE)" },
    { id: "U0LILEI", name: "lilei", realName: "李雷 Lei Li", displayName: "" },
    { id: "U0ETHAN1", name: "ethan.a", realName: "Ethan", displayName: "" },
    { id: "U0ETHAN2", name: "ethan.b", realName: "Ethan", displayName: "" },
  ];

  it("turns a display name, the name without its bracket, a real name or a handle into a mention", () => {
    expect(slackMentionsFromNames("@Nina Wang (ENG - SRE) 看下", people)).toBe("<@U0NINA> 看下");
    expect(slackMentionsFromNames("@Nina Wang 看下", people)).toBe("<@U0NINA> 看下");
    expect(slackMentionsFromNames("麻烦 @nina，谢谢", people)).toBe("麻烦 <@U0NINA>，谢谢");
    expect(slackMentionsFromNames("@李雷 Lei Li麻烦看下", people)).toBe("<@U0LILEI>麻烦看下");
  });

  it("leaves text alone when the name is not a whole word, belongs to two people, or is not a person", () => {
    expect(slackMentionsFromNames("@Ninaa 看下", people)).toBe("@Ninaa 看下");
    expect(slackMentionsFromNames("@Ethan 看下", people)).toBe("@Ethan 看下");
    expect(slackMentionsFromNames("@here 大家看下", [...people, { id: "U0HERE", name: "here", realName: "", displayName: "" }])).toBe("@here 大家看下");
    expect(slackMentionsFromNames("发给 nina@example.com", people)).toBe("发给 nina@example.com");
  });

  it("does not touch code or markup that is already Slack's", () => {
    expect(slackMentionsFromNames("跑 `@nina` 和 <@U0NINA> 和 <https://example.com|@nina>", people))
      .toBe("跑 `@nina` 和 <@U0NINA> 和 <https://example.com|@nina>");
    expect(slackMentionsFromNames("```\n@nina\n```\n@nina", people)).toBe("```\n@nina\n```\n<@U0NINA>");
  });
});
