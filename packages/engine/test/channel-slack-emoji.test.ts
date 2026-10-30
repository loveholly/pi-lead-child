// Slack 署名里助手名前面的 emoji（设置 → 身份与风格 → 形象，2026-10-28）：
//   - 每发一条消息现算：设置页改了以后，下一条消息就用新的（daemon 给适配器一个函数，builtin.ts 交过去）。
//   - 设置页的预览：hub 的 previewDisclosureMark 问 Slack 的 emoji.list（要 emoji:read），alias 跟到原图，只给 https 的地址；
//     几分钟内不再问；没有权限、没连上时说明原因。署名的文字和真的发出去的「auto-reply」一样。
//   - emoji:read 是可选的权限：写进建应用的清单，设置页的检查不要求它。
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { openDb, type Db } from "@pi-lead-child/store";
import {
  builtinChannelAdapters, ChannelHub, ChannelRegistry, createSlackChannelAdapter, leadAvatarSlackEmoji, setLeadAvatarSlackEmoji,
  SLACK_EMOJI_SCOPE_MISSING, SLACK_OPTIONAL_USER_SCOPES, SLACK_USER_SCOPES, slackAppManifest,
} from "../src/index.js";
import { FAKE_SLACK_USER_SCOPES, FakeSlack } from "../testing/index.js";

let db: Db;
let slack: FakeSlack;
let hub: ChannelHub | null = null;

beforeEach(() => {
  db = openDb(join(tempDir("plc-slack-emoji-"), "plc.db"));
  slack = new FakeSlack({
    scopes: [...FAKE_SLACK_USER_SCOPES, "emoji:read"],
    emoji: {
      "robot_face": "https://emoji.slack-edge.com/T0HOME/robot_face/abc.gif",
      sparkle: "alias:robot_face",
      party: "alias:tada",
      plain: "http://emoji.example.test/plain.png",
    },
  });
});

afterEach(async () => {
  await hub?.idle();
  hub = null;
  db.close();
});

function startHub(options: { emoji?: () => string | null | undefined; credential?: boolean } = {}) {
  hub = new ChannelHub({
    db,
    registry: new ChannelRegistry([createSlackChannelAdapter({ api: slack.api, ...(options.emoji ? { assistantEmoji: options.emoji } : {}) })]),
    credentials: { credential: async () => (options.credential === false ? null : slack.credential) },
    log: () => {},
  });
  return hub;
}

describe("the byline emoji follows the setting", () => {
  it("is read again for every message, so the next message after a change uses the new emoji", async () => {
    const channels = startHub({ emoji: () => leadAvatarSlackEmoji(db, undefined) });
    const by = "lead for user via turn:turn-1";
    await channels.sendMessage("slack:@U0ZHANG", { text: "第一条", words: "assistant", forUser: true, by });
    setLeadAvatarSlackEmoji(db, { emoji: "sparkles", caller: { kind: "user" } });
    await channels.sendMessage("slack:@U0ZHANG", { text: "第二条", words: "assistant", forUser: true, by });
    setLeadAvatarSlackEmoji(db, { emoji: "", caller: { kind: "user" } });
    await channels.sendMessage("slack:@U0ZHANG", { text: "第三条", words: "assistant", forUser: true, by });
    expect(slack.sent("D0ZHANG").map((message) => message.text.split("\n")[0])).toEqual([
      ":robot_face: Paimon (Assistant) · confirmed by 我",
      ":sparkles: Paimon (Assistant) · confirmed by 我",
      "Paimon (Assistant) · confirmed by 我",
    ]);
  });

  it("takes a function, falls back to the default when it gives nothing or throws, and still drops a malformed code", () => {
    let value: string | null | undefined = ":tada:";
    const adapter = createSlackChannelAdapter({ api: slack.api, assistantEmoji: () => value });
    expect(adapter.disclosureMark).toBe(":tada:");
    value = undefined;
    expect(adapter.disclosureMark).toBe(":robot_face:");
    value = "<!channel>";
    expect(adapter.disclosureMark).toBeNull();
    expect(createSlackChannelAdapter({ api: slack.api, assistantEmoji: () => { throw new Error("db closed"); } }).disclosureMark).toBe(":robot_face:");
  });

  it("lets the daemon's function win over the config, which it already includes", () => {
    const config = { slack: { assistantEmoji: ":fairy-zz:" } };
    expect(builtinChannelAdapters({ slack: { api: slack.api } }, config)[0]!.disclosureMark).toBe(":fairy-zz:");
    expect(builtinChannelAdapters({ slack: { api: slack.api } }, config, { assistantEmoji: () => ":sparkles:" })[0]!.disclosureMark)
      .toBe(":sparkles:");
  });
});

describe("previewing an emoji for the settings page", () => {
  it("finds a custom emoji, follows an alias to its image, and says not found for the rest", async () => {
    const channels = startHub();
    expect(await channels.previewDisclosureMark(":robot_face:")).toEqual({
      status: "custom", imageUrl: "https://emoji.slack-edge.com/T0HOME/robot_face/abc.gif", byline: "Paimon (Assistant) · auto-reply for 我",
    });
    expect(await channels.previewDisclosureMark(":sparkle:")).toMatchObject({
      status: "custom", imageUrl: "https://emoji.slack-edge.com/T0HOME/robot_face/abc.gif",
    });
    // alias 指向 Slack 自带的 emoji、不在工作区的自定义 emoji 里：not_found。
    expect(await channels.previewDisclosureMark(":party:")).toMatchObject({ status: "not_found" });
    expect(await channels.previewDisclosureMark(":thumbsup:")).toMatchObject({ status: "not_found" });
    expect(await channels.previewDisclosureMark(":plain:")).toMatchObject({ status: "unavailable", reason: expect.stringContaining("https") });
    // 几分钟内只问 Slack 一次。
    expect(slack.calls.filter((call) => call.method === "emoji.list")).toHaveLength(1);
  });

  it("says the app needs emoji:read when the token does not have it, and asks again once it does", async () => {
    slack.scopes = [...FAKE_SLACK_USER_SCOPES];
    const channels = startHub();
    expect(await channels.previewDisclosureMark(":robot_face:")).toEqual({
      status: "unavailable", reason: SLACK_EMOJI_SCOPE_MISSING, byline: "Paimon (Assistant) · auto-reply for 我",
    });
    expect(SLACK_EMOJI_SCOPE_MISSING).toBe("Slack 应用没有 emoji:read 权限：在应用的 OAuth & Permissions 里加上它，再重新安装。");
    slack.scopes.push("emoji:read");
    expect(await channels.previewDisclosureMark(":robot_face:")).toMatchObject({ status: "custom" });
  });

  it("says Slack is not connected when there is no credential, and never leaks the token", async () => {
    expect(await startHub({ credential: false }).previewDisclosureMark(":robot_face:")).toMatchObject({
      status: "unavailable", reason: expect.stringContaining("还没有连上"),
    });
    await hub!.idle();
    slack.failNext("emoji.list", `request failed for ${slack.credential.token}`);
    const preview = await startHub().previewDisclosureMark(":robot_face:");
    expect(preview.status).toBe("unavailable");
    expect(JSON.stringify(preview)).not.toContain(slack.credential.token);
  });

  it("keeps emoji:read optional: in the app manifest, not in the checked scopes", () => {
    expect(SLACK_OPTIONAL_USER_SCOPES).toEqual(["emoji:read"]);
    expect(SLACK_USER_SCOPES).not.toContain("emoji:read");
    expect(slackAppManifest("Leo")).toContain("      - emoji:read\n");
  });
});
