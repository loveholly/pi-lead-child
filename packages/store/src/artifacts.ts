import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ReadStream } from "node:fs";
import type { Db } from "./db.js";
import { repairItemProofMaterialization } from "./checkpoints.js";
import type { Artifact, ArtifactAvailability } from "@pi-lead-child/core";

const MAX_ARTIFACTS_PER_CHECKPOINT = 20;
const MAX_ARTIFACTS_PER_ITEM = 200;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_ITEM_ARTIFACT_BYTES = 250 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SECRET_PATTERN = /(?:\b(?:[a-z0-9_-]*token|api[_-]?key|secret|password|passwd)\b\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{8,})/i;
const MIME_TOKEN_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export interface StageArtifactInput {
  dataDir: string;
  itemId: number;
  runId: number | null;
  ref: string;
  name: string;
  kind: string;
  mediaType: string;
  description: string | null;
  relativePath: string | null;
}

export type ArtifactRegistrationSet = readonly StageArtifactInput[];

export interface StagedArtifact {
  itemId: number;
  runId: number | null;
  ref: string;
  name: string;
  kind: string;
  mediaType: string;
  description: string | null;
  originalFilename: string | null;
  sha256: string | null;
  byteLength: number | null;
  storageKey: string | null;
  availability: "available" | "metadata_only";
  verifyStorage(): void;
  cleanup(): void;
}

export interface ArtifactContent {
  artifactId: number;
  filename: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  stream: ReadStream;
}

export type ArtifactIntegrityCode =
  | "missing"
  | "metadata"
  | "path"
  | "type"
  | "length"
  | "sha256"
  | "topology"
  | "collision";

export class ArtifactIntegrityError extends Error {
  readonly code: ArtifactIntegrityCode;

  constructor(code: ArtifactIntegrityCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactIntegrityError";
    this.code = code;
  }
}

export interface ArtifactRepairOptions {
  beforeVerifyArtifact?: (context: {
    artifactId: number;
    storageKey: string;
  }) => void;
  beforeOrphanDelete?: (candidate: {
    path: string;
    storageKey: string;
    sha256: string;
  }) => void;
}

export interface ArtifactStageOptions {
  beforeBlobFinalize?: (context: {
    prefixPath: string;
    storageKey: string;
    sha256: string;
  }) => void;
  afterBlobParentValidation?: (context: {
    prefixPath: string;
    storageKey: string;
    sha256: string;
  }) => void;
  beforeBlobLink?: (context: {
    prefixPath: string;
    storageKey: string;
    sha256: string;
  }) => void;
}

export interface RepairResult {
  proofItemsRepaired: number;
  artifactsDowngraded: number;
  orphansRemoved: number;
}

interface ArtifactRow {
  id: number;
  item_id: number;
  run_id: number | null;
  checkpoint_id: number;
  ref: string;
  name: string;
  kind: string;
  media_type: string;
  description: string | null;
  original_filename: string | null;
  sha256: string | null;
  byte_length: number | null;
  storage_key: string | null;
  availability: ArtifactAvailability;
  created_at: string;
}

interface OpenArtifactSource {
  fd: number;
  canonicalPath: string;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface InspectedArtifactRegistration {
  input: StageArtifactInput;
  originalFilename: string | null;
  sha256: string | null;
  byteLength: number | null;
  availability: "available" | "metadata_only";
}

interface ValidatedDirectory {
  path: string;
  canonicalPath: string;
  dev: number;
  ino: number;
}

interface ManagedArtifactRoots {
  dataDir: ValidatedDirectory;
  artifacts: ValidatedDirectory;
  blobs: ValidatedDirectory;
}

interface OrphanCandidate {
  path: string;
  canonicalPath: string;
  storageKey: string;
  sha256: string;
  parent: ValidatedDirectory;
  dev: number;
  ino: number;
}

function charLength(value: string): number {
  return Array.from(value).length;
}

function boundedString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  const length = charLength(normalized);
  if (length < min || length > max) {
    throw new Error(`${field} must contain ${min}-${max} characters`);
  }
  if (SECRET_PATTERN.test(normalized)) {
    throw new Error(`${field} appears to contain secret-bearing data`);
  }
  return normalized;
}

function normalizeMediaType(value: unknown): string {
  if (typeof value !== "string") throw new Error("artifact media type must be a string");
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("artifact media type contains control characters");
  }
  const normalized = boundedString(value, "artifact media type", 1, 120);
  const parts = normalized.split("/");
  if (parts.length !== 2
    || !MIME_TOKEN_PATTERN.test(parts[0]!)
    || !MIME_TOKEN_PATTERN.test(parts[1]!)) {
    throw new Error("artifact media type must use valid MIME type/subtype syntax");
  }
  return normalized.toLowerCase();
}

function normalizeStageInput(input: StageArtifactInput): StageArtifactInput {
  if (!Number.isSafeInteger(input.itemId) || input.itemId < 1) {
    throw new Error("itemId must be a positive safe integer");
  }
  if (input.runId !== null && (!Number.isSafeInteger(input.runId) || input.runId < 1)) {
    throw new Error("runId must be a positive safe integer or null");
  }
  const ref = boundedString(input.ref, "artifact ref", 1, 160);
  if (!/^[A-Za-z0-9._:/-]+$/.test(ref)) throw new Error("artifact ref contains invalid characters");
  const description = input.description === null
    ? null
    : boundedString(input.description, "artifact description", 1, 1_000);
  if (input.relativePath !== null) {
    if (typeof input.relativePath !== "string" || input.relativePath.length < 1
      || input.relativePath.length > 4_096) {
      throw new Error("artifact relative path must contain 1-4096 characters");
    }
  }
  return {
    ...input,
    ref,
    name: boundedString(input.name, "artifact name", 1, 180),
    kind: boundedString(input.kind, "artifact kind", 1, 120),
    mediaType: normalizeMediaType(input.mediaType),
    description,
  };
}

function storageKeyForSha(sha256: string): string {
  return ["artifacts", "blobs", sha256.slice(0, 2), sha256].join("/");
}

function keyPath(dataDir: string, storageKey: string): string {
  return join(dataDir, ...storageKey.split("/"));
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function fsErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function throwIntegrityFsError(
  error: unknown,
  code: ArtifactIntegrityCode,
  message: string,
  allowedCodes: readonly string[],
): never {
  if (allowedCodes.includes(fsErrorCode(error) ?? "")) {
    throw new ArtifactIntegrityError(code, message, { cause: error });
  }
  throw error;
}

function validateRealDirectory(
  path: string,
  label: string,
  options?: {
    parent?: ValidatedDirectory;
    expected?: ValidatedDirectory;
    allowMissing?: boolean;
  },
): ValidatedDirectory | null {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (options?.allowMissing && fsErrorCode(error) === "ENOENT") return null;
    throwIntegrityFsError(error, "topology", `${label} topology changed`, [
      "ENOENT", "ENOTDIR", "ELOOP",
    ]);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ArtifactIntegrityError("topology", `${label} must be a real non-symlink directory`);
  }
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
  } catch (error) {
    throwIntegrityFsError(error, "topology", `${label} topology changed`, [
      "ENOENT", "ENOTDIR", "ELOOP",
    ]);
  }
  if (options?.parent && !isContained(options.parent.canonicalPath, canonicalPath)) {
    throw new ArtifactIntegrityError("path", `${label} escaped its canonical parent`);
  }
  let canonicalEntry;
  try {
    canonicalEntry = statSync(canonicalPath);
  } catch (error) {
    throwIntegrityFsError(error, "topology", `${label} topology changed`, [
      "ENOENT", "ENOTDIR", "ELOOP",
    ]);
  }
  if (canonicalEntry.dev !== entry.dev || canonicalEntry.ino !== entry.ino) {
    throw new ArtifactIntegrityError("topology", `${label} topology changed`);
  }
  if (options?.expected
    && (options.expected.canonicalPath !== canonicalPath
      || options.expected.dev !== entry.dev
      || options.expected.ino !== entry.ino)) {
    throw new ArtifactIntegrityError("topology", `${label} topology changed`);
  }
  return { path, canonicalPath, dev: entry.dev, ino: entry.ino };
}

function revalidateDirectory(directory: ValidatedDirectory, label: string): ValidatedDirectory {
  return validateRealDirectory(directory.path, label, { expected: directory })!;
}

function ensureChildDirectory(
  parent: ValidatedDirectory,
  name: string,
  label: string,
): ValidatedDirectory {
  revalidateDirectory(parent, `${label} parent`);
  const path = join(parent.path, name);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (fsErrorCode(error) !== "EEXIST") {
      throwIntegrityFsError(error, "topology", `${label} could not be created safely`, [
        "ENOENT", "ENOTDIR", "ELOOP",
      ]);
    }
  }
  const currentParent = revalidateDirectory(parent, `${label} parent`);
  return validateRealDirectory(path, label, { parent: currentParent })!;
}

function establishManagedArtifactRoots(dataDir: string): ManagedArtifactRoots {
  const validatedDataDir = validateRealDirectory(dataDir, "artifact data directory")!;
  const artifacts = ensureChildDirectory(
    validatedDataDir,
    "artifacts",
    "managed artifact root",
  );
  const blobs = ensureChildDirectory(artifacts, "blobs", "managed artifact blobs root");
  return { dataDir: validatedDataDir, artifacts, blobs };
}

function revalidateManagedArtifactRoots(roots: ManagedArtifactRoots): ManagedArtifactRoots {
  const dataDir = validateRealDirectory(roots.dataDir.path, "artifact data directory", {
    expected: roots.dataDir,
  })!;
  const artifacts = validateRealDirectory(roots.artifacts.path, "managed artifact root", {
    parent: dataDir,
    expected: roots.artifacts,
  })!;
  const blobs = validateRealDirectory(roots.blobs.path, "managed artifact blobs root", {
    parent: artifacts,
    expected: roots.blobs,
  })!;
  return { dataDir, artifacts, blobs };
}

function validateManagedBlobsRoot(
  dataDir: string,
  options?: { allowMissing?: boolean },
): ValidatedDirectory | null {
  const validatedDataDir = validateRealDirectory(dataDir, "artifact data directory")!;
  const artifacts = validateRealDirectory(
    join(dataDir, "artifacts"),
    "managed artifact root",
    { parent: validatedDataDir, allowMissing: options?.allowMissing },
  );
  if (!artifacts) return null;
  return validateRealDirectory(
    join(artifacts.path, "blobs"),
    "managed artifact blobs root",
    { parent: artifacts, allowMissing: options?.allowMissing },
  );
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (fsErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function validateRelativePath(path: string): void {
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new Error("artifact path contains control characters");
  if (isAbsolute(path) || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    throw new Error("artifact path must be relative");
  }
  if (path.split(/[\\/]/).some((segment) => segment === "." || segment === "..")) {
    throw new Error("artifact path traversal is not allowed");
  }
}

function openCanonicalSource(workdir: string, relativePath: string): OpenArtifactSource {
  validateRelativePath(relativePath);
  let canonicalWorkdir: string;
  let canonicalPath: string;
  try {
    canonicalWorkdir = realpathSync(workdir);
    canonicalPath = realpathSync(resolve(canonicalWorkdir, relativePath));
  } catch (error) {
    throw new Error("artifact source file is missing or its path is invalid", { cause: error });
  }
  if (!isContained(canonicalWorkdir, canonicalPath)) {
    throw new Error("artifact source must remain inside the item workdir");
  }
  let fd: number;
  try {
    fd = openSync(canonicalPath, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    throw new Error("artifact source could not be opened without following symlinks", { cause: error });
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error("artifact source must be a regular file");
    if (opened.size > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact file exceeds the ${MAX_ARTIFACT_BYTES} byte quota`);
    }
    const afterOpenPath = realpathSync(canonicalPath);
    if (!isContained(canonicalWorkdir, afterOpenPath)) {
      throw new Error("artifact source escaped the item workdir during open");
    }
    const afterOpen = statSync(afterOpenPath);
    if (afterOpen.dev !== opened.dev || afterOpen.ino !== opened.ino) {
      throw new Error("artifact source changed during open");
    }
    return {
      fd,
      canonicalPath: afterOpenPath,
      size: opened.size,
      dev: opened.dev,
      ino: opened.ino,
      mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertSourceUnchanged(source: OpenArtifactSource, byteLength: number): void {
  const afterRead = fstatSync(source.fd);
  if (!afterRead.isFile()
    || afterRead.dev !== source.dev
    || afterRead.ino !== source.ino
    || afterRead.size !== source.size
    || afterRead.mtimeMs !== source.mtimeMs
    || afterRead.ctimeMs !== source.ctimeMs
    || byteLength !== source.size) {
    throw new Error("artifact source changed while it was being inspected");
  }
}

function hashDescriptor(fd: number, expectedSize: number): { sha256: string; byteLength: number } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (position < expectedSize) {
    const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, expectedSize - position), position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return { sha256: hash.digest("hex"), byteLength: position };
}

function copyDescriptorToFile(
  sourceFd: number,
  expectedSize: number,
  targetPath: string,
): { sha256: string; byteLength: number } {
  const targetFd = openSync(
    targetPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  try {
    while (position < expectedSize) {
      const bytesRead = readSync(
        sourceFd,
        buffer,
        0,
        Math.min(buffer.length, expectedSize - position),
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(targetFd, buffer, written, bytesRead - written);
      }
      position += bytesRead;
    }
    fchmodSync(targetFd, 0o400);
    fsyncSync(targetFd);
  } finally {
    closeSync(targetFd);
  }
  return { sha256: hash.digest("hex"), byteLength: position };
}

function openVerifiedFile(path: string, sha256: string, byteLength: number): number {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throwIntegrityFsError(error, "missing", "managed artifact content is missing", [
      "ENOENT", "ENOTDIR",
    ]);
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new ArtifactIntegrityError("type", "managed artifact is not a regular file");
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    throwIntegrityFsError(error, "type", "managed artifact could not be opened safely", [
      "ENOENT", "ENOTDIR", "ELOOP",
    ]);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== byteLength) {
      throw new ArtifactIntegrityError(
        "length",
        "managed artifact byte length does not match metadata",
      );
    }
    const actual = hashDescriptor(fd, byteLength);
    if (actual.byteLength !== byteLength || actual.sha256 !== sha256) {
      throw new ArtifactIntegrityError("sha256", "managed artifact SHA does not match metadata");
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function verifyManagedBlob(dataDir: string, storageKey: string, sha256: string, byteLength: number): void {
  if (storageKey !== storageKeyForSha(sha256)) {
    throw new ArtifactIntegrityError("metadata", "managed artifact storage key is invalid");
  }
  const root = validateManagedBlobsRoot(dataDir);
  const path = keyPath(dataDir, storageKey);
  const parent = validateDirectoryUnderRoot(dirname(path), root!);
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
  } catch (error) {
    throwIntegrityFsError(error, "missing", "managed artifact content is missing", [
      "ENOENT", "ENOTDIR", "ELOOP",
    ]);
  }
  if (!isContained(parent.canonicalPath, canonicalPath)
    || !isContained(root!.canonicalPath, canonicalPath)) {
    throw new ArtifactIntegrityError("path", "managed artifact escaped storage root");
  }
  const fd = openVerifiedFile(path, sha256, byteLength);
  try {
    let afterOpenPath: string;
    try {
      afterOpenPath = realpathSync(path);
    } catch (error) {
      throwIntegrityFsError(error, "topology", "managed artifact changed during verification", [
        "ENOENT", "ENOTDIR", "ELOOP",
      ]);
    }
    const opened = fstatSync(fd);
    const current = statSync(afterOpenPath);
    if (!isContained(root!.canonicalPath, afterOpenPath)
      || opened.dev !== current.dev
      || opened.ino !== current.ino) {
      throw new ArtifactIntegrityError("topology", "managed artifact changed during verification");
    }
    fchmodSync(fd, 0o400);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function itemArtifactCount(db: Db, itemId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE item_id=?")
    .get(itemId) as { n: number }).n;
}

function itemDistinctBytes(db: Db, itemId: number): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(byte_length), 0) AS bytes
     FROM (
       SELECT sha256, MAX(byte_length) AS byte_length
       FROM artifacts
       WHERE item_id=? AND availability='available'
       GROUP BY sha256
     )`,
  ).get(itemId) as { bytes: number }).bytes;
}

function itemHasSha(db: Db, itemId: number, sha256: string): boolean {
  return !!db.prepare(
    "SELECT 1 FROM artifacts WHERE item_id=? AND availability='available' AND sha256=? LIMIT 1",
  ).get(itemId, sha256);
}

function validateStageRelations(
  db: Db,
  input: StageArtifactInput,
  options?: { skipRefQuota?: boolean },
): { workdir: string | null } {
  const item = db.prepare("SELECT workdir FROM items WHERE id=?").get(input.itemId) as
    { workdir: string | null } | undefined;
  if (!item) throw new Error(`item ${input.itemId} not found`);
  if (input.runId !== null) {
    const run = db.prepare("SELECT item_id FROM runs WHERE id=?").get(input.runId) as
      { item_id: number } | undefined;
    if (!run) throw new Error(`run ${input.runId} not found`);
    if (run.item_id !== input.itemId) {
      throw new Error(`run ${input.runId} does not belong to item ${input.itemId}`);
    }
  }
  const existingRef = db.prepare("SELECT 1 FROM artifacts WHERE item_id=? AND ref=?")
    .get(input.itemId, input.ref);
  if (!options?.skipRefQuota
    && !existingRef
    && itemArtifactCount(db, input.itemId) >= MAX_ARTIFACTS_PER_ITEM) {
    throw new Error(`item artifact quota exceeds ${MAX_ARTIFACTS_PER_ITEM} refs`);
  }
  return item;
}

function inspectArtifactRegistration(
  input: StageArtifactInput,
  workdir: string | null,
): InspectedArtifactRegistration {
  if (input.relativePath === null) {
    return {
      input,
      originalFilename: null,
      sha256: null,
      byteLength: null,
      availability: "metadata_only",
    };
  }
  if (!workdir) throw new Error(`item ${input.itemId} has no artifact workdir`);
  const source = openCanonicalSource(workdir, input.relativePath);
  try {
    const inspected = hashDescriptor(source.fd, source.size);
    assertSourceUnchanged(source, inspected.byteLength);
    return {
      input,
      originalFilename: basename(source.canonicalPath),
      sha256: inspected.sha256,
      byteLength: inspected.byteLength,
      availability: "available",
    };
  } finally {
    closeSync(source.fd);
  }
}

function inspectedMatchesExisting(
  existing: ArtifactRow,
  inspected: InspectedArtifactRegistration,
): boolean {
  return existing.item_id === inspected.input.itemId
    && existing.run_id === inspected.input.runId
    && existing.ref === inspected.input.ref
    && existing.name === inspected.input.name
    && existing.kind === inspected.input.kind
    && normalizeMediaType(existing.media_type) === inspected.input.mediaType
    && existing.description === inspected.input.description
    && existing.original_filename === inspected.originalFilename
    && existing.sha256 === inspected.sha256
    && existing.byte_length === inspected.byteLength
    && existing.availability === inspected.availability;
}

export function preflightArtifactRegistrations(
  db: Db,
  registrations: ArtifactRegistrationSet,
): void {
  if (!Array.isArray(registrations)) throw new Error("artifact registrations must be an array");
  if (registrations.length > MAX_ARTIFACTS_PER_CHECKPOINT) {
    throw new Error(`checkpoint artifact quota exceeds ${MAX_ARTIFACTS_PER_CHECKPOINT} registrations`);
  }
  if (registrations.length === 0) return;

  const normalized = registrations.map(normalizeStageInput);
  const first = normalized[0]!;
  const refs = new Set<string>();
  for (const input of normalized) {
    if (input.itemId !== first.itemId
      || input.runId !== first.runId
      || resolve(input.dataDir) !== resolve(first.dataDir)) {
      throw new Error("artifact registrations must share one item, run, and data directory");
    }
    if (refs.has(input.ref)) throw new Error(`duplicate artifact ref '${input.ref}' in checkpoint`);
    refs.add(input.ref);
  }

  const item = validateStageRelations(db, first, { skipRefQuota: true });
  const existingRows = artifactRows(db, first.itemId);
  const existingByRef = new Map(existingRows.map((row) => [row.ref, row]));
  const newRefCount = normalized.filter((input) => !existingByRef.has(input.ref)).length;
  if (existingRows.length + newRefCount > MAX_ARTIFACTS_PER_ITEM) {
    throw new Error(`item artifact quota exceeds ${MAX_ARTIFACTS_PER_ITEM} refs`);
  }

  const inspected = normalized.map((input) => inspectArtifactRegistration(input, item.workdir));
  for (const item of inspected) {
    const existing = existingByRef.get(item.input.ref);
    if (existing && !inspectedMatchesExisting(existing, item)) {
      throw new Error(`artifact ref '${item.input.ref}' is already registered with different content`);
    }
  }

  const existingShas = new Set(
    existingRows.filter((row) => row.availability === "available" && row.sha256)
      .map((row) => row.sha256!),
  );
  const addedShas = new Set<string>();
  let totalBytes = itemDistinctBytes(db, first.itemId);
  for (const item of inspected) {
    if (existingByRef.has(item.input.ref)
      || item.availability !== "available"
      || !item.sha256
      || item.byteLength === null
      || existingShas.has(item.sha256)
      || addedShas.has(item.sha256)) {
      continue;
    }
    addedShas.add(item.sha256);
    totalBytes += item.byteLength;
  }
  if (totalBytes > MAX_ITEM_ARTIFACT_BYTES) {
    throw new Error(`item immutable artifact quota exceeds ${MAX_ITEM_ARTIFACT_BYTES} bytes`);
  }
}

function quarantineCollision(dataDir: string, path: string, sha256: string): void {
  let roots = establishManagedArtifactRoots(dataDir);
  let sourceParent = validateDirectoryUnderRoot(dirname(path), roots.blobs);
  let quarantineDir = ensureChildDirectory(
    roots.artifacts,
    "quarantine",
    "managed artifact quarantine directory",
  );
  const target = join(quarantineDir.path, `${sha256}-${Date.now()}-${randomUUID()}`);
  roots = revalidateManagedArtifactRoots(roots);
  sourceParent = validateDirectoryUnderRoot(sourceParent.path, roots.blobs, sourceParent);
  quarantineDir = validateRealDirectory(
    quarantineDir.path,
    "managed artifact quarantine directory",
    { parent: roots.artifacts, expected: quarantineDir },
  )!;
  renameSync(path, target);
  fsyncDirectory(quarantineDir.path);
  fsyncDirectory(sourceParent.path);
}

function quarantineCollisionAndDowngrade(
  db: Db,
  dataDir: string,
  path: string,
  storageKey: string,
  sha256: string,
  cause: ArtifactIntegrityError,
): never {
  const apply = () => {
    db.prepare(
      `UPDATE artifacts
       SET availability='unavailable', storage_key=NULL
       WHERE storage_key=?`,
    ).run(storageKey);
    quarantineCollision(dataDir, path, sha256);
  };
  if (db.inTransaction) apply();
  else db.transaction(apply).immediate();
  throw new ArtifactIntegrityError(
    "collision",
    "content-addressed artifact collision was quarantined",
    { cause },
  );
}

function isQuarantinableCollision(error: ArtifactIntegrityError): boolean {
  return error.code === "sha256" || error.code === "length" || error.code === "type";
}

function unlinkOwnedLink(
  path: string | null,
  expected: { dev: number; ino: number } | null,
): void {
  if (!path || !expected) return;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()
      || entry.dev !== expected.dev || entry.ino !== expected.ino) return;
    unlinkSync(path);
  } catch {
    // The candidate disappeared or changed ownership; startup repair owns ambiguous state.
  }
}

export function stageArtifact(
  db: Db,
  rawInput: StageArtifactInput,
  options?: ArtifactStageOptions,
): StagedArtifact {
  const input = normalizeStageInput(rawInput);
  const item = validateStageRelations(db, input);
  if (input.relativePath === null) {
    return {
      itemId: input.itemId,
      runId: input.runId,
      ref: input.ref,
      name: input.name,
      kind: input.kind,
      mediaType: input.mediaType,
      description: input.description,
      originalFilename: null,
      sha256: null,
      byteLength: null,
      storageKey: null,
      availability: "metadata_only",
      verifyStorage() {},
      cleanup() {},
    };
  }
  if (!item.workdir) throw new Error(`item ${input.itemId} has no artifact workdir`);

  const source = openCanonicalSource(item.workdir, input.relativePath);
  let roots: ManagedArtifactRoots;
  let stagingDir: ValidatedDirectory;
  let temporaryPath: string | null = null;
  let finalizedPath: string | null = null;
  let storageKey: string | null = null;
  let createdBlob = false;
  let linkedCandidate: { dev: number; ino: number } | null = null;
  try {
    roots = establishManagedArtifactRoots(input.dataDir);
    stagingDir = ensureChildDirectory(
      roots.artifacts,
      "staging",
      "managed artifact staging directory",
    );
    temporaryPath = join(stagingDir.path, `${randomUUID()}.tmp`);
    roots = revalidateManagedArtifactRoots(roots);
    stagingDir = validateRealDirectory(
      stagingDir.path,
      "managed artifact staging directory",
      { parent: roots.artifacts, expected: stagingDir },
    )!;
    const copied = copyDescriptorToFile(source.fd, source.size, temporaryPath);
    const afterCopy = fstatSync(source.fd);
    if (!afterCopy.isFile()
      || afterCopy.dev !== source.dev
      || afterCopy.ino !== source.ino
      || afterCopy.size !== source.size
      || afterCopy.mtimeMs !== source.mtimeMs
      || afterCopy.ctimeMs !== source.ctimeMs
      || copied.byteLength !== source.size) {
      throw new Error("artifact source changed while it was being staged");
    }

    const existingBytes = itemDistinctBytes(db, input.itemId);
    if (!itemHasSha(db, input.itemId, copied.sha256)
      && existingBytes + copied.byteLength > MAX_ITEM_ARTIFACT_BYTES) {
      throw new Error(`item immutable artifact quota exceeds ${MAX_ITEM_ARTIFACT_BYTES} bytes`);
    }

    storageKey = storageKeyForSha(copied.sha256);
    roots = revalidateManagedArtifactRoots(roots);
    let prefixDir = ensureChildDirectory(
      roots.blobs,
      copied.sha256.slice(0, 2),
      "managed artifact content-address prefix",
    );
    finalizedPath = join(prefixDir.path, copied.sha256);
    options?.beforeBlobFinalize?.({
      prefixPath: prefixDir.path,
      storageKey,
      sha256: copied.sha256,
    });
    roots = revalidateManagedArtifactRoots(roots);
    prefixDir = validateDirectoryUnderRoot(prefixDir.path, roots.blobs, prefixDir);
    if (entryExists(finalizedPath)) {
      try {
        verifyManagedBlob(input.dataDir, storageKey, copied.sha256, copied.byteLength);
        unlinkSync(temporaryPath);
      } catch (error) {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
        if (!(error instanceof ArtifactIntegrityError) || !isQuarantinableCollision(error)) {
          throw error;
        }
        return quarantineCollisionAndDowngrade(
          db,
          input.dataDir,
          finalizedPath,
          storageKey,
          copied.sha256,
          error,
        );
      }
    } else {
      try {
        roots = revalidateManagedArtifactRoots(roots);
        prefixDir = validateDirectoryUnderRoot(prefixDir.path, roots.blobs, prefixDir);
        options?.afterBlobParentValidation?.({
          prefixPath: prefixDir.path,
          storageKey,
          sha256: copied.sha256,
        });
        roots = revalidateManagedArtifactRoots(roots);
        prefixDir = validateDirectoryUnderRoot(prefixDir.path, roots.blobs, prefixDir);
        const temporaryEntry = lstatSync(temporaryPath);
        options?.beforeBlobLink?.({
          prefixPath: prefixDir.path,
          storageKey,
          sha256: copied.sha256,
        });
        linkSync(temporaryPath, finalizedPath);
        linkedCandidate = { dev: temporaryEntry.dev, ino: temporaryEntry.ino };
        roots = revalidateManagedArtifactRoots(roots);
        prefixDir = validateDirectoryUnderRoot(prefixDir.path, roots.blobs, prefixDir);
        const finalizedEntry = lstatSync(finalizedPath);
        if (!finalizedEntry.isFile()
          || finalizedEntry.isSymbolicLink()
          || finalizedEntry.dev !== temporaryEntry.dev
          || finalizedEntry.ino !== temporaryEntry.ino) {
          throw new ArtifactIntegrityError(
            "topology",
            "managed artifact finalization target changed during link",
          );
        }
        unlinkSync(temporaryPath);
        createdBlob = true;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        try {
          verifyManagedBlob(input.dataDir, storageKey, copied.sha256, copied.byteLength);
          unlinkSync(temporaryPath);
        } catch (verifyError) {
          if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
          if (!(verifyError instanceof ArtifactIntegrityError)
            || !isQuarantinableCollision(verifyError)) {
            throw verifyError;
          }
          return quarantineCollisionAndDowngrade(
            db,
            input.dataDir,
            finalizedPath,
            storageKey,
            copied.sha256,
            verifyError,
          );
        }
      }
      roots = revalidateManagedArtifactRoots(roots);
      prefixDir = validateDirectoryUnderRoot(prefixDir.path, roots.blobs, prefixDir);
      fsyncDirectory(prefixDir.path);
    }
    roots = revalidateManagedArtifactRoots(roots);
    stagingDir = validateRealDirectory(
      stagingDir.path,
      "managed artifact staging directory",
      { parent: roots.artifacts, expected: stagingDir },
    )!;
    fsyncDirectory(stagingDir.path);

    const staged: StagedArtifact = {
      itemId: input.itemId,
      runId: input.runId,
      ref: input.ref,
      name: input.name,
      kind: input.kind,
      mediaType: input.mediaType,
      description: input.description,
      originalFilename: basename(source.canonicalPath),
      sha256: copied.sha256,
      byteLength: copied.byteLength,
      storageKey,
      availability: "available",
      verifyStorage() {
        verifyManagedBlob(input.dataDir, storageKey!, copied.sha256, copied.byteLength);
      },
      cleanup() {
        if (!createdBlob || !finalizedPath || !existsSync(finalizedPath)) return;
        const referenced = db.prepare("SELECT 1 FROM artifacts WHERE storage_key=? LIMIT 1")
          .get(storageKey);
        if (referenced) return;
        try {
          verifyManagedBlob(input.dataDir, storageKey!, copied.sha256, copied.byteLength);
          unlinkSync(finalizedPath);
          fsyncDirectory(dirname(finalizedPath));
        } catch {
          // Startup repair owns ambiguous or concurrently changed entries.
        }
      },
    };
    linkedCandidate = null;
    return staged;
  } catch (error) {
    unlinkOwnedLink(finalizedPath, linkedCandidate);
    if (temporaryPath && existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  } finally {
    closeSync(source.fd);
  }
}

function parseArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    checkpointId: row.checkpoint_id,
    ref: row.ref,
    name: row.name,
    kind: row.kind,
    mediaType: normalizeMediaType(row.media_type),
    description: row.description,
    availability: row.availability,
    byteLength: row.byte_length,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function artifactRows(db: Db, itemId: number): ArtifactRow[] {
  return db.prepare("SELECT * FROM artifacts WHERE item_id=? ORDER BY id")
    .all(itemId) as ArtifactRow[];
}

function stagedMatchesExisting(row: ArtifactRow, checkpointId: number, staged: StagedArtifact): boolean {
  return row.checkpoint_id === checkpointId
    && row.item_id === staged.itemId
    && row.run_id === staged.runId
    && row.ref === staged.ref
    && row.name === staged.name
    && row.kind === staged.kind
    && row.media_type === staged.mediaType
    && row.description === staged.description
    && row.original_filename === staged.originalFilename
    && row.sha256 === staged.sha256
    && row.byte_length === staged.byteLength
    && row.storage_key === staged.storageKey
    && row.availability === staged.availability;
}

export function commitStagedArtifacts(
  db: Db,
  checkpointId: number,
  stagedArtifacts: StagedArtifact[],
): Artifact[] {
  if (!Number.isSafeInteger(checkpointId) || checkpointId < 1) {
    throw new Error("checkpointId must be a positive safe integer");
  }
  if (!Array.isArray(stagedArtifacts)) throw new Error("staged artifacts must be an array");
  if (stagedArtifacts.length > MAX_ARTIFACTS_PER_CHECKPOINT) {
    throw new Error(`checkpoint artifact quota exceeds ${MAX_ARTIFACTS_PER_CHECKPOINT} registrations`);
  }
  const refs = new Set<string>();
  for (const staged of stagedArtifacts) {
    if (refs.has(staged.ref)) throw new Error(`duplicate artifact ref '${staged.ref}' in checkpoint`);
    refs.add(staged.ref);
    if (normalizeMediaType(staged.mediaType) !== staged.mediaType) {
      throw new Error("staged artifact media type must already be normalized");
    }
  }

  const commit = (): Artifact[] => {
    const checkpoint = db.prepare(
      "SELECT item_id, run_id, created_at FROM checkpoints WHERE id=?",
    ).get(checkpointId) as {
      item_id: number;
      run_id: number | null;
      created_at: string;
    } | undefined;
    if (!checkpoint) throw new Error(`checkpoint ${checkpointId} not found`);
    for (const staged of stagedArtifacts) {
      if (staged.itemId !== checkpoint.item_id || staged.runId !== checkpoint.run_id) {
        throw new Error("staged artifact provenance does not match checkpoint");
      }
      staged.verifyStorage();
    }

    const existingRows = artifactRows(db, checkpoint.item_id);
    const existingByRef = new Map(existingRows.map((row) => [row.ref, row]));
    const newArtifacts = stagedArtifacts.filter((staged) => !existingByRef.has(staged.ref));
    if (existingRows.length + newArtifacts.length > MAX_ARTIFACTS_PER_ITEM) {
      throw new Error(`item artifact quota exceeds ${MAX_ARTIFACTS_PER_ITEM} refs`);
    }
    for (const staged of stagedArtifacts) {
      const existing = existingByRef.get(staged.ref);
      if (existing && !stagedMatchesExisting(existing, checkpointId, staged)) {
        throw new Error(`artifact ref '${staged.ref}' is already registered with different content`);
      }
    }

    const existingShas = new Set(
      existingRows.filter((row) => row.availability === "available" && row.sha256)
        .map((row) => row.sha256!),
    );
    let bytes = itemDistinctBytes(db, checkpoint.item_id);
    const addedShas = new Set<string>();
    for (const staged of newArtifacts) {
      if (staged.availability !== "available" || !staged.sha256 || staged.byteLength === null) continue;
      if (existingShas.has(staged.sha256) || addedShas.has(staged.sha256)) continue;
      bytes += staged.byteLength;
      addedShas.add(staged.sha256);
    }
    if (bytes > MAX_ITEM_ARTIFACT_BYTES) {
      throw new Error(`item immutable artifact quota exceeds ${MAX_ITEM_ARTIFACT_BYTES} bytes`);
    }

    const insert = db.prepare(
      `INSERT INTO artifacts (
         item_id, run_id, checkpoint_id, ref, name, kind, media_type, description,
         original_filename, sha256, byte_length, storage_key, availability, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const staged of newArtifacts) {
      insert.run(
        staged.itemId,
        staged.runId,
        checkpointId,
        staged.ref,
        staged.name,
        staged.kind,
        staged.mediaType,
        staged.description,
        staged.originalFilename,
        staged.sha256,
        staged.byteLength,
        staged.storageKey,
        staged.availability,
        checkpoint.created_at,
      );
    }
    const rows = artifactRows(db, checkpoint.item_id);
    const byRef = new Map(rows.map((row) => [row.ref, row]));
    return stagedArtifacts.map((staged) => parseArtifact(byRef.get(staged.ref)!));
  };
  return db.inTransaction ? commit() : db.transaction(commit).immediate();
}

export function listArtifacts(db: Db, itemId: number): Artifact[] {
  if (!Number.isSafeInteger(itemId) || itemId < 1) {
    throw new Error("itemId must be a positive safe integer");
  }
  return artifactRows(db, itemId).map(parseArtifact);
}

function safeFilename(name: string, artifactId: number): string {
  const leaf = basename(name.replaceAll("\\", "/"));
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim();
  const safe = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : `artifact-${artifactId}`;
  return Array.from(safe).slice(0, 180).join("");
}

export function openArtifactContent(
  db: Db,
  dataDir: string,
  itemId: number,
  artifactId: number,
): ArtifactContent {
  const row = db.prepare("SELECT * FROM artifacts WHERE item_id=? AND id=?")
    .get(itemId, artifactId) as ArtifactRow | undefined;
  if (!row || row.availability !== "available" || !row.sha256
    || row.byte_length === null || !row.storage_key) {
    throw new Error("artifact content is unavailable");
  }
  if (row.storage_key !== storageKeyForSha(row.sha256)) {
    throw new Error("artifact content storage metadata is corrupt");
  }
  const mediaType = normalizeMediaType(row.media_type);
  const blobsRoot = realpathSync(join(dataDir, "artifacts", "blobs"));
  const rawPath = keyPath(dataDir, row.storage_key);
  const canonicalPath = realpathSync(rawPath);
  if (!isContained(blobsRoot, canonicalPath)) throw new Error("artifact content escaped storage root");
  const fd = openVerifiedFile(canonicalPath, row.sha256, row.byte_length);
  try {
    const afterOpenPath = realpathSync(rawPath);
    const opened = fstatSync(fd);
    const current = statSync(afterOpenPath);
    if (!isContained(blobsRoot, afterOpenPath)
      || opened.dev !== current.dev
      || opened.ino !== current.ino) {
      throw new Error("artifact content changed during open");
    }
    return {
      artifactId: row.id,
      filename: safeFilename(row.name, row.id),
      mediaType,
      byteLength: row.byte_length,
      sha256: row.sha256,
      stream: createReadStream(canonicalPath, { fd, autoClose: true, start: 0 }),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function validateDirectoryUnderRoot(
  path: string,
  root: ValidatedDirectory,
  expected?: ValidatedDirectory,
): ValidatedDirectory {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    throwIntegrityFsError(error, "topology", "managed artifact directory topology changed", [
      "ENOENT", "ENOTDIR", "ELOOP",
    ]);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new ArtifactIntegrityError(
      "topology",
      "managed artifact directory must not be a symlink or non-directory",
    );
  }
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(path);
  } catch (error) {
    throwIntegrityFsError(error, "topology", "managed artifact directory topology changed", [
      "ENOENT", "ENOTDIR", "ELOOP",
    ]);
  }
  if (!isContained(root.canonicalPath, canonicalPath)) {
    throw new ArtifactIntegrityError("path", "managed artifact directory escaped blobs root");
  }
  const canonicalEntry = statSync(canonicalPath);
  if (canonicalEntry.dev !== entry.dev
    || canonicalEntry.ino !== entry.ino
    || (expected && (expected.dev !== entry.dev
      || expected.ino !== entry.ino
      || expected.canonicalPath !== canonicalPath))) {
    throw new ArtifactIntegrityError("topology", "managed artifact directory topology changed");
  }
  return { path, canonicalPath, dev: entry.dev, ino: entry.ino };
}

function validateOrphanCandidate(
  dataDir: string,
  root: ValidatedDirectory,
  candidate: OrphanCandidate,
): void {
  const currentRoot = validateManagedBlobsRoot(dataDir);
  if (!currentRoot
    || currentRoot.dev !== root.dev
    || currentRoot.ino !== root.ino
    || currentRoot.canonicalPath !== root.canonicalPath) {
    throw new ArtifactIntegrityError("topology", "managed artifact blobs root changed");
  }
  validateDirectoryUnderRoot(candidate.parent.path, root, candidate.parent);
  let entry;
  try {
    entry = lstatSync(candidate.path);
  } catch (error) {
    throwIntegrityFsError(error, "topology", "orphan artifact topology changed", [
      "ENOENT", "ENOTDIR", "ELOOP",
    ]);
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new ArtifactIntegrityError("topology", "orphan artifact must remain a regular file");
  }
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(candidate.path);
  } catch (error) {
    throwIntegrityFsError(error, "topology", "orphan artifact topology changed", [
      "ENOENT", "ENOTDIR", "ELOOP",
    ]);
  }
  if (!isContained(candidate.parent.canonicalPath, canonicalPath)
    || !isContained(root.canonicalPath, canonicalPath)) {
    throw new ArtifactIntegrityError("path", "orphan artifact escaped managed storage");
  }
  const canonicalEntry = statSync(canonicalPath);
  if (canonicalPath !== candidate.canonicalPath
    || entry.dev !== candidate.dev
    || entry.ino !== candidate.ino
    || canonicalEntry.dev !== candidate.dev
    || canonicalEntry.ino !== candidate.ino) {
    throw new ArtifactIntegrityError("topology", "orphan artifact topology changed");
  }
}

function removeExpiredOrphans(
  db: Db,
  dataDir: string,
  now: Date,
  orphanGraceMs: number,
  options?: ArtifactRepairOptions,
): number {
  if (db.inTransaction) {
    throw new Error("artifact orphan GC requires its own immediate database transaction");
  }
  const root = validateManagedBlobsRoot(dataDir, { allowMissing: true });
  if (!root) return 0;
  const referenced = new Set(
    (db.prepare("SELECT storage_key FROM artifacts WHERE storage_key IS NOT NULL").all() as Array<{
      storage_key: string;
    }>).map((row) => row.storage_key),
  );
  const cutoff = now.getTime() - orphanGraceMs;
  const candidates: OrphanCandidate[] = [];
  for (const prefixEntry of readdirSync(root.path, { withFileTypes: true })) {
    if (prefixEntry.isSymbolicLink()) {
      throw new ArtifactIntegrityError("topology", "managed artifact prefix must not be a symlink");
    }
    if (!/^[0-9a-f]{2}$/.test(prefixEntry.name)) continue;
    const prefixPath = join(root.path, prefixEntry.name);
    const parent = validateDirectoryUnderRoot(prefixPath, root);
    for (const fileEntry of readdirSync(parent.path, { withFileTypes: true })) {
      if (fileEntry.isSymbolicLink()) {
        throw new ArtifactIntegrityError("topology", "managed artifact entry must not be a symlink");
      }
      const sha256 = fileEntry.name;
      if (!/^[0-9a-f]{64}$/.test(sha256) || sha256.slice(0, 2) !== prefixEntry.name) continue;
      const path = join(parent.path, sha256);
      let entry;
      try {
        entry = lstatSync(path);
      } catch (error) {
        throwIntegrityFsError(error, "topology", "managed artifact entry changed", [
          "ENOENT", "ENOTDIR", "ELOOP",
        ]);
      }
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new ArtifactIntegrityError("topology", "managed artifact entry is not a regular file");
      }
      let canonicalPath: string;
      try {
        canonicalPath = realpathSync(path);
      } catch (error) {
        throwIntegrityFsError(error, "topology", "managed artifact entry changed", [
          "ENOENT", "ENOTDIR", "ELOOP",
        ]);
      }
      if (!isContained(parent.canonicalPath, canonicalPath)
        || !isContained(root.canonicalPath, canonicalPath)) {
        throw new ArtifactIntegrityError("path", "managed artifact entry escaped storage root");
      }
      const storageKey = storageKeyForSha(sha256);
      if (referenced.has(storageKey) || entry.mtimeMs > cutoff) continue;
      candidates.push({
        path,
        canonicalPath,
        storageKey,
        sha256,
        parent,
        dev: entry.dev,
        ino: entry.ino,
      });
    }
  }

  const rootFd = openSync(
    root.canonicalPath,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NO_FOLLOW,
  );
  let removed = 0;
  try {
    const openedRoot = fstatSync(rootFd);
    if (openedRoot.dev !== root.dev || openedRoot.ino !== root.ino) {
      throw new ArtifactIntegrityError("topology", "managed artifact blobs root changed");
    }
    for (const candidate of candidates) {
      options?.beforeOrphanDelete?.({
        path: candidate.path,
        storageKey: candidate.storageKey,
        sha256: candidate.sha256,
      });
      const removeCandidate = db.transaction((): boolean => {
        validateOrphanCandidate(dataDir, root, candidate);
        const becameReferenced = db.prepare(
          "SELECT 1 FROM artifacts WHERE storage_key=? LIMIT 1",
        ).get(candidate.storageKey);
        if (becameReferenced) return false;
        unlinkSync(candidate.path);
        return true;
      });
      if (removeCandidate.immediate()) removed++;
    }
    if (removed) fsyncSync(rootFd);
  } finally {
    closeSync(rootFd);
  }
  return removed;
}

export function repairArtifactStorage(
  db: Db,
  dataDir: string,
  now: Date,
  orphanGraceMs: number,
  options?: ArtifactRepairOptions,
): RepairResult {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("repair time is invalid");
  if (!Number.isSafeInteger(orphanGraceMs) || orphanGraceMs <= 0) {
    throw new Error("artifact orphan grace must be a positive safe integer");
  }
  const repairRows = () => {
    const proofItemsRepaired = repairItemProofMaterialization(db);
    const available = db.prepare(
      `SELECT id, sha256, byte_length, storage_key
       FROM artifacts WHERE availability='available' ORDER BY id`,
    ).all() as Array<{
      id: number;
      sha256: string;
      byte_length: number;
      storage_key: string;
    }>;
    let artifactsDowngraded = 0;
    const downgrade = db.prepare(
      "UPDATE artifacts SET availability='unavailable', storage_key=NULL WHERE id=?",
    );
    for (const row of available) {
      try {
        options?.beforeVerifyArtifact?.({
          artifactId: row.id,
          storageKey: row.storage_key,
        });
        verifyManagedBlob(dataDir, row.storage_key, row.sha256, row.byte_length);
      } catch (error) {
        if (!(error instanceof ArtifactIntegrityError)) throw error;
        downgrade.run(row.id);
        artifactsDowngraded++;
      }
    }
    return { proofItemsRepaired, artifactsDowngraded };
  };
  const repaired = db.inTransaction ? repairRows() : db.transaction(repairRows).immediate();
  const orphansRemoved = removeExpiredOrphans(db, dataDir, now, orphanGraceMs, options);
  return { ...repaired, orphansRemoved };
}
