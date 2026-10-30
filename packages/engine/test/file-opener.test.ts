// daemon 在这台 Mac 上用默认程序打开文件的那一步（工单 07）。测试换掉 execFile，不真的调用 macOS 的 open：
// 只核对交给它的是 /usr/bin/open、一个参数数组（不经过 shell）、绝对路径前面有 --、一份最小的环境变量。
import { describe, expect, it } from "vitest";
import { DAEMON_ONLY_ENV_NAMES } from "@pi-lead-child/core";
import {
  DEFAULT_PROGRAM_EXTENSIONS, daemonFileOpener, opensWith, systemFileOpener,
} from "../src/coordinator/file-opener.js";

function recorder() {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
  const execFile = async (file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
  };
  return { calls, execFile };
}

describe("the system file opener", () => {
  it("runs /usr/bin/open with the absolute path as one argument after --, without a shell", async () => {
    const { calls, execFile } = recorder();
    const opener = systemFileOpener({ platform: "darwin", execFile, env: {} });
    expect(opener.supported).toBe(true);

    const path = "/Users/me/repo/docs/$(touch pwned); rm -rf ~ `id` 'a b'.md";
    await opener.open(path, "default");
    await opener.open("/Users/me/repo/scripts/deploy.command", "text_editor");

    expect(calls.map(({ file, args }) => ({ file, args }))).toEqual([
      { file: "/usr/bin/open", args: ["--", path] },
      { file: "/usr/bin/open", args: ["-t", "--", "/Users/me/repo/scripts/deploy.command"] },
    ]);
    for (const call of calls) {
      expect(call.options.shell ?? false).toBe(false);
      expect(call.options.timeout).toBeGreaterThan(0);
    }
  });

  // 审查 M5、L1：以前 open 继承 daemon 的全部环境，包括 Slack 令牌、OAuth 的 client secret。
  // 现在只给 PATH=/usr/bin:/bin 和 HOME、LANG、USER、TMPDIR。
  it("gives open a minimal environment without the daemon's secrets", async () => {
    const { calls, execFile } = recorder();
    const daemonEnv: Record<string, string> = {
      PATH: "/opt/evil/bin:/usr/bin", HOME: "/Users/me", LANG: "zh_CN.UTF-8", USER: "me", TMPDIR: "/var/tmp/me/",
      OPENAI_API_KEY: "sk-test", DYLD_INSERT_LIBRARIES: "/tmp/x.dylib", NODE_OPTIONS: "--require /tmp/x.js",
    };
    for (const name of DAEMON_ONLY_ENV_NAMES) daemonEnv[name] = `secret-${name}`;
    await systemFileOpener({ platform: "darwin", execFile, env: daemonEnv }).open("/Users/me/plan.md", "default");

    expect(calls[0]!.options.env).toEqual({
      PATH: "/usr/bin:/bin", HOME: "/Users/me", LANG: "zh_CN.UTF-8", USER: "me", TMPDIR: "/var/tmp/me/",
    });
    for (const name of DAEMON_ONLY_ENV_NAMES) expect(calls[0]!.options.env).not.toHaveProperty(name);
  });

  it("refuses a relative path, or one that could be read as an option, without running anything", async () => {
    const { calls, execFile } = recorder();
    const opener = systemFileOpener({ platform: "darwin", execFile, env: {} });
    for (const path of ["docs/plan.md", "-a Terminal", "--args", "~/plan.md", ""]) {
      await expect(opener.open(path, "default")).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });

  it("is not supported off macOS and never runs anything there", async () => {
    const { calls, execFile } = recorder();
    for (const platform of ["linux", "win32"] as const) {
      const opener = systemFileOpener({ platform, execFile, env: {} });
      expect(opener.supported).toBe(false);
      await expect(opener.open("/home/me/plan.md", "default")).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });
});

// 审查 L3：测试起的 daemon 以前默认用真的 open。根 vitest 配置设置 PLC_OPEN_FILES=off（它是环境变量，子进程里的 daemon 也收到），
// daemon 的缺省 opener 这时一律拒绝，不执行任何命令。
describe("the daemon's default opener", () => {
  it("refuses to open anything under the test configuration", async () => {
    expect(process.env.PLC_OPEN_FILES).toBe("off");
    await expect(daemonFileOpener().open("/Users/me/plan.md", "default")).rejects.toThrow(/PLC_OPEN_FILES=off/);
    await expect(daemonFileOpener({ PLC_OPEN_FILES: "off" }).open("/Users/me/plan.md", "text_editor")).rejects.toThrow();
  });

  it("is the system opener otherwise", () => {
    expect(daemonFileOpener({}).supported).toBe(process.platform === "darwin");
  });
});

// 审查 M2：只有白名单里的类型交给默认程序，其余一律用文本编辑器。
describe("which program opens a file", () => {
  it("uses the default program only for allow-listed documents, images, media and source without the execute bit", () => {
    for (const name of ["plan.md", "notes.txt", "data.json", "ci.yaml", "Cargo.toml", "app.ts", "view.tsx", "main.go",
      "lib.rs", "App.swift", "tool.rb", "style.css", "report.pdf", "logo.png", "photo.JPG", "spec.docx", "sheet.xlsx",
      "deck.pptx", "rows.csv", "run.log", "clip.mp4", ".eslintrc.json"]) {
      expect({ name, app: opensWith(`/r/${name}`, 0o100644) }).toEqual({ name, app: "default" });
    }
  });

  it("uses the text editor for everything else, for web pages and SVG, and for any file with the execute bit", () => {
    for (const name of ["page.html", "page.htm", "icon.svg", "fetch.py", "run.sh", "a.command", "a.terminal", "a.jar",
      "a.webloc", "a.pkg", "a.mobileconfig", "a.workflow", "Makefile", "Dockerfile", ".gitignore", "a.xml", "a.unknown"]) {
      expect({ name, app: opensWith(`/r/${name}`, 0o100644) }).toEqual({ name, app: "text_editor" });
    }
    expect(opensWith("/r/deploy.ts", 0o100755)).toBe("text_editor");
    expect(opensWith("/r/plan.md", 0o100744)).toBe("text_editor");
  });

  it("keeps web pages, scripts and launchers out of the allow-list", () => {
    for (const extension of ["html", "htm", "xhtml", "svg", "xml", "py", "sh", "command", "terminal", "jar", "webloc", "app", "pkg"]) {
      expect(DEFAULT_PROGRAM_EXTENSIONS.has(extension)).toBe(false);
    }
  });
});
