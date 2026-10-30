import { Density } from '@pi-lead-child/components';
import { inboxNotices, type ExternalTimerDto, type TicketStatus, type WatchTimerDto } from '@pi-lead-child/protocol';
import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useCompanionRuntime, useControlPlaneStore, useWorkspaceStore } from '@/state/CompanionStateProvider';
import {
  useAgenda, useConnectionPhase, useInboxView, useLeadBusy, useLeadName, useNotifications, useProjectOverviews, useProjects,
  useTimeline, useWorkItems,
} from '@/state/hooks';
import { useLeadPresence } from '@/components/LeadIdentity';
import { useLeadAvatarSource } from '@/components/useLeadAvatarSource';
import { leadFairy } from '@/components/leadPresence';

import { isWorkspaceControlActionId, resolveWorkspaceTickets, type Ticket } from './model';
import { sortUpcoming, watchReminder, type UpcomingReminder } from './inboxModel';
import { userOutboxNotifications } from './notificationOutbox';
import { InboxChannelCards } from './InboxChannelCards';
import { WorkRail } from './WorkRail';

type ConnectedWorkRailProps = {
  connected: boolean;
  ticketSummaries: Parameters<typeof resolveWorkspaceTickets>[1];
  selectedTicketId: string | null;
  onSelectTicket: (ticketId: string) => void;
  onClose?: () => void;
  view?: 'inbox' | 'tickets' | 'projects' | 'agenda';
  showViewTabs?: boolean;
};

export function ConnectedWorkRail({
  connected,
  ticketSummaries,
  selectedTicketId,
  onSelectTicket,
  onClose,
  view,
  showViewTabs,
}: ConnectedWorkRailProps) {
  const { items: workItems } = useWorkItems();
  const leadName = useLeadName();
  const presence = useLeadPresence();
  const leadBusy = useLeadBusy();
  const look = useMemo(() => leadFairy(presence, leadBusy), [presence, leadBusy]);
  const source = useLeadAvatarSource(look);
  const fairy = useMemo(() => ({ ...look, source }), [look, source]);
  const runtime = useCompanionRuntime();
  const router = useRouter();
  const projects = useProjects();
  const projectOverviews = useProjectOverviews();
  const agenda = useAgenda();
  const timeline = useTimeline();
  const inbox = useInboxView();
  const allNotifications = useNotifications();
  // 这个客户端自己做的主人操作不进收件箱（工单 15）：会话里只有一行记录。
  const ownBindingId = runtime.currentBinding()?.id ?? null;
  const notifications = useMemo(
    () => userOutboxNotifications(allNotifications, { ownBindingId }),
    [allNotifications, ownBindingId],
  );
  const railView = useWorkspaceStore((state) => state.railView);
  const ticketQuery = useWorkspaceStore((state) => state.ticketQuery);
  const ticketFilter = useWorkspaceStore((state) => state.ticketFilter);
  const ticketProject = useWorkspaceStore((state) => state.ticketProject);
  const setTicketProject = useWorkspaceStore((state) => state.setTicketProject);
  const setRailView = useWorkspaceStore((state) => state.setRailView);
  const setTicketQuery = useWorkspaceStore((state) => state.setTicketQuery);
  const setTicketFilter = useWorkspaceStore((state) => state.setTicketFilter);
  const setComposerDraft = useWorkspaceStore((state) => state.setComposerDraft);
  const setCompactDestination = useWorkspaceStore((state) => state.setCompactDestination);
  const items = useMemo<Ticket[]>(
    () => resolveWorkspaceTickets(connected, ticketSummaries, workItems),
    [connected, ticketSummaries, workItems],
  );
  // 提醒不在工单列表里；日程带来它们的当前状态，已经确认的提醒就不再出现在收件箱。
  const notices = useMemo(() => {
    const reminderStages = new Map<number, TicketStatus>();
    for (const item of agenda) {
      if (item.kind === 'ticket_reminder' && item.ticketId !== null && item.status) reminderStages.set(item.ticketId, item.status);
    }
    return inboxNotices(notifications, ticketSummaries, { reminderStages });
  }, [agenda, notifications, ticketSummaries]);
  // 外部的人要求设、还在等的定时器（spec D16，工单 12）：GET /v1/timers/external。设、改、取消定时器时 daemon 发 ticket.updated，
  // 日程跟着重取：日程变了就重读一次。旧的 daemon 没有这个路由时是空的。
  // 还在等的后台检查（.scratch/lead-watch/spec.md D5）：GET /v1/timers/watches，和上面同时读、同时重读。
  // 两个列表分开读：一个读不到（旧的 daemon 没有 watches 路由）时，另一个照常显示。
  const ready = useConnectionPhase() === 'ready';
  const [externalTimers, setExternalTimers] = useState<readonly ExternalTimerDto[]>([]);
  const [watchTimers, setWatchTimers] = useState<readonly WatchTimerDto[]>([]);
  const loadTimers = useCallback((signal?: AbortSignal) => Promise.all([
    runtime.externalTimers(signal).then(
      (timers) => { if (!signal?.aborted) setExternalTimers(timers); },
      () => { if (!signal?.aborted) setExternalTimers([]); },
    ),
    runtime.watchTimers(signal).then(
      (watches) => { if (!signal?.aborted) setWatchTimers(watches); },
      () => { if (!signal?.aborted) setWatchTimers([]); },
    ),
  ]), [runtime]);
  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    void loadTimers(controller.signal);
    return () => controller.abort();
  }, [agenda, loadTimers, ready]);
  // 还在等的提醒（工单 07）：日程里接下来 24 小时的，先到的在前，最多 3 条。「重要」来自已经取到的提醒详情。
  // 外部的人要求设的定时器全部列出（不管多久以后到点），写明是谁要求的，可以取消；同一条提醒只出现一次。
  // 后台检查也全部给出，按下一次检查的时间排；卡里最多露出 3 个，其余的收成一行（inboxModel.splitUpcoming）。
  const ticketDetails = useControlPlaneStore((state) => state.ticketDetailsById);
  const upcomingReminders = useMemo<UpcomingReminder[]>(() => {
    const now = Date.now();
    const external = new Set(externalTimers.map((timer) => timer.ref));
    const own = agenda
      .filter((item) => item.kind === 'ticket_reminder' && item.status === 'scheduled' && item.ticketId !== null)
      .filter((item) => !external.has(`reminder:${item.ticketId}`))
      .filter((item) => {
        const at = Date.parse(item.startsAt);
        return Number.isFinite(at) && at >= now && at - now <= 24 * 60 * 60_000;
      })
      .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt))
      .slice(0, 3)
      .map((item): UpcomingReminder => ({
        id: item.ticketId!, title: item.title, at: item.startsAt,
        important: ticketDetails[item.ticketId!]?.reminder?.level === 'interrupt',
      }));
    const asked = externalTimers.map((timer): UpcomingReminder => {
      const reminderId = timer.kind === 'reminder' ? Number(timer.ref.split(':')[1]) : null;
      return {
        id: timer.ref, timerRef: timer.ref, title: timer.title, at: timer.at,
        important: reminderId !== null && ticketDetails[reminderId]?.reminder?.level === 'interrupt',
        requester: { name: timer.requester.name, sourceLabel: timer.requester.sourceLabel },
      };
    });
    return sortUpcoming([...own, ...asked, ...watchTimers.map(watchReminder)]);
  }, [agenda, externalTimers, ticketDetails, watchTimers]);
  // 取消是操作层的 timer.cancel（页面和 Lead 同一个操作），取消以后重读一次列表。
  const cancelTimer = useCallback(async (ref: string) => {
    await runtime.cancelTimer(ref);
    await loadTimers();
  }, [loadTimers, runtime]);
  // 你在收件箱那一行上做了事（动作或查看），收进那一行的通知一起确认。
  const ackNotices = (ids: readonly number[]) => {
    for (const id of ids) void runtime.ackNotification(id).catch(() => undefined);
  };
  // 工作台的面板是扫读的列表，用紧凑密度（2026-10-22）。
  return (
    <Density zone="workspace"><WorkRail
      leadName={leadName}
      fairy={fairy}
      inboxExtra={<InboxChannelCards />}
      items={items}
      projects={projects}
      projectOverviews={projectOverviews}
      onSetProjectArchived={(projectId, archived) => runtime.setProjectArchived(projectId, archived)}
      timeline={timeline}
      onUpdateMilestone={(milestoneId, patch) => runtime.updateMilestone(milestoneId, patch)}
      view={view ?? railView}
      onViewChange={(nextView) => {
        setRailView(nextView);
        // 手机上每个 tab 是一个底部导航目的地；从项目点进工单时要跟着切过去。
        if (view !== undefined) setCompactDestination(nextView);
      }}
      showViewTabs={showViewTabs}
      query={ticketQuery}
      onQueryChange={setTicketQuery}
      filter={ticketFilter}
      onFilterChange={setTicketFilter}
      ticketProject={ticketProject}
      onTicketProjectChange={setTicketProject}
      selectedTicketId={selectedTicketId}
      onSelectTicket={onSelectTicket}
      onClose={onClose}
      // 桌面上停在「连接」（app/settings/index.tsx）。
      onOpenSettings={() => router.push('/settings' as Href)}
      onCreateTask={() => {
        setComposerDraft('lead', '');
        setCompactDestination('conversation');
      }}
      onSeedTask={(draft) => {
        setComposerDraft('lead', draft);
        setCompactDestination('conversation');
      }}
      notices={notices}
      upcomingReminders={upcomingReminders}
      onCancelTimer={cancelTimer}
      inbox={inbox}
      onOpenInboxTicket={(ticketId, noticeIds) => {
        onSelectTicket(ticketId);
        ackNotices(noticeIds);
      }}
      onRunInboxAction={async (ticketId, option, noticeIds) => {
        const id = Number(ticketId);
        if (option.id === 'request_review') await runtime.requestTicketReview(id);
        else if (!isWorkspaceControlActionId(option.id)) await runtime.performTicketAction(id, option.id);
        ackNotices(noticeIds);
      }}
      onInboxSeen={() => {
        void runtime.markInboxSeen().catch(() => undefined);
      }}
      onAckNotification={(id) => {
        void runtime.ackNotification(id);
      }}
      // 「不是我」（工单 15）：网关撤销那次操作、作废凭证，并确认这条通知。失败时通知还在，可以再点。
      onDisownOwnerAction={(eventId) => {
        void runtime.disownOwnerAction(eventId).catch(() => undefined);
      }}
      onAckReminders={(reminders) => {
        void (async () => {
          for (const reminder of reminders) {
            // 提醒本身可能已经确认过（例如在对话里让 Lead 确认了）；那时动作会被拒绝，通知照样确认。
            if (reminder.ticketId !== null) {
              await runtime.performTicketAction(reminder.ticketId, 'ack').catch(() => undefined);
            }
            await runtime.ackNotification(reminder.id).catch(() => undefined);
          }
        })();
      }}
    /></Density>
  );
}
