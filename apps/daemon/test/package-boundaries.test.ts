// monorepo 的包边界。每个包只能通过 package.json 里声明的依赖引用别的包，而且只能从对方的公开入口
// （exports 里的 "." 或 "./testing"）引用。相对路径不能越出本包的目录。
// 包之间的依赖图必须和下面的分层一致：低层的包不知道高层的包，图里没有环。
// daemon 是服务的组合根，所以这条整个工作区的规则放在它的测试里。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCOPE = "@pi-lead-child/";

// 每个包允许依赖的包（不含 dev 依赖）。改分层时先改这里，再改 package.json。
const LAYERS: Record<string, string[]> = {
  protocol: [],
  client: ["protocol"],
  components: [],
  core: ["protocol"],
  runtime: ["core"],
  store: ["core", "runtime", "protocol"],
  connections: ["core", "store", "protocol"],
  engine: ["core", "runtime", "store", "protocol"],
  supervisor: ["core", "runtime", "store", "protocol"],
  gateway: ["core", "runtime", "store", "engine", "protocol"],
  lead: ["core", "runtime", "store", "engine", "supervisor", "connections", "protocol"],
  daemon: ["core", "runtime", "store", "engine", "supervisor", "gateway", "lead", "connections", "protocol"],
  // cli 和 companion 一样是 daemon 的客户端：客户端动作走网关（client），本机 socket 的消息类型来自
  // protocol。core 只用来找路径（数据目录、daemon 的构建产物），见下面的 CLI_CORE_IMPORTS。
  cli: ["client", "protocol", "core"],
  companion: ["components", "client", "protocol"],
};

// cli 从 core 里只能拿路径。core 里的领域类型、配置解析和领域规则属于 daemon 一侧。
const CLI_CORE_IMPORTS = ["dataDir", "distDir", "packageSource", "projectRoot", "workspaceDir"];

type Workspace = {
  name: string;
  dir: string;
  manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; exports?: Record<string, string> };
};

function workspaces(): Workspace[] {
  return ["packages", "apps"].flatMap((group) => readdirSync(join(ROOT, group)).flatMap((entry) => {
    const dir = join(ROOT, group, entry);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) return [];
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Workspace["manifest"] & { name: string };
    return [{ name: manifest.name.slice(SCOPE.length), dir, manifest }];
  }));
}

function internalDeps(deps: Record<string, string> | undefined): string[] {
  return Object.keys(deps ?? {}).filter((name) => name.startsWith(SCOPE)).map((name) => name.slice(SCOPE.length)).sort();
}

const SOURCE = /\.(?:ts|tsx|mts|mjs)$/;
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name.startsWith(".") || name.startsWith("dist-")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return SOURCE.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual)\(\s*)(["'])([^"']+)\1/g;
function specifiers(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(SPECIFIER)].map((match) => match[2]!);
}

describe("monorepo package boundaries", () => {
  const all = workspaces();

  it("knows every workspace, and every workspace has a layer", () => {
    expect(all.map((workspace) => workspace.name).sort()).toEqual(Object.keys(LAYERS).sort());
  });

  it("declares exactly the dependencies its layer allows", () => {
    for (const workspace of all) {
      expect.soft(internalDeps(workspace.manifest.dependencies), workspace.name)
        .toEqual([...LAYERS[workspace.name]!].sort());
    }
  });

  // 各个 app 互相独立，测试也不例外，所以 dev 依赖也要检查。
  it("keeps the apps independent: no app depends on another app", () => {
    const apps = all.filter((workspace) => workspace.dir.startsWith(join(ROOT, "apps") + sep));
    const names = apps.map((app) => app.name);
    expect(names).toEqual(expect.arrayContaining(["cli", "companion", "daemon"]));
    for (const app of apps) {
      const deps = [...internalDeps(app.manifest.dependencies), ...internalDeps(app.manifest.devDependencies)];
      expect.soft(deps.filter((dep) => names.includes(dep)), app.name).toEqual([]);
    }
  });

  it("has an acyclic dependency graph", () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, path: string[]): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) throw new Error(`cycle: ${[...path, name].join(" -> ")}`);
      visiting.add(name);
      for (const dep of LAYERS[name] ?? []) visit(dep, [...path, name]);
      visiting.delete(name);
      done.add(name);
    };
    for (const name of Object.keys(LAYERS)) visit(name, []);
  });

  it("lets the cli take only paths from core", () => {
    const cli = all.find((workspace) => workspace.name === "cli")!;
    const named = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@pi-lead-child\/core["']/g;
    const used = new Set<string>();
    for (const file of sourceFiles(cli.dir)) {
      for (const match of readFileSync(file, "utf8").matchAll(named)) {
        for (const name of match[1]!.split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!)) {
          if (name) used.add(name);
        }
      }
      expect.soft(readFileSync(file, "utf8"), relative(ROOT, file)).not.toMatch(/import\s*\*\s*as\s+\w+\s*from\s*["']@pi-lead-child\/core["']/);
    }
    expect([...used].filter((name) => !CLI_CORE_IMPORTS.includes(name)).sort()).toEqual([]);
  });

  it("imports other workspaces only through declared dependencies and their public entries", () => {
    const offenders: string[] = [];
    for (const workspace of all) {
      const declared = new Set([
        ...internalDeps(workspace.manifest.dependencies),
        ...internalDeps(workspace.manifest.devDependencies),
      ]);
      for (const file of sourceFiles(workspace.dir)) {
        const where = relative(ROOT, file);
        for (const spec of specifiers(file)) {
          if (spec.startsWith(".")) {
            const target = normalize(join(dirname(file), spec));
            if (!(target + sep).startsWith(workspace.dir + sep)) offenders.push(`${where}: relative import leaves the package: ${spec}`);
            continue;
          }
          if (!spec.startsWith(SCOPE)) continue;
          const [name, ...subpath] = spec.slice(SCOPE.length).split("/");
          const entry = subpath.length ? `./${subpath.join("/")}` : ".";
          if (name === workspace.name) offenders.push(`${where}: imports its own package by name: ${spec}`);
          else if (!declared.has(name!)) offenders.push(`${where}: undeclared dependency: ${spec}`);
          else {
            const target = all.find((candidate) => candidate.name === name);
            if (!target?.manifest.exports?.[entry]) offenders.push(`${where}: not a public entry: ${spec}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
