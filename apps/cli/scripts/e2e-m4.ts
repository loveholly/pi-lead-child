// M4 端到端验收驱动：真实 lead + 3 个真实 child 并发，含进度确认/插话/steer/中止/验收。
// 用法: npx tsx scripts/e2e-m4.ts   （транскрипт → /tmp/plc-e2e/transcript.log）
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = "/tmp/plc-e2e";
rmSync(DATA, { recursive: true, force: true });
for (const d of ["", "work1", "work2", "work3"]) mkdirSync(join(DATA, d), { recursive: true });
const LOG = join(DATA, "transcript.log");
writeFileSync(LOG, "");

const proc = spawn(join(ROOT, "bin", "plc"), ["chat"], {
  env: { ...process.env, PLC_DATA_DIR: DATA, PLC_CHILD_LINGER_MS: "120000" },
  stdio: ["pipe", "pipe", "pipe"],
});
const stamp = () => new Date().toISOString().slice(11, 19);
for (const s of [proc.stdout, proc.stderr]) {
  s.on("data", (c) => appendFileSync(LOG, c));
}
const send = (line: string) => {
  appendFileSync(LOG, `\n>>> [${stamp()}] USER: ${line}\n`);
  proc.stdin.write(line + "\n");
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SCRIPT: Array<[number, string]> = [
  [2000, `同时开三个任务并行执行：
1. 在 /tmp/plc-e2e/work1 写一个 Python CSV 统计工具 stats.py（读 CSV 输出每个数值列的 min/max/mean），并写 test_stats.py 自测三组数据，必须实际运行测试通过。优先级高。
2. 在 /tmp/plc-e2e/work2 写一份 SQLite WAL 模式调研笔记 wal.md，至少 5 个要点，包含适用场景与限制。普通优先级。
3. 在 /tmp/plc-e2e/work3 写一个 bash 脚本 watch.sh（轮询监控目录新文件并打印）加 README 使用说明。低优先级。`],
  [25_000, "现在三个任务各自什么进展？"],   // lead 大概率还在忙 → 走 steer 插话路径
  [45_000, "给写 WAL 调研笔记的那个任务追加要求：必须包含与 rollback journal 的对比表格。用 steer 直接告诉它的 child。"],
  [25_000, "把 watch.sh 那个任务中止掉，我不需要了，工单也取消。"],
  [150_000, "现在所有任务什么状态？处于 review 的逐个做实物验收，通过就关单。"],
  [120_000, "最后：把这次协作中值得长期记住的结论存个笔记。然后总结一下本次会话账本里发生了什么。"],
  [60_000, "/quit"],
];

(async () => {
  for (const [delay, line] of SCRIPT) {
    await sleep(delay);
    send(line);
  }
  // 等 plc 自然退出（最多 3 分钟）
  const exited = new Promise((r) => proc.on("exit", r));
  const timeout = sleep(180_000).then(() => "timeout");
  const result = await Promise.race([exited, timeout]);
  if (result === "timeout") { appendFileSync(LOG, "\n!!! driver timeout, killing\n"); proc.kill("SIGKILL"); }
  appendFileSync(LOG, `\n=== driver done (${stamp()}) ===\n`);
  process.exit(0);
})();
