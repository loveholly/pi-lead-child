import {
  Box, Button, Card, ChoiceGroup, Column, Icon, LeadAvatar, Pressable, Row, Screen, ScrollArea, SegmentedControl, Text, TextField,
} from '@pi-lead-child/components';
import type { ModelProviderApi } from '@pi-lead-child/protocol';
import { useState } from 'react';

import { useLeadAvatarSource } from '@/components/useLeadAvatarSource';
import { useLocale, useMessages } from '@/i18n';
import { useLeadName, useModelSettings } from '@/state/hooks';
import { useModelAction } from '@/features/settings/useModelAction';

import { onboardingMessages } from './onboarding.messages';
import {
  connectedProvider, firstRunPresets, firstRunModelList, firstRunModelMeta, firstRunPreset, firstRunProviderFacts, firstRunProviderRequest,
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
  const m = useMessages(onboardingMessages);
  if (done) {
    return (
      <Box w={20} h={20} rounded="full" bg="success-soft" items="center" justify="center" aria-label={m.done}>
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
  const locale = useLocale();
  const m = useMessages(onboardingMessages);
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

  const facts = firstRunProviderFacts(connectedProvider(modelSettings, providerName), locale);
  const { connected } = facts;
  const models = firstRunModelList(facts.models, showAll ? null : MODEL_LIST_LIMIT);
  const recommended = recommendedBrainModel(facts.models);
  const recommendedId = recommended ? recommended.model : null;
  const chosen = picked ?? recommendedId;
  const custom = preset === 'custom';
  const presetInfo = firstRunPreset(preset, locale);

  const connect = async () => {
    const request = firstRunProviderRequest({ preset, apiKey, baseUrl, api }, modelSettings?.brain.providers ?? [], locale);
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
                <Text size="label" weight="semibold" tone="secondary">{m.offline(leadName)}</Text>
              </Row>
              <Text testID="first-run-title" size="page-title" weight="bold">{m.title(leadName)}</Text>
              <Text size="body" tone="secondary">
                {m.intro(leadName)}
              </Text>
            </Column>

            <Card testID="first-run-step-provider" w="100%" rounded="xl" p="page-card" gap="card-section">
              <Row items="center" gap="inline-item">
                <StepMark index={1} done={connected} active={!connected} />
                <Text size="card-title" weight="semibold">{m.stepProvider}</Text>
                {connected ? (
                  <>
                    <Text testID="first-run-provider-done" flex={1} minW={0} size="secondary" tone="secondary" numberOfLines={1}>
                      {m.providerDone(facts.name ?? '', facts.modelCount)}
                    </Text>
                    <Pressable testID="first-run-provider-change" aria-label={m.changeProvider} onPress={() => setProviderName(null)}>
                      <Text size="label" weight="semibold" color="accent-strong">{m.change}</Text>
                    </Pressable>
                  </>
                ) : null}
              </Row>
              {connected ? null : (
                <Column gap="card-row">
                  <ChoiceGroup
                    testID="first-run-presets"
                    variant="radio"
                    accessibilityLabel={m.apiType}
                    value={preset}
                    options={firstRunPresets(locale).map((entry) => ({ id: entry.id, label: entry.label, description: entry.description }))}
                    optionTestID={(id) => `first-run-preset-${id}`}
                    onSelect={(id) => { setPreset(id as FirstRunPresetId); setProblem(null); }}
                    disabled={busy}
                  />
                  {custom ? (
                    <Column gap="card-row">
                      <Column gap="text-stack">
                        <Text size="label" weight="semibold" tone="secondary">{m.baseUrl}</Text>
                        <TextField testID="first-run-base-url" value={baseUrl} onChangeText={setBaseUrl} placeholder="http://127.0.0.1:8317/v1"
                          variant="filled" size="sm" mono keyboardType="url" autoComplete="off" autoCapitalize="none" autoCorrect={false} />
                      </Column>
                      <Column gap="text-stack">
                        <Text size="label" weight="semibold" tone="secondary">{m.apiFormat}</Text>
                        <SegmentedControl testID="first-run-api" options={API_OPTIONS} value={api} onChange={setApi} size="sm" />
                      </Column>
                    </Column>
                  ) : null}
                  <Column gap="text-stack">
                    <Text size="label" weight="semibold" tone="secondary">{custom ? m.apiKeyCustom : m.apiKey}</Text>
                    <TextField
                      testID="first-run-api-key"
                      value={apiKey}
                      onChangeText={setApiKey}
                      placeholder={custom ? m.apiKeyOptional : m.apiKeyPlaceholder(presetInfo.label)}
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
                    <Text flex={1} size="note" tone="secondary">{m.keyNote}</Text>
                    <Button testID="first-run-connect" label={busy ? m.connecting : m.connect} size="sm" tone="accent" disabled={busy} onPress={() => void connect()} />
                  </Row>
                </Column>
              )}
            </Card>

            <Card testID="first-run-step-model" w="100%" rounded="xl" p="page-card" gap="card-section">
              <Row items="center" gap="inline-item">
                <StepMark index={2} done={false} active={connected} />
                <Text size="card-title" weight="semibold" tone={connected ? 'default' : 'muted'}>{m.stepModel}</Text>
                {connected ? null : <Text size="secondary" tone="muted">{m.stepModelWaiting}</Text>}
              </Row>
              {connected ? (
                <Column gap="card-row">
                  <ChoiceGroup
                    testID="first-run-models"
                    variant="radio"
                    accessibilityLabel={m.brainModel}
                    value={chosen}
                    {...(recommendedId ? { recommended: recommendedId } : {})}
                    options={models.map((model) => ({ id: model.model, label: model.name ?? model.id, description: firstRunModelMeta(model, locale) }))}
                    optionTestID={(id) => `first-run-model-${id}`}
                    onSelect={setPicked}
                    disabled={busy}
                  />
                  {!showAll && facts.modelCount > MODEL_LIST_LIMIT ? (
                    <Pressable testID="first-run-show-all" aria-label={m.showAllLabel} onPress={() => setShowAll(true)}>
                      <Text size="label" weight="semibold" color="accent-strong">{m.showAll(facts.modelCount)}</Text>
                    </Pressable>
                  ) : null}
                  <Text size="note" tone="secondary">{m.modelNote}</Text>
                  {problem ? <Text testID="first-run-problem" size="note" color="danger-dark">{problem}</Text> : null}
                  <Row justify="flex-end">
                    <Button testID="first-run-go" label={busy ? m.goingOnline : m.goOnline(leadName)} size="sm" tone="accent" disabled={busy || chosen === null}
                      onPress={() => void goOnline()} />
                  </Row>
                </Column>
              ) : null}
            </Card>

            <Row justify="center" gap="icon-label">
              <Text size="note" tone="secondary">{m.skipQuestion}</Text>
              <Pressable testID="first-run-skip" aria-label={m.skip} onPress={onSkip}>
                <Text size="note" weight="semibold" color="accent-strong">{m.skip}</Text>
              </Pressable>
              <Text size="note" tone="secondary">{m.staysOffline(leadName)}</Text>
            </Row>
          </Column>
        </Column>
      </ScrollArea>
    </Screen>
  );
}
