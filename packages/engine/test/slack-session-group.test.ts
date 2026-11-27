// Slack 的会话分组（工单 #588）：规则只写在 Slack 适配器里，内核只认 session.key。
import { describe, expect, it } from "vitest";
import { slackSessionGroup } from "../src/channels/sources/slack.js";

describe("slackSessionGroup", () => {
  it("puts a DM's main conversation and its threads in one group, and marks the thread", () => {
    expect(slackSessionGroup("D0ALICE", true, null)).toEqual({ key: "slack:D0ALICE" });
    expect(slackSessionGroup("D0ALICE", true, "1700000000.000100")).toEqual({ key: "slack:D0ALICE", thread: "1700000000.000100" });
    // 群聊私信也一样。
    expect(slackSessionGroup("G0TEAM", true, "1700000000.000100").key).toBe("slack:G0TEAM");
  });

  it("gives each channel thread its own group with the main timeline before it as the prelude", () => {
    expect(slackSessionGroup("C0PROJ", false, "1700000000.000100")).toEqual({
      key: "slack:C0PROJ:1700000000.000100",
      prelude: { objectKey: "slack:C0PROJ:main", before: "1700000000.000100", at: new Date(1_700_000_000_000).toISOString() },
    });
  });

  it("puts every message on a channel's main timeline in one group", () => {
    expect(slackSessionGroup("C0PROJ", false, null)).toEqual({ key: "slack:C0PROJ" });
  });
});
