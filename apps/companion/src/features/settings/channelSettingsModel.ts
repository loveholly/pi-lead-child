// 设置 → 账号 → 消息通道的视图模型（2026-10-20）。契约：packages/protocol/src/channel-settings.ts。
// 这里只处理 daemon 给的状态：卡片上永远没有密钥的值，输入框也不预填。
import type {
  ChannelSecretSetting, ChannelSecretsTestResult, ChannelSourceAccount, ChannelSourceSettingsDto, Locale,
} from '@pi-lead-child/protocol';

import { channelsMessages } from './channels.messages';

// 下面的 leadName 都是 Lead 的名字（useLeadName）；locale 是界面语言（useLocale）。
export function channelsDescription(leadName: string, locale: Locale): string {
  return channelsMessages(locale).description(leadName);
}

export function readOnlyNote(leadName: string, locale: Locale): string {
  return channelsMessages(locale).readOnlyNote(leadName);
}

export type ChannelStatusTone = 'success' | 'accent' | 'danger' | 'muted';
export type ChannelStatusView = { label: string; tone: ChannelStatusTone; detail: string };

// 卡片右上角的状态和下面的一句说明。
export function channelStatusView(source: ChannelSourceSettingsDto, locale: Locale): ChannelStatusView {
  const m = channelsMessages(locale);
  const label = m.status[source.status];
  switch (source.status) {
    case 'connected':
      return { label, tone: 'success', detail: source.account ? accountText(source.account, locale) : m.connectedDetail };
    case 'connecting':
      return { label, tone: 'accent', detail: m.connectingDetail };
    case 'error':
      return { label, tone: 'danger', detail: source.lastError ?? m.errorDetail };
    case 'not_configured':
      return { label, tone: 'muted', detail: m.notConfiguredDetail };
  }
}

// 连上的是谁、哪个工作区。名字是空的时候用编号。
export function accountText(account: ChannelSourceAccount, locale: Locale): string {
  const user = account.userName || account.userId;
  const team = account.teamName || account.teamId;
  return channelsMessages(locale).account(user, team);
}

// 一个密钥现在的样子：只说有没有、来自哪里，不显示值。
export function secretStateText(secret: ChannelSecretSetting, locale: Locale): string {
  const m = channelsMessages(locale);
  if (!secret.present) return m.secretNotSaved;
  return secret.origin ? m.secretSavedFrom(m.origin[secret.origin]) : m.secretSaved;
}

export function secretPlaceholder(secret: ChannelSecretSetting, locale: Locale): string {
  const m = channelsMessages(locale);
  if (!secret.present) return secret.prefix ? m.pastePrefixed(secret.prefix) : m.paste;
  if (secret.origin === 'keychain') return m.keychainInUse;
  if (secret.origin === 'env') return m.envInUse;
  return m.savedReplace;
}

// 建应用的链接显示成什么：去掉查询串（链接里可以带上整份清单，很长），点开的还是完整的链接。
export function setupLinkText(url: string): string {
  return url.split(/[?#]/)[0] || url;
}

// 「断开」只删设置页存的密钥（DELETE 不动 Keychain 和环境变量），所以只有密钥来自设置页时才出现。
export function canDisconnect(source: ChannelSourceSettingsDto): boolean {
  return source.editable && source.secrets.some((secret) => secret.present && secret.origin === 'vault');
}

export type ExternalSecretNote = { name: string; text: string; command: string | null };

// 来自 Keychain 或环境变量的密钥：页面删不掉，说明要在终端里删。
// Keychain 里的名字是 dev-secret:<密钥名>（packages/core/src/config.ts，接入步骤 .scratch/slack-takeover/setup.md）。
export function externalSecretNotes(source: ChannelSourceSettingsDto, locale: Locale): ExternalSecretNote[] {
  const m = channelsMessages(locale);
  return source.secrets.flatMap((secret): ExternalSecretNote[] => {
    if (!secret.present) return [];
    if (secret.origin === 'keychain') {
      return [{
        name: secret.name,
        text: m.keychainNote(secret.label),
        command: `security delete-generic-password -a "$USER" -s "dev-secret:${secret.name}"`,
      }];
    }
    if (secret.origin === 'env') {
      return [{
        name: secret.name,
        text: m.envNote(secret.label, secret.name),
        command: null,
      }];
    }
    return [];
  });
}

export type SecretForm = Record<string, string>;

// 输入框的初始值：一律是空的，不预填已保存的密钥。
export function emptySecretForm(source: ChannelSourceSettingsDto): SecretForm {
  return Object.fromEntries(source.secrets.map((secret) => [secret.name, '']));
}

export type SecretRequest = { secrets: Record<string, string> } | { problem: string };

// 要发出去的密钥：只发填了的那几个。还没保存过的密钥必须填；都已保存时至少要换一个。
// 前缀只用来提示；格式由来源插件检查。
export function secretRequest(source: ChannelSourceSettingsDto, form: SecretForm, locale: Locale): SecretRequest {
  const m = channelsMessages(locale);
  const secrets: Record<string, string> = {};
  for (const secret of source.secrets) {
    const value = (form[secret.name] ?? '').trim();
    if (value) secrets[secret.name] = value;
  }
  const missing = source.secrets.filter((secret) => !secret.present && !secrets[secret.name]);
  if (missing.length) return { problem: m.stillMissing(missing.map((secret) => secret.label)) };
  if (!Object.keys(secrets).length) return { problem: m.pasteFirst };
  if (Object.values(secrets).some((value) => value.length > 1_000)) return { problem: m.tooLong };
  return { secrets };
}

export type CheckRow = { id: string; mark: '✓' | '✗'; pass: boolean; label: string; detail: string };

export function checkRows(result: ChannelSecretsTestResult): CheckRow[] {
  return result.checks.map((check) => ({
    id: check.id,
    mark: check.pass ? '✓' : '✗',
    pass: check.pass,
    label: check.label,
    detail: check.detail,
  }));
}

// 「测试」以后的一句话。
export function testSummary(result: ChannelSecretsTestResult, locale: Locale): string {
  const m = channelsMessages(locale);
  if (!result.ok) return m.testFailed;
  return result.account ? m.testPassedAccount(accountText(result.account, locale)) : m.testPassed;
}

// 客户端自己的几句（packages/client 的 controlPlaneClient.ts）。
function clientMessage(message: string, locale: Locale): string | undefined {
  const m = channelsMessages(locale);
  const known: Record<string, string> = {
    'this client cannot manage channel settings': m.clientCannotManage,
    'device is not paired': m.deviceNotPaired,
    'channel secrets are invalid': m.secretsInvalid,
    'channel source is invalid': m.sourceInvalid,
  };
  return known[message];
}

// 给你看的错误。按 HTTP 状态码分（机器给的），不解析网关的英文说明。
export function channelErrorText(reason: unknown, leadName: string, locale: Locale): string {
  const m = channelsMessages(locale);
  const status = typeof reason === 'object' && reason !== null && 'status' in reason ? (reason as { status?: unknown }).status : undefined;
  if (status === 403) return m.forbidden(readOnlyNote(leadName, locale));
  if (status === 404) return m.notFound;
  if (status === 400) return m.badRequest;
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return clientMessage(message, locale) ?? (message || m.failed);
}
