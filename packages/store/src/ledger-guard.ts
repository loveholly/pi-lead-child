// 账本的写入守卫（2026-10-19 审查）。
//
// 一个 child 在 bash 里执行了 `sqlite3 ~/.pi-lead-child/plc.db "UPDATE connections SET write_policy = 'direct' …"`。
// child 和 daemon 是同一个系统用户，文件权限挡不住它。规则是：plc.db 可以读（排查问题要用 sqlite3 -readonly），
// 不能写；改设置必须走 daemon 的 API。
//
// 做法：每张表有三个 BEFORE 触发器（INSERT、UPDATE、DELETE），条件里调用一个自定义函数 LEDGER_WRITER_FUNCTION。
// 这个函数只在本包的 openDb、openExistingDb 打开的连接上注册。别的进程（sqlite3 命令行、python 的 sqlite3）
// 没有这个函数，写语句在准备阶段就失败，报错是「no such function: <函数名>」，函数名本身说明了该怎么做。
// 读不受影响，也不碰触发器。
//
// 这不是隔离：任何连接都能 DROP TRIGGER，python 的 create_function 也能注册同名函数。它挡住的是顺手的直接改库。
// 绕过之后的改动由别的机制发现：连接的权限设置有保险库的封印（packages/connections 的 hub），
// child 的命令里出现写账本的操作会报警（engine 的 ledger-write-detector），daemon 每分钟核对一次触发器的
// 名字和内容，缺了或者被换过就补装并报警（ledgerGuardProblems）。
//
// 回滚：触发器写在库文件里。没有注册这个函数的旧代码打开装过守卫的库，第一条写语句就会失败，daemon 起不来。
// 只回滚代码之前，先停 daemon，再用新代码卸掉守卫：`plc daemon ledger-guard uninstall`（ops.ts）。
// 新代码用不了时，用 sqlite3 删掉触发器也可以（DROP TRIGGER 不需要这个函数），语句见 ledgerGuardDropSql。
// PLC_LEDGER_GUARD=off 时，openDb 不装守卫，并卸掉已有的守卫（应急开关，只有 daemon 的启动环境能设）。
import type { Db } from "./db.js";

// 名字就是报错给 child 看的说明。
export const LEDGER_WRITER_FUNCTION = "plc_db_is_read_only_use_the_daemon_api";

const TRIGGER_PREFIX = "plc_ledger_guard_";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERATIONS = ["insert", "update", "delete"] as const;

/** 在一个连接上注册写入函数。这个连接以后可以写账本。 */
export function registerLedgerWriter(db: Db): void {
  db.function(LEDGER_WRITER_FUNCTION, { deterministic: false }, () => 1);
}

/** 要守卫的表：普通表，不含 sqlite_ 开头的内部表、虚表和虚表的影子表（FTS 自己写它们）。 */
export function ledgerGuardedTables(db: Db): string[] {
  const rows = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
  ).all() as Array<{ name: string; sql: string | null }>;
  const virtual = rows.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? "")).map((row) => row.name);
  return rows
    .filter((row) => !virtual.includes(row.name) && !virtual.some((name) => row.name.startsWith(`${name}_`)))
    .map((row) => row.name)
    .filter((name) => IDENTIFIER.test(name));
}

const GUARD_MESSAGE = "plc.db 只能由 daemon 写入。改设置请走 daemon 的 API；只读查询用 sqlite3 -readonly。";

// 一个守卫触发器的语句。sqlite_master 里存的是去掉 IF NOT EXISTS 和末尾分号的同一句（ledgerGuardProblems 比较它）。
function guardTriggerSql(table: string, operation: typeof OPERATIONS[number]): string {
  return `CREATE TRIGGER "${TRIGGER_PREFIX}${table}_${operation}" BEFORE ${operation.toUpperCase()} ON "${table}" `
    + `WHEN ${LEDGER_WRITER_FUNCTION}() IS NOT 1 BEGIN SELECT RAISE(ABORT, '${GUARD_MESSAGE}'); END`;
}

const normalizeSql = (sql: string) => sql.replace(/\s+/g, " ").trim().replace(/;$/, "");

/**
 * 守卫的现状：缺的（被删掉了，或者新表还没装），和名字对、内容被换过的（例如删掉后建了一个同名的空触发器）。
 * 只按名字核对会被同名的空触发器骗过（2026-10-19 复审）。
 */
export function ledgerGuardProblems(db: Db): { missing: string[]; altered: string[] } {
  const installed = new Map((db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE ?",
  ).all(`${TRIGGER_PREFIX}%`) as Array<{ name: string; sql: string | null }>).map((row) => [row.name, row.sql ?? ""]));
  const missing: string[] = [];
  const altered: string[] = [];
  for (const table of ledgerGuardedTables(db)) {
    for (const operation of OPERATIONS) {
      const name = `${TRIGGER_PREFIX}${table}_${operation}`;
      const sql = installed.get(name);
      if (sql === undefined) missing.push(name);
      else if (normalizeSql(sql) !== normalizeSql(guardTriggerSql(table, operation))) altered.push(name);
    }
  }
  return { missing, altered };
}

/**
 * 给每张表装上写入守卫。缺的补上，内容被换过的删掉重建。openDb 在迁移之后调用，所以迁移重建过的表也会重新装上。
 * 表名来自 sqlite_master，并且只接受普通标识符，再加双引号。
 */
export function installLedgerGuards(db: Db): void {
  const { altered } = ledgerGuardProblems(db);
  const statements = altered.map((name) => `DROP TRIGGER IF EXISTS "${name}";`);
  for (const table of ledgerGuardedTables(db)) {
    for (const operation of OPERATIONS) {
      statements.push(`${guardTriggerSql(table, operation).replace(/^CREATE TRIGGER /, "CREATE TRIGGER IF NOT EXISTS ")};`);
    }
  }
  if (statements.length) db.exec(statements.join("\n"));
}

/** 守卫开着吗。PLC_LEDGER_GUARD=off 时关。 */
export function ledgerGuardsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PLC_LEDGER_GUARD?.trim().toLowerCase() !== "off";
}

/** 卸掉所有守卫。返回卸掉了几个触发器。不需要写入函数：DROP TRIGGER 在任何连接上都能执行。 */
export function dropLedgerGuards(db: Db): number {
  const names = ledgerGuardTriggers(db);
  if (names.length) db.exec(names.map((name) => `DROP TRIGGER IF EXISTS "${name}";`).join("\n"));
  return names.length;
}

/** 卸掉守卫的 SQL，给用不了新代码时手工执行（sqlite3 plc.db < 这些语句）。 */
export function ledgerGuardDropSql(db: Db): string {
  return ledgerGuardTriggers(db).map((name) => `DROP TRIGGER IF EXISTS "${name}";`).join("\n");
}

/** 要修的守卫触发器：缺的，和内容被换过的（ledgerGuardProblems）。 */
export function missingLedgerGuards(db: Db): string[] {
  const { missing, altered } = ledgerGuardProblems(db);
  return [...missing, ...altered];
}

/** 装了守卫的表（测试和 doctor 用）。 */
export function ledgerGuardTriggers(db: Db): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE ? ORDER BY name",
  ).all(`${TRIGGER_PREFIX}%`) as Array<{ name: string }>).map((row) => row.name);
}
