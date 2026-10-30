import { Box, Button, Column, Text } from '@pi-lead-child/components';
import { userActionTargetParts, type UserActionRequest } from '@pi-lead-child/protocol';

import { useOpenInbox } from '../chat/useOpenInbox';
import { useOpenTicket } from '../chat/useOpenTicket';
import { ConnectionConfirmCard, ConnectionConnectCard } from './ConnectionCards';
import { RuleChangeConfirmCard } from './RuleChangeCards';
import { TimerRequestConfirmCard } from './TimerRequestCards';

// 请用户做一件事（通用，2026-10-19，protocol 的 user-actions.ts）。action 是系统给的结构化数据，Lead 原样放进卡片。
// 按 kind 选控件，按 target 找到那件事：控件只做这一件事，走它自己的路由（只有用户能按到）。不按服务写特例：
//   · authorize、reauthorize：连接卡（和设置页同一个连接流程，状态实时读取）；
//   · confirm_write：那一次写入的确认卡；
//   · confirm_rule_change：被拦下的那一次改规则操作的确认卡（统一的消息事件工单 09）；
//   · confirm_timer：外部的人要求设、代价不够低的定时器的确认卡（统一的消息事件工单 12）；
//   · accept：打开工单，在工单里验收；
//   · choose、approve：打开「待你」，在那里选择或审批。
export function UserActionCard({ action }: { action: UserActionRequest }) {
  const target = userActionTargetParts(action.target);
  const openTicket = useOpenTicket();
  const openInbox = useOpenInbox();
  if (!target) return null;
  switch (action.kind) {
    case 'authorize':
    case 'reauthorize':
      return <ConnectionConnectCard connection={target.id} reason={action.reason} />;
    case 'confirm_write':
      return <ConnectionConfirmCard confirmation={target.id} />;
    case 'confirm_rule_change':
      return <RuleChangeConfirmCard confirmation={target.id} />;
    case 'confirm_timer':
      return <TimerRequestConfirmCard request={target.id} />;
    case 'accept':
      return (
        <ActionRow
          testID={`surface-user-action-${action.kind}-${target.id}`}
          reason={action.reason}
          title={action.title}
          onPress={() => openTicket(Number(target.id))}
        />
      );
    case 'choose':
    case 'approve':
      return (
        <ActionRow
          testID={`surface-user-action-${action.kind}-${target.id}`}
          reason={action.reason}
          title={action.title}
          onPress={openInbox}
        />
      );
    default:
      return null;
  }
}

function ActionRow({ testID, reason, title, onPress }: { testID: string; reason: string; title: string; onPress: () => void }) {
  return (
    <Column testID={testID} gap="card-row">
      <Text size="body">{reason}</Text>
      <Box self="flex-start">
        <Button label={title} variant="solid" tone="accent" size="sm" onPress={onPress} />
      </Box>
    </Column>
  );
}
