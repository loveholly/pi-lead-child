// 会话搜索的匹配规则（工单 #339）：精确区分大小写和空格、可以只认整个词；模糊忽略大小写和多余空白，容忍错字、断行、夹了代码块。
import { describe, expect, it } from "vitest";
import { findInText, normalizeForFuzzy, snippetAround } from "../src/index.ts";

const exact = { mode: "exact" as const };
const fuzzy = { mode: "fuzzy" as const };

describe("exact mode", () => {
  it("keeps case and spaces", () => {
    expect(findInText("Restart the Daemon now", "Daemon", exact)).toMatchObject({ start: 12, end: 18, score: 1 });
    expect(findInText("Restart the Daemon now", "daemon", exact)).toBeNull();
    expect(findInText("a  b", "a b", exact)).toBeNull();
  });

  it("matches whole words only when asked", () => {
    expect(findInText("redaemonize", "daemon", exact)).not.toBeNull();
    expect(findInText("redaemonize", "daemon", { ...exact, wholeWord: true })).toBeNull();
    // 第一处在词中间，第二处是整个词：要找到第二处。
    expect(findInText("redaemon daemon.", "daemon", { ...exact, wholeWord: true })).toMatchObject({ start: 9 });
  });
});

describe("fuzzy mode", () => {
  it("ignores case and extra whitespace, and maps back to the original text", () => {
    const text = "上次说 Daemon\n\n   重启 的事";
    const hit = findInText(text, "daemon 重启", fuzzy)!;
    expect(hit.score).toBe(1);
    expect(text.slice(hit.start, hit.end)).toBe("Daemon\n\n   重启");
  });

  it("finds words in order even with a code block between them", () => {
    const text = "restart the daemon\n```\nnpm run start\n```\nafter the config change";
    const hit = findInText(text, "daemon config", fuzzy);
    expect(hit).not.toBeNull();
    expect(hit!.score).toBeLessThan(1);
  });

  it("does not match words in the wrong order", () => {
    expect(findInText("config first, daemon later", "daemon config", fuzzy)).toBeNull();
  });

  it("tolerates a typo", () => {
    expect(findInText("we should restart the daemon today", "deamon", fuzzy)).not.toBeNull();
    expect(findInText("we should restart the daemon today", "kubernetes", fuzzy)).toBeNull();
  });

  it("does not guess on very short queries", () => {
    expect(findInText("abc", "xyz", fuzzy)).toBeNull();
  });

  it("scores an exact substring above a typo match", () => {
    const direct = findInText("restart the daemon", "daemon", fuzzy)!;
    const typo = findInText("restart the daemon", "deamon", fuzzy)!;
    expect(direct.score).toBeGreaterThan(typo.score);
  });
});

describe("helpers", () => {
  it("normalizes with an index map", () => {
    const { text, map } = normalizeForFuzzy("A \n B");
    expect(text).toBe("a b");
    expect(map).toEqual([0, 1, 4]);
  });

  it("cuts a snippet with about 30 characters on each side", () => {
    const text = `${"前".repeat(50)}目标${"后".repeat(50)}`;
    const match = findInText(text, "目标", exact)!;
    const snippet = snippetAround(text, match);
    expect(snippet.matched).toBe("目标");
    expect(snippet.before).toBe(`…${"前".repeat(30)}`);
    expect(snippet.after).toBe(`${"后".repeat(30)}…`);
  });
});
