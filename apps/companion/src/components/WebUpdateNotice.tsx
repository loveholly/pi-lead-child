import { Button, IconButton, Row, Text } from '@pi-lead-child/components';

import { useWebUpdate } from '@/state/hooks';

// 有新版本（2026-10-20）：daemon 提供的网页比这个页面新（state/webVersion.ts）。放在会话顶栏里，安静：
// 灰字、细描边，和「等待重新连接」的提示同一个样子，不用警告色。
// 不自动刷新：用户可能正在输入。收起以后同一个版本不再提示，更新的版本再提示一次。
// compact：手机宽度的顶栏放不下整句，只写「有新版本」。
export function WebUpdateNotice({ compact = false }: { compact?: boolean }) {
  const update = useWebUpdate();
  if (!update.available) return null;
  return (
    <Row
      testID="web-update-notice"
      items="center"
      gap="inline-item"
      pl="pill-x"
      pr="pill-x"
      minW={0}
      shrink={1}
      borderWidth={1}
      borderColor="border"
      rounded="full"
      bg="surface"
    >
      {/* spacing-exempt: 徽标字号 */}
      <Text size="11" weight="semibold" tone="secondary" numberOfLines={1} shrink={1}>{compact ? '有新版本' : '有新版本，刷新后生效'}</Text>
      {update.reload ? <Button label="刷新" onPress={update.reload} variant="link" tone="accent" size="xs" /> : null}
      <IconButton icon="close" label="不再提示这个版本" onPress={update.dismiss} variant="ghost" tone="neutral" size="xs" iconSize={9} />
    </Row>
  );
}
