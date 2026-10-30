// 维护前的数据库备份（部署闸门，2026-10-19）：daemon 还在跑时做在线备份。
// SQLite 的在线备份按步复制页面。better-sqlite3 缺省每步 100 页，另一个连接每写一次，备份就从头开始：
// 约 60 MB 的库在每 200 ms 写一次时要 17–32 秒，写得更勤时一分钟也完不成（审查 2026-10-20 A）。
// 能接管的 child 在跑时不挡维护，而它们正好在写库。所以一步复制全部页面（实测约 0.3 秒），并且有时限：
// 到时限还没完成就放弃，删掉半成品，这次维护被拒绝。
import Database from "better-sqlite3";
import { rmSync } from "node:fs";

export const BACKUP_TIMEOUT_MS_DEFAULT = 60_000;

export async function backupSqlite(
  source: string,
  destination: string,
  options: { timeoutMs?: number; pagesPerStep?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? BACKUP_TIMEOUT_MS_DEFAULT;
  // 0x7fffffff 是 better-sqlite3 允许的最大步长：剩下的页面一步复制完。
  const pagesPerStep = options.pagesPerStep ?? 0x7fffffff;
  const deadline = Date.now() + timeoutMs;
  const db = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destination, {
      progress: () => {
        if (Date.now() > deadline) throw new Error(`database backup did not finish within ${timeoutMs} ms`);
        return pagesPerStep;
      },
    });
  } catch (error) {
    for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(`${destination}${suffix}`, { force: true });
    throw error;
  } finally {
    db.close();
  }
}
