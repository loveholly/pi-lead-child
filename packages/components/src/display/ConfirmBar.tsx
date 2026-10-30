import type { ReactNode } from 'react';

import { Button, type ButtonTone } from '../controls/Button';
import { FactList, type FactItem } from '../data/FactList';
import { Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';

export type ConfirmBarProps = {
  /** 一句问题，例如「推到 GitHub，开一个草稿 PR？」。 */
  title: string;
  /** 几行说明：左边名字，右边内容，例如推送哪个分支、目标分支。 */
  details?: readonly FactItem[];
  /** 说明下面的提醒，例如对外操作的后果。 */
  note?: string;
  /** 说明和按钮之间的其他内容。 */
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** 确认按钮的颜色。危险操作用 danger。 */
  tone?: ButtonTone;
  /** 正在提交：确认按钮不能再点。 */
  busy?: boolean;
  testID?: string;
};

// 对外操作之前的一次确认（第四轮画板：开 PR、不等核查直接验收）。放在底部操作栏的位置（ActionBar 的 confirm）。
export function ConfirmBar({
  title, details = [], note, children, confirmLabel, cancelLabel = '取消', onConfirm, onCancel, tone = 'accent', busy = false,
  testID,
}: ConfirmBarProps) {
  return (
    <Column testID={testID} role="dialog" aria-label={title} px="card" pt="card" pb="card">
      <Text size="card-title" weight="extrabold">{title}</Text>
      {details.length > 0 ? (
        <Column mt="card-section">
          <FactList variant="labeled" labelWidth={44} items={details} />
        </Column>
      ) : null}
      {children}
      {note ? <Text mt="card-row" size="secondary" tone="strong">{note}</Text> : null}
      <Row justify="flex-end" gap="actions" mt="card-section">
        <Button label={cancelLabel} onPress={onCancel} variant="outline" tone="neutral" size="md" testID={testID ? `${testID}-cancel` : undefined} />
        <Button
          label={confirmLabel}
          onPress={onConfirm}
          disabled={busy}
          variant="solid"
          tone={tone}
          size="md"
          testID={testID ? `${testID}-confirm` : undefined}
        />
      </Row>
    </Column>
  );
}
