import { useState, type ReactNode } from 'react';

import { Pressable } from '../primitives/Pressable';
import { Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { AnchoredPanel } from './AnchoredPanel';
import { Icon } from './Icon';
import type { IconName } from './icons';
import { RecordTag } from './RecordBlock';

export type GroupEntry = {
  key: string;
  /** 等宽字的时间「10:29」。没有时这一列空着。 */
  time?: string | null;
  content: ReactNode;
};

export type GroupProps = {
  /** 做了什么：「行内评论」「GitHub 写入」。收起时只占一行。 */
  label: string;
  /** 前面的小标签：「已加」「跳过」。和记录块的标签是同一个（RecordTag）。 */
  tag?: string | null;
  tone?: 'neutral' | 'warning';
  icon?: IconName;
  /** 组里的每一件。件数由它数出来，调用方不写数字。 */
  entries: readonly GroupEntry[];
  /** 件数后面的时间段「10:29–10:30」。 */
  range?: string | null;
  testID?: string;
};

// 同类合并（2026-10-28 用户定稿，改版稿第 2 版第 5 组）：一组同类的事。
// 收起时一行：标签、做了什么、件数和时间段、箭头。点开从原位置撑开成锚定浮层（AnchoredPanel），每件一行，会话列表不变高。
// genui 的 Group 节点、合并后的系统信息行都用它；浮层里的列表是 GroupList。
export function Group({ label, tag, tone = 'neutral', icon, entries, range, testID }: GroupProps) {
  const [open, setOpen] = useState(false);
  const row = (expanded: boolean) => (
    <Pressable
      testID={testID ? `${testID}-${expanded ? 'collapse' : 'expand'}` : undefined}
      aria-label={expanded ? `收起${label}` : `展开${label}，${entries.length} 件`}
      aria-expanded={expanded}
      onPress={() => setOpen(!expanded)}
      feedback="none"
    >
      <Row items="center" gap="inline-item" minW={0}>
        {tag ? <RecordTag label={tag} tone={tone} {...(icon ? { icon } : {})} /> : null}
        <Text flex={1} minW={0} size="message-body" tone="strong" numberOfLines={1}>{label}</Text>
        <Text testID={testID ? `${testID}-count` : undefined} size="meta" weight="semibold" tone="secondary" shrink={0}>
          {range ? `${entries.length} 件 · ${range}` : `${entries.length} 件`}
        </Text>
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color="text-secondary" weight="semibold" />
      </Row>
    </Pressable>
  );
  return (
    <AnchoredPanel
      open={open}
      onClose={() => setOpen(false)}
      label={`${label} · ${entries.length} 件`}
      header={<Column px="card" py="card-row">{row(true)}</Column>}
      body={<Column px="card" py="card-row"><GroupList entries={entries} testID={testID ? `${testID}-list` : undefined} /></Column>}
      {...(testID ? { testID } : {})}
    >
      {row(false)}
    </AnchoredPanel>
  );
}

// 组里的每一件，一件一行：等宽时间，后面是内容。Group 的浮层、合并后的系统信息行的浮层、记录块展开后的明细都用它。
export function GroupList({ entries, testID }: { entries: readonly GroupEntry[]; testID?: string }) {
  const timed = entries.some((entry) => entry.time);
  return (
    <Column testID={testID} gap="list-row">
      {entries.map((entry) => (
        <Row key={entry.key} items="baseline" gap="inline-item" minW={0}>
          {timed ? <Text size="meta" mono tone="secondary" shrink={0}>{entry.time ?? ''}</Text> : null}
          <Column flex={1} minW={0}>
            {typeof entry.content === 'string' ? <Text size="note" tone="secondary">{entry.content}</Text> : entry.content}
          </Column>
        </Row>
      ))}
    </Column>
  );
}
