import { Box, LayoutTransition, Row, SlidePanel, useBreakpoint } from '@pi-lead-child/components';
import { useEffect } from 'react';

import { LeadConversation } from '@/features/chat/LeadConversation';
import { ConnectedTicketRecords } from '@/features/tickets/ConnectedTicketRecords';
import { ConnectedTicketThread } from '@/features/tickets/ConnectedTicketThread';
import { ViewsPanel } from '@/features/views/ViewsPanel';
import { useWorkspaceStore } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useTickets, useWorkItems } from '@/state/hooks';

import { resolveWorkspaceTicket, resolveWorkspaceTickets, shouldShowWorkspaceBootShell } from './model';
import { CompactWorkspaceNav } from './CompactWorkspaceNav';
import { ConnectedWorkRail } from './ConnectedWorkRail';
import { WorkspaceBootShell } from './WorkspaceBootShell';

// 桌面宽度下的三栏：侧栏固定 300，会话和工单面板平分其余的宽度，工单面板最宽 640（复核 P2-6）。
// 视图面板（2026-10-30）和工单面板共用右边这一栏（patterns P16.2）：同一时间只开一个。
// 以前按 288 : 470 : 400 分，1440 宽时工单面板只有 496，长回复和验收清单都挤在里面。现在是 300 / 570 / 570。
const RAIL_LAYOUT = { grow: 0, basis: 300, minWidth: 300, maxWidth: 300 };
const SESSION_LAYOUT = { grow: 1, basis: 0, minWidth: 0 };
const THREAD_LAYOUT = { grow: 1, basis: 0, minWidth: 0, maxWidth: 640 };

export default function Workbench() {
  const { desktop } = useBreakpoint();
  const phase = useConnectionPhase();
  const tickets = useTickets();
  const { items: workItems } = useWorkItems();
  const hydrated = useWorkspaceStore((state) => state.hydrated);
  const selectedTicketId = useWorkspaceStore((state) => state.selectedTicketId);
  const railOpen = useWorkspaceStore((state) => state.railOpen);
  const threadOpen = useWorkspaceStore((state) => state.threadOpen);
  const ticketRecordsOpenId = useWorkspaceStore((state) => state.ticketRecordsOpenId);
  const compactPanel = useWorkspaceStore((state) => state.compactPanel);
  const compactDestination = useWorkspaceStore((state) => state.compactDestination);
  const ticketReturnDestination = useWorkspaceStore((state) => state.ticketReturnDestination);
  const selectTicketState = useWorkspaceStore((state) => state.selectTicket);
  const openRail = useWorkspaceStore((state) => state.openRail);
  const closeRail = useWorkspaceStore((state) => state.closeRail);
  const openThread = useWorkspaceStore((state) => state.openThread);
  const closeThread = useWorkspaceStore((state) => state.closeThread);
  const viewsOpen = useWorkspaceStore((state) => state.viewsOpen);
  const openViews = useWorkspaceStore((state) => state.openViews);
  const closeViews = useWorkspaceStore((state) => state.closeViews);
  const toggleViews = viewsOpen ? closeViews : openViews;
  const openCompactPanel = useWorkspaceStore((state) => state.openCompactPanel);
  const closeCompactPanel = useWorkspaceStore((state) => state.closeCompactPanel);
  const setCompactDestination = useWorkspaceStore((state) => state.setCompactDestination);
  const setTicketReturnDestination = useWorkspaceStore((state) => state.setTicketReturnDestination);
  const setRailView = useWorkspaceStore((state) => state.setRailView);
  const handleBreakpointChange = useWorkspaceStore((state) => state.handleBreakpointChange);
  const items = resolveWorkspaceTickets(phase === 'ready', tickets, workItems);
  const todoCount = items.filter((ticket) => ticket.needsUser != null).length;
  const selectedTicket = resolveWorkspaceTicket(phase === 'ready', tickets, selectedTicketId, workItems);
  const selectedTicketSummary = tickets.find((ticket) => ticket.id === selectedTicketId);
  const railSelectedTicketId = selectedTicketSummary?.parentTicketId ?? selectedTicketId;

  const recordsTicket = desktop && threadOpen && selectedTicket && Number(selectedTicket.id) === ticketRecordsOpenId
    ? selectedTicket
    : null;

  useEffect(() => handleBreakpointChange(), [desktop, handleBreakpointChange]);
  // 工单详情只在用户自己打开时出现（左栏的工单行、会话里的工单小标签和卡片、Lead 卡片里的 TicketRef）。
  // Lead 会话是主界面。以前没有选中的工单时工作台自己打开一张：每次刷新页面都自己打开 #66（2026-10-16 用户决定去掉）。

  if (shouldShowWorkspaceBootShell(hydrated, phase)) {
    return <WorkspaceBootShell />;
  }

  const selectTicket = (ticketId: string) => {
    selectTicketState(Number(ticketId));
    if (desktop) openThread();
    else {
      setTicketReturnDestination(compactDestination);
      setCompactDestination('tickets');
      openCompactPanel('thread');
    }
  };

  const selectCompactDestination = (destination: typeof compactDestination) => {
    closeCompactPanel();
    setCompactDestination(destination);
    if (destination !== 'conversation') setRailView(destination);
  };

  const closeCompactThread = () => {
    closeCompactPanel();
    setCompactDestination(ticketReturnDestination);
  };

  if (!desktop) {
    if (compactDestination === 'conversation') {
      return (
        <Box testID="workbench" flex={1} bg="workspace">
          <LeadConversation
            compact
            onOpenAll={() => selectCompactDestination('tickets')}
            viewsOpen={viewsOpen}
            onToggleViews={toggleViews}
          />
          {/* 手机宽度上视图面板盖在会话上（P16.3）。 */}
          {viewsOpen && (
            <SlidePanel edge="right" modal bg="workspace">
              <ViewsPanel onClose={closeViews} standalone />
            </SlidePanel>
          )}
        </Box>
      );
    }

    return (
      <Box testID="workbench" flex={1} bg="workspace">
        <CompactWorkspaceNav
          active={compactDestination}
          todoCount={todoCount}
          onSelect={selectCompactDestination}
          placement="top"
        />
        <Box flex={1} minH={0} overflow="hidden">
          <ConnectedWorkRail
            connected={phase === 'ready'}
            ticketSummaries={tickets}
            selectedTicketId={railSelectedTicketId === null ? null : String(railSelectedTicketId)}
            onSelectTicket={selectTicket}
            view={compactDestination === 'inbox' ? 'inbox' : compactDestination === 'tickets' ? 'tickets' : compactDestination}
            showViewTabs={false}
          />
          {compactPanel === 'thread' && selectedTicket && (
            <SlidePanel edge="right" modal bg="workspace">
              <ConnectedTicketThread ticket={selectedTicket} onClose={closeCompactThread} standalone />
            </SlidePanel>
          )}
        </Box>
      </Box>
    );
  }

  return (
    <Box testID="workbench" flex={1} minW={0} minH={0} bg="canvas">
      <Row
        flex={1}
        w="100%"
        h="100%"
        minW={0}
        minH={0}
        overflow="hidden"
        borderWidth={1}
        borderColor="border-strong"
        rounded="4xl"
        bg="workspace"
      >
        {railOpen && (
          <SlidePanel edge="left" {...RAIL_LAYOUT} borderRightWidth={1} borderRightColor="border">
            <ConnectedWorkRail connected={phase === 'ready'} ticketSummaries={tickets} selectedTicketId={railSelectedTicketId === null ? null : String(railSelectedTicketId)} onSelectTicket={selectTicket} onClose={closeRail} />
          </SlidePanel>
        )}
        <LayoutTransition testID="workspace-session" {...SESSION_LAYOUT} minW={0}>
          {/* 「证据与记录」占的是 Lead 会话栏，工单面板留在右边（方案 D）。会话藏起来但不卸载，收起后滚动位置还在。 */}
          {recordsTicket ? <ConnectedTicketRecords ticket={recordsTicket} /> : null}
          <Box flex={1} minW={0} minH={0} display={recordsTicket ? 'none' : 'flex'}>
            <LeadConversation
              railOpen={railOpen}
              onOpenRail={openRail}
              onOpenAll={openRail}
              viewsOpen={viewsOpen}
              onToggleViews={toggleViews}
            />
          </Box>
        </LayoutTransition>
        {threadOpen && selectedTicketId && selectedTicket && (
          <SlidePanel edge="right" {...THREAD_LAYOUT} borderLeftWidth={1} borderLeftColor="border">
            <ConnectedTicketThread ticket={selectedTicket} onClose={closeThread} />
          </SlidePanel>
        )}
        {viewsOpen && (
          <SlidePanel edge="right" {...THREAD_LAYOUT} borderLeftWidth={1} borderLeftColor="border">
            <ViewsPanel onClose={closeViews} />
          </SlidePanel>
        )}
      </Row>
    </Box>
  );
}
