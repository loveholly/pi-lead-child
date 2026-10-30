// 清理历史记录里的密钥明文（spec 的方案 E）。只由部署流程执行，步骤见 .scratch/permission-boundaries/spec.md：
//   1. 停 daemon（plc daemon stop）。
//   2. 把要清理的密钥放进这个进程的环境（例如从 Keychain 读 AM_API_KEY），先空跑：
//        node --import tsx apps/daemon/scripts/scrub-secret-values.ts --names AM_API_KEY
//   3. 看过统计和「要你决定」的清单（artifact blob、只追加的表、二进制文件），再加 --apply 跑一次。
//      它会改写文本文件，逐个清理 plc.db 和 backups/、plc.db.bak-* 这些数据库备份（改之前和之后都做完整性检查），
//      改过的数据库会 VACUUM。「要你决定」的文件它不动。
//   4. 启动 daemon，然后轮换这些密钥。
// 只打印路径、文件数和次数，不打印值。--data-dir 缺省是 PLC_DATA_DIR 或 ~/.pi-lead-child。
import { connect } from "node:net";
import { join } from "node:path";
import { dataDir } from "@pi-lead-child/core";
import { scrubSecretHistory } from "../src/secret-history-scrub.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dir = flag("--data-dir") ?? dataDir();
const names = (flag("--names") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const apply = args.includes("--apply");
if (!names.length) {
  console.error("usage: scrub-secret-values.ts --names AM_API_KEY[,TAVILY_API_KEY] [--data-dir DIR] [--apply]");
  process.exit(2);
}
const missing = names.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`这些变量不在环境里：${missing.join(", ")}。先把它们的值放进这个进程的环境。`);
  process.exit(2);
}

const daemonRunning = await new Promise<boolean>((resolve) => {
  const sock = connect(join(dir, "plc.sock"));
  sock.once("connect", () => { sock.end(); resolve(true); });
  sock.once("error", () => resolve(false));
});
if (apply && daemonRunning) {
  console.error("daemon 还在运行。先停 daemon（plc daemon stop）再加 --apply。");
  process.exit(1);
}

const report = scrubSecretHistory({ dataDir: dir, values: names.map((name) => process.env[name]!), apply });
console.log(`${apply ? "已清理" : "空跑（加 --apply 才会改）"}：${dir}`);
console.log(`  文本文件：扫了 ${report.text.scanned} 个，${report.text.matched} 个有明文，共 ${report.text.replacements} 处`);
for (const db of report.databases) {
  const tables = Object.entries(db.tables).map(([table, rows]) => `${table} ${rows} 行`).join("，") || "行里没有";
  console.log(`  数据库 ${db.path}：${tables}；文件里（含 WAL、旧页）${db.rawHits} 处；完整性 ${db.integrityBefore}`
    + (db.vacuumed ? `；已 VACUUM，之后完整性 ${db.integrityAfter}` : ""));
}
if (report.needsDecision.length) {
  console.log("  要你决定：");
  for (const item of report.needsDecision) console.log(`    ${item.path}：${item.reason}`);
}
