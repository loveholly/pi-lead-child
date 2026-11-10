// 安装页（设计第 4.1、4.3 节）：按 desktop-install 的进度显示三行；失败时有「重试」「查看日志」「复制诊断信息」。
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstallProgress } from "../src/install.js";
import { installView } from "../src/install-view.js";
import { renderInstallView } from "../src/renderer/render.js";

function progress(extra: Partial<InstallProgress>): InstallProgress {
  return {
    stage: "working",
    steps: { unpack: "done", takeover: "skipped", service: "running", start: "pending" },
    detail: "Setting up the background service.",
    backgroundNotice: true,
    error: null,
    gatewayUrl: null,
    takeoverKind: null,
    ...extra,
  };
}

// 根配置的 setup 文件不能在 DOM 环境里跑，所以在 node 环境里自己建一个文档（happy-dom 的 Window）：
// 渲染函数本来就收 document 参数。
// 每画一次开一个新窗口；用例结束时全部关掉。
const windows: Window[] = [];
let document: Document;

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

function draw(view: ReturnType<typeof installView>) {
  const window = new Window();
  windows.push(window);
  window.document.write("<!doctype html><html><head><title></title></head><body></body></html>");
  document = window.document as unknown as Document;
  const root = document.createElement("div");
  const act = vi.fn();
  renderInstallView(document, root, view, act);
  return { root, act };
}

describe("the install page", () => {
  it("shows the three steps, the step detail and the background item notice", () => {
    const { root } = draw(installView({ kind: "progress", progress: progress({}) }, { leadName: "Nina", locale: "en" }));
    expect(document.title).toBe("Nina");
    expect([...root.querySelectorAll("li")].map((li) => [li.dataset.step, li.dataset.state, li.textContent])).toEqual([
      ["unpack", "done", "Copy the program filesDone"],
      ["service", "running", "Set up the background serviceIn progress"],
      ["start", "pending", "Start the service (on a busy Mac, this can take several minutes)Waiting"],
    ]);
    expect(root.querySelector(".detail")?.textContent).toBe("Setting up the background service.");
    expect(root.querySelector(".notice")?.textContent).toContain("added a background item. This is normal");
    expect(root.querySelectorAll("button")).toHaveLength(0);
  });

  // 接管存量安装时多一行（设计第 12.7 节），说明文字跟着每一步变；失败时说清楚、给「重试」。
  it("shows the takeover row only while it takes over, with its step detail and its failure", () => {
    const taking = progress({
      steps: { unpack: "done", takeover: "running", service: "pending", start: "pending" },
      detail: "Moving your data to the new place.",
    });
    const { root } = draw(installView({ kind: "progress", progress: taking }, { leadName: "Nina", locale: "en" }));
    expect([...root.querySelectorAll("li")].map((li) => [li.dataset.step, li.dataset.state])).toEqual([
      ["unpack", "done"], ["takeover", "running"], ["service", "pending"], ["start", "pending"],
    ]);
    expect(root.querySelector("li[data-step=takeover]")?.textContent).toContain("Take over the data and settings");
    expect(root.querySelector(".detail")?.textContent).toBe("Moving your data to the new place.");

    const failed = progress({
      stage: "failed",
      steps: { unpack: "done", takeover: "failed", service: "pending", start: "pending" },
      backgroundNotice: false,
      error: { code: "takeover_rolled_back", message: "没能接手原来的安装，已经恢复原样：数据没有改动，原来的服务照常运行。" },
    });
    const page = draw(installView({ kind: "progress", progress: failed }, { leadName: "Nina", locale: "zh" }));
    expect(page.root.querySelector("li[data-step=takeover]")?.textContent).toBe("接手已有的数据和设置失败");
    expect(page.root.querySelector("[role=alert]")?.textContent).toContain("已经恢复原样");
    expect([...page.root.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["重试", "查看日志", "复制诊断信息"]);
  });

  // 普通升级原来也显示「接手已有的数据和设置」，用户读成要搬数据（2026-11-05）。换版本要重启时写备份和换版本
  // （设计第 7.5.2 节）；不重启时这一行跳过，不显示。
  it("labels an upgrade that restarts as a backup and a switch, not a takeover, and hides the row when nothing restarts", () => {
    const upgrading = progress({ steps: { unpack: "done", takeover: "running", service: "pending", start: "pending" }, takeoverKind: "upgrade" });
    expect(draw(installView({ kind: "progress", progress: upgrading }, { leadName: "Nina", locale: "en" })).root
      .querySelector("li[data-step=takeover]")?.textContent).toBe("Back up the data and switch to the new versionIn progress");
    expect(draw(installView({ kind: "progress", progress: upgrading }, { leadName: "Nina", locale: "zh" })).root
      .querySelector("li[data-step=takeover]")?.textContent).toBe("备份数据，换到新版本进行中");

    const keepsRunning = progress({ steps: { unpack: "done", takeover: "skipped", service: "done", start: "running" }, takeoverKind: "upgrade" });
    const { root } = draw(installView({ kind: "progress", progress: keepsRunning }, { leadName: "Nina", locale: "en" }));
    expect([...root.querySelectorAll("li")].map((li) => li.dataset.step)).toEqual(["unpack", "service", "start"]);
  });

  it("shows the failure and three actions; the buttons call back with their action", () => {
    const failed = progress({
      stage: "failed",
      steps: { unpack: "done", takeover: "pending", service: "failed", start: "pending" },
      backgroundNotice: false,
      error: { code: "launchd_bootstrap_failed", message: "The background service could not start." },
    });
    const { root, act } = draw(installView({ kind: "progress", progress: failed }, { leadName: "Paimon", locale: "zh" }));
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(root.querySelector("[role=alert]")?.textContent).toBe("The background service could not start.");
    const buttons = [...root.querySelectorAll("button")];
    expect(buttons.map((button) => [button.textContent, button.className])).toEqual([
      ["重试", "button primary"],
      ["查看日志", "button"],
      ["复制诊断信息", "button"],
    ]);
    buttons[2]!.click();
    expect(act).toHaveBeenCalledWith("diagnostics");
  });

  it("writes every text as text, not as HTML", () => {
    const failed = progress({ stage: "failed", error: { code: "unexpected", message: "<img src=x onerror=alert(1)>" } });
    const { root } = draw(installView({ kind: "progress", progress: failed }, { leadName: "<b>Nina</b>", locale: "en" }));
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
    expect(root.querySelector("[role=alert]")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("disables the buttons while the diagnostics are collected", () => {
    const failed = progress({ stage: "failed", error: { code: "x", message: "m" } });
    const { root } = draw(installView({ kind: "progress", progress: failed }, { leadName: "Paimon", locale: "en", busy: true }));
    expect([...root.querySelectorAll("button")].every((button) => button.disabled)).toBe(true);
  });

  it("asks to move the App before it installs anything", () => {
    const { root } = draw(installView({ kind: "move", error: null }, { leadName: "Paimon", locale: "en" }));
    expect(root.querySelector("h1")?.textContent).toBe("Move Bytezard Lead to Applications");
    expect(root.querySelectorAll("li")).toHaveLength(0);
    expect([...root.querySelectorAll("button")].map((button) => button.dataset.action)).toEqual(["move"]);
  });
});
