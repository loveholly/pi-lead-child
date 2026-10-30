// 出处核实（slack-takeover spec D5）。纯函数：只看代查 agent 交的结果、作用域和这次运行读到的内容。
// 规则：
//   - 出处的仓库在作用域里（本地看 scope.local，GitHub 看 scope.github 和 scope.pullRequest）；
//   - 这次运行读到过这个文件，读到的行覆盖了引用的行（startLine 到 endLine 每一行都读过）；
//   - quote 去掉多余空白以后，是引用的那几行原文（同样去掉多余空白）的一部分。
// 没通过的出处标 verified=false，原因写进 caveats。review 的评论必须落在读到的 diff 的行上，
// 否则从结果里去掉，写进 caveats。
import { LOOKUP_LIMITS, type LookupResult, type LookupReviewComment, type LookupScope, type LookupSource } from "@pi-lead-child/protocol";
import { normalizeSourcePath, type LookupReadContent } from "./reads.js";

// 一条出处最多引用这么多行。
export const MAX_SOURCE_LINES = 400;

export interface SourceCheck {
  source: LookupSource;
  verified: boolean;
  reason: string | null;
}

export interface CommentCheck {
  comment: LookupReviewComment;
  kept: boolean;
  reason: string | null;
}

export interface LookupVerification {
  // 核实以后的结果：sources[].verified 已填，没通过的评论已去掉，原因并进 caveats。
  result: LookupResult;
  sources: SourceCheck[];
  comments: CommentCheck[];
}

/** 去掉多余空白：连续的空白换成一个空格，去掉首尾空白。 */
export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function scopeRepos(scope: LookupScope): { local: Set<string>; github: Set<string> } {
  const github = new Set(scope.github.map((entry) => `${entry.owner}/${entry.repo}`.toLowerCase()));
  if (scope.pullRequest) github.add(`${scope.pullRequest.owner}/${scope.pullRequest.repo}`.toLowerCase());
  return { local: new Set(scope.local.map((entry) => entry.repo.toLowerCase())), github };
}

/**
 * 核实一条按行引用的出处（本地或 GitHub 的文件）。repos 是能引用的仓库名（小写）。子 agent 的结果（agent-task/provenance.ts）也用它。
 */
export function checkLineSource(
  source: LookupSource, repos: { local: ReadonlySet<string>; github: ReadonlySet<string> }, reads: LookupReadContent,
): SourceCheck {
  return checkSource(source, repos, reads);
}

function checkSource(source: LookupSource, scope: { local: ReadonlySet<string>; github: ReadonlySet<string> }, reads: LookupReadContent): SourceCheck {
  const fail = (reason: string): SourceCheck => ({ source: { ...source, verified: false }, verified: false, reason });
  const repo = source.repo.toLowerCase();
  if (!(source.via === "local" ? scope.local : scope.github).has(repo)) return fail("仓库不在这次代查的作用域里");
  if (source.endLine < source.startLine) return fail("行号范围不对");
  if (source.endLine - source.startLine + 1 > MAX_SOURCE_LINES) return fail(`一条出处最多引用 ${MAX_SOURCE_LINES} 行`);
  const path = normalizeSourcePath(source.path);
  const file = reads.files.find((entry) => entry.via === source.via && entry.repo.toLowerCase() === repo
    && normalizeSourcePath(entry.path) === path);
  if (!file) return fail("这次代查没有读过这个文件");
  const cited: string[] = [];
  for (let line = source.startLine; line <= source.endLine; line += 1) {
    const text = file.lines[line];
    if (text === undefined) return fail(`第 ${line} 行没有读过`);
    cited.push(text);
  }
  const quote = normalizeQuote(source.quote);
  if (!quote) return fail("引用的原文是空的");
  if (!normalizeQuote(cited.join("\n")).includes(quote)) return fail("引用的原文和读到的这几行对不上");
  return {
    source: { ...source, ...(source.ref || !file.ref ? {} : { ref: file.ref }), verified: true },
    verified: true,
    reason: null,
  };
}

function checkComment(comment: LookupReviewComment, scope: LookupScope, reads: LookupReadContent): CommentCheck {
  const pr = scope.pullRequest;
  if (!pr) return { comment, kept: false, reason: "这次代查没有要 review 的 PR" };
  const repo = `${pr.owner}/${pr.repo}`.toLowerCase();
  const path = normalizeSourcePath(comment.path);
  const inDiff = reads.diffLines.some((line) => line.repo.toLowerCase() === repo && line.path === path
    && line.side === comment.side && line.line === comment.line);
  return inDiff ? { comment, kept: true, reason: null } : { comment, kept: false, reason: "这一行不在读到的 diff 里" };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 核实的说明并进 caveats，总数不超过上限。放不下时最后一条写「另有 N 处」；agent 自己的 caveats 已经占满时，
// 让出最后一条给核实的说明。
export function mergeCaveats(own: readonly string[], notes: readonly string[]): string[] {
  const max = LOOKUP_LIMITS.caveats;
  if (!notes.length) return own.slice(0, max);
  const kept = own.slice(0, Math.min(own.length, max - 1));
  const room = max - kept.length;
  if (notes.length <= room) return [...kept, ...notes];
  return [...kept, ...notes.slice(0, room - 1), `另有 ${notes.length - room + 1} 处出处或评论没有通过核实`];
}

/** 核实一份代查结果。不改输入。 */
export function verifyLookupResult(input: { result: LookupResult; scope: LookupScope; reads: LookupReadContent }): LookupVerification {
  const repos = scopeRepos(input.scope);
  const sources = input.result.sources.map((source) => checkSource(source, repos, input.reads));
  const comments = (input.result.review?.comments ?? []).map((comment) => checkComment(comment, input.scope, input.reads));
  const notes = [
    ...sources.filter((check) => !check.verified).map((check) =>
      `出处没有通过核实：${check.source.repo} ${check.source.path}:${check.source.startLine}-${check.source.endLine}（${check.reason}）`),
    ...comments.filter((check) => !check.kept).map((check) =>
      `评论已去掉：${check.comment.path}:${check.comment.line}（${check.comment.side}，${check.reason}）`),
  ].map((note) => clip(note, 500));
  const caveats = mergeCaveats(input.result.caveats, notes);
  const result: LookupResult = {
    ...input.result,
    sources: sources.map((check) => check.source),
    caveats,
    ...(input.result.review ? {
      review: { ...input.result.review, comments: comments.filter((check) => check.kept).map((check) => check.comment) },
    } : {}),
  };
  return { result, sources, comments };
}
