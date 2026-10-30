import type { Ticket } from '@/features/workspace/model';

import { Density } from '@pi-lead-child/components';

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
  // 工单详情是扫读的面板，用紧凑密度（2026-10-22）；里面的对话坞在 TicketThread 里切回标准。
  return <Density zone="ticket"><TicketThread key={ticket.id} {...model} onClose={onClose} standalone={standalone} /></Density>;
}
