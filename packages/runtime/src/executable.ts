import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { projectRoot } from "@pi-lead-child/core";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function runtimeBinDirectories(existingPath = process.env.PATH ?? ""): string[] {
  return [...new Set([
    dirname(process.execPath),
    join(projectRoot(), "node_modules", ".bin"),
    ...existingPath.split(delimiter).filter(Boolean),
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ])];
}

export function runtimeSearchPath(existingPath = process.env.PATH ?? ""): string {
  return runtimeBinDirectories(existingPath).join(delimiter);
}

export function findRuntimeExecutable(
  nameOrPath: string,
  existingPath = process.env.PATH ?? "",
): string | null {
  if (isAbsolute(nameOrPath) || nameOrPath.includes("/")) {
    return executable(nameOrPath) ? nameOrPath : null;
  }
  for (const dir of runtimeBinDirectories(existingPath)) {
    const candidate = join(dir, nameOrPath);
    if (executable(candidate)) return candidate;
  }
  return null;
}

export function resolveRuntimeExecutable(
  nameOrPath: string,
  existingPath = process.env.PATH ?? "",
): string {
  return findRuntimeExecutable(nameOrPath, existingPath) ?? nameOrPath;
}
