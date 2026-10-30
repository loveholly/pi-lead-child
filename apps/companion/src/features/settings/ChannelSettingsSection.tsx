import {
  Badge, Button, Card, CodeBlock, Column, Link, Row, ServiceMark, Text, TextField, canCopyText, copyText,
  type BadgeTone, type ServiceMarkService,
} from '@pi-lead-child/components';
import type { ChannelSecretSetting, ChannelSecretsTestResult, ChannelSourceSettingsDto } from '@pi-lead-child/protocol';
import { ChannelSecretsRejectedError } from '@pi-lead-child/client';
import { useEffect, useRef, useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useChannelSettings, useConnectionPhase, useLeadName } from '@/state/hooks';
import { RESOURCE_KEYS } from '@/state/types';

import {
  canDisconnect, channelErrorText, channelStatusView, checkRows, DISCONNECT_CONFIRM_NOTE, DISCONNECTED_NOTE, emptySecretForm,
  externalSecretNotes, readOnlyNote, SAVE_REJECTED_NOTE, SAVED_NOTE, secretPlaceholder, secretRequest, secretStateText, testSummary,
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
  if (!paired) return <UnpairedNotice />;
  if (!channelSettings) {
    if (resource?.state === 'unsupported') return <Text testID="channels-unsupported" size="body" tone="muted">这台 daemon 还不支持消息通道。</Text>;
    if (resource?.state === 'error') {
      return (
        <Card testID="channels-error" p="page-card" rounded="xl" gap="card-row">
          <Text size="secondary" tone="danger-dark">{`读不到消息通道的设置：${channelErrorText(resource.error ?? '', leadName)}`}</Text>
          <Row>
            <Button label="重试" variant="outline" tone="neutral" size="sm" onPress={() => void runtime.ensureResource(RESOURCE_KEYS.channelSettings, true).catch(() => {})} />
          </Row>
        </Card>
      );
    }
    return <Text testID="channels-loading" size="body" tone="muted">正在读取消息通道…</Text>;
  }
  if (!channelSettings.sources.length) {
    return <Text testID="channels-empty" size="body" tone="muted">这台 daemon 没有可以设置的消息通道。</Text>;
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
  const status = channelStatusView(source);
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
      {source.missingScopes.length ? <MissingScopes id={id} scopes={source.missingScopes} /> : null}
      {source.editable ? <SecretsForm source={source} /> : <ReadOnlySecrets source={source} />}
    </Card>
  );
}

function MissingScopes({ id, scopes }: { id: string; scopes: readonly string[] }) {
  return (
    <Card testID={`channel-${id}-missing-scopes`} tone="warning" rounded="lg" px="inset-x" py="inset-y" gap="card-row">
      <Text size="label" weight="semibold">令牌缺这些权限：</Text>
      <Column gap="stacked-card">
        {scopes.map((scope) => <Text key={scope} size="code" mono>{`· ${scope}`}</Text>)}
      </Column>
      <Text size="secondary" tone="secondary">给应用加上这些权限并重新安装，再保存新的令牌。</Text>
    </Card>
  );
}

// 不是这台 Mac 的网页：只显示状态，不给输入框和按钮。
function ReadOnlySecrets({ source }: { source: ChannelSourceSettingsDto }) {
  const leadName = useLeadName();
  return (
    <Column gap="card-row">
      {source.secrets.map((secret) => (
        <Row key={secret.name} testID={`channel-${source.source}-secret-${secret.name}`} items="center" gap="inline-item">
          <Text flex={1} minW={0} size="label" weight="semibold" numberOfLines={1}>{secret.label}</Text>
          <Text size="label" tone={secret.present ? 'success-dark' : 'muted'}>{secretStateText(secret)}</Text>
        </Row>
      ))}
      <Text testID={`channel-${source.source}-read-only`} size="secondary" tone="secondary">{readOnlyNote(leadName)}</Text>
    </Column>
  );
}

type Pending = 'test' | 'save' | 'clear' | null;
type Message = { text: string; error: boolean };

function SecretsForm({ source }: { source: ChannelSourceSettingsDto }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const id = source.source;
  const { form, setForm, field } = useServerForm<SecretForm>(emptySecretForm(source));
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [checks, setChecks] = useState<ChannelSecretsTestResult | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const notes = externalSecretNotes(source);

  // 填好的密钥，或者要先改的地方（不发请求）。
  const prepare = (): Record<string, string> | null => {
    const request = secretRequest(source, form);
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
        setMessage({ text: testSummary(result), error: !result.ok });
      })
      .catch((reason: unknown) => setMessage({ text: channelErrorText(reason, leadName), error: true }))
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
        setMessage({ text: SAVED_NOTE, error: false });
      })
      .catch((reason: unknown) => {
        if (reason instanceof ChannelSecretsRejectedError) {
          setChecks(reason.result);
          setMessage({ text: SAVE_REJECTED_NOTE, error: true });
          return;
        }
        setMessage({ text: channelErrorText(reason, leadName), error: true });
      })
      .finally(() => setPending(null));
  };
  const disconnect = () => {
    setConfirmDisconnect(false);
    setPending('clear');
    setMessage(null);
    setChecks(null);
    runtime.clearChannelSecrets(id)
      .then(() => setMessage({ text: DISCONNECTED_NOTE, error: false }))
      .catch((reason: unknown) => setMessage({ text: channelErrorText(reason, leadName), error: true }))
      .finally(() => setPending(null));
  };

  return (
    <Column gap="form-field">
      {source.secrets.map((secret) => (
        <SecretField key={secret.name} sourceId={id} secret={secret} value={form[secret.name] ?? ''} onChange={field(secret.name)} />
      ))}
      <Row items="center" gap="actions" flexWrap="wrap">
        <Button testID={`channel-${id}-test`} label="测试" variant="outline" tone="neutral" size="sm" disabled={pending !== null} onPress={test} />
        <Button testID={`channel-${id}-save`} label="保存" size="sm" disabled={pending !== null} onPress={save} />
        {canDisconnect(source) && !confirmDisconnect ? (
          <Button testID={`channel-${id}-disconnect-start`} label="断开" variant="ghost" tone="danger" size="sm" disabled={pending !== null} onPress={() => setConfirmDisconnect(true)} />
        ) : null}
      </Row>
      {canDisconnect(source) && confirmDisconnect ? (
        <Row testID={`channel-${id}-disconnect-confirm`} items="center" gap="actions" flexWrap="wrap">
          <Text size="body" tone="secondary">{DISCONNECT_CONFIRM_NOTE}</Text>
          <Button testID={`channel-${id}-disconnect`} label="断开" variant="outline" tone="danger" size="sm" disabled={pending !== null} onPress={disconnect} />
          <Button label="取消" variant="ghost" tone="neutral" size="sm" onPress={() => setConfirmDisconnect(false)} />
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
  return (
    <Column testID={`channel-${sourceId}-secret-${secret.name}`} gap="field">
      <Row items="center" gap="inline-item" flexWrap="wrap">
        <Text size="label" weight="semibold">{secret.label}</Text>
        <Text size="code" mono tone="muted">{secret.name}</Text>
        <Text flex={1} minW={0} size="label" align="right" tone={secret.present ? 'success-dark' : 'muted'}>{secretStateText(secret)}</Text>
      </Row>
      {secret.hint ? <Text size="note" tone="secondary">{secret.hint}</Text> : null}
      <TextField
        testID={`channel-${sourceId}-input-${secret.name}`}
        accessibilityLabel={secret.label}
        value={value}
        onChangeText={onChange}
        placeholder={secretPlaceholder(secret)}
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
          {`缺的权限：${result.missingScopes.join('、')}`}
        </Text>
      ) : null}
    </Column>
  );
}

// 建应用：建应用的网页，和可以展开、复制的应用清单。
function AppSetup({ source }: { source: ChannelSourceSettingsDto }) {
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
      <Text size="eyebrow" weight="bold" tone="secondary">建应用</Text>
      {source.setupUrl ? (
        <Text size="secondary" tone="secondary">
          {'在 '}
          <Link testID={`channel-${id}-setup-url`} href={source.setupUrl} size="secondary">{source.setupUrl}</Link>
          {manifest ? ' 用下面的清单建应用，再把生成的令牌填在上面。' : ' 建应用，再把生成的令牌填在上面。'}
        </Text>
      ) : null}
      {manifest ? (
        <Row items="center" gap="actions" flexWrap="wrap">
          <Button
            testID={`channel-${id}-manifest-toggle`}
            label={open ? '收起清单' : '查看清单'}
            icon={open ? 'chevron-up' : 'chevron-down'}
            variant="outline"
            tone="neutral"
            size="sm"
            onPress={() => setOpen((value) => !value)}
          />
          {canCopyText ? (
            <Button testID={`channel-${id}-manifest-copy`} label={copied ? '已复制' : '复制'} icon={copied ? 'check' : 'copy'} variant="ghost" tone="neutral" size="sm" onPress={() => void copy()} />
          ) : null}
        </Row>
      ) : null}
      {manifest && open ? <CodeBlock testID={`channel-${id}-manifest`} code={manifest} language={null} /> : null}
    </Column>
  );
}
