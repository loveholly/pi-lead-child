// GitHub 连接的守卫（guards.ts）。工具名和参数是 GitHub 远程 MCP（github/github-mcp-server）的线上名字。
//   - check（对所有调用方生效）：
//       · APPROVE 以前代码查四条（landing.md 第 3 节 C2），有一条不过就拒绝并给出原因：
//         检查都通过（check run 和 commit status）、review 线程都 resolve、不是 draft（并且 PR 是打开的）、
//         head 就是 review 过的那个提交。「review 过的提交」：带清单的 Run 看它的读取记录（最后一次读 PR 时的 head，
//         并且之后读过这个 head 的 diff）；别的调用方（Lead、daemon）要在 commitID 里写明。读不到、读不懂的一律拒绝。
//       · 读文件过禁止名单（硬性底线：仓库里提交了的 .env、私钥、凭据文件、日志也不读），和本地读取同一份名单。
//       · review 的形状（以前在 daemon 的 review-post.ts）：event 只能是 COMMENT、APPROVE、REQUEST_CHANGES；
//         提交 pending review 要给 event；行内评论要有 path、body、行号和 side。
//     哪些 PR、哪些 event 能用，是清单（或者调用方自己给的收窄清单）的事，不在这里。
//   - facts：搜索类工具（search_code 等）的仓库写在搜索词里（repo:owner/name）。只有一个 repo: 限定词、
//     没有 org:、user:、owner: 一类限定词时，认出 owner 和 repo，清单按它们检查；否则认不出，按清单的规则拒绝。
//   - observe：读到的文件内容、PR 的 head 和 diff 记进 Run 的读取记录，出处和「review 的是哪个提交」都按它核实。
//   - describe：写操作做了什么、对象和链接。
import { deniedSegment } from "./repo-paths.js";
import { parseUnifiedDiff } from "./unified-diff.js";
import type { RunReadLedger } from "./run-reads.js";
import type { ToolCallContext, ToolCallResult, ToolGuard, WriteDescription } from "./guards.js";

export const GITHUB_GUARD_CONNECTION = "github";

const SEARCH_TOOLS: ReadonlySet<string> = new Set(["search_code", "search_commits", "search_issues", "search_pull_requests"]);
// GitHub 的搜索限定词。仓库只能由一个 repo: 定下来。
const REPO_QUALIFIER = /(?:^|[\s(])repo:([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(?=$|[\s)])/gi;
const OTHER_SCOPE_QUALIFIER = /(?:^|[\s(])-?(?:org|user|owner|enterprise|fork):/i;
const NEGATED_REPO = /(?:^|[\s(])-repo:/i;

// get_file_contents 在文件内容前面加一句状态，例如「successfully downloaded text file (SHA: 1a2b…)」，再空一行。
const FILE_PREAMBLE = /^successfully downloaded[^\n]*\n\n/i;
const FILE_SHA = /\(SHA:\s*([0-9a-f]{7,64})\)/i;
const COMMIT_SHA = /^[0-9a-f]{7,64}$/i;
const GITHUB_LINK = /^https:\/\/github\.com\/[^\s<>|"]{1,400}$/;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const num = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d{1,10}$/.test(value)) return Number(value);
  return null;
};

/** 搜索词里唯一的仓库。有别的范围限定词、排除仓库、或者不止一个仓库时为 null。 */
export function searchQueryRepo(query: string): { owner: string; repo: string } | null {
  if (OTHER_SCOPE_QUALIFIER.test(query) || NEGATED_REPO.test(query)) return null;
  const found = [...query.matchAll(REPO_QUALIFIER)].map((match) => ({ owner: match[1]!, repo: match[2]! }));
  const unique = found.filter((entry, index) => found.findIndex((other) =>
    other.owner.toLowerCase() === entry.owner.toLowerCase() && other.repo.toLowerCase() === entry.repo.toLowerCase()) === index);
  return unique.length === 1 ? unique[0]! : null;
}

/** 一次调用的仓库和 PR（或 issue）号。 */
export function githubCallTarget(tool: string, args: Readonly<Record<string, unknown>>): { repo: string | null; number: number | null; path: string | null } {
  let owner = str(args.owner);
  let repo = str(args.repo);
  if (SEARCH_TOOLS.has(tool) && typeof args.query === "string") {
    const found = searchQueryRepo(args.query);
    owner = found?.owner ?? null;
    repo = found?.repo ?? null;
  }
  return {
    repo: owner && repo ? `${owner}/${repo}` : null,
    number: num(args.pullNumber) ?? num(args.issue_number),
    path: str(args.path),
  };
}

function targetText(tool: string, args: Readonly<Record<string, unknown>>): string | null {
  const { repo, number, path } = githubCallTarget(tool, args);
  if (!repo) return null;
  if (number !== null) return `${repo}#${number}`;
  return path ? `${repo}:${path}` : repo;
}

/** PR 的 JSON（pull_request_read 的 get）里的 head 提交号。读不出来时是 undefined。 */
export function pullRequestHead(text: string): string | undefined {
  try {
    const sha = (JSON.parse(text) as { head?: { sha?: unknown } } | null)?.head?.sha;
    return typeof sha === "string" && COMMIT_SHA.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 这个 Run 最后一次读 PR（pull_request_read 的 get）时看到的 head：这就是它 review 的提交。没读过时是 null。
 * 代查以前记的工具名是 github_pr，也认。
 */
export function lastReadPullRequestHead(ledger: RunReadLedger | null, pr: { repo: string; number: number }): string | null {
  if (!ledger) return null;
  const repo = pr.repo.toLowerCase();
  const path = `pull/${pr.number}/get`;
  const read = ledger.records().reverse().find((entry) => (entry.tool === "pull_request_read" || entry.tool === "github_pr")
    && entry.refused === undefined && entry.repo.toLowerCase() === repo && entry.path === path
    && entry.ref !== undefined && COMMIT_SHA.test(entry.ref));
  return read?.ref ?? null;
}

const bytesOf = (body: string): number => Buffer.byteLength(body, "utf8");

function observe(context: ToolCallContext, result: ToolCallResult): void {
  const ledger = context.ledger;
  if (!ledger) return;
  const { tool, args } = context;
  const { repo, number, path } = githubCallTarget(tool, args);
  const name = repo ?? "-";
  if (result.isError) {
    ledger.record({ tool, repo: name, ...(path ? { path } : {}), bytes: 0 });
    return;
  }
  if (tool === "get_file_contents" && repo && path) {
    const sha = FILE_SHA.exec(result.text.slice(0, 500))?.[1];
    const ref = str(args.ref) ?? str(args.sha) ?? sha;
    const content = result.text.replace(FILE_PREAMBLE, "");
    const lines = content.split(/\r?\n/);
    ledger.addLines("github", repo, path, 1, lines, ref ?? undefined);
    ledger.record({ tool, repo, path, lines: [1, Math.max(lines.length, 1)], ...(ref ? { ref } : {}), bytes: bytesOf(content) });
    return;
  }
  if (tool === "pull_request_read" && repo && number !== null) {
    const method = str(args.method) ?? "get";
    const head = method === "get" ? pullRequestHead(result.text) : undefined;
    if (method === "get_diff") ledger.addDiff(repo, parseUnifiedDiff(result.text), lastReadPullRequestHead(ledger, { repo, number }) ?? undefined);
    ledger.record({ tool, repo, path: `pull/${number}/${method}`, ...(head ? { ref: head } : {}), bytes: bytesOf(result.text) });
    return;
  }
  ledger.record({ tool, repo: name, ...(path ? { path } : {}), bytes: bytesOf(result.text) });
}

function htmlUrl(text: string): string | null {
  try {
    const value = JSON.parse(text) as { html_url?: unknown; htmlURL?: unknown; url?: unknown } | null;
    const link = typeof value?.html_url === "string" ? value.html_url : typeof value?.htmlURL === "string" ? value.htmlURL : null;
    return link && GITHUB_LINK.test(link) ? link : null;
  } catch {
    return null;
  }
}

function describe(context: ToolCallContext, result: ToolCallResult): WriteDescription {
  const { tool, args } = context;
  const { repo, number, path } = githubCallTarget(tool, args);
  const target = targetText(tool, args);
  const prUrl = repo && number !== null ? `https://github.com/${repo}/pull/${number}` : null;
  const link = htmlUrl(result.text);
  if (tool === "pull_request_review_write") {
    const method = str(args.method);
    const event = str(args.event);
    const summary = method === "delete_pending" ? `删掉了 ${target ?? "PR"} 上没提交的 review`
      : method === "create" && !event ? `在 ${target ?? "PR"} 上建了一个没提交的 review`
      : method === "resolve_thread" ? `在 ${target ?? "PR"} 上把一个 review 线程标成已解决`
      : method === "unresolve_thread" ? `在 ${target ?? "PR"} 上重新打开一个 review 线程`
      : `在 ${target ?? "PR"} 上提交了 review（${event ?? "COMMENT"}）`;
    // 没提交的 pending review（建、删）只有自己看得到。
    const visible = !(method === "delete_pending" || (method === "create" && !event));
    return { summary, target, url: link ?? prUrl, visible };
  }
  if (tool === "add_comment_to_pending_review") {
    const line = num(args.line);
    // 加在 pending review 里：提交以前别人看不到，提交时那一次写操作会记下来。
    return { summary: `在 ${target ?? "PR"} 的 review 里加了一条行内评论${path ? `（${path}${line ? `:${line}` : ""}）` : ""}`, target, url: link ?? prUrl, visible: false };
  }
  if (tool === "add_issue_comment") {
    return { summary: `在 ${target ?? "issue"} 上发了一条评论`, target, url: link ?? (repo && number !== null ? `https://github.com/${repo}/issues/${number}` : null), visible: true };
  }
  return { summary: `调用了 GitHub 的 ${tool}${target ? `（${target}）` : ""}`, target, url: link ?? prUrl, visible: true };
}

const REVIEW_EVENTS: ReadonlySet<string> = new Set(["COMMENT", "APPROVE", "REQUEST_CHANGES"]);
const COMMENT_SIDES: ReadonlySet<string> = new Set(["RIGHT", "LEFT"]);
// 算「检查通过」的 check run 结论。
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

/**
 * review 和行内评论的形状（不读 GitHub，同步）。不对时返回原因。以前是 daemon 的 reviewCallProblem 的一部分，
 * 现在对所有调用方生效。
 */
export function githubReviewShapeProblem(tool: string, args: Readonly<Record<string, unknown>>): string | null {
  if (tool === "pull_request_review_write") {
    const method = str(args.method);
    const event = args.event === undefined || args.event === null ? null : String(args.event);
    if (event !== null && !REVIEW_EVENTS.has(event)) return `review 的 event 只能是 COMMENT、APPROVE 或 REQUEST_CHANGES，不能是 ${event}`;
    if (method === "submit_pending" && event === null) return "提交 review 时要给 event";
    return null;
  }
  if (tool === "add_comment_to_pending_review") {
    if (typeof args.path !== "string" || !args.path.trim() || typeof args.body !== "string" || !args.body.trim()) {
      return "行内评论要有 path 和 body";
    }
    const subject = str(args.subjectType) ?? "LINE";
    if (subject === "FILE") return null;
    if (subject !== "LINE") return `subjectType 只能是 LINE 或 FILE，不能是 ${subject}`;
    if (!Number.isInteger(args.line) || (args.line as number) < 1 || !COMMENT_SIDES.has(String(args.side ?? "RIGHT"))) {
      return "行内评论要有 path、body、line、side（LINE）";
    }
    return null;
  }
  return null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** check run 的列表：{ check_runs: [...] } 或者直接是数组。读不懂时为 null。 */
function checkRuns(text: string): Array<{ name: string; status: string; conclusion: string | null }> | null {
  const value = parseJson(text);
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.check_runs) ? value.check_runs : null;
  if (!list) return null;
  return list.filter(isRecord).map((run) => ({
    name: typeof run.name === "string" ? run.name : "?",
    status: typeof run.status === "string" ? run.status.toLowerCase() : "",
    conclusion: typeof run.conclusion === "string" ? run.conclusion.toLowerCase() : null,
  }));
}

/** commit status：{ statuses: [{ context, state }] }。没有 status 时 GitHub 的合并状态是 pending，这里按「没有」算。 */
function commitStatuses(text: string): Array<{ context: string; state: string }> | null {
  const value = parseJson(text);
  if (!isRecord(value) || !Array.isArray(value.statuses)) return null;
  return value.statuses.filter(isRecord).map((entry) => ({
    context: typeof entry.context === "string" ? entry.context : "?",
    state: typeof entry.state === "string" ? entry.state.toLowerCase() : "",
  }));
}

/**
 * review 线程：找带布尔 isResolved（或 is_resolved）的对象。线程列表（reviewThreads、threads、nodes）明确是空的也算读懂了。
 * 读不懂（例如只有评论、没有线程的状态）时为 null。
 */
export function reviewThreadState(text: string): { total: number; unresolved: number } | null {
  const value = parseJson(text);
  if (value === undefined) return null;
  let total = 0;
  let unresolved = 0;
  let sawList = false;
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number, key: string | null): void => {
    if (depth > 6 || node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      if (key !== null && /^(reviewThreads|review_threads|threads)$/.test(key)) sawList = true;
      for (const entry of node.slice(0, 500)) visit(entry, depth + 1, null);
      return;
    }
    const record = node as Record<string, unknown>;
    const resolved = typeof record.isResolved === "boolean" ? record.isResolved : typeof record.is_resolved === "boolean" ? record.is_resolved : null;
    if (resolved !== null) {
      total += 1;
      if (!resolved) unresolved += 1;
      return;
    }
    for (const [child, entry] of Object.entries(record).slice(0, 50)) visit(entry, depth + 1, child);
  };
  visit(value, 0, null);
  return total > 0 || sawList ? { total, unresolved } : null;
}

/** 这个 Run 读过当前 head 的 diff 没有：最后一次读 PR 时的 head 是它，并且之后读了 diff。 */
function reviewedInRun(ledger: RunReadLedger, pr: { repo: string; number: number }, head: string): string | null {
  const records = ledger.records();
  const repo = pr.repo.toLowerCase();
  let seenHead: string | null = null;
  let diffAtHead = false;
  for (const record of records) {
    if ((record.tool !== "pull_request_read" && record.tool !== "github_pr") || record.refused !== undefined || record.repo.toLowerCase() !== repo) continue;
    if (record.path === `pull/${pr.number}/get` && record.ref) {
      seenHead = record.ref;
      diffAtHead = false;
    } else if (record.path === `pull/${pr.number}/get_diff` && seenHead !== null) {
      diffAtHead = true;
    }
  }
  if (seenHead === null) return "这次运行没有读过这个 PR：先读 PR（pull_request_read 的 get）和它的 diff，再决定能不能 approve";
  if (seenHead !== head) return `review 以后 PR 又有了新的提交（review 的是 ${seenHead.slice(0, 7)}，现在是 ${head.slice(0, 7)}），要重新 review`;
  if (!diffAtHead) return `还没读过 ${head.slice(0, 7)} 的 diff（pull_request_read 的 get_diff），不能算 review 过`;
  return null;
}

/** APPROVE 以前的四条检查。都过了返回 null，否则返回第一条没过的原因。 */
async function approveProblem(context: ToolCallContext): Promise<string | null> {
  const { repo, number } = githubCallTarget(context.tool, context.args);
  if (!repo || number === null) return "approve 要给 owner、repo 和 pullNumber";
  const [owner, name] = [repo.slice(0, repo.indexOf("/")), repo.slice(repo.indexOf("/") + 1)];
  const base = { owner, repo: name, pullNumber: number };
  const read = async (method: string) => context.read("pull_request_read", { ...base, method });

  // 不是 draft，PR 是打开的，现在的 head。
  const pr = await read("get");
  const prJson = pr.isError ? undefined : parseJson(pr.text);
  if (!isRecord(prJson)) return "读不到这个 PR，不能确认它能 approve";
  const head = pullRequestHead(pr.text);
  if (!head) return "读不出 PR 现在的 head 提交";
  if (typeof prJson.state === "string" && prJson.state.toLowerCase() !== "open") return `PR 不是打开的（${prJson.state}），不能 approve`;
  if (prJson.draft === true) return "PR 还是 draft，不能 approve";

  // head 就是 review 过的那个提交。
  const commitId = str(context.args.commitID);
  if (commitId && commitId !== head) return `要批准的提交 ${commitId.slice(0, 7)} 不是 PR 现在的 head ${head.slice(0, 7)}`;
  if (context.ledger) {
    const problem = reviewedInRun(context.ledger, { repo, number }, head);
    if (problem) return problem;
  } else if (!commitId) {
    return "不知道 review 的是哪个提交：commitID 要写 review 过的那个提交";
  }

  // 检查都通过。
  const runs = await read("get_check_runs");
  const statuses = await read("get_status");
  const runList = runs.isError ? null : checkRuns(runs.text);
  const statusList = statuses.isError ? null : commitStatuses(statuses.text);
  if (runList === null || statusList === null) return "读不到 PR 的检查结果，不能确认检查都通过";
  const failing = [
    ...runList.filter((run) => run.status === "completed" && !PASSING_CONCLUSIONS.has(run.conclusion ?? "")).map((run) => run.name),
    ...statusList.filter((entry) => entry.state === "failure" || entry.state === "error").map((entry) => entry.context),
  ];
  if (failing.length) return `检查没通过：${failing.slice(0, 5).join("、")}`;
  const pending = [
    ...runList.filter((run) => run.status !== "completed").map((run) => run.name),
    ...statusList.filter((entry) => entry.state !== "success").map((entry) => entry.context),
  ];
  if (pending.length) return `检查还没跑完：${pending.slice(0, 5).join("、")}`;

  // review 线程都 resolve。
  const threads = await read("get_review_comments");
  const state = threads.isError ? null : reviewThreadState(threads.text);
  if (!state) return "看不出 review 线程有没有都 resolve，不能 approve";
  if (state.unresolved > 0) return `还有 ${state.unresolved} 个 review 线程没 resolve`;
  return null;
}

async function check(context: ToolCallContext): Promise<string | null> {
  if (context.tool === "get_file_contents" && typeof context.args.path === "string") {
    const denied = deniedSegment(context.args.path);
    if (denied) return `${denied} 在禁止名单里，不能读`;
  }
  const shape = githubReviewShapeProblem(context.tool, context.args);
  if (shape) return shape;
  if (context.tool === "pull_request_review_write") {
    const method = str(context.args.method);
    const event = str(context.args.event)?.toUpperCase();
    if (event === "APPROVE" && (method === "create" || method === "submit_pending")) return approveProblem(context);
  }
  return null;
}

export function createGithubGuard(): ToolGuard {
  return {
    connection: GITHUB_GUARD_CONNECTION,
    check,
    facts(tool, args) {
      if (!SEARCH_TOOLS.has(tool) || typeof args.query !== "string") return {};
      const found = searchQueryRepo(args.query);
      // 认不出唯一的仓库：用 null 盖掉参数里可能有的 owner、repo（搜索工具不看它们），按清单的规则拒绝。
      return found ? { owner: found.owner, repo: found.repo } : { owner: null, repo: null };
    },
    target: targetText,
    observe,
    describe,
  };
}
