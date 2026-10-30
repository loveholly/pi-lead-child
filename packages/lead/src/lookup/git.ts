// 读本地 git 仓库挪到了连接中心（packages/connections 的 local-git.ts）。
export {
  gitDirsOf, headSha, isGitRoot, originRemoteUrl, parseGithubRemote, repoDisplayName, type GithubRepoRef,
} from "@pi-lead-child/connections";
