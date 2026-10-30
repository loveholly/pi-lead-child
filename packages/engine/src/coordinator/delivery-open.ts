// 打开交付里的一个文件（工单 07，spec 5.4、D7）：本期不做在线预览，在这台电脑上用默认程序打开。
// 工单操作 open_delivery_file（ticket-actions/catalog.ts）调这里；怎么调起 open 在 file-opener.ts。
//
// 能打开什么：
// - path 是这次交付快照（工单 04）文件列表里的相对路径，先过 normalizeDeliveryPath：拒绝绝对路径、..、反斜杠、控制字符和 .git。
// - 可能含密钥的文件不打开（交付视图的隐藏规则）：按文件名、改名以前的名字、符号链接指向的文件查。
// - realpath 以后必须还在工作区（或仓库、你的目录）里面，而且是普通文件。符号链接指到外面的，拒绝。
// - 工单的目录是家目录或者更上层的目录时不打开（审查 M3）：根目录这么大，包含检查等于没有。
// 用什么程序打开（file-opener.ts 的白名单）。下面两种情况一律用文本编辑器（审查 M1、M3）：
// - 文件列表是 agent 自己报的（快照 source=agent），不是系统跑的 git diff。
// - 工作区里还有 Run 在跑：检查和打开之间，文件可能被换掉。
// 打开哪一份，按顺序找：
//   1. 工作区还在：工作区里的那份。
//   2. 已经合并、工作区清理了：仓库里合并后的那份。
//   3. 两处都没有：「工作区已清理」。
//   直接改在你目录里的工单（没有隔离分支）：你的目录里的那份。
// 报错里不带服务器路径：只说哪一步不行。
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import type { Item } from "@pi-lead-child/core";
import { getDeliverySnapshotBySequence, getWorkspace, type Db, type DeliverySnapshot } from "@pi-lead-child/store";
import { DeliveryError } from "./delivery.js";
import {
  activeRuns, deliveryFileHiddenReason, hasGitSegment, normalizeDeliveryPath, worktreePresent,
} from "./delivery-source.js";
import { recordedDeliverySnapshot } from "./delivery-snapshot.js";
import { opensWith, type FileOpenApp, type FileOpener } from "./file-opener.js";

// 文件在电脑上的哪一处：工作区（隔离 worktree）、仓库（合并以后）、你的目录（没有隔离分支的工单）。
export type DeliveryFileLocation = "workspace" | "repository" | "workdir";

export interface OpenDeliveryFileResult {
  path: string;
  // 第几次交付（path 在这次交付的快照里）。
  sequence: number;
  location: DeliveryFileLocation;
  app: FileOpenApp;
}

export const OPEN_FILE_REASONS = {
  noOpener: "这里没有接打开文件的程序，不能打开文件。",
  unsupported: "这台电脑不支持用默认程序打开文件，只有 macOS 支持。",
  // 手机上只显示文件列表（spec 5.4）。
  notLocal: "手机上不能打开文件，请在电脑上打开。",
  nothingDelivered: "还没有交付的文件。",
} as const;

const SECRET_REFUSAL = "这个文件可能含密钥，不打开。";
const BROAD_ROOT_REFUSAL = "这张工单的目录是家目录或者更上层的目录，范围太大，不在这里打开文件。";

// workspaceId：工作区（隔离 worktree）的 id，看它里面还有没有 Run 在跑。仓库和你的目录没有。
interface FileHome { location: DeliveryFileLocation; root: string; workspaceId?: number }

// root 是家目录，或者家目录的上级目录（包括 /）。读不到 realpath 时不算：后面找文件时自然找不到。
function tooBroad(root: string): boolean {
  let realRoot: string;
  let home: string;
  try {
    realRoot = realpathSync(root);
    home = realpathSync(homedir());
  } catch {
    return false;
  }
  return home === realRoot || home.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
}

// 这次交付的文件在电脑上的哪几处，按要找的顺序。一处都没有时 homes 为空，none 写明原因。
function fileHomes(db: Db, item: Item, snapshot: DeliverySnapshot): { homes: FileHome[]; none: string | null } {
  if (snapshot.workspaceId === null) {
    if (!item.workdir) return { homes: [], none: "这张工单没有记下目录，不知道文件在哪里。" };
    if (tooBroad(item.workdir)) return { homes: [], none: BROAD_ROOT_REFUSAL };
    return { homes: [{ location: "workdir", root: item.workdir }], none: null };
  }
  const workspace = getWorkspace(db, snapshot.workspaceId);
  const homes: FileHome[] = [];
  if (workspace && worktreePresent(workspace)) homes.push({ location: "workspace", root: workspace.path, workspaceId: workspace.id });
  if (workspace?.merge_status === "merged" && workspace.repo_root) homes.push({ location: "repository", root: workspace.repo_root });
  // 范围太大的那一处不找（例如你的家目录本身是一个 git 仓库）。剩下的照样找；一处都不剩时说明原因。
  const usable = homes.filter((home) => !tooBroad(home.root));
  if (usable.length) return { homes: usable, none: null };
  if (homes.length) return { homes: [], none: BROAD_ROOT_REFUSAL };
  return {
    homes,
    none: workspace?.merge_status === "abandoned"
      ? "工作区已清理，改动已经放弃，电脑上没有这些文件。"
      : "工作区已清理，改动也没有合并进你的仓库，电脑上没有这些文件。",
  };
}

const MISSING: Record<DeliveryFileLocation, string> = {
  workspace: "工作区里找不到这个文件，可能交付以后又改名或删掉了。",
  repository: "工作区已清理，仓库里也找不到合并后的这个文件，可能合并以后又改名或删掉了。",
  workdir: "目录里找不到这个文件，可能交付以后又改名或删掉了。",
};

type Resolved =
  | { kind: "file"; real: string; realRoot: string; mode: number }
  | { kind: "missing" | "outside" | "not_file" };

// path 在 root 里的那个文件，realpath 以后。中间的目录和文件本身都可能是符号链接，所以比的是 realpath 的结果。
function resolveInside(root: string, path: string): Resolved {
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(resolve(realRoot, path));
  } catch {
    return { kind: "missing" };
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return { kind: "outside" };
  try {
    const stat = statSync(real);
    return stat.isFile() ? { kind: "file", real, realRoot, mode: stat.mode } : { kind: "not_file" };
  } catch {
    return { kind: "missing" };
  }
}

// 这一处还有 Run 在跑：工作区看这个工作区的 Run；你的目录看这张工单的 Run。仓库里合并后的那份，工作区已经清理了。
function stillRunning(db: Db, item: Item, home: FileHome): boolean {
  if (home.workspaceId !== undefined) return activeRuns(db, home.workspaceId) > 0;
  if (home.location !== "workdir") return false;
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM runs WHERE item_id=? AND state IN ('starting','running','paused')",
  ).get(item.id) as { n: number }).n > 0;
}

/**
 * 工单级的「现在能不能打开文件」（操作的 available）。能时返回 null。
 * local：请求来自这台电脑（页面：回环地址；Lead：daemon 自己）。
 */
export async function deliveryFileOpenBlocker(
  db: Db, item: Item, opener: FileOpener | undefined, local: boolean,
): Promise<string | null> {
  if (!opener) return OPEN_FILE_REASONS.noOpener;
  if (!opener.supported) return OPEN_FILE_REASONS.unsupported;
  if (!local) return OPEN_FILE_REASONS.notLocal;
  const snapshot = await recordedDeliverySnapshot(db, item);
  if (!snapshot?.files.length) return OPEN_FILE_REASONS.nothingDelivered;
  return fileHomes(db, item, snapshot).none;
}

/** 打开第 sequence 次交付（不给时是最新一次）里的 path。工单级的检查由调用方先做（deliveryFileOpenBlocker）。 */
export async function openDeliveryFile(
  db: Db, item: Item, input: { path: unknown; sequence?: number }, opener: FileOpener,
): Promise<OpenDeliveryFileResult> {
  const path = normalizeDeliveryPath(input.path);
  if (!path) throw new DeliveryError("invalid_request", "文件路径不对：只能是交付里的相对路径。");
  const snapshot = input.sequence === undefined
    ? await recordedDeliverySnapshot(db, item)
    : getDeliverySnapshotBySequence(db, item.id, input.sequence);
  if (!snapshot) {
    throw new DeliveryError("not_found", input.sequence === undefined
      ? OPEN_FILE_REASONS.nothingDelivered : `工单 #${item.id} 没有第 ${input.sequence} 次交付。`);
  }
  const file = snapshot.files.find((entry) => entry.path === path);
  if (!file) throw new DeliveryError("not_found", "这个文件不在这次交付里。");
  // .env 改名成 settings.txt 以后内容还是 .env 的，所以旧名字也要查（交付视图的同一条规则）。
  if (deliveryFileHiddenReason(path) ?? (file.previousPath ? deliveryFileHiddenReason(file.previousPath) : null)) {
    throw new DeliveryError("unavailable", SECRET_REFUSAL);
  }
  if (file.status === "deleted") throw new DeliveryError("not_found", "这个文件在这次交付里删掉了，没有可以打开的文件。");

  const { homes, none } = fileHomes(db, item, snapshot);
  if (none) throw new DeliveryError("unavailable", none);
  let found: { home: FileHome; real: string; realRoot: string; mode: number } | null = null;
  for (const home of homes) {
    const resolved = resolveInside(home.root, path);
    // 指到外面的链接直接拒绝，不再去下一处找：这一处的文件就是它。
    if (resolved.kind === "outside") throw new DeliveryError("unavailable", "这个文件是指到工作区外面的链接，不打开。");
    if (resolved.kind === "not_file") throw new DeliveryError("unavailable", "这不是一个普通文件，不打开。");
    if (resolved.kind === "file") {
      found = { home, real: resolved.real, realRoot: resolved.realRoot, mode: resolved.mode };
      break;
    }
  }
  if (!found) throw new DeliveryError("not_found", MISSING[homes[0]!.location]);
  // 符号链接按它指向的文件查：notes.md -> .env 通过了包含检查，打开的却是 .env。
  if (deliveryFileHiddenReason(found.real)) throw new DeliveryError("unavailable", SECRET_REFUSAL);
  if (hasGitSegment(relative(found.realRoot, found.real))) throw new DeliveryError("unavailable", "这是 git 的内部文件，不打开。");

  const app: FileOpenApp = snapshot.source === "agent" || stillRunning(db, item, found.home)
    ? "text_editor" : opensWith(found.real, found.mode);
  try {
    await opener.open(found.real, app);
  } catch {
    // open 的报错里有文件的绝对路径，不转给客户端。
    throw new DeliveryError("failed", "没有打开这个文件：这台电脑上的 open 命令报了错，可能没有能打开这种文件的程序。");
  }
  return { path, sequence: snapshot.sequence, location: found.home.location, app };
}
