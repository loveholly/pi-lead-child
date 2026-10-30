import { Button, Card, Column, Divider, Dot, Row, Text } from '@pi-lead-child/components';
import { parseLeadModelSpec, type ModelSettingsDto } from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import { useMemorySettings, useModelSettings } from '@/state/hooks';
import { DAEMON_OLDER_THAN_WEB } from '@/state/types';

import { PendingSwitchBanner } from './MemorySection';
import { memoryErrorText } from './memoryModel';
import { AddSlot, brainPickerGroups, Slot, SlotFace, SlotGrid, type PickerGroup } from './ModelPicker';
import { ModelLibrary } from './ModelLibrary';
import { useModelAction } from './useModelAction';
import {
  backupsLeft, BRAIN_APPLIES, BRAIN_HINT, BRAIN_NAME, brainIndex, brainModelName, brainModelSub, choiceFor, FAST_APPLIES, FAST_HINT,
  FAST_NAME, fastModelSub, slotLabel, untilLabel, withoutSlot, withSlot,
} from './modelSettingsModel';

// 设置 → Lead → 模型（方案 B，2026-10-29，.scratch/model-settings/spec.md）。
//   上面「现在的分工」：大脑和直觉各一个主用、最多 3 个备用，点格子从下拉里选；直觉都用不了时问大脑的哪个模型。
//   下面「模型库」（ModelLibrary.tsx）：按服务商分组的大脑模型，和直觉的每一条；接入服务商、添加直觉都在那里。
// 每个改动都是操作层的 model_settings 操作（runtime.modelSettingsAction），和 Lead 的 perform_action 同一个函数。
export function ModelSection() {
  const { modelSettings, resource } = useModelSettings();
  if (!modelSettings && resource?.state === 'unsupported' && resource.error === DAEMON_OLDER_THAN_WEB) {
    // 部署时网页先生效，daemon 后重启：这一段时间旧 daemon 没有模型设置。重启以后页面重新连上，自动再取。
    return (
      <Column testID="model-old-daemon" gap="text-stack">
        <Row items="center" gap="icon-label">
          <Dot color="warning" size={7} />
          <Text size="body" weight="semibold" tone="warning-dark">daemon 还没更新，读不到模型设置。</Text>
        </Row>
        <Text size="secondary" tone="secondary">网页已经是新版本，daemon 还是旧版本。重启 daemon（plc daemon restart）以后，这一页会自动刷新。</Text>
      </Column>
    );
  }
  if (!modelSettings) {
    return (
      <Text testID="model-loading" size="body" tone={resource?.state === 'error' ? 'danger-dark' : 'muted'}>
        {resource?.state === 'error' ? `读不到模型设置：${resource.error ? memoryErrorText(resource.error) : '模型设置还没有启动'}` : '正在读取模型设置…'}
      </Text>
    );
  }
  return (
    <Column testID="model-section" gap="page-section">
      <ModelPendingSwitch />
      <Assignment dto={modelSettings} />
      <ModelLibrary dto={modelSettings} />
    </Column>
  );
}

// 直觉的主用换了主机、重排又用它时，daemon 出一张待确认的切换卡。在这一页也显示，用户不用跳到「记忆」去同意。
function ModelPendingSwitch() {
  const { memory } = useMemorySettings();
  return memory ? <PendingSwitchBanner memory={memory} /> : null;
}

type Picker = { block: 'brain' | 'fast' | 'fallback'; slot: number };
type Message = { block: 'brain' | 'fast'; text: string; error: boolean };

function Assignment({ dto }: { dto: ModelSettingsDto }) {
  const { busy, run } = useModelAction();
  const [picker, setPicker] = useState<Picker | null>(null);
  const [search, setSearch] = useState('');
  const [showAll, setShowAll] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<Message | null>(null);
  const index = brainIndex(dto);
  const now = new Date();

  const open = (next: Picker) => {
    setPicker(next);
    setSearch('');
    setShowAll(new Set());
  };
  const close = () => setPicker(null);
  const apply = async (block: Message['block'], action: string, input: Record<string, unknown>) => {
    close();
    setMessage(null);
    const outcome = await run(action, input);
    if (!outcome.ok) {
      setMessage({ block, text: outcome.error, error: true });
      return;
    }
    const result = outcome.result as { note?: string | null; applied?: string } | null;
    setMessage({ block, text: result?.note ?? (result?.applied === 'after_turn' ? '已保存。Lead 正在回答，这一轮结束后换主用。' : '已保存。'), error: false });
  };

  const brainChain = dto.brain.chain;
  const current = parseLeadModelSpec(leadSpec(dto.brain.current)).model;
  const pickBrain = (slot: number) => (model: string) => apply('brain', 'set_brain_chain', {
    models: withSlot(brainChain, slot, choiceFor(brainChain, slot, model)),
  });
  const brainGroups = (slot: number, selected: string | null): PickerGroup[] => brainPickerGroups(dto, {
    search, showAll, slot, selected, onPick: pickBrain(slot),
  });
  const onShowAll = (group: string) => setShowAll((previous) => new Set([...previous, group]));

  const brainSlots = brainChain.map((choice, slot) => {
    const entry = index.get(choice.model);
    const blocked = entry?.model.blockedUntil ?? null;
    const isOpen = picker?.block === 'brain' && picker.slot === slot;
    const face = (
      <SlotFace
        testID={`model-brain-slot-${slot}`}
        title={brainModelName(choice.model, entry)}
        sub={blocked ? `额度用尽 · ${untilLabel(blocked, now)} 恢复` : brainModelSub(choice.model, entry, choice.effort)}
        subTone={blocked ? 'danger-dark' : 'secondary'}
        live={choice.model === current}
        focused={isOpen}
      />
    );
    return (
      <Slot
        key={`brain-${slot}`}
        testID={`model-brain-picker-${slot}`}
        label={slotLabel(slot)}
        face={face}
        open={isOpen}
        onOpen={() => open({ block: 'brain', slot })}
        onClose={close}
        groups={isOpen ? brainGroups(slot, choice.model) : []}
        search={search}
        onSearch={setSearch}
        onShowAll={onShowAll}
        footer={slot > 0 ? (
          <Button testID={`model-brain-remove-${slot}`} label="移出备用" variant="ghost" tone="neutral" size="xs" disabled={busy}
            onPress={() => void apply('brain', 'set_brain_chain', { models: withoutSlot(brainChain, slot) })} />
        ) : null}
      />
    );
  });
  const brainLeft = backupsLeft(brainChain.length);
  const addingBrain = picker?.block === 'brain' && picker.slot === brainChain.length;
  if (brainLeft > 0) {
    brainSlots.push(addingBrain ? (
      <Slot
        key="brain-add"
        testID="model-brain-picker-add"
        label={slotLabel(brainChain.length)}
        face={<SlotFace title="选一个模型" sub="从模型库里选" focused />}
        open
        onOpen={() => {}}
        onClose={close}
        groups={brainGroups(brainChain.length, null)}
        search={search}
        onSearch={setSearch}
        onShowAll={onShowAll}
      />
    ) : (
      <AddSlot key="brain-add" testID="model-brain-add" label={slotLabel(brainChain.length)} left={`还能加 ${brainLeft} 个`}
        onPress={() => open({ block: 'brain', slot: brainChain.length })} />
    ));
  }

  const fastChain = dto.fast.chain;
  const fastById = new Map(dto.fast.models.map((model) => [model.id, model]));
  const liveFast = fastChain.find((id) => fastById.get(id)?.apiKeySet) ?? null;
  const fastGroups = (slot: number): PickerGroup[] => [{
    key: 'fast',
    title: FAST_NAME,
    count: dto.fast.models.length,
    hidden: 0,
    options: dto.fast.models
      .filter((model) => !search.trim() || `${model.name} ${model.baseUrl ?? ''} ${model.model}`.toLowerCase().includes(search.trim().toLowerCase()))
      .map((model) => {
        const elsewhere = fastChain.findIndex((id, i) => i !== slot && id === model.id);
        return {
          key: model.id,
          title: model.name,
          sub: fastModelSub(model),
          date: null,
          selected: fastChain[slot] === model.id,
          disabledReason: elsewhere >= 0 ? `已是${slotLabel(elsewhere)}` : null,
          onPick: () => void apply('fast', 'set_fast_chain', { chain: withSlot(fastChain, slot, model.id) }),
        };
      }),
  }];
  const fastSlots = fastChain.map((id, slot) => {
    const model = fastById.get(id);
    const isOpen = picker?.block === 'fast' && picker.slot === slot;
    return (
      <Slot
        key={`fast-${slot}`}
        testID={`model-fast-picker-${slot}`}
        label={slotLabel(slot)}
        face={(
          <SlotFace
            testID={`model-fast-slot-${slot}`}
            title={model?.name ?? id}
            sub={model ? (model.apiKeySet ? fastModelSub(model) : `${fastModelSub(model)} · 没有 key，跳过它`) : '找不到这一条'}
            subTone={model?.apiKeySet ? 'secondary' : 'danger-dark'}
            live={id === liveFast}
            focused={isOpen}
          />
        )}
        open={isOpen}
        onOpen={() => open({ block: 'fast', slot })}
        onClose={close}
        groups={isOpen ? fastGroups(slot) : []}
        search={search}
        onSearch={setSearch}
        footer={(
          <Button testID={`model-fast-remove-${slot}`} label={slot === 0 ? '不用直觉' : '移出备用'} variant="ghost" tone="neutral" size="xs" disabled={busy}
            onPress={() => void apply('fast', 'set_fast_chain', { chain: slot === 0 ? [] : withoutSlot(fastChain, slot) })} />
        )}
      />
    );
  });
  const fastLeft = fastChain.length === 0 ? 1 : backupsLeft(fastChain.length);
  const addingFast = picker?.block === 'fast' && picker.slot === fastChain.length;
  if (fastLeft > 0 && dto.fast.models.length > fastChain.length) {
    fastSlots.push(addingFast ? (
      <Slot
        key="fast-add"
        testID="model-fast-picker-add"
        label={slotLabel(fastChain.length)}
        face={<SlotFace title="选一条直觉" sub="从模型库里选" focused />}
        open
        onOpen={() => {}}
        onClose={close}
        groups={fastGroups(fastChain.length)}
        search={search}
        onSearch={setSearch}
      />
    ) : (
      <AddSlot key="fast-add" testID="model-fast-add" label={slotLabel(fastChain.length)}
        left={fastChain.length === 0 ? '现在判断都问大脑' : `还能加 ${fastLeft} 个`}
        onPress={() => open({ block: 'fast', slot: fastChain.length })} />
    ));
  }

  // 直觉都用不了时问大脑的哪个模型。
  const fallbackModel = dto.fast.llmFallback?.model ?? null;
  const effective = dto.fast.effectiveLlm ? parseLeadModelSpec(dto.fast.effectiveLlm).model : null;
  const fallbackOpen = picker?.block === 'fallback';
  const fallbackGroups: PickerGroup[] = fallbackOpen ? [
    {
      key: 'system', title: '系统', count: 1, hidden: 0,
      options: [{
        key: 'system', title: '系统自己选', sub: effective && !fallbackModel ? `现在是 ${brainModelName(effective, index.get(effective))}` : '配置里最新的 haiku，没有时用主用',
        date: null, selected: fallbackModel === null, disabledReason: null,
        onPick: () => void apply('fast', 'set_fast_chain', { chain: fastChain, llmFallback: null }),
      }],
    },
    ...brainPickerGroups(dto, {
      search, showAll, slot: -1, selected: fallbackModel,
      onPick: (model) => void apply('fast', 'set_fast_chain', { chain: fastChain, llmFallback: { model, effort: null } }),
    }),
  ] : [];
  const fallbackName = effective ? brainModelName(effective, index.get(effective)) : '没有可用的大脑模型';

  return (
    <Column gap="group-label">
      <Text size="eyebrow" weight="bold" tone="secondary" px="section-label-x">现在的分工</Text>
      <Card testID="model-assignment" rounded="2xl">
        <Block title={BRAIN_NAME} hint={BRAIN_HINT} applies={BRAIN_APPLIES} testID="model-brain">
          <SlotGrid>{brainSlots}</SlotGrid>
          {brainLeft === 0 ? (
            <Text testID="model-brain-full" size="meta" tone="muted">备用最多 3 个。要换一个，先在它的下拉里「移出备用」。</Text>
          ) : null}
          {message?.block === 'brain' ? <Text testID="model-brain-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
        </Block>
        <Divider />
        <Block title={FAST_NAME} hint={FAST_HINT} applies={FAST_APPLIES} testID="model-fast">
          {fastSlots.length ? <SlotGrid>{fastSlots}</SlotGrid> : (
            <Text size="note" tone="secondary">还没有直觉：判断都问大脑。在下面的模型库里添加一条。</Text>
          )}
          <SlotGrid>{[(
            <Slot
              key="fallback"
              testID="model-fallback-picker"
              label={`都用不了时，问${BRAIN_NAME}`}
              face={(
                <SlotFace
                  testID="model-fallback"
                  title={fallbackName}
                  sub={`${fallbackModel ? '你选的' : '系统选的'} · 慢一些，用的是${BRAIN_NAME}的额度`}
                  focused={fallbackOpen}
                />
              )}
              open={fallbackOpen}
              onOpen={() => open({ block: 'fallback', slot: -1 })}
              onClose={close}
              groups={fallbackGroups}
              search={search}
              onSearch={setSearch}
              onShowAll={onShowAll}
            />
          )]}</SlotGrid>
          {message?.block === 'fast' ? <Text testID="model-fast-message" size="note" tone={message.error ? 'danger-dark' : 'secondary'}>{message.text}</Text> : null}
        </Block>
      </Card>
    </Column>
  );
}

// 正在用的模型（输入框换的、或者模型自动切换换的）带推理强度时也认得出是哪一格。
function leadSpec(choice: { model: string; effort: string | null }): string {
  return choice.effort ? `${choice.model}(${choice.effort})` : choice.model;
}

function Block({ title, hint, applies, testID, children }: { title: string; hint: string; applies: string; testID: string; children: ReactNode }) {
  return (
    <Column testID={testID} p="page-card" gap="card-section">
      <Row items="baseline" gap="inline-item" flexWrap="wrap">
        <Text size="card-title" weight="bold">{title}</Text>
        <Text flex={1} size="meta" tone="muted">{hint}</Text>
        <Text size="meta" tone="muted">{applies}</Text>
      </Row>
      {children}
    </Column>
  );
}
