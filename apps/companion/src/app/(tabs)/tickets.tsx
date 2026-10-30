import { Chip, Row } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';

import { CollectionScreen } from '@/components/CollectionScreen';
import { TicketList } from '@/features/workspace/TicketList';
import {
  TICKET_RAIL_FILTERS,
  buildTicketRailPresentation,
  resolveWorkspaceTickets,
} from '@/features/workspace/model';
import { useWorkspaceStore } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useLeadName, useTickets, useWorkItems } from '@/state/hooks';

export default function TicketsScreen() {
  const router = useRouter();
  const phase = useConnectionPhase();
  const leadName = useLeadName();
  const tickets = useTickets();
  const { items: workItems } = useWorkItems();
  const ticketFilter = useWorkspaceStore((state) => state.ticketFilter);
  const ticketQuery = useWorkspaceStore((state) => state.ticketQuery);
  const setTicketFilter = useWorkspaceStore((state) => state.setTicketFilter);
  const setTicketQuery = useWorkspaceStore((state) => state.setTicketQuery);
  const setComposerDraft = useWorkspaceStore((state) => state.setComposerDraft);
  const setCompactDestination = useWorkspaceStore((state) => state.setCompactDestination);
  const loading = phase === 'loading' || phase === 'connecting';
  const items = resolveWorkspaceTickets(phase === 'ready', tickets, workItems);
  const projection = buildTicketRailPresentation(items, {
    filter: ticketFilter,
    query: ticketQuery,
    loading,
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
    <CollectionScreen title="工单" subtitle={`${leadName} 创建和监督的任务工作单`}>
      {/* spacing-exempt: 筛选条自己的规格；补齐筛选条和标题的对齐 */}
      <Row role="tablist" items="center" gap="chips" mb="stacked-card" px={6} py={4}>
        {TICKET_RAIL_FILTERS.map((filter) => (
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
      <TicketList items={items} onSelect={(id) => router.push(`/ticket/${id}`)}
        grouped
        filter={ticketFilter}
        query={ticketQuery}
        loading={loading}
        onCreateTask={openConversation}
        onClearFilters={clearFilters}
        onSeedTask={openConversation}
      />
    </CollectionScreen>
  );
}
