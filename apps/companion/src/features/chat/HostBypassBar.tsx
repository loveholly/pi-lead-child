import { Button, Dot, Row, Text } from '@pi-lead-child/components';
import { useState } from 'react';

import { useLocale } from '@/i18n';
import { hostBypassErrorText, hostBypassOn } from '@/features/settings/hostBypassModel';
import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useHostBypass } from '@/state/hooks';

import { hostBypassBarMessages } from './hostBypassBar.messages';

// 「用户本人发话时免沙箱」开着时，主对话输入框上方的标记（工单 #246 设计 5.3，主题 11.17「模式标记」）。
// 系统画（P8.1），一行，固定高度：琥珀色的点（C-11）、「免沙箱 · 开着」、右边的「关闭」。文字写明状态，不只靠颜色（P7.2）。
// 它在输入框这一栏里，不在会话列表里：出现和消失都不插进列表，列表不跳（P1）。「关闭」调 host_bypass.disable。
// 开关没有时限（用户 2026-11-10）：没有倒计时，一直显示到你或 Lead 关掉。
export function HostBypassBar() {
  const runtime = useCompanionRuntime();
  const { hostBypass } = useHostBypass();
  const locale = useLocale();
  const m = hostBypassBarMessages(locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!hostBypassOn(hostBypass)) return null;

  const close = () => {
    setBusy(true);
    setError(null);
    runtime.disableHostBypass()
      .catch((reason: unknown) => setError(hostBypassErrorText(reason, locale)))
      .finally(() => setBusy(false));
  };

  return (
    <Row
      testID="host-bypass-bar"
      w="100%"
      mb={8} // spacing-exempt: 输入框上方的状态行间距，和 InterruptBanner 一样
      items="center"
      gap="side-item"
      bg="surface"
      borderWidth={1}
      borderColor="border-soft"
      rounded="md"
      px="banner-x"
      py="banner-y"
    >
      <Dot color="warning" size={7} />
      <Text testID="host-bypass-bar-text" size="label" tone="warning-dark" numberOfLines={1} flex={1} minW={0}>
        {error ? m.failed(error) : m.line}
      </Text>
      <Button
        testID="host-bypass-bar-close"
        label={busy ? m.closing : m.close}
        onPress={close}
        disabled={busy}
        variant="link"
        size="xs"
      />
    </Row>
  );
}
