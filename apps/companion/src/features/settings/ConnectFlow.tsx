import {
  Box, Button, canCopyText, Card, Code, Column, copyText, Icon, isWeb, Link, openURL, Row, safeLink, ServiceMark, Spinner, Text,
  TextField,
} from '@pi-lead-child/components';
import type { ConnectionDto, StartConnectionResponse } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useCompanionRuntime, useControlPlaneStore } from '@/state/CompanionStateProvider';
import { useLeadName } from '@/state/hooks';

import {
  connectionErrorReason, connectionErrorText, displayUrl, minutesUntil, opensBrowser, tryPrompt,
} from './connectionModel';

// 连接流程（设置的连接列表、详情、健康条、会话里的连接卡都用这一份）：
//   1. 预览：会打开哪个授权页，连上以后 Lead 能做什么。
//   2. 等授权：浏览器授权页（web 上开新窗口；手机上复制链接到 Mac）、GitHub 设备码，或者直接连上。
//   3. 完成：已连接、账号、「试一下」。
// 等授权时每 2 秒问一次 daemon；网关推连接变了的事件时马上再问一次。

export const FLOW_POLL_MS = 2_000;

export type FlowTarget = Pick<ConnectionDto, 'key' | 'label' | 'provider' | 'capability' | 'state' | 'setupHint' | 'writePolicy' | 'problem'>;

export type ConnectFlowState =
  | { step: 'consent' }
  | { step: 'starting' }
  | { step: 'browser'; flowId: string; authorizeUrl: string; windowOpened: boolean }
  | { step: 'device'; flowId: string; userCode: string; verificationUri: string; expiresAt: string }
  | { step: 'done'; connection: ConnectionDto | null }
  | { step: 'failed'; message: string }
  // 要先配置（Slack 的 client ID），或者 GitHub 没有 gh 时粘贴令牌。
  | { step: 'setup'; message: string | null };

export type ConnectFlow = {
  state: ConnectFlowState;
  // 在按钮的点击里同步调用：web 上新窗口必须在点击里打开，等完请求再开会被浏览器拦下。
  run: (start: () => Promise<StartConnectionResponse>, options: { browser: boolean }) => void;
  reset: () => void;
};

export function initialFlowState(target: Pick<FlowTarget, 'state' | 'setupHint'>): ConnectFlowState {
  return target.state === 'needs_setup' ? { step: 'setup', message: target.setupHint } : { step: 'consent' };
}

export function useConnectFlow(initial: ConnectFlowState = { step: 'consent' }): ConnectFlow {
  const runtime = useCompanionRuntime();
  const [state, setState] = useState<ConnectFlowState>(initial);
  const alive = useRef(true);
  const pendingFlowId = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback((start: () => Promise<StartConnectionResponse>, options: { browser: boolean }) => {
    // 先开一个空白窗口，拿到授权地址以后再把它指过去。
    const popup = options.browser && isWeb ? openBlankWindow() : null;
    setState({ step: 'starting' });
    let request: Promise<StartConnectionResponse>;
    try {
      request = start();
    } catch (reason) {
      request = Promise.reject(reason);
    }
    request.then((response) => {
      if (!alive.current) { popup?.close(); return; }
      if (response.flow === 'browser') {
        const url = safeLink(response.authorizeUrl);
        const opened = Boolean(popup && url && pointWindow(popup, url));
        if (!opened) popup?.close();
        pendingFlowId.current = response.flowId;
        setState({ step: 'browser', flowId: response.flowId, authorizeUrl: response.authorizeUrl, windowOpened: opened });
        return;
      }
      popup?.close();
      if (response.flow === 'device') {
        pendingFlowId.current = response.flowId;
        setState({
          step: 'device', flowId: response.flowId, userCode: response.userCode,
          verificationUri: response.verificationUri, expiresAt: response.expiresAt,
        });
        return;
      }
      setState({ step: 'done', connection: response.connection });
    }, (reason: unknown) => {
      popup?.close();
      if (!alive.current) return;
      setState(connectionErrorReason(reason) === 'needs_setup'
        ? { step: 'setup', message: connectionErrorText(reason) }
        : { step: 'failed', message: connectionErrorText(reason) });
    });
  }, []);

  const reset = useCallback(() => {
    pendingFlowId.current = null;
    setState(initial);
  }, [initial]);

  // 等授权：每 2 秒问一次。连上、失败或过期时停。网络出错时接着等。
  const flowId = state.step === 'browser' || state.step === 'device' ? state.flowId : null;
  const settle = useCallback((result: Awaited<ReturnType<typeof runtime.connectionFlow>>): boolean => {
    if (!alive.current || pendingFlowId.current !== result.flowId || result.state === 'pending') return false;
    pendingFlowId.current = null;
    if (result.state === 'connected') setState({ step: 'done', connection: result.connection });
    else setState({ step: 'failed', message: result.message ?? (result.state === 'expired' ? '授权已过期，请重新连接。' : '授权没有完成。') });
    return true;
  }, []);

  useEffect(() => {
    if (!flowId) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      runtime.connectionFlow(flowId, controller.signal).then(
        (result) => { if (!controller.signal.aborted && !settle(result)) timer = setTimeout(check, FLOW_POLL_MS); },
        () => { if (!controller.signal.aborted) timer = setTimeout(check, FLOW_POLL_MS); },
      );
    };
    timer = setTimeout(check, FLOW_POLL_MS);
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
    };
  }, [flowId, runtime, settle]);

  // 网关说连接变了（snapshot.required）：不等下一次轮询，马上问。
  const connections = useControlPlaneStore((store) => store.connections);
  const seenConnections = useRef(connections);
  useEffect(() => {
    if (seenConnections.current === connections) return;
    seenConnections.current = connections;
    if (!flowId) return;
    void runtime.connectionFlow(flowId).then(settle, () => {});
  }, [connections, flowId, runtime, settle]);

  return { state, run, reset };
}

function openBlankWindow(): Window | null {
  try {
    return typeof window !== 'undefined' && typeof window.open === 'function' ? window.open('', '_blank') : null;
  } catch {
    return null;
  }
}

// 授权页不需要回头控制这个页面：先断开 opener，再跳过去。
function pointWindow(popup: Window, url: string): boolean {
  try {
    popup.opener = null;
    popup.location.href = url;
    return true;
  } catch {
    return false;
  }
}

// 连接流程的一整块：预览、等授权、完成。onClose：点「完成」或「取消」以后收起这一块。
export function ConnectFlowPanel({ target, onClose }: { target: FlowTarget; onClose?: () => void }) {
  const runtime = useCompanionRuntime();
  const [initial] = useState(() => initialFlowState(target));
  const flow = useConnectFlow(initial);
  const start = () => flow.run(() => runtime.startConnection(target.key), { browser: opensBrowser(target.provider) });
  return (
    <Card testID={`connect-flow-${target.key}`} p="page-card" rounded="xl" gap="card-row" bg="surface" borderColor="border">
      {flow.state.step === 'consent' ? <ConsentStep target={target} onContinue={start} onCancel={onClose} /> : (
        <ConnectFlowSteps target={target} flow={flow} onClose={onClose} onRetry={flow.reset} />
      )}
    </Card>
  );
}

// 第 1 步：连上以后会怎样。
export function ConsentStep({ target, onContinue, onCancel }: { target: FlowTarget; onContinue: () => void; onCancel?: () => void }) {
  const leadName = useLeadName();
  const reauth = target.state === 'needs_reauth' || target.problem?.kind === 'expiring';
  const how = target.provider === 'github'
    ? target.setupHint ?? '会用这台 Mac 上 gh 的登录，或者显示一个设备码'
    : `会打开 ${target.label} 的授权页`;
  return (
    <Column testID="connect-consent" gap="card-section">
      <Row items="center" gap="side-item">
        <ServiceMark service={target.provider} label={target.label} size={40} />
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="card-title" weight="extrabold">{`${reauth ? '重新授权' : '连接'} ${target.label}`}</Text>
          <Text size="secondary" tone="secondary">{how}</Text>
        </Column>
      </Row>
      <Column gap="text-stack">
        <Text size="body" weight="semibold">{`连接以后，${leadName} 可以`}</Text>
        <Text size="body" tone="secondary">{target.capability}</Text>
      </Column>
      <Column gap="text-stack">
        {target.writePolicy !== 'direct' ? <Text size="note" tone="secondary">会写入的操作每次先问你。</Text> : null}
        <Text size="note" tone="secondary">授权只保存在这台 Mac 上。你随时可以在设置里断开。</Text>
      </Column>
      <Row gap="actions" flexWrap="wrap">
        <Button testID="connect-continue" label={`继续到 ${target.label}`} onPress={onContinue} />
        {onCancel ? <Button label="取消" variant="ghost" tone="neutral" onPress={onCancel} /> : null}
      </Row>
    </Column>
  );
}

// 第 2、3 步，以及要先配置、出错。会话里的连接卡自己画第 1 步，后面的用这一份。
export function ConnectFlowSteps({ target, flow, onClose, onRetry }: {
  target: FlowTarget;
  flow: ConnectFlow;
  onClose?: () => void;
  onRetry?: () => void;
}) {
  const runtime = useCompanionRuntime();
  const { state } = flow;
  const cancel = () => {
    flow.reset();
    onClose?.();
  };
  if (state.step === 'consent' || state.step === 'starting') {
    return (
      <Row testID="connect-starting" items="center" gap="icon-label">
        <Spinner size={16} />
        <Text size="secondary" tone="secondary">{`正在连接 ${target.label}…`}</Text>
      </Row>
    );
  }
  if (state.step === 'browser') {
    return isWeb ? <BrowserWaiting url={state.authorizeUrl} opened={state.windowOpened} onCancel={cancel} /> : (
      <PhoneBrowserStep url={state.authorizeUrl} onCancel={cancel} />
    );
  }
  if (state.step === 'device') return <DeviceCodeStep state={state} onCancel={cancel} />;
  if (state.step === 'done') {
    return <DoneStep target={target} connection={state.connection} onDone={onClose ?? flow.reset} />;
  }
  if (state.step === 'setup') {
    return (
      <SetupStep
        target={target}
        message={state.message}
        onToken={(token) => flow.run(() => runtime.startConnection(target.key, { token }), { browser: false })}
        onCancel={onClose}
      />
    );
  }
  return (
    <Column testID="connect-failed" gap="card-row">
      <Text size="note" weight="semibold" tone="danger-dark">{state.message}</Text>
      <Row gap="actions">
        {onRetry ? <Button label="重试" variant="outline" tone="neutral" size="sm" onPress={onRetry} /> : null}
        {onClose ? <Button label="关闭" variant="ghost" tone="neutral" size="sm" onPress={onClose} /> : null}
      </Row>
    </Column>
  );
}

function BrowserWaiting({ url, opened, onCancel }: { url: string; opened: boolean; onCancel: () => void }) {
  return (
    <Column testID="connect-browser" gap="card-section">
      <Row items="center" gap="side-item">
        <Spinner size={18} />
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="card-title" weight="bold">{opened ? '在新窗口里完成授权' : '浏览器没有打开新窗口'}</Text>
          <Text size="secondary" tone="secondary">完成后这里会自动更新</Text>
        </Column>
      </Row>
      <Column gap="card-row">
        <Text size="secondary" tone="secondary">窗口没有打开？</Text>
        <AuthorizeLinkButtons url={url} />
      </Column>
      <Row><Button label="取消" variant="ghost" tone="neutral" size="sm" onPress={onCancel} /></Row>
    </Column>
  );
}

function PhoneBrowserStep({ url, onCancel }: { url: string; onCancel: () => void }) {
  const leadName = useLeadName();
  return (
    <Column testID="connect-browser-phone" gap="card-row">
      <Text size="body">{`授权页只能跳回运行 ${leadName} 的 Mac。复制链接，在 Mac 的浏览器里打开。`}</Text>
      <Box px="inset-x" py="inset-y" rounded="md" bg="surface-muted">
        <Text size="code" mono numberOfLines={3}>{url}</Text>
      </Box>
      <Row gap="actions" items="center">
        {canCopyText ? <CopyButton text={url} label="复制授权链接" /> : null}
        <Button label="取消" variant="ghost" tone="neutral" size="sm" onPress={onCancel} />
      </Row>
    </Column>
  );
}

function AuthorizeLinkButtons({ url }: { url: string }) {
  return (
    <Row gap="actions" items="center" flexWrap="wrap">
      {/* spacing-exempt: 链接字号 */}
      <Link testID="connect-open-link" href={url} size="13" weight="bold">打开授权页</Link>
      {canCopyText ? <CopyButton text={url} label="复制授权链接" /> : null}
    </Row>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      testID="connect-copy-link"
      label={copied ? '已复制' : label}
      variant="outline"
      tone="neutral"
      size="sm"
      onPress={() => { void copyText(text).then((ok) => setCopied(ok)); }}
    />
  );
}

function DeviceCodeStep({ state, onCancel }: {
  state: Extract<ConnectFlowState, { step: 'device' }>;
  onCancel: () => void;
}) {
  const minutes = minutesUntil(state.expiresAt);
  const openGithub = () => {
    void copyText(state.userCode).finally(() => openURL(state.verificationUri));
  };
  return (
    <Column testID="connect-device" gap="card-row">
      <Text size="body">在 GitHub 上输入这个设备码：</Text>
      <Box py="inset-y" rounded="lg" bg="surface-muted" items="center">
        <Text testID="connect-device-code" size="numeric" mono weight="bold" letterSpacing={2}>{state.userCode}</Text>
      </Box>
      <Row><Button testID="connect-device-open" label="复制并打开 GitHub" onPress={openGithub} /></Row>
      <Text size="meta" tone="secondary">{`${displayUrl(state.verificationUri)}${minutes ? ` · ${minutes} 分钟内有效` : ''}`}</Text>
      <Row items="center" gap="icon-label">
        <Spinner size={14} />
        <Text flex={1} size="secondary" tone="secondary">输入设备码以后，这里会自动更新</Text>
        <Button label="取消" variant="ghost" tone="neutral" size="sm" onPress={onCancel} />
      </Row>
    </Column>
  );
}

function DoneStep({ target, connection, onDone }: { target: FlowTarget; connection: ConnectionDto | null; onDone: () => void }) {
  const label = connection?.label ?? target.label;
  return (
    <Column testID="connect-done" gap="card-row" items="center">
      <Box w={40} h={40} rounded="full" bg="success-soft" items="center" justify="center">
        <Icon name="check" size={20} color="success-dark" weight="bold" />
      </Box>
      <Text size="card-title" weight="extrabold" align="center">{`${label} 已连接`}</Text>
      {connection?.account ? <Text size="secondary" tone="secondary" align="center">{connection.account}</Text> : null}
      <Text size="secondary" tone="secondary" align="center">
        {'试一下：'}
        <Code size="code">{tryPrompt(connection?.provider ?? target.provider, label)}</Code>
      </Text>
      <Button testID="connect-finish" label="完成" variant="outline" tone="neutral" size="sm" onPress={onDone} />
    </Column>
  );
}

function SetupStep({ target, message, onToken, onCancel }: {
  target: FlowTarget;
  message: string | null;
  onToken: (token: string) => void;
  onCancel?: () => void;
}) {
  const [token, setToken] = useState('');
  if (target.provider === 'github') {
    const submit = () => {
      const value = token.trim();
      if (!value) return;
      // 令牌只交给 daemon，界面上不留它。
      setToken('');
      onToken(value);
    };
    return (
      <Column testID="connect-setup" gap="card-row">
        {message ? <Text size="secondary" tone="secondary">{message}</Text> : null}
        <Text size="label" weight="semibold">粘贴一个 GitHub 令牌</Text>
        <TextField
          testID="connect-github-token"
          value={token}
          onChangeText={setToken}
          placeholder="ghp_…"
          secure
          mono
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="GitHub 令牌"
          onSubmit={submit}
        />
        <Text size="note" tone="secondary">令牌只保存在这台 Mac 上，加密存放。</Text>
        <Row gap="actions">
          <Button testID="connect-github-token-submit" label="连接" disabled={!token.trim()} onPress={submit} />
          {onCancel ? <Button label="取消" variant="ghost" tone="neutral" onPress={onCancel} /> : null}
        </Row>
      </Column>
    );
  }
  return (
    <Column testID="connect-setup" gap="card-row">
      {target.provider === 'slack' ? (
        <Text size="body">
          {'Slack 要求用你们工作区里的一个 Slack app 连接。先在 daemon 的 config.json 里填上这个 app 的 client ID（connections.slack.clientId），再重启 daemon。'}
        </Text>
      ) : (
        <Text size="body">{message ?? target.setupHint ?? `${target.label} 需要先在 daemon 上配置。`}</Text>
      )}
      {onCancel ? <Row><Button label="关闭" variant="ghost" tone="neutral" size="sm" onPress={onCancel} /></Row> : null}
    </Column>
  );
}
