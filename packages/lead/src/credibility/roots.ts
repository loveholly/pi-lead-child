// 代码引用在哪些目录里核对（code-refs.ts）。
// 工单的工作目录、它的活跃工作区、它所在项目登记的仓库；GitHub 的调用对上登记的那个仓库；
// 都没有时用所有登记的仓库。系统不知道一个仓库时，就不核对落在那里的引用。
import type { Db } from "@pi-lead-child/store";

export function ticketRoots(db: Db, ticketId: number): string[] {
  const item = db.prepare("SELECT workdir, project_id FROM items WHERE id=?").get(ticketId) as
    { workdir: string | null; project_id: number | null } | undefined;
  if (!item) return [];
  const workspaces = (db.prepare(
    `SELECT path FROM workspaces WHERE owner_item_id=? AND state NOT IN ('released','cleaning','cleaned','archived','failed')`,
  ).all(ticketId) as Array<{ path: string }>).map((row) => row.path);
  const repos = item.project_id === null ? [] : (db.prepare(
    "SELECT repo_root FROM project_repositories WHERE project_id=?",
  ).all(item.project_id) as Array<{ repo_root: string }>).map((row) => row.repo_root);
  return [...new Set([item.workdir, ...workspaces, ...repos].filter((root): root is string => Boolean(root)))];
}

export function knownRoots(db: Db): string[] {
  const repos = (db.prepare("SELECT repo_root FROM project_repositories").all() as Array<{ repo_root: string }>)
    .map((row) => row.repo_root);
  const workspaces = (db.prepare(
    `SELECT path FROM workspaces WHERE state NOT IN ('released','cleaning','cleaned','archived','failed')`,
  ).all() as Array<{ path: string }>).map((row) => row.path);
  return [...new Set([...repos, ...workspaces])];
}

// GitHub 的 owner/repo 对上登记的仓库（remote_url 形如 github.com/Acme/agent-app，大小写不敏感）。
export function githubRepoRoots(db: Db, owner: string, repo: string): string[] {
  const wanted = `github.com/${owner}/${repo}`.toLowerCase();
  return (db.prepare("SELECT repo_root, remote_url FROM project_repositories WHERE remote_url IS NOT NULL").all() as
    Array<{ repo_root: string; remote_url: string }>)
    .filter((row) => row.remote_url.toLowerCase().replace(/^[a-z+]+:\/\//, "").replace(/^git@github\.com:/, "github.com/")
      .replace(/\.git$/, "").replace(/\/$/, "").endsWith(wanted))
    .map((row) => row.repo_root);
}

// 文字里的工单编号（#93）。只是用来多收集几个目录，认错了（比如 PR #93）也只是多找几个地方。
export function ticketIdsInText(text: string): number[] {
  return [...new Set([...text.matchAll(/#(\d{1,7})\b/g)].map((match) => Number(match[1])))].slice(0, 20);
}
