// 清理历史记录里的密钥明文（2026-10-19 审查，spec 的方案 E；复审意见 2 扩大了范围）。
//
// 新代码只在写入时盖掉密钥（engine 的 secret-scrub.ts）。这之前写下的记录里还有明文，复审找到的地方有：
// runtime-events/、sessions/、lead-sessions/、launches/、logs/ 里的文本文件，plc.db 的 runtime_events 和 gateway_events，
// backups/*.db 和 plc.db.bak-*（数据库的备份），artifacts/blobs/ 里的 blob。所以这里不再列目录，而是走遍整个数据目录：
//   - SQLite 文件（看文件头）：每张表的每个文本列按值替换。先做完整性检查，不通过的不动；改过以后
//     checkpoint WAL 并 VACUUM，旧页里的明文才会消失。只追加的表（有触发器拒绝 UPDATE）改不了，列进「要你决定」。
//   - artifacts/blobs/ 下的文件：它们按内容的 sha256 寻址，改了内容就和名字对不上。只列进「要你决定」（删掉，或者保留）。
//   - 别的二进制文件（有 NUL 字节）：只列进「要你决定」。
//   - 文本文件：按值替换后原子地写回。
//
// 只由部署流程执行（scripts/scrub-secret-values.ts），先停 daemon，在轮换密钥之前做：轮换以后，旧值就不在环境里了。
// 缺省只统计不改（dry run），apply 才写。报告里只有路径、文件数和次数，没有值。
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { REDACTED } from "@pi-lead-child/protocol";
import { openExistingDb, type Db } from "@pi-lead-child/store";

// 比它大的文本文件跳过，列进「要你决定」。数据库不受这个限制。
const MAX_TEXT_BYTES = 256 * 1024 * 1024;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface DatabaseScrub {
  path: string;
  // 每张表有明文的行数。
  tables: Record<string, number>;
  // 文件里（包括 WAL 和没用的旧页）出现明文的次数。行里没有、这里有，说明在旧页里：VACUUM 才能清掉。
  rawHits: number;
  // 改不了的表（只追加，触发器拒绝 UPDATE）。
  readOnlyTables: string[];
  integrityBefore: string;
  integrityAfter: string | null;
  vacuumed: boolean;
}

export interface ScrubReport {
  apply: boolean;
  text: { scanned: number; matched: number; replacements: number };
  databases: DatabaseScrub[];
  // 要你决定的：路径和原因。
  needsDecision: Array<{ path: string; reason: string }>;
}

function forms(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    out.add(value);
    out.add(JSON.stringify(value).slice(1, -1));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function countIn(haystack: Buffer, needles: readonly string[]): number {
  let total = 0;
  for (const needle of needles) {
    const bytes = Buffer.from(needle, "utf8");
    for (let at = haystack.indexOf(bytes); at >= 0; at = haystack.indexOf(bytes, at + bytes.length)) total += 1;
  }
  return total;
}

function isSqlite(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return readSync(fd, header, 0, header.length, 0) === header.length && header.equals(SQLITE_HEADER);
  } finally {
    closeSync(fd);
  }
}

function* filesUnder(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

function textTables(db: Db): Array<{ table: string; columns: string[] }> {
  const tables = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
  ).all() as Array<{ name: string; sql: string | null }>;
  const virtual = tables.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? "")).map((row) => row.name);
  return tables
    .filter((row) => IDENTIFIER.test(row.name) && !virtual.includes(row.name) && !virtual.some((name) => row.name.startsWith(`${name}_`)))
    .map((row) => ({
      table: row.name,
      columns: (db.prepare(`PRAGMA table_info("${row.name}")`).all() as Array<{ name: string }>)
        .map((column) => column.name).filter((name) => IDENTIFIER.test(name)),
    }));
}

// 只追加的表：有无条件拒绝整行 UPDATE 的触发器（BEFORE UPDATE ON t，没有 OF 列、没有 WHEN，里面 RAISE）。
// items 的 BEFORE UPDATE OF kind 只锁一列，不算。账本的写入守卫也不算（它只拦别的进程）。
function appendOnlyTables(db: Db): Set<string> {
  const triggers = db.prepare(
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'plc\\_ledger\\_guard\\_%' ESCAPE '\\'",
  ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  return new Set(triggers
    .filter((trigger) => {
      const sql = trigger.sql ?? "";
      return /\bBEFORE\s+UPDATE\s+ON\b/i.test(sql) && !/\bWHEN\b/i.test(sql) && /\bRAISE\s*\(\s*(ABORT|FAIL|ROLLBACK)/i.test(sql);
    })
    .map((trigger) => trigger.tbl_name));
}

function scrubDatabase(path: string, values: readonly string[], apply: boolean): DatabaseScrub {
  const needles = forms(values);
  const rawHits = (): number => {
    let hits = 0;
    for (const file of [path, `${path}-wal`]) if (existsSync(file)) hits += countIn(readFileSync(file), needles);
    return hits;
  };
  const result: DatabaseScrub = {
    path, tables: {}, rawHits: rawHits(), readOnlyTables: [], integrityBefore: "", integrityAfter: null, vacuumed: false,
  };
  const db = openExistingDb(path, { readonly: !apply });
  try {
    result.integrityBefore = String(db.pragma("integrity_check", { simple: true }));
    if (result.integrityBefore !== "ok") return result;
    let changed = false;
    const appendOnly = appendOnlyTables(db);
    for (const { table, columns } of textTables(db)) {
      let rows = 0;
      for (const column of columns) {
        for (const needle of needles) {
          const hits = (db.prepare(
            `SELECT COUNT(*) AS n FROM "${table}" WHERE typeof("${column}") = 'text' AND instr("${column}", ?) > 0`,
          ).get(needle) as { n: number }).n;
          if (!hits) continue;
          rows += hits;
          if (appendOnly.has(table)) {
            if (!result.readOnlyTables.includes(table)) result.readOnlyTables.push(table);
            continue;
          }
          if (!apply) continue;
          try {
            db.prepare(`UPDATE "${table}" SET "${column}" = replace("${column}", ?, ?) WHERE typeof("${column}") = 'text' AND instr("${column}", ?) > 0`)
              .run(needle, REDACTED, needle);
            changed = true;
          } catch {
            if (!result.readOnlyTables.includes(table)) result.readOnlyTables.push(table);
          }
        }
      }
      if (rows) result.tables[table] = rows;
    }
    if (apply && (changed || result.rawHits > 0)) {
      const hasFts = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'notes_fts'").get();
      if (hasFts && result.tables.notes) db.exec("INSERT INTO notes_fts(notes_fts) VALUES ('rebuild')");
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      // WAL 模式下 VACUUM 的新页先进 WAL：再 checkpoint 一次，库文件里的旧页才被换掉。
      db.pragma("wal_checkpoint(TRUNCATE)");
      result.vacuumed = true;
      result.integrityAfter = String(db.pragma("integrity_check", { simple: true }));
    }
  } finally {
    db.close();
  }
  return result;
}

/** 清理一个数据目录。values 是要盖掉的明文（8 个字符以下的忽略）。apply 为 false 时只统计。 */
export function scrubSecretHistory(input: { dataDir: string; values: readonly string[]; apply: boolean }): ScrubReport {
  const values = [...new Set(input.values.filter((value) => value.length >= 8))];
  const report: ScrubReport = { apply: input.apply, text: { scanned: 0, matched: 0, replacements: 0 }, databases: [], needsDecision: [] };
  if (!values.length) return report;
  const needles = forms(values);
  const blobs = join(input.dataDir, "artifacts", "blobs") + sep;
  for (const path of filesUnder(input.dataDir)) {
    // WAL、共享内存、回滚日志跟着它们的数据库处理。
    if (/-(wal|shm|journal)$/.test(path)) continue;
    const rel = relative(input.dataDir, path);
    if (isSqlite(path)) {
      const db = scrubDatabase(path, values, input.apply);
      if (Object.keys(db.tables).length || db.rawHits || db.integrityBefore !== "ok") report.databases.push(db);
      if (db.integrityBefore !== "ok") report.needsDecision.push({ path: rel, reason: `完整性检查没通过（${db.integrityBefore}），没有改` });
      for (const table of db.readOnlyTables) {
        report.needsDecision.push({ path: rel, reason: `表 ${table} 只追加，改不了：要清掉只能删掉这些行，或者删掉这个文件` });
      }
      continue;
    }
    const size = lstatSync(path).size;
    if (size > MAX_TEXT_BYTES) {
      report.needsDecision.push({ path: rel, reason: "文件太大，没有检查" });
      continue;
    }
    const bytes = readFileSync(path);
    report.text.scanned += 1;
    const hits = countIn(bytes, needles);
    if (!hits) continue;
    if (path.startsWith(blobs)) {
      report.needsDecision.push({ path: rel, reason: "按内容寻址的 artifact blob，改了内容就和它的 sha256 对不上：删掉，或者保留" });
      continue;
    }
    if (bytes.includes(0)) {
      report.needsDecision.push({ path: rel, reason: "二进制文件，没有改" });
      continue;
    }
    report.text.matched += 1;
    report.text.replacements += hits;
    if (!input.apply) continue;
    let text = bytes.toString("utf8");
    for (const needle of needles) text = text.split(needle).join(REDACTED);
    const temporary = `${path}.scrub-${process.pid}`;
    writeFileSync(temporary, text, { mode: lstatSync(path).mode & 0o777 });
    renameSync(temporary, path);
  }
  return report;
}
