// 系统提示词里不写用户目录的完整路径（用户 2026-10-30：「包括还 hardcode 了我的用户目录」）。
// 完整的一跳（模型实际收到的系统提示）在 daemon 的 lead-self-knowledge 测试里。
import { describe, expect, it } from "vitest";
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { hideHomeInPrompt, tildeHome } from "../src/home-paths.js";

const HOME = "/Users/alice";

describe("tildeHome", () => {
  it("writes paths under the home directory as ~/…", () => {
    expect(tildeHome("代码在 /Users/alice/Workspace/plc。", HOME)).toBe("代码在 ~/Workspace/plc。");
    expect(tildeHome("/Users/alice", HOME)).toBe("~");
    expect(tildeHome("cd /Users/alice && ls /Users/alice/.agents", `${HOME}/`)).toBe("cd ~ && ls ~/.agents");
  });

  it("leaves other directories alone, including ones whose name only starts with the home path", () => {
    expect(tildeHome("/Users/alicex/a /Users/alice.bak/b /opt/alice", HOME)).toBe("/Users/alicex/a /Users/alice.bak/b /opt/alice");
    expect(tildeHome("/Users/alice/a", "/")).toBe("/Users/alice/a");
    expect(tildeHome("/Users/alice/a", "")).toBe("/Users/alice/a");
  });
});

describe("hideHomeInPrompt", () => {
  it("rewrites every text pi puts into the system prompt: preamble, sections, working directory, skills and project files", () => {
    const options: NormalizedBuildSystemPromptOptions = {
      customPrompt: "常驻偏好：在终端用 git -C /Users/alice/repo",
      selectedTools: ["read"], hiddenTools: [],
      toolSnippets: { read: "读 /Users/alice/x" }, toolGuidelines: { read: ["别读 /Users/alice/.ssh"] },
      promptGuidelines: ["数据在 /Users/alice/.pi-lead-child"],
      appendSystemPrompt: "见 /Users/alice/notes",
      sections: { environment: "- pi-lead-child 自己的代码在 /Users/alice/Workspace/plc。" },
      cwd: "/Users/alice/.pi-lead-child",
      contextFiles: [{ path: "/Users/alice/.pi-lead-child/AGENTS.md", content: "仓库在 /Users/alice/Workspace" }],
      skills: [{ name: "ticket-planning", description: "d", filePath: "/Users/alice/Workspace/plc/skills/ticket-planning/SKILL.md" } as never],
    };
    hideHomeInPrompt(options, HOME);
    // options.cwd 不改：pi 只用它写自己的工作目录一节，那一节由下面的 sections.cwd 盖掉。
    const { cwd: _cwd, ...rendered } = options;
    expect(JSON.stringify(rendered)).not.toContain(`${HOME}/`);
    expect(options.customPrompt).toBe("常驻偏好：在终端用 git -C ~/repo");
    expect(options.sections.environment).toBe("- pi-lead-child 自己的代码在 ~/Workspace/plc。");
    // pi 的工作目录一节由同名的自定义节盖掉。
    expect(options.sections.cwd).toBe("~/.pi-lead-child");
    expect(options.skills[0]!.filePath).toBe("~/Workspace/plc/skills/ticket-planning/SKILL.md");
    expect(options.contextFiles[0]).toEqual({ path: "~/.pi-lead-child/AGENTS.md", content: "仓库在 ~/Workspace" });
    expect(options.toolGuidelines.read).toEqual(["别读 ~/.ssh"]);
  });
});
