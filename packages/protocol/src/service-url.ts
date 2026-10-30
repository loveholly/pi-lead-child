// 外部服务的地址：决策模型（SmartModel 和记忆的 reranker）、远程 embedding。只走这一个校验（2026-10-16 发布评审）。
// 写 config.json 之前校验，读 config.json 时也校验（用户可能手改了它）。设置页用同样的文字在客户端先检查一遍。
//
// 规则：
// - 能被 new URL 解析；主机名不以点结尾（多半是输入错误），也不是未指定地址（0.0.0.0、[::]）；
// - 用 https 或 http。公司内网的 LLM gateway 常常只有 http（2026-10-26 用户决定），所以任何主机都可以用 http；
//   key 和内容这时会明文传输，设置页在地址下面提示（isPlaintextServiceUrl）。key 仍然只发给它绑定的主机；
// - 不带用户名和密码；
// - 查询参数的名字不像密钥（key、token、api_key 一类）。
import { isSensitiveFieldName } from "./redaction.ts";

export type ServiceUrlProblem = "invalid_url" | "userinfo" | "secret_query";

export const SERVICE_URL_MESSAGES: Record<ServiceUrlProblem, string> = {
  invalid_url: "地址不是合法的 URL",
  userinfo: "地址里不能带用户名或密码",
  secret_query: "地址的查询参数里不能带 key、token 一类的值",
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// 未指定地址：监听时表示「所有地址」，不是一个服务的地址（new URL 把 https://0/ 也解析成 0.0.0.0）。
const UNSPECIFIED = new Set(["0.0.0.0", "[::]"]);
// 字段名规则（redaction.ts）认不出、但在 URL 里常带凭据的查询参数：Azure 的 subscription-key、SAS 的 sig、
// OAuth 的 code（2026-10-16 发布评审）。比较时忽略大小写、- 和 _。
const SECRET_QUERY_NAMES = new Set(["subscriptionkey", "sig", "signature", "code"]);

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** 地址的问题。没有问题时是 null。 */
export function serviceUrlProblem(raw: string): ServiceUrlProblem | null {
  const url = parse(raw.trim());
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return "invalid_url";
  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith(".") || UNSPECIFIED.has(hostname)) return "invalid_url";
  if (url.username || url.password) return "userinfo";
  for (const name of url.searchParams.keys()) {
    if (isSensitiveFieldName(name) || SECRET_QUERY_NAMES.has(name.toLowerCase().replace(/[-_]/g, ""))) return "secret_query";
  }
  return null;
}

/** 合法的 http 地址，主机又不是本机：key 和内容会明文经过网络。 */
export function isPlaintextServiceUrl(raw: string): boolean {
  if (serviceUrlProblem(raw) !== null) return false;
  const url = new URL(raw.trim());
  return url.protocol === "http:" && !LOOPBACK.has(url.hostname.toLowerCase());
}

/** 合法的地址去掉首尾空白和末尾的 /。不合法时是 null。 */
export function normalizeServiceUrl(raw: string): string | null {
  if (serviceUrlProblem(raw) !== null) return null;
  const url = new URL(raw.trim());
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/** key 绑定的主机：小写的 host（带端口）。不合法的地址是 null。 */
export function serviceUrlHost(raw: string): string | null {
  if (serviceUrlProblem(raw) !== null) return null;
  return new URL(raw.trim()).host.toLowerCase();
}
