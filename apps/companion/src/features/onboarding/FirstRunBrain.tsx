import {
  Box, Button, Card, ChoiceGroup, Column, Icon, LeadAvatar, Pressable, Row, Screen, ScrollArea, SegmentedControl, Text, TextField,
} from '@pi-lead-child/components';
import type { ModelProviderApi } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useLeadAvatarSource } from '@/components/useLeadAvatarSource';
import { useLeadName, useModelSettings } from '@/state/hooks';
import { useModelAction } from '@/features/settings/useModelAction';

import {
  connectedProvider, FIRST_RUN_PRESETS, firstRunModelList, firstRunModelMeta, firstRunPreset, firstRunProviderFacts, firstRunProviderRequest,
  modelEffort, recommendedBrainModel, type FirstRunPresetId,
} from './firstRunModel';

// 首次启动页（2026-10-30，.scratch/onboarding/spec.md，画布 A1、A3）：大脑不能用时整页显示，两步。
//   1. 接入服务商：选接口类型（Anthropic、OpenAI、Google、其他 OpenAI 兼容），填 key（其他服务还要地址和接口格式），
//      连接后 daemon 读这家的模型目录。用的是设置 → 模型的 save_provider，和 Lead 的 perform_action 同一个操作。
//   2. 选一个模型当大脑：set_brain_chain。daemon 热切换模型，设置状态说大脑能用了，这一页就换成会话（RootTabs）。
// 「先进去看看」只在这次打开 App 时跳过；Lead 保持离线。

const API_OPTIONS: Array<{ value: ModelProviderApi; label: string }> = [
  { value: 'openai-completions', label: 'Chat Completions' },
  { value: 'openai-responses', label: 'Responses' },
  { value: 'anthropic-messages', label: 'Anthropic' },
];

const MODEL_LIST_LIMIT = 4;

function StepMark({ index, done, active }: { index: number; done: boolean; active: boolean }) {
  if (done) {
    return (
      <Box w={20} h={20} rounded="full" bg="success-soft" items="center" justify="center" aria-label="完成">
        <Icon name="check" size={12} color="success-dark" />
      </Box>
    );
  }
  return (
    <Box w={20} h={20} rounded="full" bg={active ? 'text' : 'border-soft'} items="center" justify="center">
      <Text size="meta" weight="semibold" font="mono" color={active ? 'surface' : 'text-muted'}>{String(index)}</Text>
    </Box>
  );
}

export function FirstRunBrain({ onSkip }: { onSkip: () => void }) {
  const leadName = useLeadName();
  const avatar = useLeadAvatarSource({ state: 'idle', tone: 'quiet' });
  const { modelSettings } = useModelSettings();
  const { busy, run } = useModelAction();
  const [preset, setPreset] = useState<FirstRunPresetId>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [api, setApi] = useState<ModelProviderApi>('openai-completions');
  const [providerName, setProviderName] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const facts = firstRunProviderFacts(connectedProvider(modelSettings, providerName));
  const { connected } = facts;
  const models = firstRunModelList(facts.models, showAll ? null : MODEL_LIST_LIMIT);
  const recommended = recommendedBrainModel(facts.models);
  const recommendedId = recommended ? recommended.model : null;
  const chosen = picked ?? recommendedId;
  const custom = preset === 'custom';
  const presetInfo = firstRunPreset(preset);

  const connect = async () => {
    const request = firstRunProviderRequest({ preset, apiKey, baseUrl, api }, (modelSettings?.brain.providers ?? []).map((entry) => entry.name));
    if (!request.ok) {
      setProblem(request.problem);
      return;
    }
    setProblem(null);
    const outcome = await run('save_provider', request.input);
    if (!outcome.ok) {
      setProblem(outcome.error);
      return;
    }
    setApiKey('');
    setProviderName(request.input.name);
    setPicked(null);
  };
  const goOnline = async () => {
    if (!chosen) return;
    const outcome = await run('set_brain_chain', { models: [{ model: chosen, effort: modelEffort(facts.models, chosen) }] });
    if (!outcome.ok) setProblem(outcome.error);
  };
  const catalogProblem = facts.problem;

  return (
    <Screen testID="first-run-brain" edges={['top', 'bottom']} bg="surface-subtle">
      <ScrollArea>
        <Column w="100%" items="center" px="page-x" py="page-section">
          <Column w="100%" maxW="prose" gap="page-section">
            <Column gap="card-row">
              <Row items="center" gap="icon-label">
                <LeadAvatar source={avatar} size={32} tone="quiet" name={leadName} />
                <Text size="label" weight="semibold" tone="secondary">{`${leadName} · 离线`}</Text>
              </Row>
              <Text testID="first-run-title" size="page-title" weight="bold">{`先给 ${leadName} 接一个大模型`}</Text>
              <Text size="body" tone="secondary">
                {`两步：接入一家模型服务商，再选一个模型当大脑。接好以后 ${leadName} 马上上线。记忆、Slack、连接这些设置，它会在空闲时带你一项一项配。`}
              </Text>
            </Column>

            <Card testID="first-run-step-provider" w="100%" rounded="xl" p="page-card" gap="card-section">
              <Row items="center" gap="inline-item">
                <StepMark index={1} done={connected} active={!connected} />
                <Text size="card-title" weight="semibold">接入服务商</Text>
                {connected ? (
                  <>
                    <Text testID="first-run-provider-done" flex={1} minW={0} size="secondary" tone="secondary" numberOfLines={1}>
                      {`${facts.name ?? ''} · 读到 ${facts.modelCount} 个模型`}
                    </Text>
                    <Pressable testID="first-run-provider-change" aria-label="换一家服务商" onPress={() => setProviderName(null)}>
                      <Text size="label" weight="semibold" color="accent-strong">改</Text>
                    </Pressable>
                  </>
                ) : null}
              </Row>
              {connected ? null : (
                <Column gap="card-row">
                  <ChoiceGroup
                    testID="first-run-presets"
                    variant="radio"
                    accessibilityLabel="接口类型"
                    value={preset}
                    options={FIRST_RUN_PRESETS.map((entry) => ({ id: entry.id, label: entry.label, description: entry.description }))}
                    optionTestID={(id) => `first-run-preset-${id}`}
                    onSelect={(id) => { setPreset(id as FirstRunPresetId); setProblem(null); }}
                    disabled={busy}
                  />
                  {custom ? (
                    <Column gap="card-row">
                      <Column gap="text-stack">
                        <Text size="label" weight="semibold" tone="secondary">服务地址</Text>
                        <TextField testID="first-run-base-url" value={baseUrl} onChangeText={setBaseUrl} placeholder="http://127.0.0.1:8317/v1"
                          variant="filled" size="sm" mono keyboardType="url" autoComplete="off" autoCapitalize="none" autoCorrect={false} />
                      </Column>
                      <Column gap="text-stack">
                        <Text size="label" weight="semibold" tone="secondary">接口格式</Text>
                        <SegmentedControl testID="first-run-api" options={API_OPTIONS} value={api} onChange={setApi} size="sm" />
                      </Column>
                    </Column>
                  ) : null}
                  <Column gap="text-stack">
                    <Text size="label" weight="semibold" tone="secondary">{custom ? 'API key（本机代理通常不用填）' : 'API key'}</Text>
                    <TextField
                      testID="first-run-api-key"
                      value={apiKey}
                      onChangeText={setApiKey}
                      placeholder={custom ? '可以留空' : `粘贴 ${presetInfo.label} 的 API key`}
                      variant="filled"
                      size="sm"
                      secure
                      autoComplete="new-password"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </Column>
                  {catalogProblem ?? problem ? (
                    <Text testID="first-run-problem" size="note" color="danger-dark">{catalogProblem ?? problem}</Text>
                  ) : null}
                  <Row items="center" gap="actions">
                    <Text flex={1} size="note" tone="secondary">key 只保存在这台 Mac 上，只发给这家服务商。</Text>
                    <Button testID="first-run-connect" label={busy ? '正在连接…' : '连接并读取模型'} size="sm" tone="accent" disabled={busy} onPress={() => void connect()} />
                  </Row>
                </Column>
              )}
            </Card>

            <Card testID="first-run-step-model" w="100%" rounded="xl" p="page-card" gap="card-section">
              <Row items="center" gap="inline-item">
                <StepMark index={2} done={false} active={connected} />
                <Text size="card-title" weight="semibold" tone={connected ? 'default' : 'muted'}>选大脑模型</Text>
                {connected ? null : <Text size="secondary" tone="muted">接好服务商后，这里列出它的模型</Text>}
              </Row>
              {connected ? (
                <Column gap="card-row">
                  <ChoiceGroup
                    testID="first-run-models"
                    variant="radio"
                    accessibilityLabel="大脑模型"
                    value={chosen}
                    {...(recommendedId ? { recommended: recommendedId } : {})}
                    options={models.map((model) => ({ id: model.model, label: model.name ?? model.id, description: firstRunModelMeta(model) }))}
                    optionTestID={(id) => `first-run-model-${id}`}
                    onSelect={setPicked}
                    disabled={busy}
                  />
                  {!showAll && facts.modelCount > MODEL_LIST_LIMIT ? (
                    <Pressable testID="first-run-show-all" aria-label="显示全部模型" onPress={() => setShowAll(true)}>
                      <Text size="label" weight="semibold" color="accent-strong">{`显示全部 ${facts.modelCount} 个`}</Text>
                    </Pressable>
                  ) : null}
                  <Text size="note" tone="secondary">直觉模型（打分、排序）先由它兼任。备用模型和别的服务商，以后在「设置 → 模型」里加。</Text>
                  {problem ? <Text testID="first-run-problem" size="note" color="danger-dark">{problem}</Text> : null}
                  <Row justify="flex-end">
                    <Button testID="first-run-go" label={busy ? '正在上线…' : `让 ${leadName} 上线`} size="sm" tone="accent" disabled={busy || chosen === null}
                      onPress={() => void goOnline()} />
                  </Row>
                </Column>
              ) : null}
            </Card>

            <Row justify="center" gap="icon-label">
              <Text size="note" tone="secondary">不想现在配？</Text>
              <Pressable testID="first-run-skip" aria-label="先进去看看" onPress={onSkip}>
                <Text size="note" weight="semibold" color="accent-strong">先进去看看</Text>
              </Pressable>
              <Text size="note" tone="secondary">{`${leadName} 会保持离线。`}</Text>
            </Row>
          </Column>
        </Column>
      </ScrollArea>
    </Screen>
  );
}
