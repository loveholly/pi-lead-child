// src/deploy/launchd.ts — 本机 launchd 集成（spec §B3）。plist 不含密钥（凭证走 config.json）。
// launchd 常驻的是 Supervisor；plc daemon stop 只停止它托管的 coordinatord，Supervisor 本身保持在线。
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

export const LAUNCHD_LABEL = "com.pi-lead-child.supervisor";
export const LEGACY_LAUNCHD_LABEL = "com.pi-lead-child.coordinatord";

export interface PlistOpts { nodeBin: string; entry: string; cwd: string; logDir: string }

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

// 路径里理论上可能含 &/</>（虽然实践中罕见），plist 是 XML，插值前必须转义，否则生成非法/被截断的 plist。
const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plistContent(o: PlistOpts): string {
  const nodeBin = xmlEscape(o.nodeBin);
  const entry = xmlEscape(o.entry);
  const cwd = xmlEscape(o.cwd);
  const outLog = xmlEscape(join(o.logDir, "supervisor.out.log"));
  const errLog = xmlEscape(join(o.logDir, "supervisor.err.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${outLog}</string>
  <key>StandardErrorPath</key><string>${errLog}</string>
</dict>
</plist>
`;
}

export function launchctl(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile("launchctl", args, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout + stderr).trim() }));
  });
}

export async function installAgent(plist: string, content: string): Promise<string> {
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, content);
  await launchctl(["bootout", `gui/${process.getuid!()}/${LEGACY_LAUNCHD_LABEL}`]);
  await launchctl(["bootout", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]); // 已装则先卸（幂等）
  const r = await launchctl(["bootstrap", `gui/${process.getuid!()}`, plist]);
  if (!r.ok) throw new Error(`launchctl bootstrap 失败: ${r.out}`);
  return plist;
}

export async function uninstallAgent(plist: string): Promise<void> {
  const r = await launchctl(["bootout", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
  await launchctl(["bootout", `gui/${process.getuid!()}/${LEGACY_LAUNCHD_LABEL}`]);
  // bootout 对"本来就没装"也会返回非零（"Could not find service"之类），这是正常路径，不应报错。
  // 但真实失败（权限、launchd 本身异常等）不该被静默吞掉——不 throw（卸载失败不该是 fatal，
  // 用户仍要能清理 plist 文件），但必须打到 stderr 让人看见。
  if (!r.ok && !/No such process|not find|could not be found/i.test(r.out)) {
    console.error(`[launchd] bootout 警告: ${r.out}`);
  }
  rmSync(plist, { force: true });
}

export async function agentStatus(): Promise<string | null> {
  const r = await launchctl(["print", `gui/${process.getuid!()}/${LAUNCHD_LABEL}`]);
  return r.ok ? r.out : null; // null = 未加载
}
