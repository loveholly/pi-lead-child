// 子 agent 交的结果的出处核实（landing.md C4）。纯函数：只看结果、清单和连接中心记下的这次运行读到的内容。
//   - 文件的出处（via local 或 github）：和代查同一套规则（lookup/provenance.ts 的 checkLineSource）。仓库要在清单里，
//     读到过这个文件的这几行，quote 是这几行原文的一部分。
//   - 连接的出处（via connection，例如 CDP、Jira）：连接要在清单里，这次运行用这个工具读到过的原文里找得到 quote。
// 没通过的出处标 verified=false，原因并进 caveats。结果交回发起方（通道），由它决定能不能代你回。
import {
  LOCAL_REPO_CONNECTION, GITHUB_CONNECTION,
  type AgentTaskResult, type AgentTaskSource, type ConnectionSource, type LookupSource, type RunGrant,
} from "@pi-lead-child/protocol";
import type { RunReadContent } from "@pi-lead-child/connections";
import { checkLineSource, mergeCaveats, normalizeQuote } from "../lookup/provenance.js";

export interface AgentTaskSourceCheck {
  source: AgentTaskSource;
  verified: boolean;
  reason: string | null;
}

export interface AgentTaskVerification {
  result: AgentTaskResult;
  sources: AgentTaskSourceCheck[];
}

/** 清单里能引用的仓库（小写）：本地是清单的本地仓库，GitHub 是 GitHub 规则里定下的 owner/repo。 */
function grantRepos(grant: RunGrant): { local: Set<string>; github: Set<string> } {
  const github = new Set<string>();
  for (const rule of grant.rules) {
    if (rule.connection.toLowerCase() !== GITHUB_CONNECTION) continue;
    for (const owner of rule.args?.owner?.oneOf ?? []) {
      for (const repo of rule.args?.repo?.oneOf ?? []) github.add(`${String(owner)}/${String(repo)}`.toLowerCase());
    }
  }
  const local = new Set(grant.localRepos.map((entry) => entry.name.toLowerCase()));
  for (const rule of grant.rules) {
    if (rule.connection !== LOCAL_REPO_CONNECTION) continue;
    for (const repo of rule.args?.repo?.oneOf ?? []) local.add(String(repo).toLowerCase());
  }
  return { local, github };
}

function checkConnectionSource(source: ConnectionSource, grant: RunGrant, reads: RunReadContent): AgentTaskSourceCheck {
  const fail = (reason: string): AgentTaskSourceCheck => ({ source: { ...source, verified: false }, verified: false, reason });
  const name = source.connection.toLowerCase();
  if (!grant.rules.some((rule) => rule.connection.toLowerCase() === name)) return fail("这个连接不在清单里");
  const quote = normalizeQuote(source.quote);
  if (!quote) return fail("引用的原文是空的");
  const texts = (reads.texts ?? []).filter((entry) => entry.connections.includes(name) && entry.tool === source.tool);
  if (!texts.length) return fail("这次运行没有用这个工具读过东西");
  if (!texts.some((entry) => normalizeQuote(entry.text).includes(quote))) return fail("引用的原文在读到的结果里找不到");
  return { source: { ...source, verified: true }, verified: true, reason: null };
}

function describeSource(source: AgentTaskSource): string {
  return source.via === "connection"
    ? `${source.connection}.${source.tool}`
    : `${source.repo} ${source.path}:${source.startLine}-${source.endLine}`;
}

/** 核实一份子 agent 的结果。不改输入。 */
export function verifyAgentTaskResult(input: { result: AgentTaskResult; grant: RunGrant; reads: RunReadContent }): AgentTaskVerification {
  const repos = grantRepos(input.grant);
  const sources = input.result.sources.map((source): AgentTaskSourceCheck => source.via === "connection"
    ? checkConnectionSource(source, input.grant, input.reads)
    : checkLineSource(source as LookupSource, repos, input.reads));
  const notes = sources.filter((check) => !check.verified)
    .map((check) => `出处没有通过核实：${describeSource(check.source)}（${check.reason}）`.slice(0, 500));
  return {
    result: { ...input.result, sources: sources.map((check) => check.source), caveats: mergeCaveats(input.result.caveats, notes) },
    sources,
  };
}
