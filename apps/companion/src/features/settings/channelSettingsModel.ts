// 设置 → 账号 → 消息通道的视图模型（2026-10-20）。契约：packages/protocol/src/channel-settings.ts。
// 这里只处理 daemon 给的状态：卡片上永远没有密钥的值，输入框也不预填。
import type {
  ChannelSecretOrigin, ChannelSecretSetting, ChannelSecretsTestResult, ChannelSourceAccount, ChannelSourceSettingsDto,
} from '@pi-lead-child/protocol';

// 下面的 leadName 都是 Lead 的名字（useLeadName）。
export function channelsDescription(leadName: string): string {
  return `外部的消息来源。${leadName} 用你本人的账号读这里的消息，替你查资料，有把握时代你回复。`;
}

export function readOnlyNote(leadName: string): string {
  return `密钥只能在这台 Mac 的网页上填。在运行 ${leadName} 的那台 Mac 上打开网页，再进设置 → 消息通道。`;
}

export type ChannelStatusTone = 'success' | 'accent' | 'danger' | 'muted';
export type ChannelStatusView = { label: string; tone: ChannelStatusTone; detail: string };

// 卡片右上角的状态和下面的一句说明。
export function channelStatusView(source: ChannelSourceSettingsDto): ChannelStatusView {
  switch (source.status) {
    case 'connected':
      return { label: '已连接', tone: 'success', detail: source.account ? accountText(source.account) : '已连接。' };
    case 'connecting':
      return { label: '连接中', tone: 'accent', detail: '正在连接…' };
    case 'error':
      return { label: '出错', tone: 'danger', detail: source.lastError ?? '连不上，daemon 没有给出原因。' };
    case 'not_configured':
      return { label: '没有配置', tone: 'muted', detail: '还没有密钥。' };
  }
}

// 连上的是谁、哪个工作区。名字是空的时候用编号。
export function accountText(account: ChannelSourceAccount): string {
  const user = account.userName || account.userId;
  const team = account.teamName || account.teamId;
  return `用 ${user} 的账号，工作区 ${team}。`;
}

const ORIGIN_TEXT: Record<ChannelSecretOrigin, string> = {
  vault: '来自设置页',
  keychain: '来自 Keychain',
  env: '来自环境变量',
};

// 一个密钥现在的样子：只说有没有、来自哪里，不显示值。
export function secretStateText(secret: ChannelSecretSetting): string {
  if (!secret.present) return '没有保存';
  return secret.origin ? `已保存 · ${ORIGIN_TEXT[secret.origin]}` : '已保存';
}

export function secretPlaceholder(secret: ChannelSecretSetting): string {
  if (!secret.present) return secret.prefix ? `粘贴 ${secret.prefix} 开头的值` : '粘贴值';
  if (secret.origin === 'keychain') return '正在用 Keychain 里的 · 粘贴新的会改用这里存的';
  if (secret.origin === 'env') return '正在用环境变量里的 · 粘贴新的会改用这里存的';
  return '已保存 · 要更换就粘贴新的';
}

// 「断开」只删设置页存的密钥（DELETE 不动 Keychain 和环境变量），所以只有密钥来自设置页时才出现。
export function canDisconnect(source: ChannelSourceSettingsDto): boolean {
  return source.editable && source.secrets.some((secret) => secret.present && secret.origin === 'vault');
}

export type ExternalSecretNote = { name: string; text: string; command: string | null };

// 来自 Keychain 或环境变量的密钥：页面删不掉，说明要在终端里删。
// Keychain 里的名字是 dev-secret:<密钥名>（packages/core/src/config.ts，接入步骤 .scratch/slack-takeover/setup.md）。
export function externalSecretNotes(source: ChannelSourceSettingsDto): ExternalSecretNote[] {
  return source.secrets.flatMap((secret): ExternalSecretNote[] => {
    if (!secret.present) return [];
    if (secret.origin === 'keychain') {
      return [{
        name: secret.name,
        text: `${secret.label} 存在 Keychain 里，这个页面删不掉。要删，在终端里运行：`,
        command: `security delete-generic-password -a "$USER" -s "dev-secret:${secret.name}"`,
      }];
    }
    if (secret.origin === 'env') {
      return [{
        name: secret.name,
        text: `${secret.label} 来自 daemon 的环境变量 ${secret.name}，这个页面删不掉。要删，在终端里从启动 daemon 的环境中去掉它，再重启 daemon。`,
        command: null,
      }];
    }
    return [];
  });
}

export const DISCONNECT_CONFIRM_NOTE = '删掉设置页存的密钥并断开。Keychain 或环境变量里还有这些密钥时，会改用它们。';

export type SecretForm = Record<string, string>;

// 输入框的初始值：一律是空的，不预填已保存的密钥。
export function emptySecretForm(source: ChannelSourceSettingsDto): SecretForm {
  return Object.fromEntries(source.secrets.map((secret) => [secret.name, '']));
}

export type SecretRequest = { secrets: Record<string, string> } | { problem: string };

// 要发出去的密钥：只发填了的那几个。还没保存过的密钥必须填；都已保存时至少要换一个。
// 前缀只用来提示；格式由来源插件检查。
export function secretRequest(source: ChannelSourceSettingsDto, form: SecretForm): SecretRequest {
  const secrets: Record<string, string> = {};
  for (const secret of source.secrets) {
    const value = (form[secret.name] ?? '').trim();
    if (value) secrets[secret.name] = value;
  }
  const missing = source.secrets.filter((secret) => !secret.present && !secrets[secret.name]);
  if (missing.length) return { problem: `还要填：${missing.map((secret) => secret.label).join('、')}。` };
  if (!Object.keys(secrets).length) return { problem: '先粘贴要更换的密钥。' };
  if (Object.values(secrets).some((value) => value.length > 1_000)) return { problem: '密钥太长：每个最多 1000 个字符。' };
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
export function testSummary(result: ChannelSecretsTestResult): string {
  if (!result.ok) return '有检查没通过，见下面。密钥没有保存。';
  return result.account ? `检查都通过了。${accountText(result.account)}还没有保存。` : '检查都通过了。还没有保存。';
}

export const SAVE_REJECTED_NOTE = '没有保存：有检查没通过，见下面。';
export const SAVED_NOTE = '已保存，正在用新的密钥连接。';
export const DISCONNECTED_NOTE = '已断开，设置页存的密钥已删除。';

// 客户端自己的几句（packages/client 的 controlPlaneClient.ts）。
const CLIENT_MESSAGES: Record<string, string> = {
  'this client cannot manage channel settings': '这个版本的客户端不能设置消息通道。',
  'device is not paired': '这台设备还没有配对。',
  'channel secrets are invalid': '密钥的格式不对：每个最多 1000 个字符。',
  'channel source is invalid': '这个消息通道的编号不对。',
};

// 给你看的错误。按 HTTP 状态码分（机器给的），不解析网关的英文说明。
export function channelErrorText(reason: unknown, leadName: string): string {
  const status = typeof reason === 'object' && reason !== null && 'status' in reason ? (reason as { status?: unknown }).status : undefined;
  if (status === 403) return `这里不能改密钥。${readOnlyNote(leadName)}`;
  if (status === 404) return '没有这个消息通道。';
  if (status === 400) return '密钥的名字或格式不对。';
  const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  return CLIENT_MESSAGES[message] ?? (message || '请求没有完成，请再试一次。');
}
