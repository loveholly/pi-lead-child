// 进程的独占锁：一个数据目录里同一时刻只有一个 supervisor、一个 daemon。
// 锁由内核持有。进程退出时（包括崩溃和 kill -9）内核放掉它，所以不会留下陈旧的锁。
// 卡住的进程（事件循环不动）还活着，所以它仍然持有锁。因此"另一个实例还活着"只能用锁判断，不能用 socket 探活：
// status 会超时，accept 队列满了以后 connect 也会被拒绝。2026-10-15 的两次接管都是这样发生的。
// 实现用 SQLite 的文件锁（fcntl）：BEGIN EXCLUSIVE 之后不提交，锁一直持有到 release。
// 同一进程里的两个连接也互斥（SQLite 按 inode 记账），所以测试可以在一个进程里验证。
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// 有 supervisor.lock 才能拥有 supervisor.sock 和 supervisor-state.json，才能拉起 daemon。
export const supervisorLockPath = (dir: string): string => join(dir, "supervisor.lock");
// 有 daemon.lock 才能拥有 plc.sock，才能打开账本、跑启动修复、绑定网关。
export const daemonLockPath = (dir: string): string => join(dir, "daemon.lock");

export interface InstanceLock {
  release(): void;
}

// 持有中的锁。连接对象被回收时会被关掉，锁也就放掉了，所以这里一直引用它，直到 release。
const held = new Set<Database.Database>();

const isBusy = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
};

// 拿锁。另一个进程（或者本进程的另一个连接）持有它时返回 null，不等待。
export function claimInstanceLock(path: string): InstanceLock | null {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { timeout: 0 });
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if (isBusy(error)) return null;
    throw error;
  }
  held.add(db);
  return {
    release() {
      if (held.delete(db)) db.close();
    },
  };
}

// 有没有活着的进程持有这把锁。锁文件不存在就是没有；探测不会创建锁文件。
// 探测会短暂拿一下锁，所以不要在一个可能正在拿锁的进程（例如刚拉起的 daemon）启动时探测。
export function instanceLockHeld(path: string): boolean {
  if (!existsSync(path)) return false;
  const db = new Database(path, { timeout: 0, fileMustExist: true });
  try {
    db.exec("BEGIN EXCLUSIVE");
    return false;
  } catch (error) {
    if (isBusy(error)) return true;
    throw error;
  } finally {
    db.close();
  }
}
