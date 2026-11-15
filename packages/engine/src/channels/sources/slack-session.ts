// Slack 的浏览器会话方式（channels.slack.connection 是 "session"，2026-11-02）：凭据和 Web API。
//   - 根凭据是网页版 Slack 的会话 cookie（core 的 SLACK_SESSION_COOKIE_ENV，存在 Keychain 或设置页的保险库）。
//     gabriel-slack 用它换出会话令牌（xoxc-）。令牌只在这里的 GabrielCore 里，不存、不写日志，每次启动重新换。
//   - 一个 cookie 一个 GabrielCore。凭据定期重新换（daemon 的凭据缓存），cookie 没变就接着用同一个，传输的连接不断；
//     cookie 换了，或者旧的会话已经失效，就关掉旧的，建一个新的。
//   - Web API 实现现有的 SlackWebApi 接口：适配器其余的代码（发消息、读历史、下载文件）两种方式一样用。
//     Slack 回 ok:false 时 gabriel 抛错，这里转回 { ok: false, error }，和 slack-web-api.ts 一样。
//     调用时给的 token 参数不用：会话令牌在 GabrielCore 里。
import { createGabrielCore, gabrielErrorOf, type GabrielCore, type SlackSessionNetwork } from "./slack-gabriel.js";
import { readSlackFile, scrubSlackText, slackFileUrlAllowed, SLACK_FILES_HOST, type SlackWebApi } from "./slack-web-api.js";

export type { SlackSessionNetwork } from "./slack-gabriel.js";

/** 会话 cookie 的前缀（网页版 Slack 的 d cookie）。 */
export const SLACK_SESSION_COOKIE_PREFIX = "xoxd-";

/** 换好的会话：用户本人、工作区。不含令牌。 */
export interface SlackSessionIdentity {
  userId: string;
  teamId: string;
  teamName: string | null;
  // 工作区的子域名（acme.slack.com 的 acme）。会话没给时是 null。
  domain: string | null;
  // 工作区的网址（会话的 apiBase，例如 https://acme.slack.com/），拼消息的地址用。Enterprise Grid 下它和 domain 拼的不一样。没给时是 null。
  url: string | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 会话方式现在的 GabrielCore。按 cookie 建，cookie 不变时一直用同一个。 */
export class SlackSessions {
  private current: { cookie: string; core: GabrielCore } | null = null;
  private opening: Promise<{ core: GabrielCore; identity: SlackSessionIdentity }> | null = null;
  // 换了一个新的 GabrielCore 时通知（传输要换到新的连接上）。
  private readonly listeners = new Set<() => void>();

  constructor(private readonly network: SlackSessionNetwork = {}) {}

  /** 现在的 GabrielCore。还没换过凭据，或者已经关掉时是 null。 */
  core(): GabrielCore | null {
    return this.current?.core ?? null;
  }

  /** 现在的 cookie（去掉日志里的凭据用）。 */
  cookie(): string | null {
    return this.current?.cookie ?? null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 用 cookie 换出会话。cookie 没变、旧的会话还活着时接着用旧的。换不成时抛错，错误的话里没有凭据。 */
  async open(cookie: string, log: (line: string) => void): Promise<{ core: GabrielCore; identity: SlackSessionIdentity }> {
    const known = this.current;
    if (known && known.cookie === cookie && known.core.authManager.state !== "AUTH_DEAD") {
      return { core: known.core, identity: identityOf(await known.core.initialize()) };
    }
    if (this.opening) await this.opening.catch(() => {});
    const pending = (async () => {
      const core = await createGabrielCore({ cookie, network: this.network, log });
      let session;
      try {
        session = await core.initialize();
      } catch (error) {
        throw new Error(`the Slack session could not start: ${scrubSlackText(errorText(error), [cookie])}`);
      }
      const previous = this.current;
      this.current = { cookie, core };
      if (previous && previous.core !== core) previous.core.disconnect();
      for (const listener of this.listeners) listener();
      return { core, identity: identityOf(session) };
    })();
    this.opening = pending;
    try {
      return await pending;
    } finally {
      if (this.opening === pending) this.opening = null;
    }
  }

  /** 关掉现在的会话（断开连接）。 */
  close(): void {
    const known = this.current;
    this.current = null;
    known?.core.disconnect();
  }
}

function identityOf(session: { userId: string; teamId: string; teamName?: string; domain?: string; apiBase?: string }): SlackSessionIdentity {
  return {
    userId: session.userId, teamId: session.teamId, teamName: session.teamName || null, domain: session.domain || null,
    url: session.apiBase || null,
  };
}

/** 会话方式的 SlackWebApi：经过现在的 GabrielCore 调。还没有会话时抛错。 */
export function createSlackSessionWebApi(sessions: SlackSessions): SlackWebApi {
  const coreOrThrow = (what: string): GabrielCore => {
    const core = sessions.core();
    if (!core) throw new Error(`${what}: the Slack session is not open yet`);
    return core;
  };
  const scrub = (text: string, core: GabrielCore) => {
    let token: string | null = null;
    try {
      token = core.session.token;
    } catch {
      token = null;
    }
    return scrubSlackText(text, [sessions.cookie(), token]);
  };
  return {
    async call(method, args) {
      const core = coreOrThrow(`slack ${method}`);
      const { token: _ignored, ...fields } = args as Record<string, unknown> & { token?: unknown };
      try {
        return await core.callWebApi(method, fields);
      } catch (error) {
        const { slackError } = gabrielErrorOf(error);
        if (slackError) return { ok: false, error: slackError };
        throw new Error(`slack ${method}: ${scrub(errorText(error), core)}`);
      }
    },
    async download(url, _token, maxBytes) {
      if (!slackFileUrlAllowed(url)) throw new Error(`slack file download: only ${SLACK_FILES_HOST} addresses are allowed`);
      const core = coreOrThrow("slack file download");
      let response: Response;
      try {
        response = await core.http.fetchAuthenticated(url, { method: "GET", signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new Error(`slack file download: ${scrub(errorText(error), core)}`);
      }
      return readSlackFile(response, maxBytes);
    },
  };
}
