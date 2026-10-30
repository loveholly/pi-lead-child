// Slack 正文里的标记换成人看得懂的字（slackDisplayText）：卡片、动态、Lead 和模型读到的都是它（用户 2026-10-23：
// 动态里显示了 <@U0FAKEUSR1>）。纯函数；经过适配器和 hub 的整条路在 channel-slack-inbound.test.ts。
import { describe, expect, it } from "vitest";
import { slackDisplayText, slackMarkupIds } from "../src/index.js";

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
