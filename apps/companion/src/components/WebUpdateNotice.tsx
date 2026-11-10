import { Button, IconButton, Row, Text } from '@pi-lead-child/components';
import type { ReactNode } from 'react';

import { useMessages } from '@/i18n';
import { useShellUpdate, useWebUpdate } from '@/state/hooks';
import type { ShellUpdateStatus } from '@/state/shellUpdate';

import { componentsMessages } from './components.messages';

// 有新版本（2026-10-20）：daemon 提供的网页比这个页面新（state/webVersion.ts）。放在会话顶栏里，安静：
// 灰字、细描边，和「等待重新连接」的提示同一个样子，不用警告色。
// 不自动刷新：用户可能正在输入。收起以后同一个版本不再提示，更新的版本再提示一次。
// compact：手机宽度的顶栏放不下整句，只写「有新版本」。
// 桌面 App 有新版时（2026-11-04，state/shellUpdate.ts）同一个位置写新版本号和「更新」，盖过网页的提示：
// 新版 App 带着新的网页。点了以后这里写下载进度、正在安装；失败时写原因和「重试」。
// 原因带上 App 给的报错原文（例如 HTTP 404、stalled），用户能照着说出是哪种网络错误。
export function WebUpdateNotice({ compact = false }: { compact?: boolean }) {
  const update = useWebUpdate();
  const app = useShellUpdate();
  const m = useMessages(componentsMessages);
  if (app && app.status.state !== 'none') return <AppUpdateNotice status={app.status} compact={compact} onUpdate={app.apply} onLater={app.dismiss} />;
  if (!update.available) return null;
  return (
    <NoticePill testID="web-update-notice" text={compact ? m.updateShort : m.updateLong}>
      {update.reload ? <Button label={m.reload} onPress={update.reload} variant="link" tone="accent" size="xs" /> : null}
      <IconButton icon="close" label={m.dismissUpdate} onPress={update.dismiss} variant="ghost" tone="neutral" size="xs" iconSize={9} />
    </NoticePill>
  );
}

function AppUpdateNotice({ status, compact, onUpdate, onLater }: {
  status: Exclude<ShellUpdateStatus, { state: 'none' }>;
  compact: boolean;
  onUpdate: () => void;
  onLater: () => void;
}) {
  const m = useMessages(componentsMessages).appUpdate;
  const later = <IconButton icon="close" label={m.later} onPress={onLater} variant="ghost" tone="neutral" size="xs" iconSize={9} />;
  if (status.state === 'available') {
    return (
      <NoticePill testID="app-update-notice" text={m.available(status.version)}>
        <Button label={m.update} onPress={onUpdate} variant="link" tone="accent" size="xs" />
        {later}
      </NoticePill>
    );
  }
  if (status.state === 'downloading') {
    const percent = status.total > 0 ? Math.min(100, Math.floor((status.received / status.total) * 100)) : 0;
    return <NoticePill testID="app-update-notice" text={m.downloading(percent)} />;
  }
  if (status.state === 'installing') return <NoticePill testID="app-update-notice" text={compact ? m.installingShort : m.installing} />;
  return (
    <NoticePill testID="app-update-notice" text={status.detail ? m.failedWithReason(m.failed[status.code], status.detail) : m.failed[status.code]}>
      <Button label={m.retry} onPress={onUpdate} variant="link" tone="accent" size="xs" />
      {later}
    </NoticePill>
  );
}

function NoticePill({ testID, text, children }: { testID: string; text: string; children?: ReactNode }) {
  return (
    <Row
      testID={testID}
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
      <Text size="11" weight="semibold" tone="secondary" numberOfLines={1} shrink={1}>{text}</Text>
      {children}
    </Row>
  );
}
