import { Chip, Row, ScrollArea } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';

import { CollectionScreen } from '@/components/CollectionScreen';
import { TicketList } from '@/features/workspace/TicketList';
import {
  buildTicketRailPresentation,
  resolveWorkspaceTickets,
  ticketRailFilters,
} from '@/features/workspace/model';
import { useLocale, useMessages } from '@/i18n';
import { navigationMessages } from '@/navigation/navigation.messages';
import { useCompanionRuntime, useWorkspaceStore } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useLeadName, useTickets, useWorkItems } from '@/state/hooks';

export default function TicketsScreen() {
  const router = useRouter();
  const runtime = useCompanionRuntime();
  const phase = useConnectionPhase();
  const leadName = useLeadName();
  const locale = useLocale();
  const m = useMessages(navigationMessages);
  const tickets = useTickets();
  const { items: workItems } = useWorkItems();
  const ticketFilter = useWorkspaceStore((state) => state.ticketFilter);
  const ticketQuery = useWorkspaceStore((state) => state.ticketQuery);
  const setTicketFilter = useWorkspaceStore((state) => state.setTicketFilter);
  const setTicketQuery = useWorkspaceStore((state) => state.setTicketQuery);
  const setComposerDraft = useWorkspaceStore((state) => state.setComposerDraft);
  const setCompactDestination = useWorkspaceStore((state) => state.setCompactDestination);
  const loading = phase === 'loading' || phase === 'connecting';
  const items = resolveWorkspaceTickets(phase === 'ready', tickets, workItems, locale);
  const projection = buildTicketRailPresentation(items, {
    filter: ticketFilter,
    query: ticketQuery,
    loading,
    locale,
  });

  const clearFilters = () => {
    setTicketFilter('all');
    setTicketQuery('');
  };

  const openConversation = (draft = '') => {
    setComposerDraft('lead', draft);
    setCompactDestination('conversation');
    router.push('/');
  };

  return (
    <CollectionScreen title={m.tickets} subtitle={m.ticketsSubtitle(leadName)}>
      {/* 六个筛选放不下一行：横向滑动（工单 #111）。 */}
      <ScrollArea horizontal flex={0}>
      {/* spacing-exempt: 筛选条自己的规格；补齐筛选条和标题的对齐 */}
      <Row role="tablist" items="center" gap="chips" mb="stacked-card" px={6} py={4}>
        {ticketRailFilters(locale).map((filter) => (
          <Chip
            key={filter.id}
            label={filter.label}
            count={projection.filterCounts[filter.id]}
            selected={ticketFilter === filter.id}
            onPress={() => setTicketFilter(filter.id)}
            size="md"
            testID={`native-ticket-filter-${filter.id}`}
          />
        ))}
      </Row>
      </ScrollArea>
      <TicketList items={items} onSelect={(id) => router.push(`/ticket/${id}`)}
        grouped
        filter={ticketFilter}
        query={ticketQuery}
        loading={loading}
        onCreateTask={openConversation}
        onClearFilters={clearFilters}
        onSeedTask={openConversation}
        onResumeTicket={(ticket) => runtime.runTicketAction(Number(ticket.id), 'resume_run', ticket.pause ? { input: { runId: ticket.pause.attemptId } } : {})}
        onCancelTicket={(ticket) => runtime.runTicketAction(Number(ticket.id), 'cancel')}
      />
    </CollectionScreen>
  );
}
