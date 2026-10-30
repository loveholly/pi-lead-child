import { Badge, Button, Card, Column, Dot, Icon, Pressable, Row, SegmentedControl, Text, TextField, useBreakpoint } from '@pi-lead-child/components';
import type { FastModel, ModelProvider, ModelProviderApi, ModelSettingsDto } from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';

import { endpointProblem, keyHostChange, keyHostChangeNote, memoryNeedsUser, pendingRerankFlow, plaintextNote, testResultLabel } from './memoryModel';
import { useModelAction } from './useModelAction';
import {
  BRAIN_NAME, brainIndex, brainInUse, brainModelName, brainRoles, contextLabel, defaultExpanded, FAST_NAME, FAST_USES,
  fastFormProblem, fastKeyLabel, fastModelSub, fastRoles, groupUseLabel, providerFormProblem, providerGroup, providerSub,
  releaseLabel, untilLabel, urlHost,
} from './modelSettingsModel';
import { useServerForm } from './useServerForm';

// 设置 → 模型的「模型库」（方案 B，2026-10-29）：
//   大脑：按服务商分组，组可以折叠（有在用模型的组默认展开），组里最新发布的在前，先露 5 个和正在用的。
//   直觉：一条一行。点一行在下面展开它的表单（和「连接」页的接入流程一样，在原位展开）。
// 接入服务商、添加直觉也在这里。带 key 的改动只有你本人能做（user_direct），Lead 调用会被拒绝。

type Editing = { kind: 'provider'; name: string | null } | { kind: 'fast'; id: string | null } | null;

export function ModelLibrary({ dto }: { dto: ModelSettingsDto }) {
  const { tablet } = useBreakpoint();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(dto));
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing>(null);
  const toggle = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };
  const used = brainInUse(dto);
  const index = brainIndex(dto);
  const query = search.trim();
  const now = new Date();

  return (
    <Column testID="model-library" gap="group-label">
      <Row items="center" gap="inline-item" px="section-label-x" flexWrap="wrap">
        <Text size="eyebrow" weight="bold" tone="secondary">模型库</Text>
        <Text flex={1} size="meta" tone="muted">按服务商分组，组里最新发布的在上面</Text>
        <Column w={tablet ? 220 : '100%'}>{/* spacing-exempt: 搜索框的宽度，组件规格 */}
          <TextField testID="model-library-search" value={search} onChangeText={setSearch} placeholder="搜索模型" variant="filled" size="sm"
            autoCapitalize="none" autoCorrect={false} />
        </Column>
      </Row>

      <Text size="label" weight="semibold" tone="strong" px="section-label-x" pt="section-label-top">{BRAIN_NAME}</Text>
      <Card testID="model-providers" rounded="2xl" overflow="hidden">
        {dto.brain.providers.map((provider, i) => {
          const open = query.length > 0 || expanded.has(provider.name);
          const group = providerGroup(provider, used, { query, showAll: showAll.has(provider.name) });
          if (query && group.models.length === 0) return null;
          const useLabel = groupUseLabel(dto, group);
          const editingThis = editing?.kind === 'provider' && editing.name === provider.name;
          return (
            <Column key={provider.name} testID={`model-provider-${provider.name}`} borderTopWidth={i === 0 ? 0 : 1} borderTopColor="border-soft">
              <Row items="center" gap="side-item" px="row-x" py="row-y">
                <Pressable
                  testID={`model-provider-toggle-${provider.name}`}
                  aria-expanded={open}
                  aria-label={`${open ? '收起' : '展开'} ${provider.name}`}
                  onPress={() => setExpanded((previous) => toggle(previous, provider.name))}
                  flex={1}
                  minW={0}
                  flexDirection="row"
                  items="center"
                  gap="inline-item"
                  feedback="none"
                >
                  <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} color="text-muted" />
                  <Column flex={1} minW={0} gap="text-stack">
                    <Text size="card-title" weight="bold" numberOfLines={1}>{provider.name}</Text>
                    <Text testID={`model-provider-sub-${provider.name}`} size="meta" tone="secondary" numberOfLines={1}>{providerSub(group)}</Text>
                  </Column>
                </Pressable>
                {!open && useLabel ? <Text size="label" weight="semibold" tone="strong">{useLabel}</Text> : null}
                <Button testID={`model-provider-edit-${provider.name}`} label={editingThis ? '收起设置' : '设置'} variant="ghost" tone="neutral" size="xs"
                  onPress={() => setEditing(editingThis ? null : { kind: 'provider', name: provider.name })} />
              </Row>
              {provider.problem ? (
                <Text testID={`model-provider-problem-${provider.name}`} size="note" tone="danger-dark" pl="group-indent" pr="row-x" pb="row-y">
                  {`拉不到目录：${provider.problem}`}
                </Text>
              ) : null}
              {editingThis ? <ProviderForm dto={dto} provider={provider} onDone={() => setEditing(null)} /> : null}
              {open ? group.models.map((model) => {
                const roles = brainRoles(dto, model.model);
                const release = releaseLabel(model.released);
                return (
                  <Row key={model.model} testID={`model-row-${model.model}`} items="center" gap="inline-item" pl="group-indent" pr="row-x" py="row-y"
                    borderTopWidth={1} borderTopColor="border-soft">
                    <Column flex={1} minW={0} gap="text-stack">
                      <Text size="body" weight="semibold" numberOfLines={1}>{brainModelName(model.model, index.get(model.model))}</Text>
                      <Text size="meta" tone="secondary" mono numberOfLines={1}>
                        {/* 手机上右边放不下日期：写进第二行。 */}
                        {[model.id, model.image ? '图片' : null, contextLabel(model.contextWindow), tablet ? null : release].filter(Boolean).join(' · ')}
                      </Text>
                    </Column>
                    {model.blockedUntil ? (
                      <Row items="center" gap="icon-label">
                        <Dot color="danger" size={7} />
                        <Text size="label" weight="semibold" tone="danger-dark">{`额度用尽 · ${untilLabel(model.blockedUntil, now)} 恢复`}</Text>
                      </Row>
                    ) : null}
                    {roles.map((role) => <Badge key={role} label={role} tone={role === '主用' ? 'accent' : 'neutral'} size="xs" />)}
                    {release && tablet ? <Text size="meta" tone="muted" mono>{release}</Text> : null}
                  </Row>
                );
              }) : null}
              {open && group.hidden > 0 ? (
                <Row items="center" gap="inline-item" pl="group-indent" pr="row-x" py="row-y" borderTopWidth={1} borderTopColor="border-soft">
                  <Button testID={`model-provider-more-${provider.name}`} label={`显示其余 ${group.hidden} 个`} variant="link" size="xs"
                    onPress={() => setShowAll((previous) => toggle(previous, provider.name))} />
                  <Text size="meta" tone="muted">正在用的模型总会显示</Text>
                </Row>
              ) : null}
            </Column>
          );
        })}
        {editing?.kind === 'provider' && editing.name === null ? <ProviderForm dto={dto} provider={null} onDone={() => setEditing(null)} /> : null}
        <Row px="row-x" py="row-y" borderTopWidth={dto.brain.providers.length ? 1 : 0} borderTopColor="border-soft">
          <Button testID="model-provider-add" label="接入服务商" icon="plus" variant="link" size="sm"
            onPress={() => setEditing({ kind: 'provider', name: null })} />
        </Row>
      </Card>

      <Text size="label" weight="semibold" tone="strong" px="section-label-x" pt="section-label-top">{FAST_NAME}</Text>
      <Card testID="model-fast-library" rounded="2xl" overflow="hidden">
        {dto.fast.models.map((model, i) => {
          const editingThis = editing?.kind === 'fast' && editing.id === model.id;
          return (
            <Column key={model.id} borderTopWidth={i === 0 ? 0 : 1} borderTopColor="border-soft">
              <Pressable
                testID={`model-fast-row-${model.id}`}
                aria-expanded={editingThis}
                onPress={() => setEditing(editingThis ? null : { kind: 'fast', id: model.id })}
                flexDirection="row"
                items="center"
                gap="inline-item"
                px="row-x"
                py="row-y"
                bg={editingThis ? 'accent-wash' : { default: 'surface', hover: 'surface-subtle', press: 'surface-muted' }}
                feedback="none"
              >
                <Column flex={1} minW={0} gap="text-stack">
                  <Text size="card-title" weight="semibold" numberOfLines={1}>{model.name}</Text>
                  <Text size="meta" tone={model.baseUrl ? 'secondary' : 'danger-dark'} numberOfLines={1}>{fastModelSub(model)}</Text>
                </Column>
                <Text size="meta" tone={model.apiKeySet ? 'muted' : 'warning-dark'}>{fastKeyLabel(model)}</Text>
                {fastRoles(dto, model.id).map((role) => <Badge key={role} label={role} tone={role === '主用' ? 'accent' : 'neutral'} size="xs" />)}
                <Icon name={editingThis ? 'chevron-down' : 'chevron-right'} size={14} color="text-ghost" />
              </Pressable>
              {editingThis ? <FastModelForm dto={dto} model={model} onDone={() => setEditing(null)} /> : null}
            </Column>
          );
        })}
        {editing?.kind === 'fast' && editing.id === null ? <FastModelForm dto={dto} model={null} onDone={() => setEditing(null)} /> : null}
        <Row items="center" gap="inline-item" px="row-x" py="row-y" borderTopWidth={dto.fast.models.length ? 1 : 0} borderTopColor="border-soft" flexWrap="wrap">
          <Button testID="model-fast-add-entry" label="添加决策模型" icon="plus" variant="link" size="sm" onPress={() => setEditing({ kind: 'fast', id: null })} />
          <Text flex={1} size="meta" tone="muted" align="right">{FAST_USES}</Text>
        </Row>
      </Card>
    </Column>
  );
}

// ── 表单 ─────────────────────────────────────────────────────────────────────

function FormFrame({ testID, children }: { testID: string; children: ReactNode }) {
  return (
    <Column testID={testID} gap="form-field" p="page-card" borderTopWidth={1} borderTopColor="border-soft">
      {children}
    </Column>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Column gap="field">
      <Text size="label" tone="secondary">{label}</Text>
      {children}
    </Column>
  );
}

// 删掉之前就地确认（P5.3）：确认行替换原来的按钮。现在不能删时按钮停用，写明原因（P5.8）。
function DeleteRow({ label, confirmText, blocked, busy, onDelete, testID }: {
  label: string; confirmText: string; blocked: string | null; busy: boolean; onDelete: () => void; testID: string;
}) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <Row testID={`${testID}-confirm`} items="center" gap="actions" flexWrap="wrap">
        <Text flex={1} size="body" tone="secondary">{confirmText}</Text>
        <Button testID={`${testID}-yes`} label="删除" variant="outline" tone="danger" size="sm" disabled={busy} onPress={onDelete} />
        <Button label="取消" variant="ghost" tone="neutral" size="sm" onPress={() => setConfirming(false)} />
      </Row>
    );
  }
  return (
    <Column gap="field">
      <Row><Button testID={testID} label={label} variant="ghost" tone="danger" size="sm" disabled={blocked !== null} onPress={() => setConfirming(true)} /></Row>
      {blocked ? <Text size="note" tone="muted">{blocked}</Text> : null}
    </Column>
  );
}

const API_OPTIONS: Array<{ value: ModelProviderApi; label: string }> = [
  { value: 'openai-completions', label: 'OpenAI 兼容' },
  { value: 'openai-responses', label: 'Responses' },
  { value: 'anthropic-messages', label: 'Anthropic' },
  { value: 'google-generative-ai', label: 'Google' },
];

// 表单从一个可能是 null 的对象（新加的时候是 null）算出来的东西，都在组件外面的普通函数里算。网页包开着 React Compiler：
// 组件里读 provider.name、model.baseUrl 这类属性时，编译器会把它提到渲染时当依赖读，对象是 null 时整个组件崩掉
// （2026-10-29：「接入服务商」「添加决策模型」点了就报错）。函数只拿整个对象当参数，编译器的依赖是整个对象。
function providerFacts(dto: ModelSettingsDto, provider: ModelProvider | null, baseUrl: string) {
  if (!provider) return { name: null, keySource: null, keyNote: null, inUse: [] as string[] };
  const movedHost = baseUrl && urlHost(baseUrl) !== urlHost(provider.baseUrl) ? urlHost(baseUrl) : null;
  const keyNote = !movedHost ? null
    : provider.keySource === 'settings' ? `地址换到了 ${movedHost}。已保存的 key 属于 ${provider.keyHost}，不会发给新地址，保存后会被删掉。`
    : provider.keySource === 'config' ? `地址换到了 ${movedHost}。config.json 里的 key 保存后会被删掉，它不会发给新地址。`
    : null;
  const inUse = dto.brain.chain.filter((choice) => choice.model.startsWith(`${provider.name}/`)).map((choice) => choice.model);
  return { name: provider.name, keySource: provider.keySource, keyNote, inUse };
}

function ProviderForm({ dto, provider, onDone }: { dto: ModelSettingsDto; provider: ModelProvider | null; onDone: () => void }) {
  const { busy, run } = useModelAction();
  const isNew = provider === null;
  const { form, setForm, field } = useServerForm({ name: provider?.name ?? '', baseUrl: provider?.baseUrl ?? '', apiKey: '' });
  const [api, setApi] = useState<ModelProviderApi>(provider?.api ?? 'openai-completions');
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const baseUrl = form.baseUrl.trim();
  const facts = providerFacts(dto, provider, baseUrl);
  const { keyNote, inUse } = facts;
  const save = async () => {
    const problem = providerFormProblem(form, isNew, dto.brain.providers.map((entry) => entry.name), baseUrl ? endpointProblem(baseUrl) : null);
    if (problem) {
      setMessage({ text: problem, error: true });
      return;
    }
    const outcome = await run('save_provider', {
      name: (facts.name ?? form.name).trim(), baseUrl, api, ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    });
    if (!outcome.ok) {
      setMessage({ text: outcome.error, error: true });
      return;
    }
    setForm((current) => ({ ...current, apiKey: '' }));
    const note = (outcome.result as { note?: string | null } | null)?.note;
    if (isNew) onDone();
    else setMessage({ text: note ?? '已保存。下一次拉目录、换模型时用新的设置。', error: false });
  };
  const remove = async () => {
    if (facts.name === null) return;
    const outcome = await run('remove_provider', { name: facts.name });
    if (!outcome.ok) setMessage({ text: outcome.error, error: true });
    else onDone();
  };
  return (
    <FormFrame testID={facts.name === null ? 'model-provider-form-new' : `model-provider-form-${facts.name}`}>
      {isNew ? (
        <Field label="名字（模型写成 名字/模型 id）">
          <TextField testID="model-provider-name" value={form.name} onChangeText={field('name')} placeholder="openai" variant="filled" size="sm" mono
            autoCapitalize="none" autoCorrect={false} />
        </Field>
      ) : null}
      <Field label="地址">
        <TextField testID="model-provider-url" value={form.baseUrl} onChangeText={field('baseUrl')} placeholder="https://api.openai.com/v1" variant="filled"
          size="sm" mono keyboardType="url" autoComplete="off" autoCapitalize="none" autoCorrect={false} />
      </Field>
      {plaintextNote(form.baseUrl) ? <Text size="note" tone="warning-dark">{plaintextNote(form.baseUrl)}</Text> : null}
      <Field label="接口格式">
        <SegmentedControl testID="model-provider-api" options={API_OPTIONS} value={api} onChange={setApi} size="sm" />
      </Field>
      <Field label="API key">
        <TextField
          testID="model-provider-key"
          value={form.apiKey}
          onChangeText={field('apiKey')}
          placeholder={facts.keySource === 'settings' ? '已设置 · 要更换就粘贴新的'
            : facts.keySource === 'config' ? '正在用 config.json 里的 key · 粘贴新的会改用这里的'
            : '不需要时留空（例如本机的代理）'}
          variant="filled"
          size="sm"
          secure
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      {keyNote ? <Text testID="model-provider-key-note" size="note" tone="warning-dark">{keyNote}</Text> : null}
      <Text size="note" tone="secondary">
        {`${BRAIN_NAME}用这里的模型时，会把对话发给 ${baseUrl ? urlHost(baseUrl) : '这个地址'}。key 只发给这个主机，只保存在这台 Mac 上。`}
      </Text>
      <Row items="center" gap="actions" flexWrap="wrap">
        <Button testID="model-provider-save" label={isNew ? '接入' : '保存'} size="sm" disabled={busy} onPress={() => void save()} />
        <Button label="取消" variant="ghost" tone="neutral" size="sm" onPress={onDone} />
      </Row>
      {message ? <Text testID="model-provider-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
      {facts.name !== null ? (
        <DeleteRow
          testID="model-provider-delete"
          label="删除服务商"
          confirmText={`删掉 ${facts.name}，它的 key 也一起删掉。`}
          blocked={inUse.length ? `${BRAIN_NAME}的分工里还在用 ${inUse.join('、')}，先在上面换掉。` : null}
          busy={busy}
          onDelete={() => void remove()}
        />
      ) : null}
    </FormFrame>
  );
}

// 同 providerFacts：在组件外面算，新加的时候 model 是 null。
function fastModelFacts(dto: ModelSettingsDto, model: FastModel | null, formBaseUrl: string) {
  if (!model) return { id: null, name: null, apiKeySet: false, source: null, hostChange: null, savedHost: null, inChain: false };
  return {
    id: model.id,
    name: model.name,
    apiKeySet: model.apiKeySet,
    source: model.apiKeySource === 'env' ? 'external' as const : model.apiKeySource === 'settings' ? 'settings' as const : null,
    hostChange: keyHostChange(model.apiKeyHost, formBaseUrl, model.apiKeySet),
    savedHost: model.baseUrl ? urlHost(model.baseUrl) : null,
    inChain: dto.fast.chain.includes(model.id),
  };
}

function FastModelForm({ dto, model, onDone }: { dto: ModelSettingsDto; model: FastModel | null; onDone: () => void }) {
  const runtime = useCompanionRuntime();
  const { busy, run } = useModelAction();
  const isNew = model === null;
  const { form, setForm, field } = useServerForm({
    name: model?.name ?? '', baseUrl: model?.baseUrl ?? 'https://api.typesafe.ai', model: model?.model ?? 'jev-latest', apiKey: '',
  });
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [tested, setTested] = useState<{ text: string; ok: boolean } | null>(null);
  const facts = fastModelFacts(dto, model, form.baseUrl);
  const { source, hostChange, savedHost, inChain } = facts;
  const plaintext = plaintextNote(form.baseUrl);
  const save = async () => {
    const problem = fastFormProblem(form, form.baseUrl.trim() ? endpointProblem(form.baseUrl) : null);
    if (problem) {
      setMessage({ text: problem, error: true });
      return;
    }
    const outcome = await run('save_fast_model', {
      ...(facts.id !== null ? { id: facts.id } : {}),
      name: form.name.trim(), baseUrl: form.baseUrl.trim(), model: form.model.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    });
    if (!outcome.ok) {
      setMessage({ text: outcome.error, error: true });
      return;
    }
    setForm((current) => ({ ...current, apiKey: '' }));
    // 要往一个新主机发召回内容时，daemon 不直接开始：它出一张待确认的切换卡（见页面上面）。
    const memory = runtime.control.getState().memory;
    const flow = memory && memoryNeedsUser(memory) ? pendingRerankFlow(memory) : null;
    const note = (outcome.result as { note?: string | null } | null)?.note;
    if (isNew) {
      onDone();
      return;
    }
    setMessage({ text: flow ? `已保存。重排开始往 ${flow.host} 发之前，会先问你：见上面。` : note ?? '已保存，下一次判断就用新的。', error: false });
  };
  const test = async () => {
    setTested(null);
    if (facts.id === null) return;
    const outcome = await run('test_fast_model', { id: facts.id });
    setTested(outcome.ok
      ? { text: testResultLabel(outcome.result as { ok: boolean; message: string; latencyMs: number | null }), ok: (outcome.result as { ok: boolean }).ok }
      : { text: outcome.error, ok: false });
  };
  const remove = async () => {
    if (facts.id === null) return;
    const outcome = await run('remove_fast_model', { id: facts.id });
    if (!outcome.ok) setMessage({ text: outcome.error, error: true });
    else onDone();
  };
  return (
    <FormFrame testID={facts.id === null ? 'model-fast-form-new' : `model-fast-form-${facts.id}`}>
      <Field label="名字">
        <TextField testID="model-fast-name" value={form.name} onChangeText={field('name')} placeholder="decision-1" variant="filled" size="sm"
          autoCapitalize="none" autoCorrect={false} />
      </Field>
      <Field label="地址（会请求 地址/v1/systemone）">
        <TextField testID="model-fast-url" value={form.baseUrl} onChangeText={field('baseUrl')} placeholder="https://api.typesafe.ai" variant="filled"
          size="sm" mono keyboardType="url" autoComplete="off" autoCapitalize="none" autoCorrect={false} />
      </Field>
      {plaintext ? <Text testID="model-fast-plaintext" size="note" tone="warning-dark">{plaintext}</Text> : null}
      <Field label="模型">
        <TextField testID="model-fast-model" value={form.model} onChangeText={field('model')} placeholder="jev-latest" variant="filled" size="sm" mono
          autoCapitalize="none" autoCorrect={false} />
      </Field>
      <Field label="API key">
        <TextField
          testID="model-fast-key"
          value={form.apiKey}
          onChangeText={field('apiKey')}
          placeholder={hostChange ? `粘贴 ${hostChange.to} 的 API key` : !facts.apiKeySet ? '粘贴 API key'
            : source === 'external' ? '正在用 Keychain 里的 key · 粘贴新的会改用这里的' : '已设置 · 要更换就粘贴新的'}
          variant="filled"
          size="sm"
          secure
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      {hostChange ? <Text testID="model-fast-host-change" size="note" tone="warning-dark">{keyHostChangeNote(hostChange, source)}</Text> : null}
      <Text testID="model-fast-data-note" size="note" tone="secondary">
        {`轮到它判断时，会把要判断的内容发给 ${savedHost ?? (form.baseUrl.trim() ? urlHost(form.baseUrl.trim()) : '这个地址')}。key 只发给这个主机，只保存在这台 Mac 上。`}
      </Text>
      <Row items="center" gap="actions" flexWrap="wrap">
        <Button testID="model-fast-save" label={isNew ? '添加' : '保存'} size="sm" disabled={busy} onPress={() => void save()} />
        {facts.id !== null ? (
          <Button testID="model-fast-test" label="测试已保存的配置" variant="outline" tone="neutral" size="sm" disabled={busy || !facts.apiKeySet}
            onPress={() => void test()} />
        ) : null}
        <Button label="取消" variant="ghost" tone="neutral" size="sm" onPress={onDone} />
        {tested ? <Text testID="model-fast-tested" size="label" weight="bold" tone={tested.ok ? 'success-dark' : 'danger-dark'}>{tested.text}</Text> : null}
      </Row>
      {message ? <Text testID="model-fast-form-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
      {facts.name !== null ? (
        <DeleteRow
          testID="model-fast-delete"
          label="删除这条直觉"
          confirmText={`删掉 ${facts.name}，它的 key 也一起删掉。`}
          blocked={inChain ? `${facts.name} 还在${FAST_NAME}的分工里，先在上面移出。` : null}
          busy={busy}
          onDelete={() => void remove()}
        />
      ) : null}
    </FormFrame>
  );
}

