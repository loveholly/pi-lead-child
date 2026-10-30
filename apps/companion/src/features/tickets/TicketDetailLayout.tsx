import { Column, EmptyState, Row, Text, type IconName } from '@pi-lead-child/components';

// 一块内容的小标题和计数（例如「进展记录 20」）。12 号 text-strong：以前 10.5 号的 text-muted 在白底上只有约 2.6:1。
export function SectionHeader({ title, count }: { title: string; count: string }) {
  return (
    <Row items="center" gap="inline-item" pt="section-label-top">
      <Text size="section-title" weight="extrabold" tone="strong">{title}</Text>
      <Text size="meta" mono weight="bold" tone="secondary">{count}</Text>
    </Row>
  );
}

// 一块内容还没有东西时的空状态。
export function DetailEmpty({ title, body, icon }: { title: string; body: string; icon: IconName }) {
  return (
    <Column minH={250} items="center" justify="center">
      <EmptyState icon={icon} iconColor="text-muted" iconBackground="surface-muted" title={title} body={body} />
    </Column>
  );
}
