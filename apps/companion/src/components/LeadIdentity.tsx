import { Column, Dot, LeadAvatar, Pressable, Row, Text, type TextTone } from '@pi-lead-child/components';
import { useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';

import { isDevicePaired } from '@/features/settings/settingsNav';
import { useConnectionPhase, useConnectionState, useLeadBusy, useLeadName, useOverview } from '@/state/hooks';

import { useLeadAvatarSource } from './useLeadAvatarSource';
import { leadFairy, leadPresence, type LeadPresence } from './leadPresence';

// 会话顶栏左侧的 Lead 身份：形象、名字和 Lead 的状态（在线、降级、离线，见 ./leadPresence）。
// 方案 C（主题 F-7、11.14）：只在手机上和左栏收起时放在顶栏；形象的状态和左栏头部一样（leadFairy）。
// 已经配对时点它打开设置的「本设备」；还没配对时打开配对页。手机上这里就是设置的入口。
export function LeadIdentity({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const phase = useConnectionPhase();
  const presence = useLeadPresence();
  const name = useLeadName();
  const fairy = leadFairy(presence, useLeadBusy());
  const source = useLeadAvatarSource(fairy);
  const target = isDevicePaired(phase) ? '/settings/device' : '/pair';

  return (
    <Pressable testID="lead-identity" onPress={() => router.push(target as Href)} h={48} rounded="md" justify="center">
      <Row items="center" gap="side-item">
        <LeadAvatar testID="lead-identity-fairy" size={32} name={name} state={fairy.state} tone={fairy.tone} source={source} />
        <Column gap="text-stack" minW={0} shrink={1}>
          <Row items="center" gap="icon-label">
            <Text size={compact ? '14.5' : '15'} weight="extrabold">{name}</Text>
            <Dot
              color={presence.dotColor}
              size={7}
              pulse={presence.pulse}
              testID="lead-status-dot"
              accessibilityLabel={presence.label}
            />
          </Row>
          {presence.subtitle ? (
            <Text size="secondary" tone={leadSubtitleTone(presence)} numberOfLines={1}>
              {presence.subtitle}
            </Text>
          ) : null}
        </Column>
      </Row>
    </Pressable>
  );
}

// Lead 现在的状态。会话顶栏和设置首页的 Lead 名字卡片用同一个。
export function useLeadPresence(): LeadPresence {
  const connectionState = useConnectionState();
  const phase = useConnectionPhase();
  const lead = useOverview()?.lead;
  const name = useLeadName();
  // 下一次自动重试的时间一到就重画一次，顶栏不会一直挂着一个已经过去的时间。
  const [now, setNow] = useState(() => Date.now());
  const retryAt = lead?.state === 'degraded' && lead.nextAttemptAt ? Date.parse(lead.nextAttemptAt) : null;
  useEffect(() => {
    if (retryAt === null || Number.isNaN(retryAt)) return undefined;
    const wait = retryAt - Date.now();
    if (wait <= 0) { setNow(Date.now()); return undefined; }
    const timer = setTimeout(() => setNow(Date.now()), wait + 50);
    return () => clearTimeout(timer);
  }, [retryAt]);
  return leadPresence({ connectionState, phase, lead, now, name });
}

// 小字和状态点同色系：认证、配置失败是红点红字，会自己恢复的降级是橙点橙字，其余是次要文字色。
// 三种颜色在白底上都到 WCAG AA（4.83、5.43、4.97:1）。
export function leadSubtitleTone(presence: LeadPresence): TextTone {
  if (presence.dotColor === 'danger') return 'danger-dark';
  return presence.state === 'degraded' ? 'warning-dark' : 'secondary';
}
