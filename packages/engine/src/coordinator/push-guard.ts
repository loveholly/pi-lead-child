// 推送前的检查：要推的分支和 origin 的默认分支有没有共同历史（2026-11-06，#288）。
//
// 起因：用户给主 checkout 加上了 origin，指向公开仓库。#222 的分支建在旧的、没有脱敏的本地历史上，和公开仓库的
// master 没有共同历史。系统交付后自动开草稿 PR，先把分支推了上去（推送成功），开 PR 才失败：
// 「The ... branch has no history in common with master」。结果整段私有历史被推到了公开仓库。
//
// 所以推送之前先在本地查两件事，任何一件不通过就不推、不开 PR：
// 1. 分支和 origin/<默认分支> 有共同祖先（git merge-base 找得到）。找不到默认分支时也不推：没法确认。
// 2. 分支上 origin 还没有的提交（任何 origin/* 都到不了的）不超过 MAX_UNPUBLISHED_COMMITS 个。
//    一张工单的分支连同返工通常只有几个到几十个提交；#222 带出去的是 1455 个。100 给长工单留了余量，
//    又能挡住「有共同历史，但带着一大段没公开过的本地提交」这种情况（例如分支从领先 origin 很多的本地分支切出来）。
import { gitRun, firstLine, redact } from "./delivery-source.js";
import { fetchOrigin, originDefaultBranchAsync } from "./workspace-remote.js";

export const MAX_UNPUBLISHED_COMMITS = 100;

export type PushCheck =
  | { ok: true; defaultBranch: string; unpublished: number }
  | { ok: false; reason: string; defaultBranch: string | null; unpublished: number | null };

function refuse(reason: string, defaultBranch: string | null = null, unpublished: number | null = null): PushCheck {
  return { ok: false, reason, defaultBranch, unpublished };
}

/**
 * 查 branch（本地分支名）能不能推到 origin。先 fetch 一次 origin（60 秒内 fetch 过就不再连远端；失败也接着查本地的引用）。
 * 不抛错：通过时 ok=true；不通过时 reason 写给人看的原因和下一步。
 */
export async function checkPushAgainstOrigin(repo: string, branch: string): Promise<PushCheck> {
  await fetchOrigin(repo);
  const defaultBranch = await originDefaultBranchAsync(repo);
  const originRef = defaultBranch ? `refs/remotes/origin/${defaultBranch}` : null;
  const known = originRef ? await gitRun(["rev-parse", "--verify", "--quiet", originRef], repo) : null;
  if (!defaultBranch || !known?.ok) {
    return refuse("找不到 origin 的默认分支，没法确认这条分支和它有共同历史，所以没有推送。"
      + "如果 origin 是新建的空仓库，先手动推一次默认分支；否则检查 origin 的地址。");
  }
  const target = `origin/${defaultBranch}`;
  const base = await gitRun(["merge-base", `refs/heads/${branch}`, originRef!], repo);
  if (!base.ok || !base.stdout.trim()) {
    // merge-base 找不到共同祖先时退出码是 1、没有输出；别的失败（例如分支不存在）带着 git 的报错。
    const detail = base.stderr.trim() ? `（git：${redact(firstLine(base.stderr))}）` : "";
    return refuse(`这条分支和 ${target} 没有共同历史，可能建在别的历史上，所以没有推送，也没有开 PR${detail}。`
      + `需要先把这张工单自己的提交 rebase 到 ${target} 上，再推送。`, defaultBranch);
  }
  const counted = await gitRun(["rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes=origin"], repo);
  const unpublished = counted.ok ? Number.parseInt(counted.stdout.trim(), 10) : Number.NaN;
  if (!Number.isFinite(unpublished)) {
    return refuse(`数不出这条分支上有多少个提交 origin 还没有（git：${redact(firstLine(counted.stderr))}），所以没有推送。`, defaultBranch);
  }
  if (unpublished > MAX_UNPUBLISHED_COMMITS) {
    return refuse(`这条分支上有 ${unpublished} 个提交 origin 还没有，超过了 ${MAX_UNPUBLISHED_COMMITS} 个，`
      + `可能带着不属于这张工单的本地历史，所以没有推送，也没有开 PR。`
      + `需要先确认这些提交可以公开，或者只把这张工单自己的提交 rebase 到 ${target} 上。`, defaultBranch, unpublished);
  }
  return { ok: true, defaultBranch, unpublished };
}
