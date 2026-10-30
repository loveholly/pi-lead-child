import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createCoordinator } from "../src/coordinator/service.js";
import { resolveProjectForWorkdir } from "../src/coordinator/project-resolver.js";
import { openDb } from "@pi-lead-child/store";
import { getItem } from "@pi-lead-child/store";
import { listProjectRepositories } from "@pi-lead-child/store";

describe("project resolution", () => {
  it("creates and reuses a repository-named logical project", () => {
    const dir = tempDir("plc-project-resolution-");
    const repo = join(dir, "returns-buyer");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:example/returns-buyer.git"]);
    const db = openDb(join(dir, "plc.db"));

    const first = resolveProjectForWorkdir(db, repo, { createdBy: "system:test" });
    const nested = join(repo, "src");
    mkdirSync(nested);
    const second = resolveProjectForWorkdir(db, nested, { createdBy: "system:test" });

    expect(first?.name).toBe(basename(repo));
    expect(second?.id).toBe(first?.id);
    expect(listProjectRepositories(db, first!.id)).toEqual([
      expect.objectContaining({ repo_root: realpathSync(repo), remote_url: "github.com/example/returns-buyer" }),
    ]);

    const coordinator = createCoordinator({ db });
    const itemId = coordinator.createRootItem({
      title: "repo task", brief: "b", createdBy: "lead", workdir: nested,
    });
    expect(getItem(db, itemId)).toMatchObject({
      project_id: first!.id,
      project: "returns-buyer",
      root_item_id: itemId,
    });
  });

  it("returns null outside git when no explicit project exists", () => {
    const dir = tempDir("plc-project-none-");
    const db = openDb(join(dir, "plc.db"));
    expect(resolveProjectForWorkdir(db, dir, { createdBy: "system:test" })).toBeNull();
  });
});
