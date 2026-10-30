// 测试用的假 GitHub（slack-takeover 工单 06）：gh 登录的账号（api.github.com/user）和 GitHub 的远程 MCP
// （api.githubcopilot.com/mcp/），都挂在注入的 fetch 上，不走网络。daemon 的 ConnectionHub 和真的 GitHub 一样连它。
// 工具的名字和参数照 github-mcp-server：
//   - pull_request_read（只读）：get、get_diff、get_files、get_review_comments（review 线程，带 isResolved）、get_reviews、
//     get_check_runs、get_status；
//   - pull_request_review_write（写）：create（不带 event 时建 pending review）、submit_pending、delete_pending、resolve_thread；
//   - add_comment_to_pending_review（写）、add_issue_comment（写）、merge_pull_request（写，测试检查没有人调用它）；
//   - get_file_contents、search_code（只读）。
// 提交的 review 里每一条行内评论开一个没 resolve 的 review 线程（和 GitHub 一样）。
// 行为照 GitHub 的规则：一个人在一个 PR 上同时只能有一个 pending review；列 review 时只看得到自己的 pending review；
// 行内评论只能加在 diff 里的行上（加不上时工具返回 isError）。测试可以注入故障（failNext）。
import { parseUnifiedDiff } from "../src/unified-diff.js";

export const FAKE_GH_TOKEN = `gho_${"f".repeat(36)}`;
export const FAKE_GITHUB_MCP = "https://api.githubcopilot.com/mcp/";

export interface FakePullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  headSha: string;
  diff: string;
  draft?: boolean;
  state?: "open" | "closed";
  // CI：check run 和老式的 commit status。不给时都没有。
  checkRuns?: Array<{ name: string; status: string; conclusion: string | null }>;
  statuses?: Array<{ context: string; state: "success" | "pending" | "failure" | "error" }>;
  // review 线程（除了提交 review 时自动开的那些）。
  threads?: FakeThread[];
}

export interface FakeThread { id: string; isResolved: boolean; path?: string; line?: number; body?: string }

export interface FakeReviewComment { path: string; line: number; side: string; body: string }

export interface FakeReview {
  id: number;
  pr: string;
  user: string;
  state: "PENDING" | "COMMENTED" | "APPROVED" | "CHANGES_REQUESTED";
  body: string;
  commitId: string;
  comments: FakeReviewComment[];
}

// 故障：error 让工具返回 isError（GitHub 拒绝了）；rpc 回 JSON-RPC 的错误（daemon 那边是抛错）；
// lost 先照常做完，再回 HTTP 502（做成了，回复丢了）。
export type FakeGithubFault = "error" | "rpc" | "lost";

type CallResult = { text: string; isError: boolean };

const prKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`.toLowerCase();

export class FakeGithub {
  readonly login: string;
  readonly prs = new Map<string, FakePullRequest>();
  readonly reviews: FakeReview[] = [];
  // 每一次 tools/call：工具名和参数。
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  // 下一次调用这个工具（或者 pull_request_review_write 的某个 method，写成 "pull_request_review_write:submit_pending"）时的故障。
  readonly faults = new Map<string, FakeGithubFault>();
  // 这些行（path:line:side）加评论时 GitHub 拒绝。
  readonly rejectedLines = new Set<string>();
  // 仓库里的文件：owner/repo:path（小写）→ 内容和 sha。
  readonly files = new Map<string, { content: string; sha: string }>();
  // 发在 issue（或 PR 对话）上的评论。
  readonly issueComments: Array<{ repo: string; number: number; body: string }> = [];
  #nextReviewId = 9001;
  #nextThread = 1;

  constructor(options: { login?: string } = {}) {
    this.login = options.login ?? "octo-me";
  }

  addPullRequest(pr: FakePullRequest): void {
    this.prs.set(prKey(pr.owner, pr.repo, pr.number), pr);
  }

  addFile(owner: string, repo: string, path: string, content: string, sha = "f".repeat(40)): void {
    this.files.set(`${owner}/${repo}:${path}`.toLowerCase(), { content, sha });
  }

  failNext(target: string, fault: FakeGithubFault): void {
    this.faults.set(target, fault);
  }

  /** 这个 PR 上提交了的 review（别人看得到的）。 */
  submitted(owner: string, repo: string, number: number): FakeReview[] {
    return this.reviews.filter((review) => review.pr === prKey(owner, repo, number) && review.state !== "PENDING");
  }

  pending(owner: string, repo: string, number: number): FakeReview[] {
    return this.reviews.filter((review) => review.pr === prKey(owner, repo, number) && review.state === "PENDING");
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
    const bearer = new Headers(init.headers).get("authorization");
    if (url.host === "api.github.com" && url.pathname === "/user") {
      return bearer === `Bearer ${FAKE_GH_TOKEN}` ? json(200, { login: this.login }) : json(401, { message: "Bad credentials" });
    }
    if (`${url.origin}${url.pathname}` !== FAKE_GITHUB_MCP) return json(404, { message: "Not Found" });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (bearer !== `Bearer ${FAKE_GH_TOKEN}`) return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
    const message = JSON.parse(String(init.body ?? "{}")) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: message.id, result }, message.method === "initialize" ? { "mcp-session-id": "gh-session" } : {});
    if (message.method === "initialize") {
      return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake-github", version: "1" } });
    }
    if (message.method === "tools/list") return reply({ tools: TOOLS });
    if (message.method !== "tools/call") {
      return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
    }
    const name = message.params?.name ?? "";
    const args = message.params?.arguments ?? {};
    this.calls.push({ tool: name, args });
    const target = name === "pull_request_review_write" ? `${name}:${String(args.method)}` : name;
    const fault = this.faults.get(target) ?? this.faults.get(name);
    if (fault) {
      this.faults.delete(this.faults.has(target) ? target : name);
      if (fault === "rpc") return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `${target} failed upstream` } });
      if (fault === "error") return reply({ content: [{ type: "text", text: `${target}: GitHub refused the request` }], isError: true });
    }
    const result = this.call(name, args);
    if (fault === "lost") return new Response("bad gateway", { status: 502 });
    return reply({ content: [{ type: "text", text: result.text }], isError: result.isError });
  };

  /** 直接调一个工具（单元测试不经过 MCP 时用）。故障照样生效。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallResult> {
    this.calls.push({ tool: name, args });
    const target = name === "pull_request_review_write" ? `${name}:${String(args.method)}` : name;
    const fault = this.faults.get(target) ?? this.faults.get(name);
    if (fault) {
      this.faults.delete(this.faults.has(target) ? target : name);
      if (fault === "rpc") throw new Error(`${target} failed upstream`);
      if (fault === "error") return { text: `${target}: GitHub refused the request`, isError: true };
    }
    const result = this.call(name, args);
    if (fault === "lost") throw new Error("the MCP server returned HTTP 502");
    return result;
  }

  /** 一个 PR 现在的 review 线程：PR 自己带的，加上提交的 review 里每一条行内评论开的。 */
  threads(owner: string, repo: string, number: number): FakeThread[] {
    const pr = this.prs.get(prKey(owner, repo, number));
    if (!pr) return [];
    pr.threads ??= [];
    return pr.threads;
  }

  private call(name: string, args: Record<string, unknown>): CallResult {
    const error = (text: string): CallResult => ({ text, isError: true });
    if (name === "get_file_contents") {
      const file = this.files.get(`${String(args.owner)}/${String(args.repo)}:${String(args.path)}`.toLowerCase());
      if (!file) return error("file not found");
      return { text: `successfully downloaded text file (SHA: ${file.sha})\n\n${file.content}`, isError: false };
    }
    if (name === "search_code") {
      const query = String(args.query ?? "");
      const repo = /repo:(\S+)/.exec(query)?.[1]?.toLowerCase();
      const needle = query.replace(/repo:\S+/g, "").trim().toLowerCase();
      const items = [...this.files.entries()]
        .filter(([key, file]) => (!repo || key.startsWith(`${repo}:`)) && file.content.toLowerCase().includes(needle))
        .map(([key]) => ({ path: key.slice(key.indexOf(":") + 1), repository: { full_name: key.slice(0, key.indexOf(":")) } }));
      return { text: JSON.stringify({ total_count: items.length, items }), isError: false };
    }
    if (name === "add_issue_comment") {
      this.issueComments.push({ repo: `${String(args.owner)}/${String(args.repo)}`, number: Number(args.issue_number), body: String(args.body) });
      return { text: JSON.stringify({ id: 1, html_url: `https://github.com/${String(args.owner)}/${String(args.repo)}/issues/${String(args.issue_number)}#issuecomment-1` }), isError: false };
    }
    const pr = this.prs.get(prKey(String(args.owner), String(args.repo), Number(args.pullNumber)));
    if (!pr) return error("pull request not found");
    const key = prKey(pr.owner, pr.repo, pr.number);
    const mine = () => this.reviews.find((review) => review.pr === key && review.user === this.login && review.state === "PENDING");
    const url = (review: FakeReview) => `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}#pullrequestreview-${review.id}`;
    switch (name) {
      case "pull_request_read":
        switch (args.method) {
          case "get":
            return {
              text: JSON.stringify({
                number: pr.number, title: pr.title, body: pr.body, state: pr.state ?? "open", draft: pr.draft ?? false,
                head: { sha: pr.headSha, ref: "feature" }, html_url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
              }),
              isError: false,
            };
          case "get_check_runs":
            return { text: JSON.stringify({ total_count: (pr.checkRuns ?? []).length, check_runs: pr.checkRuns ?? [] }), isError: false };
          case "get_status": {
            const statuses = pr.statuses ?? [];
            const state = statuses.some((entry) => entry.state === "failure" || entry.state === "error") ? "failure"
              : statuses.length === 0 || statuses.some((entry) => entry.state === "pending") ? "pending" : "success";
            return { text: JSON.stringify({ state, total_count: statuses.length, statuses, sha: pr.headSha }), isError: false };
          }
          case "get_diff":
            return { text: pr.diff, isError: false };
          case "get_files":
            return { text: JSON.stringify([...new Set(parseUnifiedDiff(pr.diff).map((line) => line.path))].map((filename) => ({ filename }))), isError: false };
          case "get_review_comments":
            return {
              text: JSON.stringify({
                reviewThreads: this.threads(pr.owner, pr.repo, pr.number).map((thread) => ({
                  id: thread.id, isResolved: thread.isResolved, isOutdated: false,
                  comments: { nodes: [{ path: thread.path ?? null, line: thread.line ?? null, body: thread.body ?? "" }] },
                })),
              }),
              isError: false,
            };
          case "get_reviews":
            // 别人的 pending review 看不到。
            return {
              text: JSON.stringify(this.reviews.filter((review) => review.pr === key && (review.state !== "PENDING" || review.user === this.login))
                .map((review) => ({ id: review.id, user: { login: review.user }, state: review.state, body: review.body, commit_id: review.commitId, html_url: url(review) }))),
              isError: false,
            };
          default:
            return error(`unknown method ${String(args.method)}`);
        }
      case "pull_request_review_write":
        switch (args.method) {
          case "create": {
            if (mine()) return error("failed to create review: user already has a pending review");
            const review: FakeReview = {
              id: this.#nextReviewId++, pr: key, user: this.login, body: typeof args.body === "string" ? args.body : "",
              commitId: typeof args.commitID === "string" ? args.commitID : pr.headSha, comments: [],
              state: args.event === undefined ? "PENDING" : eventState(args.event),
            };
            this.reviews.push(review);
            return { text: args.event === undefined ? "pending pull request created" : "pull request review created", isError: false };
          }
          case "submit_pending": {
            const review = mine();
            if (!review) return error("no pending review found for the viewer");
            review.state = eventState(args.event);
            if (typeof args.body === "string") review.body = args.body;
            for (const comment of review.comments) {
              this.threads(pr.owner, pr.repo, pr.number).push({
                id: `thread-${this.#nextThread++}`, isResolved: false, path: comment.path, line: comment.line, body: comment.body,
              });
            }
            return { text: "pending pull request review successfully submitted", isError: false };
          }
          case "resolve_thread": {
            const thread = this.threads(pr.owner, pr.repo, pr.number).find((entry) => entry.id === args.threadId);
            if (!thread) return error("thread not found");
            thread.isResolved = true;
            return { text: "review thread resolved", isError: false };
          }
          case "delete_pending": {
            const review = mine();
            if (!review) return error("no pending review found for the viewer");
            this.reviews.splice(this.reviews.indexOf(review), 1);
            return { text: "pending pull request review successfully deleted", isError: false };
          }
          default:
            return error(`unknown method ${String(args.method)}`);
        }
      case "add_comment_to_pending_review": {
        const review = mine();
        if (!review) return error("no pending review found for the viewer");
        const line = Number(args.line);
        const side = String(args.side ?? "RIGHT");
        const inDiff = parseUnifiedDiff(pr.diff).some((entry) => entry.path === args.path && entry.line === line && entry.side === side);
        if (!inDiff || this.rejectedLines.has(`${String(args.path)}:${line}:${side}`)) {
          return error("failed to add comment: Line could not be resolved");
        }
        review.comments.push({ path: String(args.path), line, side, body: String(args.body) });
        return { text: "pull request review comment successfully added to pending review", isError: false };
      }
      case "merge_pull_request":
        return { text: "merged", isError: false };
      default:
        return error(`unknown tool ${name}`);
    }
  }
}

function eventState(event: unknown): FakeReview["state"] {
  if (event === "APPROVE") return "APPROVED";
  if (event === "REQUEST_CHANGES") return "CHANGES_REQUESTED";
  return "COMMENTED";
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const TOOLS = [
  {
    name: "pull_request_read", description: "Get information on a specific pull request",
    inputSchema: object({ method: { type: "string" }, owner: { type: "string" }, repo: { type: "string" }, pullNumber: { type: "number" } }, ["method", "owner", "repo", "pullNumber"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "pull_request_review_write", description: "Create and/or submit, delete review of a pull request",
    inputSchema: object({ method: { type: "string" }, owner: { type: "string" }, repo: { type: "string" }, pullNumber: { type: "number" }, body: { type: "string" }, event: { type: "string" }, commitID: { type: "string" } }, ["method", "owner", "repo", "pullNumber"]),
  },
  {
    name: "add_comment_to_pending_review", description: "Add review comment to the requester's latest pending pull request review",
    inputSchema: object({ owner: { type: "string" }, repo: { type: "string" }, pullNumber: { type: "number" }, path: { type: "string" }, body: { type: "string" }, subjectType: { type: "string" }, line: { type: "number" }, side: { type: "string" } }, ["owner", "repo", "pullNumber", "path", "body", "subjectType"]),
  },
  {
    name: "add_issue_comment", description: "Add a comment to an issue or pull request",
    inputSchema: object({ owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "number" }, body: { type: "string" } }, ["owner", "repo", "issue_number", "body"]),
  },
  {
    name: "get_file_contents", description: "Get the contents of a file",
    inputSchema: object({ owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } }, ["owner", "repo"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_code", description: "Search code across repositories",
    inputSchema: object({ query: { type: "string" } }, ["query"]),
    annotations: { readOnlyHint: true },
  },
  {
    name: "merge_pull_request", description: "Merge a pull request",
    inputSchema: object({ owner: { type: "string" }, repo: { type: "string" }, pullNumber: { type: "number" } }, ["owner", "repo", "pullNumber"]),
  },
];
