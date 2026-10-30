import { Column, Pressable, Row, Screen, ScrollArea, Text, useBreakpoint } from '@pi-lead-child/components';
import { useRouter, type Href } from 'expo-router';
import type { ReactNode } from 'react';

type SettingsPageProps = {
  // 不给时不画标题：内容自己有标题（例如手机上一个连接的详情）。
  title?: string;
  // 标题下面的一句说明。
  description?: string;
  // 手机上左上角的返回：回到哪一页、按钮上写什么。缺省回到设置首页。
  back?: { label: string; href: string };
  children?: ReactNode;
};

// 设置里一个分组的页面。
// 桌面上侧栏和滚动区由 SettingsDesktopShell 提供，这里只画标题和内容。
// 手机上是一整屏：左上角「‹ 设置」，下面是标题和可以滚动的内容。
export function SettingsPage({ title, description, back = { label: '设置', href: '/settings' }, children }: SettingsPageProps) {
  const { desktop } = useBreakpoint();
  const router = useRouter();
  const heading = title === undefined ? null : (
    <Column gap="group-label" mb="page-section">
      <Text testID="settings-page-title" size="page-title" weight="extrabold" letterSpacing={-0.4}>{title}</Text>
      {description ? <Text size="secondary" tone="secondary" maxW={520}>{description}</Text> : null}
    </Column>
  );

  if (desktop) {
    return <Column testID="settings-page">{heading}{children}</Column>;
  }

  return (
    <Screen edges={['top', 'bottom']} bg="surface-muted">
      <Row h={44} px="page-x" items="center">
        {/* 栈里有那一页时退回去；没有时（从别处直接打开这一页）换成那一页，不会退出设置。 */}
        <Pressable
          testID="settings-back"
          aria-label={`返回${back.label}`}
          onPress={() => router.dismissTo(back.href as Href)}
          h={36}
          px={6} // spacing-exempt: 返回链接点击区
          justify="center"
          rounded="sm"
        >
          {/* spacing-exempt: 链接字号 */}
          <Text size="15" weight="semibold" tone="accent">{`‹ ${back.label}`}</Text>
        </Pressable>
      </Row>
      <ScrollArea>
        {/* spacing-exempt: 标题自带留白 */}
        <Column testID="settings-page" px="page-x" pt={2} pb="page-bottom">
          {heading}
          {children}
        </Column>
      </ScrollArea>
    </Screen>
  );
}
