import { Column, Density, ScrollArea, Screen, Text } from '@pi-lead-child/components';
import type { PropsWithChildren } from 'react';

// 原生标签页（工单、项目、日程）的页面骨架：标题栏加一个滚动的内容区。扫读的列表，用紧凑密度（2026-10-22）。
export function CollectionScreen({ title, subtitle, children }: PropsWithChildren<{ title: string; subtitle: string }>) {
  return (
    <Density zone="workspace"><Screen edges={['top']}>
      <Column gap="text-stack" px="page-x" pt="page-top" pb="page-section" borderBottomWidth={1} borderBottomColor="border-soft" bg="surface">
        <Text size="page-title" weight="extrabold" letterSpacing={-0.4}>{title}</Text>
        <Text size="secondary" tone="muted">{subtitle}</Text>
      </Column>
      <ScrollArea>
        {/* spacing-exempt: 给对话坞和标签栏留位置 */}
        <Column px="page-x" pt="page-top" pb={120}>{children}</Column>
      </ScrollArea>
    </Screen></Density>
  );
}
