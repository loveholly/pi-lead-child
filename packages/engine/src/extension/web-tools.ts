// 注入 child 的 web 工具。零依赖零 key——web_fetch 就是 HTTP GET + HTML 转文本，
// 和 Claude Code/Codex 的内置 fetch 同理。search（从 query 发现 URL）需要搜索后端，另行。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// 极简 HTML → 纯文本：去脚本/样式、去标签、解实体、压空白。够喂给 LLM 阅读。
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchUrl(
  url: string,
  opts: { maxChars?: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<{ status: number; text: string; truncated: boolean }> {
  const max = opts.maxChars ?? 8000;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await fetch(url, {
    signal, redirect: "follow",
    headers: { "user-agent": "pi-lead-child/1.0 (+web_fetch)" },
  });
  const ct = res.headers.get("content-type") ?? "";
  let body = await res.text();
  if (ct.includes("html")) body = htmlToText(body);
  const truncated = body.length > max;
  return { status: res.status, text: body.slice(0, max), truncated };
}

export interface SearchResult { title: string; url: string; content: string }

// tavily REST 搜索（不走 MCP——对 pi child 而言 REST 等价且简单得多）。baseUrl 可注入供测试。
export async function tavilySearch(
  query: string,
  opts: { apiKey: string; maxResults?: number; signal?: AbortSignal; baseUrl?: string },
): Promise<SearchResult[]> {
  const base = opts.baseUrl ?? "https://api.tavily.com";
  const res = await fetch(`${base}/search`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({ query, max_results: opts.maxResults ?? 5, search_depth: "basic" }),
    signal: opts.signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = (await res.json()) as { results?: SearchResult[] };
  return data.results ?? [];
}

export default function (pi: ExtensionAPI) {
  const tavilyKey = process.env.PLC_TAVILY_KEY ?? process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    pi.registerTool({
      name: "web_search",
      label: "Web Search",
      description:
        "用搜索引擎从关键词发现相关网页（返回标题/URL/摘要）。调研时先 web_search 找来源，再对感兴趣的 URL 用 web_fetch 读全文。产出必须引用找到的真实来源。",
      parameters: Type.Object({
        query: Type.String(),
        max_results: Type.Optional(Type.Number({ description: "结果条数，默认 5" })),
      }),
      async execute(_toolCallId: string, params: { query: string; max_results?: number }, signal?: AbortSignal) {
        const done = (text: string, details: Record<string, unknown>) =>
          ({ content: [{ type: "text" as const, text }], details });
        try {
          const results = await tavilySearch(params.query, {
            apiKey: tavilyKey, maxResults: params.max_results, signal,
            baseUrl: process.env.PLC_TAVILY_URL,
          });
          if (!results.length) return done(`无结果：${params.query}`, { count: 0 });
          const text = results.map((r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content.slice(0, 300)}`).join("\n\n");
          return done(text, { count: results.length });
        } catch (e: any) {
          return done(`搜索失败：${e.message}`, { error: String(e) });
        }
      },
    });
  }

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "抓取一个 URL 的内容（HTTP GET，HTML 自动转纯文本，超长截断）。用于阅读网页/在线文档/API 响应。" +
      "无需 key。只读、无副作用。做调研时用它获取真实内容，不要凭记忆编造。",
    parameters: Type.Object({
      url: Type.String({ description: "要抓取的完整 URL（http/https）" }),
      max_chars: Type.Optional(Type.Number({ description: "返回正文最大字符数，默认 8000" })),
    }),
    async execute(_toolCallId: string, params: { url: string; max_chars?: number }, signal?: AbortSignal) {
      const done = (text: string, details: Record<string, unknown>) =>
        ({ content: [{ type: "text" as const, text }], details });
      try {
        const r = await fetchUrl(params.url, { maxChars: params.max_chars, signal });
        const note = r.truncated ? "\n\n[已截断]" : "";
        return done(`# ${params.url} (HTTP ${r.status})\n\n${r.text}${note}`, { status: r.status, truncated: r.truncated });
      } catch (e: any) {
        return done(`抓取失败 ${params.url}: ${e.message}`, { error: String(e) });
      }
    },
  });
}
