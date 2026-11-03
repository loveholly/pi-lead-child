import {
  Badge, Button, Card, CodeBlock, Column, Link, Row, ServiceMark, Text, TextField, canCopyText, copyText,
  type BadgeTone, type ServiceMarkService,
} from '@pi-lead-child/components';
import type { ChannelConnectionDto, ChannelSecretSetting, ChannelSecretsTestResult, ChannelSourceSettingsDto } from '@pi-lead-child/protocol';
import { ChannelSecretsRejectedError } from '@pi-lead-child/client';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useLocale, useMessages } from '@/i18n';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useChannelSettings, useConnectionPhase, useLeadName } from '@/state/hooks';
import { RESOURCE_KEYS } from '@/state/types';

import { ChannelConnectionBlock, ChannelWritesSwitch, useChannelConnection } from './ChannelConnection';
import { channelsMessages } from './channels.messages';
import {
  canDisconnect, channelErrorText, channelStatusView, checkRows, emptySecretForm,
  externalSecretNotes, readOnlyNote, secretPlaceholder, secretRequest, secretStateText, setupLinkText, testSummary,
  type ChannelStatusTone, type SecretForm,
} from './channelSettingsModel';
import { HandbookSection } from './HandbookSection';
import { isDevicePaired } from './settingsNav';
import { UnpairedNotice } from './UnpairedNotice';
import { useServerForm } from './useServerForm';

export { channelsDescription } from './channelSettingsModel';

const STATUS_TONE: Record<ChannelStatusTone, BadgeTone> = { success: 'success', accent: 'accent', danger: 'danger', muted: 'muted' };
const KNOWN_MARKS: readonly ServiceMarkService[] = ['atlassian', 'github', 'notion', 'slack', 'google'];

// 设置 → 账号 → 消息通道（2026-10-20）。每个来源一张卡：状态、缺的权限、每个密钥的来处、填密钥的表单、建应用的清单。
// 密钥只写不读：卡上没有值，输入框不预填，保存成功后清空。只有这台 Mac 的网页能改（editable），别的设备只看状态。
export function ChannelSettingsSection() {
  const runtime = useCompanionRuntime();
  const paired = isDevicePaired(useConnectionPhase());
  const { channelSettings, resource } = useChannelSettings();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = channelsMessages(locale);
  if (!paired) return <UnpairedNotice />;
  if (!channelSettings) {
    if (resource?.state === 'unsupported') return <Text testID="channels-unsupported" size="body" tone="muted">{m.unsupported}</Text>;
    if (resource?.state === 'error') {
      return (
        <Card testID="channels-error" p="page-card" rounded="xl" gap="card-row">
          <Text size="secondary" tone="danger-dark">{m.loadFailed(channelErrorText(resource.error ?? '', leadName, locale))}</Text>
          <Row>
            <Button label={m.retry} variant="outline" tone="neutral" size="sm" onPress={() => void runtime.ensureResource(RESOURCE_KEYS.channelSettings, true).catch(() => {})} />
          </Row>
        </Card>
      );
    }
    return <Text testID="channels-loading" size="body" tone="muted">{m.loading}</Text>;
  }
  if (!channelSettings.sources.length) {
    return <Text testID="channels-empty" size="body" tone="muted">{m.empty}</Text>;
  }
  return (
    <Column testID="channels-section" gap="page-section">
      {/* 表单不按服务端的值加 key：连上、断开时卡片不重新挂载，没保存的输入和检查结果都留着。 */}
      {channelSettings.sources.map((source) => <ChannelSourceCard key={source.source} source={source} />)}
      {/* 自动代你处理（交接说明，2026-10-30）：一份，对所有来源生效。开关、预演一条消息、交接说明正文。打开以后，开关那张卡里还有代回复风格。 */}
      <HandbookSection />
    </Column>
  );
}

function ChannelSourceCard({ source }: { source: ChannelSourceSettingsDto }) {
  const id = source.source;
  const status = channelStatusView(source, useLocale());
  // 有几种连接方式的来源（2026-11-02）：头部下面是连接方式。选了要登录的方式、正在登录时不画填密钥的表单；
  // 现在用的是要登录的方式时，换成会话那一块（没有粘贴的入口）。
  const connectionView = useChannelConnection(source);
  const connection = connectionView.connection;
  const signingIn = Boolean(connectionView.picked) || connection?.signIn?.state === 'waiting';
  const signedInMode = connection?.modes.find((item) => item.mode === connection.mode && item.needsSignIn) ? connection : null;
  return (
    <Card testID={`channel-${id}`} rounded="xl" p="page-card" gap="card-section">
      <Row items="center" gap="side-item">
        <ServiceMark service={KNOWN_MARKS.includes(id as ServiceMarkService) ? id as ServiceMarkService : 'custom'} label={source.label} size={32} />
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="card-title" weight="bold" numberOfLines={1}>{source.label}</Text>
          <Text testID={`channel-${id}-detail`} size="secondary" tone={source.status === 'error' ? 'danger-dark' : 'secondary'}>{status.detail}</Text>
        </Column>
        <Badge testID={`channel-${id}-status`} label={status.label} tone={STATUS_TONE[status.tone]} dot size="sm" />
      </Row>
      <ChannelConnectionBlock source={source} view={connectionView} />
      {source.missingScopes.length && !signedInMode ? <MissingScopes id={id} scopes={source.missingScopes} /> : null}
      {source.noEventsWarning && !signedInMode ? <NoEvents id={id} warning={source.noEventsWarning} /> : null}
      {!source.editable ? <ReadOnlySecrets source={source} />
        : signingIn ? null
        : signedInMode ? (
          <SessionForm source={source} connection={signedInMode} reload={connectionView.reload}>
            <ChannelWritesSwitch source={source} view={connectionView} />
          </SessionForm>
        )
        : <SecretsForm source={source} />}
    </Card>
  );
}

// 现在用的是要登录的连接方式（例如 Slack 的浏览器会话）：会话存在哪里、令牌不存；测试、重新登录、断开。
// 会话失效（来源报错）时，「重新登录」是主按钮，旁边可以改用不用登录的方式。
// children：会话那几行和按钮之间的东西（「代你发消息」开关）。
function SessionForm({ source, connection, reload, children }: {
  source: ChannelSourceSettingsDto; connection: ChannelConnectionDto; reload: () => void; children?: ReactNode;
}) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = channelsMessages(locale);
  const id = source.source;
  const [pending, setPending] = useState<'test' | 'action' | 'clear' | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [checks, setChecks] = useState<ChannelSecretsTestResult | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const ended = source.status === 'error';
  const fallback = connection.modes.find((item) => !item.needsSignIn);
  const run = (kind: 'action' | 'clear', work: () => Promise<unknown>, done?: string) => {
    setPending(kind);
    setMessage(null);
    setChecks(null);
    work()
      .then(() => {
        reload();
        if (done) setMessage({ text: done, error: false });
      })
      .catch((reason: unknown) => setMessage({ text: channelErrorText(reason, leadName, locale), error: true }))
      .finally(() => setPending(null));
  };
  const test = () => {
    setPending('test');
    setMessage(null);
    setChecks(null);
    runtime.testChannelSecrets(id, {})
      .then((result) => {
        setChecks(result);
        setMessage({ text: testSummary(result, locale), error: !result.ok });
      })
      .catch((reason: unknown) => setMessage({ text: channelErrorText(reason, leadName, locale), error: true }))
      .finally(() => setPending(null));
  };
  const signInAgain = () => run('action', () => runtime.performUiAction('channel_connection', id, 'sign_in', { input: { mode: connection.mode } }));
  return (
    <Column testID={`channel-${id}-session`} gap="form-field">
      <Column gap="card-row">
        {source.secrets.map((secret) => (
          <Row key={secret.name} testID={`channel-${id}-session-secret`} items="center" gap="inline-item">
            <Text flex={1} minW={0} size="label" weight="semibold">{m.sessionLabel}</Text>
            <Text size="label" tone={secret.present ? 'success-dark' : 'muted'}>{secretStateText(secret, locale)}</Text>
          </Row>
        ))}
        <Row items="center" gap="inline-item">
          <Text flex={1} minW={0} size="label" weight="semibold">{m.tokenLabel}</Text>
          <Text size="label" tone="secondary">{m.tokenNote}</Text>
        </Row>
      </Column>
      {children}
      <Row items="center" gap="actions" flexWrap="wrap">
        {ended ? (
          <>
            <Button testID={`channel-${id}-session-sign-in`} label={m.signInAgain} size="sm" disabled={pending !== null} onPress={signInAgain} />
            {fallback ? (
              <Button
                testID={`channel-${id}-session-use-fallback`}
                label={m.useMode(m.modeName(id, fallback.mode))}
                variant="outline"
                tone="neutral"
                size="sm"
                disabled={pending !== null}
                onPress={() => run('action', () => runtime.performUiAction('channel_connection', id, 'use_mode', { input: { mode: fallback.mode } }))}
              />
            ) : null}
          </>
        ) : (
          <>
            <Button testID={`channel-${id}-session-test`} label={m.test} variant="outline" tone="neutral" size="sm" disabled={pending !== null} onPress={test} />
            <Button testID={`channel-${id}-session-sign-in`} label={m.signInAgain} variant="outline" tone="neutral" size="sm" disabled={pending !== null} onPress={signInAgain} />
          </>
        )}
        {canDisconnect(source) && !confirmDisconnect ? (
          <Button testID={`channel-${id}-disconnect-start`} label={m.disconnect} variant="ghost" tone="danger" size="sm" disabled={pending !== null} onPress={() => setConfirmDisconnect(true)} />
        ) : null}
      </Row>
      {canDisconnect(source) && confirmDisconnect ? (
        <Row testID={`channel-${id}-disconnect-confirm`} items="center" gap="actions" flexWrap="wrap">
          <Text size="body" tone="secondary">{m.disconnectConfirm}</Text>
          <Button
            testID={`channel-${id}-disconnect`}
            label={m.disconnect}
            variant="outline"
            tone="danger"
            size="sm"
            disabled={pending !== null}
            onPress={() => {
              setConfirmDisconnect(false);
              run('clear', () => runtime.clearChannelSecrets(id), m.disconnected);
            }}
          />
          <Button label={m.cancel} variant="ghost" tone="neutral" size="sm" onPress={() => setConfirmDisconnect(false)} />
        </Row>
      ) : null}
      {message ? <Text testID={`channel-${id}-message`} size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
      {checks ? <CheckList id={id} result={checks} /> : null}
    </Column>
  );
}

function MissingScopes({ id, scopes }: { id: string; scopes: readonly string[] }) {
  const m = useMessages(channelsMessages);
  return (
    <Card testID={`channel-${id}-missing-scopes`} tone="warning" rounded="lg" px="inset-x" py="inset-y" gap="card-row">
      <Text size="label" weight="semibold">{m.missingScopesTitle}</Text>
      <Column gap="stacked-card">
        {scopes.map((scope) => <Text key={scope} size="code" mono>{`· ${scope}`}</Text>)}
      </Column>
      <Text size="secondary" tone="secondary">{m.missingScopesHelp}</Text>
    </Card>
  );
}

// 连上了很久却一个事件都没收到（2026-11-02）：daemon 给的提醒，来源插件写的该查哪里、怎样验证。
function NoEvents({ id, warning }: { id: string; warning: string }) {
  const m = useMessages(channelsMessages);
  return (
    <Card testID={`channel-${id}-no-events`} tone="warning" rounded="lg" px="inset-x" py="inset-y" gap="card-row">
      <Text size="label" weight="semibold">{m.noEventsTitle}</Text>
      <Text size="secondary" tone="secondary">{warning}</Text>
    </Card>
  );
}

// 不是这台 Mac 的网页：只显示状态，不给输入框和按钮。
function ReadOnlySecrets({ source }: { source: ChannelSourceSettingsDto }) {
  const leadName = useLeadName();
  const locale = useLocale();
  return (
    <Column gap="card-row">
      {source.secrets.map((secret) => (
        <Row key={secret.name} testID={`channel-${source.source}-secret-${secret.name}`} items="center" gap="inline-item">
          <Text flex={1} minW={0} size="label" weight="semibold" numberOfLines={1}>{secret.label}</Text>
          <Text size="label" tone={secret.present ? 'success-dark' : 'muted'}>{secretStateText(secret, locale)}</Text>
        </Row>
      ))}
      <Text testID={`channel-${source.source}-read-only`} size="secondary" tone="secondary">{readOnlyNote(leadName, locale)}</Text>
    </Column>
  );
}

type Pending = 'test' | 'save' | 'clear' | null;
type Message = { text: string; error: boolean };

function SecretsForm({ source }: { source: ChannelSourceSettingsDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = channelsMessages(locale);
  const id = source.source;
  const { form, setForm, field } = useServerForm<SecretForm>(emptySecretForm(source));
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [checks, setChecks] = useState<ChannelSecretsTestResult | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const notes = externalSecretNotes(source, locale);

  // 填好的密钥，或者要先改的地方（不发请求）。
  const prepare = (): Record<string, string> | null => {
    const request = secretRequest(source, form, locale);
    if ('problem' in request) {
      setChecks(null);
      setMessage({ text: request.problem, error: true });
      return null;
    }
    return request.secrets;
  };
  const test = () => {
    const secrets = prepare();
    if (!secrets) return;
    setPending('test');
    setMessage(null);
    setChecks(null);
    runtime.testChannelSecrets(id, secrets)
      .then((result) => {
        setChecks(result);
        setMessage({ text: testSummary(result, locale), error: !result.ok });
      })
      .catch((reason: unknown) => setMessage({ text: channelErrorText(reason, leadName, locale), error: true }))
      .finally(() => setPending(null));
  };
  // daemon 先试，全部检查通过才保存并重连。没通过时显示每项检查，输入框留着，改了再存。
  const save = () => {
    const secrets = prepare();
    if (!secrets) return;
    setPending('save');
    setMessage(null);
    setChecks(null);
    runtime.saveChannelSecrets(id, secrets)
      .then(() => {
        setForm((current) => Object.fromEntries(Object.keys(current).map((name) => [name, ''])));
        setMessage({ text: m.saved, error: false });
      })
      .catch((reason: unknown) => {
        if (reason instanceof ChannelSecretsRejectedError) {
          setChecks(reason.result);
          setMessage({ text: m.saveRejected, error: true });
          return;
        }
        setMessage({ text: channelErrorText(reason, leadName, locale), error: true });
      })
      .finally(() => setPending(null));
  };
  const disconnect = () => {
    setConfirmDisconnect(false);
    setPending('clear');
    setMessage(null);
    setChecks(null);
    runtime.clearChannelSecrets(id)
      .then(() => setMessage({ text: m.disconnected, error: false }))
      .catch((reason: unknown) => setMessage({ text: channelErrorText(reason, leadName, locale), error: true }))
      .finally(() => setPending(null));
  };

  return (
    <Column gap="form-field">
      {source.secrets.map((secret) => (
        <SecretField key={secret.name} sourceId={id} secret={secret} value={form[secret.name] ?? ''} onChange={field(secret.name)} />
      ))}
      <Row items="center" gap="actions" flexWrap="wrap">
        <Button testID={`channel-${id}-test`} label={m.test} variant="outline" tone="neutral" size="sm" disabled={pending !== null} onPress={test} />
        <Button testID={`channel-${id}-save`} label={m.save} size="sm" disabled={pending !== null} onPress={save} />
        {canDisconnect(source) && !confirmDisconnect ? (
          <Button testID={`channel-${id}-disconnect-start`} label={m.disconnect} variant="ghost" tone="danger" size="sm" disabled={pending !== null} onPress={() => setConfirmDisconnect(true)} />
        ) : null}
      </Row>
      {canDisconnect(source) && confirmDisconnect ? (
        <Row testID={`channel-${id}-disconnect-confirm`} items="center" gap="actions" flexWrap="wrap">
          <Text size="body" tone="secondary">{m.disconnectConfirm}</Text>
          <Button testID={`channel-${id}-disconnect`} label={m.disconnect} variant="outline" tone="danger" size="sm" disabled={pending !== null} onPress={disconnect} />
          <Button label={m.cancel} variant="ghost" tone="neutral" size="sm" onPress={() => setConfirmDisconnect(false)} />
        </Row>
      ) : null}
      {message ? <Text testID={`channel-${id}-message`} size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
      {checks ? <CheckList id={id} result={checks} /> : null}
      {notes.length ? (
        <Column testID={`channel-${id}-external`} gap="stacked-card">
          {notes.map((note) => (
            <Column key={note.name} gap="text-stack">
              <Text size="secondary" tone="secondary">{note.text}</Text>
              {note.command ? <CodeBlock code={note.command} language="bash" /> : null}
            </Column>
          ))}
        </Column>
      ) : null}
      <AppSetup source={source} />
    </Column>
  );
}

function SecretField({ sourceId, secret, value, onChange }: {
  sourceId: string;
  secret: ChannelSecretSetting;
  value: string;
  onChange: (value: string) => void;
}) {
  const locale = useLocale();
  return (
    <Column testID={`channel-${sourceId}-secret-${secret.name}`} gap="field">
      <Row items="center" gap="inline-item" flexWrap="wrap">
        <Text size="label" weight="semibold">{secret.label}</Text>
        <Text size="code" mono tone="muted">{secret.name}</Text>
        <Text flex={1} minW={0} size="label" align="right" tone={secret.present ? 'success-dark' : 'muted'}>{secretStateText(secret, locale)}</Text>
      </Row>
      {secret.hint ? <Text size="note" tone="secondary">{secret.hint}</Text> : null}
      <TextField
        testID={`channel-${sourceId}-input-${secret.name}`}
        accessibilityLabel={secret.label}
        value={value}
        onChangeText={onChange}
        placeholder={secretPlaceholder(secret, locale)}
        variant="filled"
        size="sm"
        mono
        secure
        autoComplete="new-password"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={1_000}
      />
    </Column>
  );
}

function CheckList({ id, result }: { id: string; result: ChannelSecretsTestResult }) {
  const m = useMessages(channelsMessages);
  return (
    <Column testID={`channel-${id}-checks`} gap="stacked-card">
      {checkRows(result).map((row) => (
        <Row key={row.id} testID={`channel-${id}-check-${row.id}`} items="flex-start" gap="side-item">
          {/* spacing-exempt: 对勾符号字号 */}
          <Text w={14} size="13" weight="bold" tone={row.pass ? 'success-dark' : 'danger-dark'}>{row.mark}</Text>
          <Column flex={1} minW={0} gap="text-stack">
            <Text size="label" weight="semibold">{row.label}</Text>
            {row.detail ? <Text size="secondary" tone="secondary">{row.detail}</Text> : null}
          </Column>
        </Row>
      ))}
      {result.missingScopes.length ? (
        <Text testID={`channel-${id}-check-missing-scopes`} size="note" tone="danger-dark">
          {m.missingScopes(result.missingScopes)}
        </Text>
      ) : null}
    </Column>
  );
}

// 建应用：建应用的网页，和可以展开、复制的应用清单。
function AppSetup({ source }: { source: ChannelSourceSettingsDto }) {
  const m = useMessages(channelsMessages);
  const id = source.source;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (reset.current) clearTimeout(reset.current);
  }, []);
  if (!source.manifest && !source.setupUrl) return null;
  const manifest = source.manifest;
  const copy = async () => {
    if (!manifest || !(await copyText(manifest))) return;
    setCopied(true);
    if (reset.current) clearTimeout(reset.current);
    reset.current = setTimeout(() => setCopied(false), 1600);
  };
  return (
    <Column testID={`channel-${id}-app`} gap="card-row" pt="page-card" borderTopWidth={1} borderTopColor="border-soft">
      <Text size="eyebrow" weight="bold" tone="secondary">{m.appSetup}</Text>
      {source.setupUrl ? (
        <Text size="secondary" tone="secondary">
          {m.setupBefore}
          <Link testID={`channel-${id}-setup-url`} href={source.setupUrl} size="secondary">{setupLinkText(source.setupUrl)}</Link>
          {manifest ? m.setupAfterManifest : m.setupAfter}
        </Text>
      ) : null}
      {source.setupNote ? <Text testID={`channel-${id}-setup-note`} size="secondary" tone="secondary">{source.setupNote}</Text> : null}
      {manifest ? (
        <Row items="center" gap="actions" flexWrap="wrap">
          <Button
            testID={`channel-${id}-manifest-toggle`}
            label={open ? m.hideManifest : m.showManifest}
            icon={open ? 'chevron-up' : 'chevron-down'}
            variant="outline"
            tone="neutral"
            size="sm"
            onPress={() => setOpen((value) => !value)}
          />
          {canCopyText ? (
            <Button testID={`channel-${id}-manifest-copy`} label={copied ? m.copied : m.copy} icon={copied ? 'check' : 'copy'} variant="ghost" tone="neutral" size="sm" onPress={() => void copy()} />
          ) : null}
        </Row>
      ) : null}
      {manifest && open ? <CodeBlock testID={`channel-${id}-manifest`} code={manifest} language={null} /> : null}
    </Column>
  );
}
