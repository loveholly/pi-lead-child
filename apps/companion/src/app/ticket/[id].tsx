import { Button, Column, Screen, Text } from '@pi-lead-child/components';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ConnectedTicketThread } from '@/features/tickets/ConnectedTicketThread';
import { resolveWorkspaceTicket } from '@/features/workspace/model';
import { useConnectionPhase, useTickets, useWorkItems } from '@/state/hooks';

export default function TicketDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const phase = useConnectionPhase();
  const tickets = useTickets();
  const { items: workItems } = useWorkItems();
  const ticket = resolveWorkspaceTicket(phase === 'ready', tickets, id ?? null, workItems);
  const loading = phase === 'loading' || phase === 'connecting';
  return (
    <Screen edges={['top', 'bottom']}>
      {ticket ? (
        <ConnectedTicketThread
          ticket={ticket}
          standalone
          onClose={() => router.back()}
          onOpenTicket={(ticketId) => router.push({ pathname: '/ticket/[id]', params: { id: String(ticketId) } })}
        />
      ) : loading ? (
        <Column flex={1} items="center" justify="center" px="page-x">
          <Text size="secondary" tone="muted" align="center">正在读取真实工单…</Text>
        </Column>
      ) : (
        <Column flex={1} items="center" justify="center" px="page-x">
          <Column w="100%" maxW={420} p="card" items="center" gap="card-row">
            <Text size="section-title" weight="extrabold" align="center">{`未找到工单${id ? ` #${id}` : ''}`}</Text>
            <Text size="secondary" tone="muted" align="center">这张工单可能已删除，或者当前绑定没有读取权限。</Text>
            <Button testID="ticket-not-found-back" label="返回" onPress={() => router.back()} />
          </Column>
        </Column>
      )}
    </Screen>
  );
}
