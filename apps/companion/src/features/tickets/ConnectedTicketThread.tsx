import type { Ticket } from '@/features/workspace/model';

import { Density } from '@pi-lead-child/components';

import { useWorkspaceStore } from '@/state/CompanionStateProvider';

import { TicketThread } from './TicketThread';
import { useTicketDetailModel } from './useTicketDetailModel';

type ConnectedTicketThreadProps = {
  ticket: Ticket;
  onClose: () => void;
  standalone?: boolean;
  onOpenTicket?: (ticketId: number) => void;
};

// 工单面板的容器：数据和动作来自 useTicketDetailModel，TicketThread 只负责画。
export function ConnectedTicketThread({ ticket, onClose, standalone = false, onOpenTicket }: ConnectedTicketThreadProps) {
  const model = useTicketDetailModel(ticket, { onOpenTicket });
  // 详情已经开着这张工单、你又点了打开它的入口：顶栏闪一下（store 的 showTicket，#590）。
  const flash = useWorkspaceStore((state) => (state.panelNudge?.panel === 'thread' ? state.panelNudge.seq : null));
  // 工单详情是扫读的面板，用紧凑密度（2026-10-22）；里面的对话坞在 TicketThread 里切回标准。
  return <Density zone="ticket"><TicketThread key={ticket.id} {...model} onClose={onClose} standalone={standalone} flash={flash} /></Density>;
}
