import { AnchoredPanel, Button, Column, Dot, Icon, Pressable, Row, Text, TextField, useBreakpoint } from '@pi-lead-child/components';
import type { ModelSettingsDto } from '@pi-lead-child/protocol';
import { useState, type ReactNode } from 'react';

import {
  brainIndex, brainInUse, brainModelName, PICKER_VISIBLE, providerGroup, releaseLabel, slotLabel,
} from './modelSettingsModel';

// 设置 → 模型的分工格子和它的下拉（方案 B，2026-10-29）。下拉是锚定浮层（P2）：从格子原来的位置撑开，
// 手机宽度时从底部升起。

// 一格：标签在上，下面是选中的模型。第二行写服务商和能力；出问题时（额度用尽）写原因。
export function SlotFace({ title, sub, subTone = 'secondary', live, focused, testID }: {
  title: string;
  sub: string;
  subTone?: 'secondary' | 'danger-dark';
  live?: boolean;
  focused?: boolean;
  testID?: string;
}) {
  return (
    <Row
      testID={testID}
      items="center"
      gap="inline-item"
      h={52} // 格子的规格：两行文字加上下留白，和画布一样高
      px="row-x"
      rounded="lg"
      borderWidth={1}
      borderColor={focused ? 'accent' : 'border-input'}
      bg="surface"
    >
      <Column flex={1} minW={0} gap="text-stack">
        <Text size="body" weight="semibold" numberOfLines={1}>{title}</Text>
        <Text size="meta" tone={subTone} numberOfLines={1}>{sub}</Text>
      </Column>
      {live ? (
        <Row items="center" gap="icon-label" shrink={0}>
          <Dot color="accent" size={7} />
          <Text size="label" weight="semibold" tone="accent">在用</Text>
        </Row>
      ) : null}
      <Icon name="chevron-down" size={14} color="text-muted" />
    </Row>
  );
}

export type PickerOption = {
  key: string;
  title: string;
  sub: string;
  date: string | null;
  selected: boolean;
  // 不能选的原因（例如「已是主用」）。能选时为 null。
  disabledReason: string | null;
  onPick: () => void;
};

export type PickerGroup = {
  key: string;
  title: string;
  count: number;
  options: PickerOption[];
  hidden: number;
};

// 一个格子：点开是下拉。footer 是下拉底部的一行（例如「移出备用」）。below 是格子下面的说明（例如选的模型用不了的原因）。
export function Slot({ label, face, open, onOpen, onClose, groups, footer, below, search, onSearch, onShowAll, testID }: {
  label: string;
  face: ReactNode;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  groups: PickerGroup[];
  footer?: ReactNode;
  below?: ReactNode;
  search: string;
  onSearch: (value: string) => void;
  onShowAll?: (group: string) => void;
  testID: string;
}) {
  const body = (
    <Column gap="nav-item" px="row-x" pb="card-row">
      <TextField
        testID={`${testID}-search`}
        value={search}
        onChangeText={onSearch}
        placeholder="搜索模型"
        variant="filled"
        size="sm"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {groups.length === 0 ? <Text size="note" tone="muted" py="row-y">没有匹配的模型。</Text> : null}
      {groups.map((group) => (
        <Column key={group.key} testID={`${testID}-group-${group.key}`}>
          <Row items="center" gap="inline-item" pt="section-label-top" pb="section-label-bottom">
            <Text size="meta" weight="semibold" tone="secondary">{group.title}</Text>
            <Text size="meta" tone="muted">{group.count}</Text>
          </Row>
          {group.options.map((option) => (
            <Pressable
              key={option.key}
              testID={`${testID}-option-${option.key}`}
              aria-label={option.title}
              aria-selected={option.selected}
              aria-disabled={option.disabledReason !== null}
              disabled={option.disabledReason !== null}
              onPress={option.onPick}
              flexDirection="row"
              items="center"
              gap="inline-item"
              px="row-x"
              py="row-y"
              rounded="md"
              bg={option.selected ? 'accent-wash' : { default: 'transparent', hover: 'surface-subtle', press: 'surface-muted' }}
              opacity={option.disabledReason ? 0.5 : 1}
            >
              <Column flex={1} minW={0} gap="text-stack">
                <Text size="body" weight="semibold" numberOfLines={1}>{option.title}</Text>
                <Text size="meta" tone="secondary" numberOfLines={1}>{option.disabledReason ?? option.sub}</Text>
              </Column>
              {option.date ? <Text size="meta" tone="muted" mono>{option.date}</Text> : null}
              {option.selected ? <Icon name="check" size={14} color="accent-strong" /> : null}
            </Pressable>
          ))}
          {group.hidden > 0 && onShowAll ? (
            <Row px="row-x" py="nav-item">
              <Button testID={`${testID}-more-${group.key}`} label={`显示 ${group.title} 的其余 ${group.hidden} 个`} variant="link" size="xs" onPress={() => onShowAll(group.key)} />
            </Row>
          ) : null}
        </Column>
      ))}
      {footer ? <Row items="center" gap="actions" pt="card-row" borderTopWidth={1} borderTopColor="border-soft">{footer}</Row> : null}
    </Column>
  );
  const panel = (
    <AnchoredPanel
        testID={testID}
        open={open}
        onClose={onClose}
        label={`选择${label}`}
        header={<Pressable aria-label={`收起${label}`} onPress={onClose} feedback="none">{face}</Pressable>}
        body={body}
      >
        <Pressable testID={`${testID}-open`} aria-label={`选择${label}`} aria-haspopup="listbox" onPress={onOpen} feedback="none">
          {face}
        </Pressable>
      </AnchoredPanel>
  );
  return (
    <Column flex={1} minW={0} gap="field">
      <Text size="label" weight="semibold" tone="secondary">{label}</Text>
      {panel}
      {below}
    </Column>
  );
}

// 格子两个一行；手机宽度时一个一行。
export function SlotGrid({ children }: { children: ReactNode[] }) {
  const { tablet } = useBreakpoint();
  const perRow = tablet ? 2 : 1;
  const rows: ReactNode[][] = [];
  children.forEach((child, i) => {
    if (i % perRow === 0) rows.push([]);
    rows[rows.length - 1]!.push(child);
  });
  return (
    <Column gap="card-row">
      {rows.map((row, i) => (
        <Row key={i} gap="card-row" items="flex-start">
          {row}
          {row.length < perRow ? <Column flex={1} /> : null}
        </Row>
      ))}
    </Column>
  );
}

// 「再加一个备用」：虚线的空格子。
export function AddSlot({ label, left, onPress, testID }: { label: string; left: string; onPress: () => void; testID: string }) {
  return (
    <Column flex={1} minW={0} gap="field">
      <Text size="label" weight="semibold" tone="muted">{label}</Text>
      <Pressable
        testID={testID}
        onPress={onPress}
        flexDirection="row"
        items="center"
        gap="icon-label"
        h={52} // 和 SlotFace 一样高
        px="row-x"
        rounded="lg"
        borderWidth={1}
        borderStyle="dashed"
        borderColor="border-strong"
        bg={{ default: 'surface', hover: 'surface-subtle', press: 'surface-muted' }}
      >
        <Icon name="plus" size={14} color="accent-strong" />
        <Text flex={1} size="label" weight="semibold" tone="accent">再加一个备用</Text>
        <Text size="meta" tone="muted">{left}</Text>
      </Pressable>
    </Column>
  );
}

// 大脑的下拉：按服务商分组，组里最新的在前，每组先露几个（正在用的和选中的总露出来）。分工里别的格子已经用了的模型不能选。
// 设置 → 记忆的摘要模型也用它（slot 为 -1）。
export function brainPickerGroups(dto: ModelSettingsDto, options: {
  search: string;
  showAll: ReadonlySet<string>;
  // 正在选的是分工的哪一格（-1：不在分工里，例如直觉兜底那一格、记忆的摘要模型）。
  slot: number;
  selected: string | null;
  onPick: (model: string) => void;
}): PickerGroup[] {
  const used = brainInUse(dto);
  if (options.selected) used.add(options.selected);
  const index = brainIndex(dto);
  const groups: PickerGroup[] = [];
  for (const provider of dto.brain.providers) {
    const view = providerGroup(provider, used, { query: options.search, showAll: options.showAll.has(provider.name), visible: PICKER_VISIBLE });
    if (view.models.length === 0) continue;
    groups.push({
      key: provider.name,
      title: provider.name,
      count: provider.models.length,
      hidden: view.hidden,
      options: view.models.map((model) => {
        const elsewhere = options.slot >= 0
          ? dto.brain.chain.findIndex((choice, i) => i !== options.slot && choice.model === model.model)
          : -1;
        return {
          key: model.model,
          title: brainModelName(model.model, index.get(model.model)),
          sub: model.id,
          date: releaseLabel(model.released),
          selected: model.model === options.selected,
          disabledReason: elsewhere >= 0 ? `已是${slotLabel(elsewhere)}` : null,
          onPick: () => options.onPick(model.model),
        };
      }),
    });
  }
  return groups;
}
