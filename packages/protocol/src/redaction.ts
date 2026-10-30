// 工具参数和结果里的密钥。只有这一套规则：
// - 网关把工具事件落库、推给客户端之前（packages/gateway 的 redactProtocolValue）；
// - 会话快照和实时事件折叠工具调用时的展示投影（conversation-tool-calls.ts 的 projectToolDisplay）；
// - companion 执行日志里的命令、失败原因和 stderr。
// 界面拿到的参数和结果都已经过这里，组件库不再自己脱敏。
//
// 这些函数跑在 daemon 的同步事件路径上，所以每条规则都必须是线性的：量词都有上限，起点都锚在
// 固定的字符或前一个字符上，不会从每个位置一路扫到末尾（第二轮发布评审：200 KB 的输入曾要 52 秒）。
// 调用方先截断再脱敏（redactAndCap）。
export const REDACTED = "[REDACTED]";

// ——— 字段名 ———
// 按词判断。拼在一起也认的复合词放在 SENSITIVE_PARTS；容易误伤的短词只认整个词（一个分段）。
// 所以 accessToken、X-Api-Key、AWS_SECRET_ACCESS_KEY、_auth 都算；author、sort_key、keyboard、max_tokens 不算。
// 名字恰好是 key 时也算（{"key": …}、--key …）。
const SENSITIVE_PARTS = [
  "password", "passwd", "secret", "credential", "authorization",
  "apikey", "accesskey", "privatekey", "sshkey", "clientkey", "signingkey",
  "authtoken", "accesstoken", "refreshtoken", "sessiontoken", "bearertoken",
];
const SENSITIVE_WORDS = new Set(["token", "pwd", "cookie", "cookies", "passphrase", "auth"]);

// 像密钥的名字都含这些片段之一。文本里一个都没有时，键值对的规则不必跑。
const SENSITIVE_HINT = /pass|pwd|secret|credential|auth|key|token|cookie/i;

// 同一段文本里名字大量重复（日志、JSON 数组），所以记住判断过的名字。
const nameCache = new Map<string, boolean>();

export function isSensitiveFieldName(name: string): boolean {
  const cached = nameCache.get(name);
  if (cached !== undefined) return cached;
  const sensitive = SENSITIVE_HINT.test(name) && classifyName(name);
  if (nameCache.size >= 4_096) nameCache.clear();
  nameCache.set(name, sensitive);
  return sensitive;
}

function classifyName(name: string): boolean {
  const compact = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (compact === "key") return true;
  if (SENSITIVE_PARTS.some((part) => compact.includes(part))) return true;
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .some((word) => SENSITIVE_WORDS.has(word.toLowerCase()));
}

// ——— 自由文本 ———
const MAX_VALUE = 4_096;
// 不带引号的值到这些字符为止。
const VALUE_STOP = new Set([" ", "\t", "\n", "\r", "\"", "'", ",", ";", "&", "}", "]", ")"]);

// 从 start 开始的一个值在哪里结束：带引号的到对应的引号，{ 或 [ 到配对的括号，其余到 VALUE_STOP。
// 最多看 MAX_VALUE 个字符；看不到结尾时到这个上限为止（宁可多盖）。
function valueEnd(text: string, start: number): number {
  const limit = Math.min(text.length, start + MAX_VALUE);
  const first = text[start];
  if (first === "\"" || first === "'") {
    for (let i = start + 1; i < limit; i += 1) {
      if (text[i] === "\\") { i += 1; continue; }
      if (text[i] === first) return i + 1;
      if (text[i] === "\n") return i;
    }
    return limit;
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < limit; i += 1) {
      const char = text[i]!;
      if (quote) {
        if (char === "\\") i += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "\"" || char === "'") quote = char;
      else if (char === "{" || char === "[") depth += 1;
      else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }
    return limit;
  }
  let end = start;
  while (end < limit && !VALUE_STOP.has(text[end]!)) end += 1;
  return end;
}

function redactedValue(text: string, start: number): string {
  const first = text[start];
  if (first === "\"" || first === "'") return `${first}${REDACTED}${first}`;
  if (first === "{" || first === "[") return `"${REDACTED}"`;
  return REDACTED;
}

// 找到「名字 + 分隔符」以后，只有名字像密钥时才吃掉后面的值。名字不像密钥时什么也不吃，
// 所以 --from-literal=password=hunter2、--env=MYSQL_ROOT_PASSWORD=x、{"data":{"password":"x"}} 里
// 里层的那一对照样会被找到。
function redactPairs(text: string, pattern: RegExp, nameGroup: number): string {
  let output = "";
  let last = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const valueStart = match.index + match[0].length;
    if (!isSensitiveFieldName(match[nameGroup]!) || valueStart >= text.length || text[valueStart] === "-") continue;
    // 前面的规则已经盖掉的值（[REDACTED]…）不再动：不然它会被当成一个 JSON 数组再盖一层。
    if (text.startsWith("[REDACTED", valueStart) || text.startsWith(`"${REDACTED}`, valueStart)) continue;
    const end = valueEnd(text, valueStart);
    if (end === valueStart) continue;
    output += text.slice(last, valueStart) + redactedValue(text, valueStart);
    last = end;
    pattern.lastIndex = end;
  }
  return last === 0 ? text : output + text.slice(last);
}

// "name": value 和 'name': value（JSON、Python 打印出来的字典）。
const QUOTED_KEY = /(["'])([^"'\\\n]{1,80})\1\s{0,4}:\s{0,4}/g;
// name=value、--name=value、name: value。名字前面不能是名字里的字符，所以起点只在名字开头。
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])(-{0,2})([A-Za-z_][A-Za-z0-9_.-]{0,63})(?:\s{0,4}=\s{0,4}|:[ \t]{1,4})/g;
// --name value（空格分开的命令行参数）。
const FLAG = /(?<!\S)--?([A-Za-z][A-Za-z0-9-]{0,63})[ \t]{1,4}/g;

// 前缀 token 的起点：前一个字符不能是字母或数字。JWT 的前一个字符也不能是 - 或 _：
// 否则 eyJ-eyJ-… 这样的输入会让每个起点都扫一遍长串再失败。
const TOOL_TOKEN = String.raw`(?<![A-Za-z0-9])`;
const JWT_START = String.raw`(?<![A-Za-z0-9_-])`;
// [规则, 替换, 前提]。前提是一个必须出现的片段：文本里没有它时这条规则不跑（便宜的 includes）。
type Rule = [RegExp, (match: string, ...groups: string[]) => string, string?];
const TEXT_RULES: Rule[] = [
  // PEM 私钥（含 PGP）：BEGIN 到 END，截断后没有 END 时到文本末尾。
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
    () => "[REDACTED PRIVATE KEY]", "-----BEGIN"],
  // 请求头和它的变体：Authorization、Proxy-Authorization、Cookie、Set-Cookie 的整个值，不管是什么 scheme。
  [/\b((?:proxy-)?authorization|set-cookie|cookie)([ \t]{0,8}[:=][ \t]{0,8})([^\r\n'"]{1,4096})/gi,
    (_m, name, sep) => `${name}${sep}${REDACTED}`],
  // URL 里的用户信息：scheme://user:pass@host。起点锚在 ://。
  [/(:\/\/)([^\s:@/'"]{1,128}):([^\s@/'"]{1,256})@/g, (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`, "://"],
  // curl -u user:pass、-uuser:pass、--user user:pass、--user=user:pass。
  [/(^|\s)(-u[ \t]{0,4}|--user(?:[ \t]{1,4}|=))(['"]?)([^\s'":]{1,128}):([^\s'"]{1,256})/g,
    (_m, pre, flag, quote, user) => `${pre}${flag}${quote}${user}:${REDACTED}`, "-"],
  // mysql 一类工具的 -p<密码>（-p 后面紧跟密码）。
  [/\b(mysql|mysqldump|mysqladmin|mysqlimport|mysqlshow|mysqlcheck|mariadb[\w-]{0,16})\b([^\n]{0,80}?\s-p)(?!\s)([^\s'"]{1,256})/g,
    (_m, tool, middle) => `${tool}${middle}${REDACTED}`, "-p"],
  // sshpass -p <密码>、docker login -p <密码>。
  [/\b(sshpass[ \t]{1,4}-p[ \t]{0,4})([^\s'"]{1,256})/g, (_m, flag) => `${flag}${REDACTED}`, "sshpass"],
  [/\b(docker[ \t]{1,4}login\b[^\n]{0,80}?\s-p(?:[ \t]{1,4}|=))([^\s'"]{1,256})/g, (_m, flag) => `${flag}${REDACTED}`, "login"],
  // aws configure set <名字> <值>。
  [/\b(aws[ \t]{1,4}configure[ \t]{1,4}set[ \t]{1,4})([A-Za-z0-9_.-]{1,64})([ \t]{1,4})([^\s'"]{1,1024})/g,
    (match, prefix, name, sep) => isSensitiveFieldName(name) ? `${prefix}${name}${sep}${REDACTED}` : match, "configure"],
  // 认得出前缀的 token：GitHub、GitLab、Slack（xox?-、会轮换的 xoxe.、app-level 的 xapp-）、OpenAI / Anthropic、Stripe、npm、AWS、Google，以及 JWT。
  [new RegExp(`${TOOL_TOKEN}(?:gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|glpat-[A-Za-z0-9_-]{16,255}`
    + `|xox[abprs]-[A-Za-z0-9-]{10,255}|xoxe[.-][A-Za-z0-9.-]{10,255}|xapp-[A-Za-z0-9-]{10,255}`
    + `|[sr]k_(?:live|test)_[A-Za-z0-9]{10,255}|sk-[A-Za-z0-9_-]{16,255}`
    + `|npm_[A-Za-z0-9]{30,64}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,64}|ya29\\.[A-Za-z0-9_-]{10,255}`
    + `)|${JWT_START}eyJ[A-Za-z0-9_-]{5,512}\\.eyJ[A-Za-z0-9_-]{5,4096}\\.[A-Za-z0-9_-]{0,1024}`, "g"), () => REDACTED],
  // 散落在文字里的 Bearer xxx / Basic xxx。值要像 token：至少一个数字或符号（排除 Bearer Bearer 这样的普通词）。
  [/\b(Bearer|Basic)[ \t]{1,4}(?=[A-Za-z]{0,4096}[0-9._~+/=-])[A-Za-z0-9._~+/=-]{6,4096}/g, (_m, scheme) => `${scheme} ${REDACTED}`, "B"],
];

function redactTextRules(text: string): string {
  let value = text;
  for (const [pattern, replace, requires] of TEXT_RULES) {
    if (requires && !value.includes(requires)) continue;
    value = value.replace(pattern, replace as (match: string, ...groups: unknown[]) => string);
  }
  if (!SENSITIVE_HINT.test(value)) return value;
  value = redactPairs(value, QUOTED_KEY, 2);
  value = redactPairs(value, ASSIGNMENT, 2);
  return redactPairs(value, FLAG, 1);
}

// ——— 文本里的 JSON ———
// MCP 工具的结果常是 content[].text 里的一段 JSON。能解析时按字段名脱敏，和对象一样；解析不了（被截断）时
// 落到上面的文本规则。只解析不太大的文本：JSON.parse 本身是线性的，但不必为几 MB 的输出建一棵树。
const JSON_TEXT_LIMIT = 64 * 1024;
const MAX_JSON_DEPTH = 12;

function redactJsonText(text: string, depth: number): string | null {
  if (text.length > JSON_TEXT_LIMIT || depth > 2 || !/^\s*[[{]/.test(text)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const state = { changed: false };
  const clean = redactJsonValue(parsed, state, 0, depth);
  return state.changed ? JSON.stringify(clean) : text;
}

function redactJsonValue(value: unknown, state: { changed: boolean }, level: number, depth: number): unknown {
  if (typeof value === "string") {
    const clean = redactText(value, depth + 1);
    if (clean !== value) state.changed = true;
    return clean;
  }
  if (value === null || typeof value !== "object" || level > MAX_JSON_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, state, level + 1, depth));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (!isSensitiveFieldName(key)) return [key, redactJsonValue(item, state, level + 1, depth)];
    state.changed = true;
    return [key, REDACTED];
  }));
}

function redactText(text: string, depth: number): string {
  return redactJsonText(text, depth) ?? redactTextRules(text);
}

// 自由文本里的密钥：命令、请求头、URL、工具输出、JSON 文本。线性时间。
export function redactSecretText(text: string): string {
  return redactText(text, 0);
}

// 先截断再脱敏：只看前 limit 个字符再多一点（盖住跨在截断处的密钥）。能整段解析的小 JSON 例外，
// 它按字段名脱敏以后再截断。
const CUT_MARGIN = 512;

export function redactAndCap(text: string, limit: number): { text: string; redacted: boolean; truncated: boolean } {
  const structural = redactJsonText(text, 0);
  const source = structural === null && text.length > limit ? text.slice(0, limit + CUT_MARGIN) : text;
  const clean = structural ?? redactTextRules(source);
  const redacted = structural === null ? clean !== source : structural !== text;
  return clean.length > limit
    ? { text: clean.slice(0, limit), redacted, truncated: true }
    : { text: clean, redacted, truncated: text.length > limit && structural === null };
}

// ——— 已知密钥的值 ———
// 上面的规则按名字和格式认密钥。child 执行 `env | grep` 时，AM_API_KEY 的值会出现在命令输出里，
// 前面没有名字（2026-10-19 审查：值进了 runtime-events 和 child 的会话记录）。所以 daemon 记录 child 的事件和会话、
// Lead 读文件时，还要按值盖掉已知的密钥：名字像密钥、值也像密钥的环境变量的值。

const MIN_SECRET_VALUE = 8;

/**
 * 环境变量的名字像不像密钥：字段名的规则（isSensitiveFieldName），再加上 _KEY、_PAT、_PASS 结尾的名字（例如 OPENROUTER_KEY）。
 * 这条只用于环境变量：字段名里 sort_key、cache_key 很常见，环境变量里几乎没有。
 */
export function isSecretEnvName(name: string): boolean {
  return isSensitiveFieldName(name) || /(^|_)(KEY|PAT|PASS)$/i.test(name);
}

/**
 * 一个值像不像密钥：12 个字符以上，没有空白，不是路径或 URL，有字母和数字，并且有一段连续 16 个字符以上的字母数字
 * （随机生成的 key、token 都有这样一段；模型名、路径、单词串被 - / . 切得很碎）。
 * 只按名字收集会误伤：例如值是 antigravity/gemini-3-pro-2026 的变量，盖掉以后会话文件被永久改写（2026-10-19 审查和复审）。
 */
export function looksLikeSecretValue(value: string): boolean {
  if (value.length < 12 || /\s/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("~") || value.includes("://")) return false;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  return (value.match(/[A-Za-z0-9]{16,}/g) ?? []).length > 0;
}

// 一定是密钥的变量：supervisor 从 Keychain 注入 daemon 环境的那几个（supervisor 的 KEYCHAIN_ENV_KEYS，测试核对两边一致）。
// 它们的值不看长相：8 个字符以上就盖。
export const KNOWN_SECRET_ENV_NAMES: readonly string[] = ["AM_API_KEY", "TAVILY_API_KEY", "NPM_TOKEN"];

/** 环境里的密钥值：已知的密钥变量，以及名字像密钥、值也像密钥的变量。长的在前（一个值是另一个的一部分时，先盖长的）。 */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (KNOWN_SECRET_ENV_NAMES.includes(name) ? value.length >= MIN_SECRET_VALUE : isSecretEnvName(name) && looksLikeSecretValue(value)) {
      values.add(value);
    }
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** 把文字里出现的已知密钥的值换成 [REDACTED]。JSON 转义过的形式也换。 */
export function redactKnownValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value.length < MIN_SECRET_VALUE) continue;
    if (out.includes(value)) out = out.split(value).join(REDACTED);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value && out.includes(escaped)) out = out.split(escaped).join(REDACTED);
  }
  return out;
}
