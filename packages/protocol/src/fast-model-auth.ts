// 直觉（决策模型）的鉴权头（2026-11-06）。
//
// 缺省：key 以 `Bearer <key>` 放进 Authorization 头（TypeSafe 的 Jev）。
// 公司的 LLM 网关可能要别的头，例如 x-gateway-key，值是 key 原文。这时只带这个头，不带 Authorization。
// daemon 写 config.json 之前、读 config.json 时、jev 客户端发请求之前都走这一个校验；设置页用同样的规则先检查一遍。
//
// 规则：
// - 头名是字母开头的字母、数字、- 和 _，最长 64 个字符；
// - 不能是请求本身要用的头（Host、Content-Type、Accept 一类）和 Cookie：填了它们请求就坏了，key 也可能进别的地方；
// - 空的和 Authorization（不分大小写）都是缺省，存成 null。
import { defineMessages } from "./i18n.ts";

export const DEFAULT_FAST_MODEL_AUTH_HEADER = "Authorization";
export const FAST_MODEL_AUTH_HEADER_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,63}$";
const HEADER_NAME = new RegExp(FAST_MODEL_AUTH_HEADER_PATTERN);

// 比较时用小写。
const RESERVED = new Set([
  "host", "content-type", "content-length", "content-encoding", "accept", "accept-encoding", "connection", "keep-alive",
  "transfer-encoding", "te", "trailer", "upgrade", "expect", "cookie", "proxy-authorization", "proxy-connection",
]);

export type FastModelAuthHeaderProblem = "invalid" | "reserved";

/** 头名的问题。空的和 Authorization 没有问题（它们是缺省）。 */
export function fastModelAuthHeaderProblem(raw: string): FastModelAuthHeaderProblem | null {
  const name = raw.trim();
  if (!name) return null;
  if (!HEADER_NAME.test(name)) return "invalid";
  if (RESERVED.has(name.toLowerCase())) return "reserved";
  return null;
}

/** 合法的头名：缺省（空、Authorization）是 null，别的去掉首尾空白。不合法时也是 null，调用方先用 fastModelAuthHeaderProblem 查。 */
export function normalizeFastModelAuthHeader(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name || fastModelAuthHeaderProblem(name) !== null) return null;
  return name.toLowerCase() === DEFAULT_FAST_MODEL_AUTH_HEADER.toLowerCase() ? null : name;
}

/** 发请求时带的鉴权头。只有这一个头里有 key。 */
export function fastModelAuthHeaders(authHeader: string | null | undefined, apiKey: string): Record<string, string> {
  const name = normalizeFastModelAuthHeader(authHeader);
  return name ? { [name]: apiKey } : { [DEFAULT_FAST_MODEL_AUTH_HEADER]: `Bearer ${apiKey}` };
}

export const fastModelAuthHeaderMessages = defineMessages({
  en: {
    invalid: "The header name can contain only letters, digits, - and _, must start with a letter, and can have at most 64 characters",
    reserved: "This header is used by the request itself. Use another header name for the key",
  } satisfies Record<FastModelAuthHeaderProblem, string>,
  zh: {
    invalid: "头名只能用字母、数字、- 和 _，要以字母开头，最长 64 个字符",
    reserved: "这个头是请求本身要用的，不能放 key。换一个头名",
  },
});
