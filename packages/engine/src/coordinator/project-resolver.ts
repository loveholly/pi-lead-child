import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { Db } from "@pi-lead-child/store";
import {
  createProject, findProject, getProject, linkProjectRepository, type Project,
} from "@pi-lead-child/store";

export interface RepositoryIdentity {
  root: string;
  remoteUrl: string | null;
  name: string;
}

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

export function normalizeRemoteUrl(value: string): string {
  let remote = value.trim();
  const scp = remote.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) remote = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const url = new URL(remote);
      remote = `${url.hostname}${url.pathname}`;
    } catch {
      remote = remote.replace(/^file:\/\//, "");
    }
  }
  return remote.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
}

export function repositoryIdentity(workdir: string): RepositoryIdentity | null {
  const root = git(["-C", workdir, "rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const rawRemote = git(["-C", root, "remote", "get-url", "origin"]);
  return { root, remoteUrl: rawRemote ? normalizeRemoteUrl(rawRemote) : null, name: basename(root) };
}

export function resolveProjectForWorkdir(
  db: Db,
  workdir: string,
  args: { createdBy: string },
): Project | null {
  const identity = repositoryIdentity(workdir);
  if (!identity) return null;
  const byRoot = db.prepare(
    "SELECT project_id FROM project_repositories WHERE repo_root = ?",
  ).get(identity.root) as { project_id: number } | undefined;
  if (byRoot) return getProject(db, byRoot.project_id) ?? null;
  if (identity.remoteUrl) {
    const byRemote = db.prepare(
      "SELECT project_id FROM project_repositories WHERE remote_url = ? ORDER BY id LIMIT 1",
    ).get(identity.remoteUrl) as { project_id: number } | undefined;
    if (byRemote) {
      linkProjectRepository(db, byRemote.project_id, {
        repoRoot: identity.root, remoteUrl: identity.remoteUrl, repoName: identity.name, confidence: 0.9,
      });
      return getProject(db, byRemote.project_id) ?? null;
    }
  }
  const known = findProject(db, identity.name);
  const projectId = known?.id ?? createProject(db, {
    name: identity.name, createdBy: args.createdBy, confidence: 0.8,
  });
  linkProjectRepository(db, projectId, {
    repoRoot: identity.root, remoteUrl: identity.remoteUrl ?? undefined,
    repoName: identity.name, confidence: 0.8,
  });
  return getProject(db, projectId) ?? null;
}
