// /v1/channels/settings 的路由（设置页「消息通道」，slack-settings 工单 S1；契约在 protocol 的 channel-settings.ts）。
// 网关只做认证、校验请求体，再交给 daemon 的通道设置（经 PairedBridge.channelSettings）。这里不出现具体来源的名字。
//   - GET 用 tickets:view。editable 按「是不是这台电脑上的网页」给。
//   - test、PUT、DELETE 要 tickets:create，并且只接受本机网页（paired-server 的 isLoopbackPage，和「添加手机」同一条规则）：
//     网关是明文 HTTP，密钥不能经过局域网。非本机回 403。
//   - 请求体里的密钥名必须是这个来源声明过的；未知的来源回 404；没有通道服务回 503。
//   - PUT 先检查，全过才保存并重连，回新的 DTO；没过回 400，error.details 是检查结果（ChannelSecretsTestResult）。
//   - DELETE 只删保险库里的，回新的 DTO（Keychain 或环境变量里还有时，DTO 的 origin 说明，界面据此提示）。
//   - PUT、DELETE 是主人操作（channel.credentials）：保存了、删掉了密钥时记一次。
// 请求体（密钥的值）不进任何日志，也不回显：响应里只有名字、有没有、从哪里来。
import type { IncomingMessage, ServerResponse } from "node:http";
import { Value } from "typebox/value";
import {
  ChannelSecretsRequestSchema,
  type ChannelSecretsTestResult,
  type ChannelSettingsResponse,
  type ChannelSourceSettingsDto,
  type ChannelSourceSettingsResponse,
  type Scope,
} from "@pi-lead-child/protocol";
import { channelCredentialsOwnerAction, type OwnerActionInput } from "./owner-actions.js";

/** 一个来源的设置，editable 由网关按调用方补上。 */
export type ChannelSourceSettingsView = Omit<ChannelSourceSettingsDto, "editable">;

export interface ChannelSettingsSaved {
  source: ChannelSourceSettingsView;
  // 这次存进保险库的密钥名（没有值）。
  names: string[];
  // 存完以后保险库里这个来源的版本（不是密钥，也推不出密钥）。「不是我」时核对它：之后又改过就不自动删。
  revision: string;
}

/** daemon 的通道设置（apps/daemon 的 channel-settings.ts）。抛 ChannelSettingsError 时按 code 回 HTTP 状态。 */
export interface ChannelSettingsService {
  list(): ChannelSourceSettingsView[];
  // 用请求里的密钥试一次（请求里没有的，用现在的）。不保存。
  test(source: string, secrets: Readonly<Record<string, string>>): Promise<ChannelSecretsTestResult>;
  // 先试，全过才存进保险库并重连。没过时 ok=false，带检查结果，什么都不存。
  save(source: string, secrets: Readonly<Record<string, string>>): Promise<
    { ok: true; saved: ChannelSettingsSaved } | { ok: false; result: ChannelSecretsTestResult }
  >;
  // 删掉保险库里这个来源的密钥并重连。removed：删掉的密钥名。
  remove(source: string): Promise<{ source: ChannelSourceSettingsView; removed: string[] }>;
  // 「不是我」：保险库里这个来源的密钥还是 revision 那一版时，全部删掉并重连。
  revertSave(source: string, revision: string): Promise<{
    status: "reverted" | "changed" | "unknown";
    source: ChannelSourceSettingsView | null;
  }>;
}

export class ChannelSettingsError extends Error {
  constructor(readonly code: "invalid_request" | "not_found" | "unavailable", message: string) {
    super(message);
    this.name = "ChannelSettingsError";
  }
}

// 按名字和 code 认：daemon 和网关在测试里可能各自加载一份这个模块。
function settingsError(error: unknown): ChannelSettingsError | null {
  if (error instanceof ChannelSettingsError) return error;
  if (!(error instanceof Error) || error.name !== "ChannelSettingsError") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code in STATUS ? error as ChannelSettingsError : null;
}

export interface ChannelSettingsRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  service: ChannelSettingsService | undefined;
  json(status: number, value: unknown): void;
  readBody(): Promise<Record<string, unknown>>;
  requireAuth(scope: Scope): string;
  // 请求是不是这台电脑上的网页发的（paired-server 的 isLoopbackPage）。
  loopbackPage(): boolean;
  // GET 的 editable：这个调用方在这里能不能填密钥（浏览器同源的 GET 不带 Origin，按调用方判断）。只决定页面怎么画。
  editableHere(): boolean;
  // 保存、删除成功以后，记一次主人操作（工单 15）。凭证是上一次 requireAuth 的调用方。
  ownerAction?(input: OwnerActionInput): void;
}

const BASE = "/v1/channels/settings";
const SOURCE_PATH = /^\/v1\/channels\/settings\/([^/]+)(\/test)?$/;
const STATUS: Record<ChannelSettingsError["code"], number> = { invalid_request: 400, not_found: 404, unavailable: 503 };
const HTTP_CODE: Record<number, string> = { 400: "invalid_request", 403: "forbidden", 404: "not_found", 503: "internal_error" };

// 处理了返回 true。不是这条路由返回 false。
export async function handleChannelSettingsRoute(ctx: ChannelSettingsRouteContext): Promise<boolean> {
  const { req, url } = ctx;
  // reason 放在 details 里：客户端用严格的 HttpErrorResponseSchema 校验错误响应，多一个字段整条错误就会被丢掉。
  const fail = (status: number, reason: string, message: string, details?: Record<string, unknown>) =>
    ctx.json(status, { error: { code: HTTP_CODE[status] ?? "internal_error", message, details: details ?? { reason } } });
  const unavailable = () => fail(503, "unavailable", "消息通道还没有启动");

  if (url.pathname === BASE) {
    if (req.method !== "GET") return false;
    ctx.requireAuth("tickets:view");
    if (!ctx.service) {
      unavailable();
      return true;
    }
    const editable = ctx.editableHere();
    ctx.json(200, { sources: ctx.service.list().map((source) => ({ ...source, editable })) } satisfies ChannelSettingsResponse);
    return true;
  }

  const match = SOURCE_PATH.exec(url.pathname);
  if (!match) return false;
  const testing = match[2] !== undefined;
  if (testing ? req.method !== "POST" : req.method !== "PUT" && req.method !== "DELETE") return false;
  ctx.requireAuth("tickets:create");
  if (!ctx.loopbackPage()) {
    fail(403, "not_local_page", "只有这台电脑上的网页能改通道的凭据：网关是明文 HTTP，密钥不能经过局域网");
    return true;
  }
  let source: string;
  try {
    source = decodeURIComponent(match[1]!);
  } catch {
    fail(404, "not_found", "没有这个通道");
    return true;
  }
  const service = ctx.service;
  if (!service) {
    unavailable();
    return true;
  }
  const entry = service.list().find((candidate) => candidate.source === source);
  if (!entry) {
    fail(404, "not_found", "没有这个通道");
    return true;
  }

  try {
    if (req.method === "DELETE") {
      const { source: view, removed } = await service.remove(source);
      if (removed.length) ctx.ownerAction?.(channelCredentialsOwnerAction({ op: "delete", source, label: view.label, names: removed }));
      ctx.json(200, { source: { ...view, editable: true } } satisfies ChannelSourceSettingsResponse);
      return true;
    }

    const body = await ctx.readBody();
    if (!Value.Check(ChannelSecretsRequestSchema, body)) {
      fail(400, "invalid_request", "请求体要是 {secrets: {名字: 值}}，值是 1 到 1000 个字符的字符串");
      return true;
    }
    const secrets = (body as { secrets: Record<string, string> }).secrets;
    const declared = new Set(entry.secrets.map((secret) => secret.name));
    const unknown = Object.keys(secrets).filter((name) => !declared.has(name));
    if (unknown.length) {
      // 名字是调用方写的：截短以后再回显，不回显值。
      fail(400, "unknown_secret", `这个通道不认这些密钥名：${unknown.map((name) => name.slice(0, 100)).join("、").slice(0, 300)}`);
      return true;
    }

    if (testing) {
      ctx.json(200, await service.test(source, secrets) satisfies ChannelSecretsTestResult);
      return true;
    }
    const outcome = await service.save(source, secrets);
    if (!outcome.ok) {
      fail(400, "checks_failed", "检查没有全部通过，没有保存", outcome.result as unknown as Record<string, unknown>);
      return true;
    }
    const { saved } = outcome;
    if (saved.names.length) {
      ctx.ownerAction?.(channelCredentialsOwnerAction({
        op: "save", source, label: saved.source.label, names: saved.names, revision: saved.revision,
      }));
    }
    ctx.json(200, { source: { ...saved.source, editable: true } } satisfies ChannelSourceSettingsResponse);
    return true;
  } catch (error) {
    const known = settingsError(error);
    if (known) {
      fail(STATUS[known.code], known.code, known.message);
      return true;
    }
    throw error;
  }
}
