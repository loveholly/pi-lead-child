import { useState, type ReactNode } from 'react';

import { Button } from '../controls/Button';
import { Pressable } from '../primitives/Pressable';
import { Box, Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { AnchoredPanel } from './AnchoredPanel';
import { FairyMark } from './FairyMark';
import { Icon } from './Icon';

export type AnnotationDetail = {
  label: string;
  value: ReactNode;
  /** 标签用等宽字（时刻「12:42」）。 */
  mono?: boolean;
};

export type AnnotationProps = {
  /** 做了什么：「Fairy 据此取消了工单 #104」。 */
  text: string;
  /** 行尾的深色文字按钮，例如「撤销」。 */
  action?: { label: string; onPress: () => void; testID?: string };
  /** 已经撤回：原句划掉，后面跟一个勾和结果（「12:45 已撤销」）。 */
  done?: string | null;
  /** 点开以后用细竖线引出的几行：来自哪里、撤销后会怎样、不是你说的怎么办；撤回以后是结果。没有时不能点开。 */
  details?: readonly AnnotationDetail[];
  /** text 里要加粗的一段，例如合成一行时的「3 件事」（主题 11.6）。 */
  strong?: string;
  /** 展开箭头前面的一个词，例如「逐件看」。缺省只有箭头。 */
  toggleLabel?: string;
  testID?: string;
};

// 模式「注脚」（patterns P9.6，主题 11.6）：在促成它的那句话正下方，右对齐，一行。没有底色，没有边框。
// 从左到右：安静版的 Fairy 标记，灰色文字说做了什么，然后是深色文字按钮和展开箭头。
// 点开从原位置撑开成浮层（会话列表不跳），一条细竖线引出几行细节。
export function Annotation({ text, action, done, details = [], toggleLabel, strong, testID }: AnnotationProps) {
  const at = strong ? text.indexOf(strong) : -1;
  const words = at < 0 ? text : (
    <>
      {text.slice(0, at)}
      <Text size="meta" weight="semibold" tone="strong">{strong}</Text>
      {text.slice(at + strong!.length)}
    </>
  );
  const [open, setOpen] = useState(false);
  const expandable = details.length > 0;
  const line = (expanded: boolean) => (
    <Row testID={expanded ? undefined : testID} w="100%" justify="flex-end" items="center" gap="icon-label" minW={0}>
      <FairyMark quiet size={14} />
      <Text shrink={1} size="meta" tone={done ? 'muted' : 'secondary'} numberOfLines={expanded ? 2 : 1}
        {...(done ? { textDecorationLine: 'line-through' as const } : {})}>{words}</Text>
      {done ? (
        <Row items="center" gap="text-stack" shrink={0}>
          <Text size="meta" tone="faint">·</Text>
          <Icon name="check" size={10} color="success-dark" weight="bold" />
          <Text size="meta" weight="semibold" tone="success-dark">{done}</Text>
        </Row>
      ) : null}
      {action && !done ? (
        <>
          <Text size="meta" tone="faint">·</Text>
          <Button testID={action.testID} label={action.label} onPress={action.onPress} variant="link" tone="neutral" size="xs" />
        </>
      ) : null}
      {expandable ? (
        <Pressable aria-label={`${text}，${expanded ? '收起' : '展开'}`} aria-expanded={expanded} onPress={() => setOpen(!expanded)} feedback="none"
          testID={testID ? `${testID}-${expanded ? 'collapse' : 'expand'}` : undefined}>
          <Row items="center" gap="text-stack">
            {toggleLabel ? <Text size="meta" weight="semibold" tone="strong">{toggleLabel}</Text> : null}
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} color={toggleLabel ? 'text' : 'text-secondary'} weight="semibold" />
          </Row>
        </Pressable>
      ) : null}
    </Row>
  );
  if (!expandable) return line(false);
  return (
    <AnchoredPanel
      open={open}
      onClose={() => setOpen(false)}
      label={text}
      header={<Box px="card" py="card-row">{line(true)}</Box>}
      body={(
        <Row testID={testID ? `${testID}-details` : undefined} justify="flex-end" px="card" py="card-row">
          {/* 细竖线引出细节（主题 11.6）。标签列的宽度是组件规格。 */}
          <Column borderLeftWidth={1} borderLeftColor="border" pl="timeline" gap="text-stack" maxW="100%">
            {details.map((detail) => (
              <Row key={detail.label} items="flex-start" gap="inline-item">
                <Box w={44} shrink={0}><Text size="meta" mono={detail.mono} tone="secondary">{detail.label}</Text></Box>
                <Box flex={1} minW={0}>{typeof detail.value === 'string' ? <Text size="meta">{detail.value}</Text> : detail.value}</Box>
              </Row>
            ))}
          </Column>
        </Row>
      )}
    >
      {line(false)}
    </AnchoredPanel>
  );
}

export type AnnotationConfirmProps = {
  /** 「撤销「取消 #104」？#104 会回到原来的状态。」 */
  question: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** danger：「确认不是我」用红色。缺省是深色实底（「确认撤销」）。 */
  tone?: 'neutral' | 'danger';
  /** 居中（系统信息行的确认）。缺省右对齐（注脚的确认）。 */
  centered?: boolean;
  confirmTestID?: string;
  testID?: string;
};

// 注脚和系统信息行的确认：原地换成一句问话和两个按钮，和原来那一行一样高，会话列表不跳（主题 11.6 状态 3）。
export function AnnotationConfirm({
  question, confirmLabel, cancelLabel = '算了', onConfirm, onCancel, busy = false, tone = 'neutral', centered = false, confirmTestID, testID,
}: AnnotationConfirmProps) {
  return (
    <Row testID={testID} w="100%" justify={centered ? 'center' : 'flex-end'} items="center" gap="inline-item">
      <Text shrink={1} size="meta" tone="strong" numberOfLines={centered ? 2 : 1}>{question}</Text>
      <Button testID={confirmTestID} label={busy ? '正在处理…' : confirmLabel} onPress={onConfirm} disabled={busy}
        variant="solid" tone={tone === 'danger' ? 'danger' : 'neutral'} size="xs" />
      <Button label={cancelLabel} onPress={onCancel} disabled={busy} variant="ghost" tone="neutral" size="xs" />
    </Row>
  );
}
