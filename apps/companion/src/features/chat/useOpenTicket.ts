import { isWeb, useBreakpoint } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';

import { useWorkspaceStore } from '../../state/CompanionStateProvider';

// 打开会话或工单详情里提到的一张工单。原生端进单独的工单页；web 桌面打开右栏的工单详情。
// web 手机的会话页不画工单详情：先记下返回到哪一页，再切到工单页，在上面打开详情（Workbench.web 的 closeCompactThread 用这个返回）。
// 工单详情里的消息也走这里。详情已经打开时，返回的还是打开第一张工单之前的那一页，不改成工单页。
// chat：打开后把工单对话展开（会话里「发给 #N 的工单消息」的回执：你点它是想看那条消息的回答）。
// 桌面上详情已经开着这张工单时，点了也不会有变化：详情的头部闪一下（主题 Q-9，#590；store 的 showTicket）。
export type OpenTicketOptions = { chat?: boolean };

export function useOpenTicket(): (ticketId: number, options?: OpenTicketOptions) => void {
  const { desktop } = useBreakpoint();
  const router = useRouter();
  const selectTicket = useWorkspaceStore((state) => state.selectTicket);
  const showTicket = useWorkspaceStore((state) => state.showTicket);
  const openCompactPanel = useWorkspaceStore((state) => state.openCompactPanel);
  const compactPanel = useWorkspaceStore((state) => state.compactPanel);
  const compactDestination = useWorkspaceStore((state) => state.compactDestination);
  const setTicketReturnDestination = useWorkspaceStore((state) => state.setTicketReturnDestination);
  const setCompactDestination = useWorkspaceStore((state) => state.setCompactDestination);
  const setTicketChatExpanded = useWorkspaceStore((state) => state.setTicketChatExpanded);
  return (ticketId, options = {}) => {
    setTicketChatExpanded(ticketId, options.chat === true);
    if (!isWeb) {
      router.push({ pathname: '/ticket/[id]', params: { id: String(ticketId) } });
      return;
    }
    if (desktop) {
      showTicket(ticketId);
      return;
    }
    selectTicket(ticketId);
    if (compactPanel !== 'thread') setTicketReturnDestination(compactDestination);
    setCompactDestination('tickets');
    openCompactPanel('thread');
  };
}
