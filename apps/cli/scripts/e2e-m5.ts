// M5 daemon 端到端验收：会话 A 派活后 detach → daemon 独自托管 child →
// 会话 B 重连查进度并走 reviewer 独立核查 → daemon stop。
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = "/tmp/plc-m5-e2e";
rmSync(DATA, { recursive: true, force: true });
mkdirSync(join(DATA, "work"), { recursive: true });
const LOG = join(DATA, "transcript.log");
writeFileSync(LOG, "");
const ENV = { ...process.env, PLC_DATA_DIR: DATA, PLC_CHILD_LINGER_MS: "20000", PLC_HEARTBEAT_MS: "45000" };
const stamp = () => new Date().toISOString().slice(11, 19);
const mark = (s: string) => appendFileSync(LOG, `\n=== [${stamp()}] ${s} ===\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function chatSession(lines: Array<[number, string]>): Promise<any> {
  return new Promise((resolve) => {
    const proc = spawn(join(ROOT, "bin", "plc"), ["chat"], { env: ENV, stdio: ["pipe", "pipe", "pipe"] });
    for (const s of [proc.stdout, proc.stderr]) s.on("data", (c) => appendFileSync(LOG, c));
    (async () => {
      for (const [delay, line] of lines) {
        await sleep(delay);
        appendFileSync(LOG, `\n>>> [${stamp()}] USER: ${line}\n`);
        proc.stdin.write(line + "\n");
      }
    })();
    proc.on("exit", resolve);
    setTimeout(() => proc.kill("SIGKILL"), 8 * 60_000); // 单会话兜底
  });
}

mark("SESSION A: 派活后 detach");
await chatSession([
  [30_000, "在 /tmp/plc-m5-e2e/work 写一个 primes.py（打印前 20 个素数）和 test_primes.py（验证数量与前几项正确），测试必须实际运行通过。开工单执行。"],
  [60_000, "/quit"],   // child 大概率还在跑，detach 验证 daemon 独立托管
]);

mark("DETACHED: daemon 独自托管 150s（child 完成 + 可能触发心跳巡检）");
await sleep(150_000);

mark("SESSION B: 重连验收");
await chatSession([
  [8_000, "我回来了。刚才那个素数任务现在什么状态？"],
  [40_000, "按流程验收它：这个工单有'测试必须通过'的验收标准，走独立审查。"],
  [150_000, "审查报告出来了吗？出来了就按报告做验收决定。"],
  [60_000, "/quit"],
]);

mark("DAEMON STOP");
try {
  appendFileSync(LOG, execFileSync(join(ROOT, "bin", "plc"), ["daemon", "stop"], { env: ENV, timeout: 30_000 }));
} catch (e: any) { appendFileSync(LOG, `stop error: ${e.message}\n`); }
mark("DONE");
process.exit(0);
