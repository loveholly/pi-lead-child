import { ProgressBar } from '../display/ProgressBar';
import { Column, Row } from '../primitives/layout';
import { Text } from '../primitives/Text';
import { dataToneFill, type DataTone } from './tones';

export type ProgressProps = {
  label: string;
  /** 0 到 1。不给时写「进度未知」，进度条是空的。 */
  value?: number;
  /** 进度条下面的一句说明，例如「120 / 300 个」。 */
  caption?: string;
  tone?: DataTone;
  testID?: string;
};

// 一项任务的进度：上面是名字和百分比，中间是进度条，下面是说明。
export function Progress({ label, value, caption, tone, testID }: ProgressProps) {
  return (
    <Column testID={testID} gap="card-row">
      <Row items="baseline" gap="inline-item">
        <Text flex={1} minW={0} size="card-title" weight="semibold">{label}</Text>
        <Text size="meta" mono tone="secondary" shrink={0}>{value === undefined ? '进度未知' : `${Math.round(value * 100)}%`}</Text>
      </Row>
      <Row>
        <ProgressBar value={(value ?? 0) * 100} color={dataToneFill(tone)} track="surface-muted" height={6} />
      </Row>
      {caption ? <Text size="secondary" tone="secondary">{caption}</Text> : null}
    </Column>
  );
}
