// 模型目录的发现（2026-10-15 用户决定：不写死 Codex 或 Claude Code 的模型）。
// 每个 runtime 的目录都来自 CLI 自己接受的东西，并记下来源：
//   - Codex（内置订阅账号）：`codex debug models` 输出账号可用的模型、每个模型的 effort 档位和默认档位。
//   - Claude Code（内置订阅账号）：`claude --help` 的 --model 说明列出模型别名，--effort 说明列出档位。
//     别名总是指向该系列最新的模型，所以不需要知道完整的版本号。
//   - pi（它自己的 provider 配置）：`pi --list-models` 列出 provider/model 和是否支持 thinking，
//     `pi --help` 的 --thinking 说明列出档位。
// 解析函数是纯函数，按 2026-10-15 本机的输出写成测试（codex-cli 0.162.1、Claude Code 2.1.258、pi 1.1.0）。
// 发现失败时返回 ok=false：调用方把这个 runtime 的目录记成 unknown，不替 Run 选模型。
// 发现命令只读帮助和目录，不读、不打印凭据。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DiscoveredModel {
  /** 交给 CLI 的模型名：Codex 的 slug、Claude Code 的别名、pi 的 provider/model。 */
  id: string;
  /** 给人看的名字。没有时等于 id。 */
  label: string;
  /** 这个模型能用的 effort 档位。空数组表示这个模型不支持调 effort。 */
  efforts: string[];
  /** CLI 自己的默认档位。不知道时为 null。 */
  defaultEffort: string | null;
  /** 一句说明，例如 Codex 目录里的 description，或者 Claude Code 的「别名，指向该系列最新的模型」。 */
  note: string | null;
}

export type ModelDiscovery =
  | {
      ok: true;
      models: DiscoveredModel[];
      /** 这个 runtime 认的全部 effort 档位（各模型的并集，或者 CLI 帮助里的列表）。 */
      efforts: string[];
      /** CLI 自己配置的默认模型（例如 ~/.codex/config.toml 的 model）。不知道时为 null。 */
      cliDefaultModel: string | null;
      /** 目录从哪里来，例如 "codex debug models"。 */
      source: string;
      /** 这个 runtime 用谁的账号，例如「Codex 内置的订阅账号」。Lead 据此知道换 runtime 就是换账号。 */
      account: string;
      /** 目录以外 CLI 也接受的模型名（正则源码），例如 Claude Code 的完整模型名。没有时为 null。 */
      freeformModelPattern: string | null;
    }
  | { ok: false; error: string; source: string };

export interface ModelDiscoveryContext {
  /** CLI 的可执行文件。 */
  bin: string;
  /** 在可执行文件前面加的参数（例如用 node 跑的 pi）。 */
  prefixArgs?: readonly string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

/** 跑一条只读的发现命令，返回标准输出。超时或退出码不为 0 时抛错。 */
export async function runDiscoveryCommand(context: ModelDiscoveryContext, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(context.bin, [...(context.prefixArgs ?? []), ...args], {
    encoding: "utf8",
    timeout: context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    cwd: context.cwd,
    env: { ...process.env, ...(context.env ?? {}) } as NodeJS.ProcessEnv,
  });
  return stdout;
}

function unique(values: readonly string[]): string[] {
  return values.filter((value, index, all) => value && all.indexOf(value) === index);
}

function shortNote(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const first = text.trim().split(/(?<=[.!?。])\s/)[0]?.trim() ?? "";
  if (!first) return null;
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

// ── Codex：`codex debug models` ──────────────────────────────────────────────────
// { models: [{ slug, display_name, description, visibility: "list" | "hide", priority,
//   default_reasoning_level, supported_reasoning_levels: [{ effort, description }] }] }
// visibility=hide 的是 Codex 内部用的模型（例如 codex-auto-review），不放进目录。
export function parseCodexModelCatalog(json: string): DiscoveredModel[] {
  const payload = JSON.parse(json) as { models?: unknown };
  if (!Array.isArray(payload.models)) throw new Error("codex debug models did not return { models: [...] }");
  return payload.models
    .filter((model): model is Record<string, unknown> => Boolean(model) && typeof model === "object")
    .filter((model) => typeof model.slug === "string" && model.slug.trim() && model.visibility !== "hide")
    .sort((left, right) => Number(left.priority ?? 0) - Number(right.priority ?? 0))
    .map((model) => {
      const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
      const efforts = unique(levels.map((level) => (
        level && typeof level === "object" && typeof (level as { effort?: unknown }).effort === "string"
          ? (level as { effort: string }).effort.trim()
          : typeof level === "string" ? level.trim() : ""
      )));
      const slug = (model.slug as string).trim();
      return {
        id: slug,
        label: typeof model.display_name === "string" && model.display_name.trim() ? model.display_name.trim() : slug,
        efforts,
        defaultEffort: typeof model.default_reasoning_level === "string" ? model.default_reasoning_level : null,
        note: shortNote(model.description),
      };
    });
}

/** ~/.codex/config.toml 顶层的 model = "…"。只读这一行，不读别的配置。 */
export function parseCodexConfigModel(toml: string): string | null {
  for (const line of toml.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) return null; // 顶层结束，后面是 profile 等表
    const match = /^\s*model\s*=\s*"([^"]+)"\s*(?:#.*)?$/.exec(line);
    if (match) return match[1]!.trim() || null;
  }
  return null;
}

// ── Claude Code：`claude --help` ─────────────────────────────────────────────────
// --model <model>  Model for the current session. Provide an alias for the latest model
//                  (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').
// --effort <level> Effort level for the current session (low, medium, high, xhigh, max)
// 帮助文字是折行的：先把每个选项的说明拼成一行再匹配。
function helpOptionText(help: string, option: string): string | null {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^\\s*(?:-\\w,\\s*)?${option}\\b`).test(line));
  if (start === -1) return null;
  const parts = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*-{1,2}\w/.test(line) || /^\S/.test(line)) break;
    parts.push(line);
  }
  return parts.map((part) => part.trim()).join(" ");
}

export function parseClaudeHelp(help: string): { aliases: string[]; efforts: string[] } {
  const model = helpOptionText(help, "--model") ?? "";
  const aliasSentence = /alias[^(]*\(e\.g\.\s*([^)]*)\)/i.exec(model)?.[1] ?? "";
  const aliases = unique([...aliasSentence.matchAll(/'([a-z0-9][a-z0-9.-]*)'/gi)].map((match) => match[1]!.trim()));
  const effort = helpOptionText(help, "--effort") ?? "";
  const efforts = unique((/\(([^)]*)\)\s*$/.exec(effort)?.[1] ?? "").split(/,\s*/).map((value) => value.trim()));
  return { aliases, efforts };
}

export function claudeModelsFromHelp(help: string): { models: DiscoveredModel[]; efforts: string[] } {
  const { aliases, efforts } = parseClaudeHelp(help);
  return {
    efforts,
    models: aliases.map((alias) => ({
      id: alias,
      label: alias,
      efforts,
      defaultEffort: null,
      note: "别名，指向这个系列最新的模型（claude --help）",
    })),
  };
}

// ── pi：`pi --list-models` 和 `pi --help` ────────────────────────────────────────
// provider   model         context  max-out  thinking  images
// openai     gpt-6.1-sol   400K     128K     yes       yes
export function parsePiModelList(text: string, thinkingLevels: readonly string[]): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  for (const line of text.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[0] === "provider" || /^[Σ-]/.test(columns[0]!)) continue;
    const [provider, model, , , thinking] = columns;
    if (!provider || !model) continue;
    const reasoning = thinking === "yes";
    models.push({
      id: `${provider}/${model}`,
      label: `${provider}/${model}`,
      efforts: reasoning ? [...thinkingLevels] : [],
      defaultEffort: null,
      note: reasoning ? null : "不支持 thinking",
    });
  }
  return models;
}

/** 目录里的 pi 模型来自哪些 provider，按字母排。 */
export function piProviders(models: readonly DiscoveredModel[]): string[] {
  return unique(models.map((model) => model.id.split("/")[0] ?? "")).sort();
}

/**
 * pi 自己的默认模型：<agent-dir>/settings.json 的 defaultProvider 和 defaultModel，拼成 provider/model。
 * 只读这两项。少一项、或者文件不是 JSON 时返回 null（pi 按自己的规则选）。
 */
export function parsePiSettingsDefault(json: string): string | null {
  try {
    const settings = JSON.parse(json) as { defaultProvider?: unknown; defaultModel?: unknown };
    const provider = typeof settings.defaultProvider === "string" ? settings.defaultProvider.trim() : "";
    const model = typeof settings.defaultModel === "string" ? settings.defaultModel.trim() : "";
    return provider && model ? `${provider}/${model}` : null;
  } catch {
    return null;
  }
}

// --thinking <level>  Set thinking level: off, minimal, low, medium, high, xhigh, max
export function parsePiThinkingLevels(help: string): string[] {
  const text = helpOptionText(help, "--thinking") ?? "";
  const list = /:\s*([a-z, ]+)$/i.exec(text)?.[1] ?? "";
  return unique(list.split(/,\s*/).map((value) => value.trim()));
}

/** effort 来自库里，属于外部输入：只接受小写字母的档位名，看起来像选项的值不交给 CLI。 */
export function cliEffortValue(effort: string | undefined): string | undefined {
  const value = effort?.trim();
  if (!value) return undefined;
  if (!/^[a-z]+$/.test(value)) throw new Error(`invalid effort '${effort}'`);
  return value;
}
