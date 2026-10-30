import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  readFileSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@pi-lead-child/core/testing";
import { createRun } from "../src/runs.js";
import {
  ArtifactIntegrityError,
  commitStagedArtifacts,
  listArtifacts,
  openArtifactContent,
  preflightArtifactRegistrations,
  repairArtifactStorage,
  stageArtifact,
  type ArtifactContent,
  type StagedArtifact,
} from "../src/artifacts.js";
import { insertCheckpoint } from "../src/checkpoints.js";
import { openDb, type Db } from "../src/db.js";
import { createItem } from "../src/items.js";

const MIB = 1024 * 1024;

let dataDir: string;
let workdir: string;
let db: Db;
let itemId: number;
let runId: number;
let checkpointSequence: number;

beforeEach(() => {
  dataDir = tempDir("plc-artifacts-");
  workdir = join(dataDir, "workdir");
  mkdirSync(workdir, { recursive: true });
  db = openDb(join(dataDir, "plc.db"));
  itemId = createItem(db, {
    title: "artifact", brief: "immutable storage", createdBy: "system", workdir,
  });
  runId = createRun(db, { itemId, role: "executor", runtime: "codex" });
  checkpointSequence = 0;
});

function checkpoint(): number {
  checkpointSequence++;
  return insertCheckpoint(db, {
    itemId,
    runId,
    source: "agent_reported",
    kind: "milestone",
    title: `Artifact checkpoint ${checkpointSequence}`,
    summary: `Artifact summary ${checkpointSequence}`,
  }, { dedupeWindowMs: 0 }).id;
}

function artifactInput(
  ref: string,
  relativePath: string | null,
  overrides?: Partial<Parameters<typeof stageArtifact>[1]>,
): Parameters<typeof stageArtifact>[1] {
  return {
    dataDir,
    itemId,
    runId,
    ref,
    name: `${ref.replaceAll("/", "-")}.txt`,
    kind: "report",
    mediaType: "text/plain",
    description: "durable output",
    relativePath,
    ...overrides,
  };
}

async function readContent(content: ArtifactContent): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of content.stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else result.push(path);
    }
  };
  visit(root);
  return result;
}

function writeOldContentAddressedFile(root: string, sha256: string, content: string): string {
  const path = join(root, sha256.slice(0, 2), sha256);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
  return path;
}

describe("immutable artifact storage", () => {
  it("stores byte-identical content, deduplicates SHA blobs, and exposes only safe public metadata", async () => {
    const bytes = Buffer.from("artifact bytes\n", "utf8");
    writeFileSync(join(workdir, "report.txt"), bytes);
    const staged = [
      stageArtifact(db, artifactInput("report/one", "report.txt", { name: "../报告.txt" })),
      stageArtifact(db, artifactInput("report/two", "report.txt", { name: "nested\\报告-copy.txt" })),
    ];
    const artifacts = commitStagedArtifacts(db, checkpoint(), staged);

    expect(artifacts).toHaveLength(2);
    expect(artifacts[0]!.sha256).toBe(artifacts[1]!.sha256);
    const blobFiles = filesUnder(join(dataDir, "artifacts", "blobs"));
    expect(blobFiles).toHaveLength(1);
    expect(statSync(blobFiles[0]!).mode & 0o222).toBe(0);
    const publicJson = JSON.stringify(listArtifacts(db, itemId));
    expect(publicJson).not.toContain("storage_key");
    expect(publicJson).not.toContain("original_filename");
    expect(publicJson).not.toContain(workdir);
    expect(publicJson).not.toContain(dataDir);
    expect(Object.keys(artifacts[0]!).sort()).toEqual([
      "runId", "availability", "byteLength", "checkpointId", "createdAt", "description",
      "id", "kind", "mediaType", "name", "ref", "sha256", "itemId",
    ].sort());

    const content = openArtifactContent(db, dataDir, itemId, artifacts[0]!.id);
    expect(content.filename).not.toMatch(/[\\/\r\n]/);
    expect(content.filename).toContain("报告.txt");
    expect(content.byteLength).toBe(bytes.length);
    expect(content.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readContent(content)).toEqual(bytes);
  });

  it("supports metadata-only legacy-style registrations without inventing downloadable content", () => {
    const staged = stageArtifact(db, artifactInput("legacy/ref", null));
    const [artifact] = commitStagedArtifacts(db, checkpoint(), [staged]);
    expect(artifact).toMatchObject({
      availability: "metadata_only", byteLength: null, sha256: null,
    });
    expect(() => openArtifactContent(db, dataDir, itemId, artifact!.id))
      .toThrow(/unavailable|metadata/i);
  });

  it("rejects absolute, NUL, traversal, escaping symlinks, missing, and non-file sources", () => {
    const outside = join(dataDir, "outside.txt");
    writeFileSync(outside, "outside");
    mkdirSync(join(workdir, "folder"));
    symlinkSync(outside, join(workdir, "final-link"));
    const outsideDir = join(dataDir, "outside-dir");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "secret.txt"), "secret");
    symlinkSync(outsideDir, join(workdir, "intermediate"));

    for (const [label, relativePath] of [
      ["absolute", outside],
      ["NUL", "bad\0path"],
      ["traversal", "../outside.txt"],
      ["dot", "./outside.txt"],
      ["missing", "missing.txt"],
      ["directory", "folder"],
      ["final symlink", "final-link"],
      ["intermediate symlink", "intermediate/secret.txt"],
    ] as const) {
      expect(() => stageArtifact(db, artifactInput(
        `invalid/${label.replaceAll(" ", "-")}`,
        relativePath,
      )))
        .toThrow(/path|file|symlink|inside|regular|missing|absolute|traversal/i);
    }
  });

  it("never ingests outside bytes when the source path is swapped during staging", async () => {
    const source = join(workdir, "swap.bin");
    const outside = join(dataDir, "outside.bin");
    const originalBytes = Buffer.alloc(24 * MIB, 0x61);
    const outsideBytes = Buffer.from("outside-secret");
    writeFileSync(source, originalBytes);
    writeFileSync(outside, outsideBytes);
    const swapper = spawn(process.execPath, [
      "-e",
      `setTimeout(() => { const fs=require('node:fs'); try { fs.unlinkSync(${JSON.stringify(source)}); } catch {} fs.symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(source)}); }, 5)`,
    ]);

    let staged: StagedArtifact | null = null;
    let error: unknown;
    try {
      staged = stageArtifact(db, artifactInput("swap/ref", "swap.bin"));
    } catch (caught) {
      error = caught;
    }
    await new Promise<void>((resolve, reject) => {
      swapper.once("exit", () => resolve());
      swapper.once("error", reject);
    });

    if (staged) {
      expect(staged.sha256).toBe(createHash("sha256").update(originalBytes).digest("hex"));
      expect(staged.sha256).not.toBe(createHash("sha256").update(outsideBytes).digest("hex"));
    } else {
      expect(String(error)).toMatch(/changed|path|symlink|inside|file/i);
    }
  });

  it("rejects a symlinked content-address prefix during ingestion without writing outside", () => {
    const bytes = Buffer.from("symlinked-prefix-ingestion");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(workdir, "symlink-prefix.txt"), bytes);

    const blobsRoot = join(dataDir, "artifacts", "blobs");
    const outsideDir = join(dataDir, "ingestion-outside-prefix");
    const sentinel = join(outsideDir, "sentinel.txt");
    mkdirSync(blobsRoot, { recursive: true });
    mkdirSync(outsideDir);
    writeFileSync(sentinel, "outside-safe");
    symlinkSync(outsideDir, join(blobsRoot, sha256.slice(0, 2)));

    expect(() => stageArtifact(db, artifactInput(
      "ingestion/symlink-prefix",
      "symlink-prefix.txt",
    ))).toThrow(/directory|prefix|symlink|topology/i);
    expect(readFileSync(sentinel, "utf8")).toBe("outside-safe");
    expect(existsSync(join(outsideDir, sha256))).toBe(false);
  });

  it("revalidates a replaced content-address prefix immediately before finalization", () => {
    const bytes = Buffer.from("replacement-race-ingestion");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(workdir, "replace-prefix.txt"), bytes);

    const outsideDir = join(dataDir, "ingestion-race-outside");
    const sentinel = join(outsideDir, "sentinel.txt");
    mkdirSync(outsideDir);
    writeFileSync(sentinel, "outside-safe");
    let replaced = false;

    expect(() => stageArtifact(db, artifactInput(
      "ingestion/replaced-prefix",
      "replace-prefix.txt",
    ), {
      beforeBlobFinalize(context) {
        replaced = true;
        renameSync(context.prefixPath, `${context.prefixPath}-displaced`);
        symlinkSync(outsideDir, context.prefixPath);
      },
    })).toThrow(/directory|prefix|symlink|topology|changed/i);
    expect(replaced).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("outside-safe");
    expect(existsSync(join(outsideDir, sha256))).toBe(false);
  });

  it("revalidates a content-address prefix replaced after parent validation", () => {
    const bytes = Buffer.from("post-validation-replacement-race");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(workdir, "post-validation-prefix.txt"), bytes);

    const outsideDir = join(dataDir, "post-validation-race-outside");
    const sentinel = join(outsideDir, "sentinel.txt");
    mkdirSync(outsideDir);
    writeFileSync(sentinel, "outside-safe");
    let replaced = false;

    expect(() => stageArtifact(db, artifactInput(
      "ingestion/post-validation-prefix",
      "post-validation-prefix.txt",
    ), {
      afterBlobParentValidation(context) {
        replaced = true;
        renameSync(context.prefixPath, `${context.prefixPath}-displaced`);
        symlinkSync(outsideDir, context.prefixPath);
      },
    })).toThrow(/directory|prefix|symlink|topology|changed/i);
    expect(replaced).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("outside-safe");
    expect(existsSync(join(outsideDir, sha256))).toBe(false);
  });

  it("removes a link created outside after the final parent validation race", () => {
    const bytes = Buffer.from("final-link-window-replacement");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(workdir, "final-link-window.txt"), bytes);

    const outsideDir = join(dataDir, "final-link-window-outside");
    const sentinel = join(outsideDir, "sentinel.txt");
    mkdirSync(outsideDir);
    writeFileSync(sentinel, "outside-safe");
    let replaced = false;

    expect(() => stageArtifact(db, artifactInput(
      "ingestion/final-link-window",
      "final-link-window.txt",
    ), {
      beforeBlobLink(context) {
        replaced = true;
        renameSync(context.prefixPath, `${context.prefixPath}-displaced`);
        symlinkSync(outsideDir, context.prefixPath);
      },
    })).toThrow(/directory|prefix|symlink|topology|changed/i);
    expect(replaced).toBe(true);
    expect(readFileSync(sentinel, "utf8")).toBe("outside-safe");
    expect(existsSync(join(outsideDir, sha256))).toBe(false);
  });

  it("enforces the 25 MiB file limit and 20 registrations per checkpoint", () => {
    const oversized = join(workdir, "oversized.bin");
    writeFileSync(oversized, "x");
    truncateSync(oversized, 25 * MIB + 1);
    expect(() => preflightArtifactRegistrations(db, [
      artifactInput("oversized", "oversized.bin"),
    ]))
      .toThrow(/25|size|bytes|quota/i);

    writeFileSync(join(workdir, "small.txt"), "same bytes");
    const registrations = Array.from({ length: 21 }, (_, index) =>
      artifactInput(`many/${index}`, "small.txt"));
    expect(() => preflightArtifactRegistrations(db, registrations)).toThrow(/20|quota/i);
    expect(filesUnder(join(dataDir, "artifacts", "blobs"))).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 0 });
  });

  it("preflights the complete set for duplicate refs before creating managed blobs", () => {
    writeFileSync(join(workdir, "one.txt"), "one");
    writeFileSync(join(workdir, "two.txt"), "two");
    expect(() => preflightArtifactRegistrations(db, [
      artifactInput("duplicate/ref", "one.txt"),
      artifactInput("duplicate/ref", "two.txt"),
    ])).toThrow(/duplicate|ref/i);
    expect(filesUnder(join(dataDir, "artifacts", "blobs"))).toEqual([]);
  });

  it("prechecks the 200-ref and 250 MiB distinct-SHA item quotas", () => {
    const checkpointId = checkpoint();
    const insert = db.prepare(
      `INSERT INTO artifacts (
         item_id, run_id, checkpoint_id, ref, name, kind, media_type,
         sha256, byte_length, storage_key, availability
       ) VALUES (?, ?, ?, ?, ?, 'report', 'application/octet-stream', ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 200; index++) {
      insert.run(
        itemId, runId, checkpointId, `existing/${index}`, `Existing ${index}`,
        null, null, null, "metadata_only",
      );
    }
    expect(() => preflightArtifactRegistrations(db, [artifactInput("overflow/ref", null)]))
      .toThrow(/200|quota/i);

    const secondItem = createItem(db, {
      title: "byte quota", brief: "distinct sha", createdBy: "system", workdir,
    });
    const secondRun = createRun(db, { itemId: secondItem });
    const secondCheckpoint = insertCheckpoint(db, {
      itemId: secondItem,
      runId: secondRun,
      source: "agent_reported",
      kind: "milestone",
      title: "Quota seed",
      summary: "Quota seed",
    }).id;
    for (let index = 0; index < 10; index++) {
      const sha = index.toString(16).padStart(64, "0");
      insert.run(
        secondItem, secondRun, secondCheckpoint, `sha/${index}`, `SHA ${index}`,
        sha, 25 * MIB, `artifacts/blobs/${sha.slice(0, 2)}/${sha}`, "available",
      );
    }
    writeFileSync(join(workdir, "extra.txt"), "extra");
    expect(() => preflightArtifactRegistrations(db, [artifactInput("extra", "extra.txt", {
      itemId: secondItem, runId: secondRun,
    })])).toThrow(/250|quota|bytes/i);
  });

  it("rechecks item quotas inside commit after staging", () => {
    writeFileSync(join(workdir, "staged.txt"), "staged before concurrent refs");
    const staged = stageArtifact(db, artifactInput("staged/ref", "staged.txt"));
    const checkpointId = checkpoint();
    const insert = db.prepare(
      `INSERT INTO artifacts (
         item_id, run_id, checkpoint_id, ref, name, kind, media_type, availability
       ) VALUES (?, ?, ?, ?, ?, 'reference', 'application/octet-stream', 'metadata_only')`,
    );
    for (let index = 0; index < 200; index++) {
      insert.run(itemId, runId, checkpointId, `concurrent/${index}`, `Concurrent ${index}`);
    }

    expect(() => commitStagedArtifacts(db, checkpoint(), [staged])).toThrow(/200|quota/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE ref='staged/ref'").get())
      .toEqual({ n: 0 });
  });

  it("verifies an existing content-addressed target and quarantines collisions", () => {
    writeFileSync(join(workdir, "collision.txt"), "aaaaaaaa");
    const artifacts = commitStagedArtifacts(db, checkpoint(), [
      stageArtifact(db, artifactInput("collision/first", "collision.txt")),
      stageArtifact(db, artifactInput("collision/shared", "collision.txt")),
    ]);
    const row = db.prepare("SELECT storage_key FROM artifacts WHERE id=?").get(artifacts[0]!.id) as {
      storage_key: string;
    };
    const auditBefore = db.prepare(
      "SELECT id, sha256, byte_length FROM artifacts WHERE storage_key=? ORDER BY id",
    ).all(row.storage_key);
    const blobPath = join(dataDir, row.storage_key);
    unlinkSync(blobPath);
    writeFileSync(blobPath, "bbbbbbbb");

    let collisionError: unknown;
    try {
      stageArtifact(db, artifactInput("collision/second", "collision.txt"));
    } catch (error) {
      collisionError = error;
    }
    expect(collisionError).toBeInstanceOf(ArtifactIntegrityError);
    expect(String(collisionError)).toMatch(/collision|hash|sha|quarantine/i);
    expect(existsSync(blobPath)).toBe(false);
    expect(filesUnder(join(dataDir, "artifacts", "quarantine")).length).toBeGreaterThan(0);
    expect(db.prepare(
      "SELECT id, sha256, byte_length, availability, storage_key FROM artifacts ORDER BY id",
    ).all()).toEqual(auditBefore.map((artifact: any) => ({
      ...artifact,
      availability: "unavailable",
      storage_key: null,
    })));
  });

  it("rejects conflicting refs and leaves transaction failures as grace-period repairable orphans", () => {
    writeFileSync(join(workdir, "first.txt"), "first");
    commitStagedArtifacts(db, checkpoint(), [
      stageArtifact(db, artifactInput("stable/ref", "first.txt")),
    ]);
    writeFileSync(join(workdir, "second.txt"), "second");
    const blobsBeforeConflict = filesUnder(join(dataDir, "artifacts", "blobs"));
    expect(() => preflightArtifactRegistrations(db, [
      artifactInput("stable/ref", "second.txt"),
    ])).toThrow(/ref|conflict|registered/i);
    expect(filesUnder(join(dataDir, "artifacts", "blobs"))).toEqual(blobsBeforeConflict);
    const conflict = stageArtifact(db, artifactInput("stable/ref", "second.txt"));
    expect(() => commitStagedArtifacts(db, checkpoint(), [conflict])).toThrow(/ref|conflict|registered/i);

    writeFileSync(join(workdir, "orphan.txt"), "orphan");
    const orphan = stageArtifact(db, artifactInput("orphan/ref", "orphan.txt"));
    const orphanPath = join(dataDir, orphan.storageKey!);
    db.exec(`
      CREATE TRIGGER fail_artifact_commit
      BEFORE INSERT ON artifacts
      WHEN NEW.ref = 'orphan/ref'
      BEGIN
        SELECT RAISE(FAIL, 'artifact metadata unavailable');
      END;
    `);
    expect(() => commitStagedArtifacts(db, checkpoint(), [orphan]))
      .toThrow(/artifact metadata unavailable/i);
    expect(existsSync(orphanPath)).toBe(true);
    const old = new Date("2026-07-25T01:00:00.000Z");
    utimesSync(orphanPath, old, old);
    expect(repairArtifactStorage(
      db, dataDir, new Date("2026-07-25T01:00:00.500Z"), 1_000,
    ).orphansRemoved).toBe(0);
    expect(repairArtifactStorage(
      db, dataDir, new Date("2026-07-25T01:00:02.000Z"), 1_000,
    ).orphansRemoved).toBe(1);
    expect(existsSync(orphanPath)).toBe(false);
  });

  it("downgrades corrupt available blobs while retaining expected SHA and byte length for audit", () => {
    writeFileSync(join(workdir, "corrupt.txt"), "expected");
    const [artifact] = commitStagedArtifacts(db, checkpoint(), [
      stageArtifact(db, artifactInput("corrupt/ref", "corrupt.txt")),
    ]);
    const row = db.prepare("SELECT storage_key FROM artifacts WHERE id=?").get(artifact!.id) as {
      storage_key: string;
    };
    const blobPath = join(dataDir, row.storage_key);
    unlinkSync(blobPath);
    writeFileSync(blobPath, "tampered");

    const result = repairArtifactStorage(db, dataDir, new Date(), 1_000);
    expect(result.artifactsDowngraded).toBe(1);
    expect(listArtifacts(db, itemId)).toEqual([
      expect.objectContaining({
        id: artifact!.id,
        availability: "unavailable",
        sha256: artifact!.sha256,
        byteLength: artifact!.byteLength,
      }),
    ]);
    expect(db.prepare("SELECT storage_key FROM artifacts WHERE id=?").get(artifact!.id))
      .toEqual({ storage_key: null });
    expect(() => openArtifactContent(db, dataDir, itemId, artifact!.id))
      .toThrow(/unavailable|corrupt/i);
  });

  it("rejects a symlinked blobs root without touching outside files", () => {
    const outsideRoot = join(dataDir, "outside-root");
    const sha256 = "a".repeat(64);
    const outsideFile = writeOldContentAddressedFile(outsideRoot, sha256, "outside-root-data");
    const artifactsDir = join(dataDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    symlinkSync(outsideRoot, join(artifactsDir, "blobs"));

    expect(() => repairArtifactStorage(db, dataDir, new Date(), 1_000))
      .toThrow(ArtifactIntegrityError);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside-root-data");
  });

  it("rejects symlinked content-address prefix directories without recursing outside", () => {
    const blobsRoot = join(dataDir, "artifacts", "blobs");
    const sha256 = `ab${"c".repeat(62)}`;
    const outsideFile = writeOldContentAddressedFile(dataDir, sha256, "outside-prefix-data");
    mkdirSync(blobsRoot, { recursive: true });
    symlinkSync(dirname(outsideFile), join(blobsRoot, sha256.slice(0, 2)));

    expect(() => repairArtifactStorage(db, dataDir, new Date(), 1_000))
      .toThrow(ArtifactIntegrityError);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside-prefix-data");
  });

  it("revalidates orphan topology after an injected replacement race and leaves outside files untouched", () => {
    writeFileSync(join(workdir, "race-orphan.txt"), "managed orphan");
    const orphan = stageArtifact(db, artifactInput("race/orphan", "race-orphan.txt"));
    const orphanPath = join(dataDir, orphan.storageKey!);
    const old = new Date(Date.now() - 60_000);
    utimesSync(orphanPath, old, old);

    const sha256 = orphan.sha256!;
    const outsideRoot = join(dataDir, "race-outside");
    const outsideFile = writeOldContentAddressedFile(outsideRoot, sha256, "outside-race-data");
    let replaced = false;
    expect(() => repairArtifactStorage(db, dataDir, new Date(), 1_000, {
      beforeOrphanDelete(candidate) {
        if (replaced) return;
        replaced = true;
        const prefix = dirname(candidate.path);
        renameSync(prefix, `${prefix}-displaced`);
        symlinkSync(dirname(outsideFile), prefix);
      },
    })).toThrow(ArtifactIntegrityError);
    expect(replaced).toBe(true);
    expect(readFileSync(outsideFile, "utf8")).toBe("outside-race-data");
  });

  it("rechecks an orphan storage key transactionally after a concurrent reference is inserted", () => {
    writeFileSync(join(workdir, "concurrent-orphan.txt"), "concurrent orphan");
    const orphan = stageArtifact(db, artifactInput(
      "orphan/concurrent-reference",
      "concurrent-orphan.txt",
    ));
    const orphanPath = join(dataDir, orphan.storageKey!);
    const checkpointId = checkpoint();
    const old = new Date(Date.now() - 60_000);
    utimesSync(orphanPath, old, old);
    let inserted = false;

    const result = repairArtifactStorage(db, dataDir, new Date(), 1_000, {
      beforeOrphanDelete(candidate) {
        if (inserted) return;
        inserted = true;
        const concurrentDb = openDb(join(dataDir, "plc.db"));
        try {
          commitStagedArtifacts(concurrentDb, checkpointId, [orphan]);
        } finally {
          concurrentDb.close();
        }
        expect(candidate.storageKey).toBe(orphan.storageKey);
      },
    });

    expect(inserted).toBe(true);
    expect(result.orphansRemoved).toBe(0);
    expect(existsSync(orphanPath)).toBe(true);
    expect(db.prepare("SELECT availability, storage_key FROM artifacts WHERE ref=?")
      .get(orphan.ref)).toEqual({
      availability: "available",
      storage_key: orphan.storageKey,
    });
  });

  it("ignores old files outside the exact content-addressed layout", () => {
    const malformed = join(dataDir, "artifacts", "blobs", "zz", "not-a-sha");
    mkdirSync(dirname(malformed), { recursive: true });
    writeFileSync(malformed, "keep malformed");
    const old = new Date(Date.now() - 60_000);
    utimesSync(malformed, old, old);

    expect(repairArtifactStorage(db, dataDir, new Date(), 1_000).orphansRemoved).toBe(0);
    expect(readFileSync(malformed, "utf8")).toBe("keep malformed");
  });

  it("propagates transient verification errors and rolls back deterministic downgrades", () => {
    writeFileSync(join(workdir, "deterministic.txt"), "deterministic");
    writeFileSync(join(workdir, "transient.txt"), "transient");
    const [deterministic, transient] = commitStagedArtifacts(db, checkpoint(), [
      stageArtifact(db, artifactInput("repair/deterministic", "deterministic.txt")),
      stageArtifact(db, artifactInput("repair/transient", "transient.txt")),
    ]);
    const deterministicRow = db.prepare("SELECT storage_key FROM artifacts WHERE id=?")
      .get(deterministic!.id) as { storage_key: string };
    unlinkSync(join(dataDir, deterministicRow.storage_key));
    writeFileSync(join(dataDir, deterministicRow.storage_key), "corrupt-bytes");
    const transientError = Object.assign(new Error("transient EACCES"), { code: "EACCES" });

    let caught: unknown;
    try {
      repairArtifactStorage(db, dataDir, new Date(), 1_000, {
        beforeVerifyArtifact(context) {
          if (context.artifactId === transient!.id) throw transientError;
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(transientError);
    expect(db.prepare(
      "SELECT id, availability, storage_key FROM artifacts ORDER BY id",
    ).all()).toEqual([
      { id: deterministic!.id, availability: "available", storage_key: deterministicRow.storage_key },
      {
        id: transient!.id,
        availability: "available",
        storage_key: expect.any(String),
      },
    ]);
  });

  it("normalizes valid MIME type/subtype values before persistence and open", async () => {
    writeFileSync(join(workdir, "mime.txt"), "mime-safe");
    for (const mediaType of [
      "text/plain",
      "application/octet-stream",
      "application/vnd.api+json",
      "image/svg+xml",
    ]) {
      expect(() => preflightArtifactRegistrations(db, [
        artifactInput(`mime/${mediaType.replace(/[^A-Za-z0-9._-]/g, "-")}`, "mime.txt", {
          mediaType,
        }),
      ])).not.toThrow();
    }

    const [artifact] = commitStagedArtifacts(db, checkpoint(), [
      stageArtifact(db, artifactInput("mime/normalized", "mime.txt", {
        mediaType: "  Text/Plain  ",
      })),
    ]);
    expect(artifact!.mediaType).toBe("text/plain");
    const content = openArtifactContent(db, dataDir, itemId, artifact!.id);
    expect(content.mediaType).toBe("text/plain");
    expect(await readContent(content)).toEqual(Buffer.from("mime-safe"));
  });

  it("rejects malicious or invalid media types before persistence and fails closed when stored metadata is unsafe", () => {
    writeFileSync(join(workdir, "unsafe-mime.txt"), "unsafe mime");
    for (const mediaType of [
      "text/plain\r\nX-Evil: injected",
      "text/\u0000plain",
      "text",
      "text/ plain",
      "/plain",
      "text/plain; charset=utf-8",
    ]) {
      expect(() => preflightArtifactRegistrations(db, [
        artifactInput("mime/unsafe", "unsafe-mime.txt", { mediaType }),
      ])).toThrow(/media type|mime|control|syntax/i);
      expect(() => stageArtifact(db, artifactInput("mime/unsafe", "unsafe-mime.txt", {
        mediaType,
      }))).toThrow(/media type|mime|control|syntax/i);
    }

    const [artifact] = commitStagedArtifacts(db, checkpoint(), [
      stageArtifact(db, artifactInput("mime/tampered", "unsafe-mime.txt")),
    ]);
    db.prepare("UPDATE artifacts SET media_type=? WHERE id=?")
      .run("text/plain\r\nX-Evil: injected", artifact!.id);
    expect(() => openArtifactContent(db, dataDir, itemId, artifact!.id))
      .toThrow(/media type|mime|control|syntax/i);
  });
});
