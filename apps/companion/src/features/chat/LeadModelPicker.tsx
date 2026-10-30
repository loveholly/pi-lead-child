import { Badge, Box, Button, Chip, Column, Icon, Popover, Pressable, Row, Text } from '@pi-lead-child/components';
import { parseLeadModelSpec, type LeadModelCatalog, type LeadModelChoice, type LeadModelOption } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';

import { effortForModel, groupLeadModels, leadModelLabel } from './leadModelGroups';

// 会话输入框右下角的模型名（2026-10-26，参考 Kimi）：写着 Lead 正在用的模型 id 和推理强度，点开换模型。
// 浮层里先是推理强度，再是按来源分组的模型（as1、as4 各一组，见 ./leadModelGroups）。换模型和 Lead 的
// switch_lead_model 是同一个操作：Lead 空闲时马上换，正在回答时这一轮结束后换，不用重启。
export function LeadModelPicker({ current }: { current: string | null | undefined }) {
  // daemon 还不知道用哪个模型时（hello 里是 unknown）不写。
  if (!current?.trim() || current === 'unknown') return null;
  const label = leadModelLabel(current);
  // 外面包一层：Popover 的锚点自己是 alignSelf: flex-start，直接放进工具栏会贴着这一行的上边，
  // 和左边的「+」、右边的发送按钮对不齐（2026-10-26 用户截图）。这一层由工具栏垂直居中。
  return (
    <Box testID="lead-model-anchor">
    <Popover
      testID="lead-model"
      label={`Lead 的模型：${label.id}${label.effort ? ` ${label.effort}` : ''}，点开换模型`}
      title="Lead 的模型"
      width={400}
      trigger={(
        // 参考 Claude Code 的模型名：平时只是文字，鼠标放上去出现圆角的浅灰底，看起来像一个按钮，知道这里能点。
        // spacing-exempt: 按钮的规格，左右 8、上下 6，高 28（文字行高 16）
        <Row testID="lead-model-button" items="center" gap="icon-label" px={8} py={6} rounded="sm" bg={{ default: 'transparent', hover: 'surface-muted' }}>
          <Text testID="composer-model" size="label" tone="secondary" numberOfLines={1}>{label.id}</Text>
          {label.effort ? <Text testID="composer-model-effort" size="label" tone="muted">{label.effort}</Text> : null}
        </Row>
      )}
    >
      {(close) => <LeadModelPanel close={close} />}
    </Popover>
    </Box>
  );
}

type PanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; catalog: LeadModelCatalog };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// 没有回答的那一轮里的「换个模型重发」（画布「没有回答」状态 2）：点开同一个模型浮层，换好以后再发一次你那句话。
// 换模型和输入框右下角是同一个操作；Lead 正在回答时，新模型在这一轮结束后换上，重发的那句排在后面，用的是新模型。
export function LeadModelResendLink({ onSwitched }: { onSwitched: () => void }) {
  return (
    <Popover
      testID="lead-model-resend"
      label="换个模型重发"
      title="换个模型重发"
      width={400}
      trigger={<Text testID="lead-model-resend-button" size="secondary" weight="semibold" tone="accent">换个模型重发</Text>}
    >
      {(close) => <LeadModelPanel close={close} onSwitched={onSwitched} />}
    </Popover>
  );
}

function LeadModelPanel({ close, onSwitched }: { close: () => void; onSwitched?: () => void }) {
  const runtime = useCompanionRuntime();
  const [state, setState] = useState<PanelState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // 正在换的那一个（换好之前按钮都不能点），和换完以后的一句话。
  const [switching, setSwitching] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'secondary' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    runtime.loadLeadModels().then(
      (catalog) => { if (live) setState({ status: 'ready', catalog }); },
      (error: unknown) => { if (live) setState({ status: 'error', message: errorText(error) }); },
    );
    return () => { live = false; };
  }, [runtime, attempt]);

  if (state.status === 'loading') return <Text testID="lead-model-loading" size="note" tone="muted">正在读模型目录…</Text>;
  if (state.status === 'error') {
    return (
      <Column gap="card-row">
        <Text testID="lead-model-error" size="note" tone="danger">{`读不到模型目录：${state.message}`}</Text>
        <Row><Button label="重试" size="sm" variant="outline" onPress={() => { setState({ status: 'loading' }); setAttempt((count) => count + 1); }} /></Row>
      </Column>
    );
  }

  const { catalog } = state;
  const selected = catalog.selected;
  const selectedOption = catalog.models.find((model) => model.model === selected.model) ?? null;
  const choose = (choice: LeadModelChoice) => {
    if (switching) return;
    const spec = choice.effort ? `${choice.model}(${choice.effort})` : choice.model;
    setSwitching(spec);
    setNotice(null);
    runtime.switchLeadModel(choice).then(
      (result) => {
        setSwitching(null);
        setState({ status: 'ready', catalog: { ...catalog, selected: result.selected, ...(result.applied === 'after_turn' ? {} : { current: result.selected }) } });
        if (onSwitched) {
          // 换好了（或者排在这一轮之后）：重发你那句话，关掉浮层。
          close();
          onSwitched();
        } else if (result.applied === 'after_turn') {
          setNotice({ tone: 'secondary', text: `${leadModelLabel(spec).id} 会在这一轮回答结束后换上。` });
        } else {
          close();
        }
      },
      (error: unknown) => {
        setSwitching(null);
        setNotice({ tone: 'danger', text: errorText(error) });
      },
    );
  };

  const pending = selected.model !== catalog.current.model || selected.effort !== catalog.current.effort;
  const groups = groupLeadModels(catalog.models);
  // 选着的模型可能在列表很下面：最上面写一行它是哪个来源的哪个模型，不用翻下去找。
  const selectedGroup = groups.find((group) => group.models.some((model) => model.model === selected.model));
  const selectedId = selectedOption?.prefix ? selectedOption.id.slice(selectedOption.prefix.length + 1) : parseLeadModelSpec(selected.model).id;
  return (
    <Column gap="card-section" testID="lead-model-catalog">
      <Text testID="lead-model-selected" size="body" weight="semibold">
        {`正在用：${selectedGroup ? `${selectedGroup.title} · ` : ''}${selectedId}${selected.effort ? ` ${selected.effort}` : ''}`}
      </Text>
      {pending ? (
        <Text testID="lead-model-pending" size="note" tone="secondary">
          {`正在用 ${describe(catalog.current)}。你选的 ${describe(selected)} 会在这一轮回答结束后换上；限流或额度用完时系统也会暂时换用别的模型。`}
        </Text>
      ) : null}
      {notice ? <Text testID="lead-model-notice" size="note" tone={notice.tone}>{notice.text}</Text> : null}
      {selectedOption && selectedOption.efforts.length ? (
        <Column gap="field">
          <Text size="label" tone="secondary">推理强度</Text>
          <Row gap="chips" flexWrap="wrap">
            {[null, ...selectedOption.efforts].map((effort) => (
              <Chip
                key={effort ?? 'default'}
                testID={`lead-model-effort-${effort ?? 'default'}`}
                label={effort ?? '缺省'}
                selected={selected.effort === effort}
                onPress={() => { if (selected.effort !== effort) choose({ model: selected.model, effort }); }}
              />
            ))}
          </Row>
        </Column>
      ) : null}
      {groups.map((group) => (
        <Column key={group.key} gap="group-label" testID={`lead-model-group-${group.title}`}>
          <Text size="eyebrow" tone="muted">{group.title}</Text>
          <Column>
            {group.models.map((model) => (
              <ModelRow
                key={model.model}
                model={model}
                selected={model.model === selected.model}
                busy={switching !== null}
                onPress={() => choose({ model: model.model, effort: effortForModel(model, selected.effort) })}
              />
            ))}
          </Column>
        </Column>
      ))}
    </Column>
  );
}

function describe(choice: LeadModelChoice): string {
  const id = parseLeadModelSpec(choice.model).id;
  return choice.effort ? `${id} ${choice.effort}` : id;
}

function ModelRow({ model, selected, busy, onPress }: {
  model: LeadModelOption; selected: boolean; busy: boolean; onPress: () => void;
}) {
  // 组名已经写了账号前缀：行里只写模型 id。
  const id = model.prefix ? model.id.slice(model.prefix.length + 1) : model.id;
  const blockedAt = model.blockedUntil ? new Date(model.blockedUntil) : null;
  return (
    <Pressable
      testID={`lead-model-option-${model.model}`}
      aria-label={`${model.model}${selected ? '，正在选着' : ''}`}
      aria-pressed={selected}
      feedback="highlight"
      disabled={busy}
      onPress={selected ? undefined : onPress}
      rounded="md"
      px="row-x"
      py="row-y"
    >
      <Row items="center" gap="inline-item">
        <Text flex={1} minW={0} size="body" weight={selected ? 'bold' : 'regular'} numberOfLines={1}>{id}</Text>
        {blockedAt ? (
          <Badge
            label={`额度用完，${String(blockedAt.getHours()).padStart(2, '0')}:${String(blockedAt.getMinutes()).padStart(2, '0')} 恢复`}
            tone="warning"
            size="sm"
          />
        ) : null}
        {/* 几乎每个模型都能看图：只标出不能看的。 */}
        {model.image ? null : <Text size="meta" tone="muted">不能看图</Text>}
        {selected ? <Icon name="check" size={14} color="accent" accessibilityLabel="正在选着" /> : null}
      </Row>
    </Pressable>
  );
}
