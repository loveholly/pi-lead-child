import {
  Box, Chip, Column, IconButton, LeadAvatar, Row, ScrollArea, SegmentedControl, SwitchTransition, Text, TextField,
  type FairyEyeState, type FairyEyeTone, type LeadAvatarSource,
} from '@pi-lead-child/components';
import type {
  InboxNotices, InboxView, NotificationDto, ProjectOverview, ProjectSummary, TimelineResponse,
} from '@pi-lead-child/protocol';

import { leadAvatarSource } from '@/components/leadAvatarSource';
import type { TicketOptionPresentation } from '@/features/tickets/ticketState';
import { useLocale, useMessages } from '@/i18n';
import { leadNameNow } from '@/state/leadName';
import { useDeferredValue, useState, type ReactNode } from 'react';

import { AgendaTimeline, type AgendaEntryPatch, type MilestonePatch } from './AgendaTimeline';
import { InboxQueue, type UpcomingReminder } from './InboxQueue';
import {
  buildTicketRailPresentation,
  projectDisplayName,
  resolveRailViewDirection,
  ticketRailFilters,
  type RailView,
  type RailViewDirection,
  type Ticket,
  type TicketFilter,
  type TicketProjectScope,
} from './model';
import { ProjectList } from './ProjectList';
import { railMessages } from './rail.messages';
import { TicketList } from './TicketList';

const RAIL_VIEWS: readonly RailView[] = ['inbox', 'tickets', 'projects', 'agenda'];

type WorkRailProps = {
  selectedTicketId: string | null;
  onSelectTicket: (id: string) => void;
  onClose?: () => void;
  onCreateTask?: () => void;
  // 头部右边的齿轮：打开设置。不给就不显示齿轮。
  onOpenSettings?: () => void;
  items?: Ticket[];
  projects?: ProjectSummary[];
  // 项目卡片（GET /v1/projects/overview），含归档的项目。还没取到时为 null。
  projectOverviews?: ProjectOverview[] | null;
  onSetProjectArchived?: (projectId: number, archived: boolean) => Promise<void>;
  // 日程（GET /v1/timeline）。还没取到时为 null。
  timeline?: TimelineResponse | null;
  onUpdateMilestone?: (milestoneId: number, patch: MilestonePatch) => Promise<void>;
  onUpdateAgendaEntry?: (entryId: number, patch: AgendaEntryPatch) => Promise<void>;
  loading?: boolean;
  view?: RailView;
  onViewChange?: (view: RailView) => void;
  filter?: TicketFilter;
  onFilterChange?: (filter: TicketFilter) => void;
  query?: string;
  onQueryChange?: (query: string) => void;
  // 工单 tab 只看这个项目（项目名）。从项目 tab 点进来时设置。
  ticketProject?: string | null;
  onTicketProjectChange?: (project: string | null) => void;
  onSeedTask?: (draft: string) => void;
  // 停太久的暂停工单在工单行上直接继续、取消（工单 #111）。
  onResumeTicket?: (ticket: Ticket) => Promise<unknown>;
  onCancelTicket?: (ticket: Ticket) => Promise<unknown>;
  showViewTabs?: boolean;
  // 收件箱里单独露出来的通知（protocol 的 inboxNotices）。只在收件箱渲染。
  notices?: InboxNotices;
  onAckNotification?: (id: number) => void;
  onAckReminders?: (notices: NotificationDto[]) => void;
  // 还在等的提醒（工单 07）：「待你」托盘里列出接下来的几条，到点前一直在。
  upcomingReminders?: readonly UpcomingReminder[];
  /** 取消外部的人要求设的定时器（spec D16，工单 12）。 */
  onCancelTimer?: (ref: string) => Promise<void>;
  // 主人操作的提醒上的「不是我」（工单 15）。
  onDisownOwnerAction?: (eventId: string, notificationId: number) => void;
  // 收件箱的服务端事实（GET /v1/inbox）和卡片上的动作。
  inbox?: InboxView | null;
  onRunInboxAction?: (ticketId: string, option: TicketOptionPresentation, noticeIds: number[]) => Promise<void>;
  onOpenInboxTicket?: (ticketId: string, noticeIds: number[]) => void;
  onInboxSeen?: () => void;
  // 收件箱里接在「需要你」后面的部分（ConnectedWorkRail 放「外部消息」的通道卡）。
  inboxExtra?: ReactNode;
  // Lead 的名字（useLeadName）：头部和收件箱「已处理」用它。不给时读最近一次取到的名字。
  leadName?: string;
  // 头部的形象（主题 F-4）：忙的时候在想；离线、降级时用离线的图，下面一行改写说明（不写 Run 的数）。
  // source 是形象从哪来（components/leadAvatarSource）；不给时用系统素材。不给 fairy 时形象待机，下面一行写 Run 的数。
  fairy?: { state: FairyEyeState; tone: FairyEyeTone; note: string | null; source?: LeadAvatarSource };
};

const EMPTY_NOTICES: InboxNotices = { general: [], reminders: [], byTicket: {} };

export function WorkRail({
  selectedTicketId,
  onSelectTicket,
  onCreateTask,
  onOpenSettings,
  items = [],
  projects = [],
  projectOverviews = null,
  onSetProjectArchived,
  timeline = null,
  onUpdateMilestone,
  onUpdateAgendaEntry,
  loading = false,
  view: controlledView,
  onViewChange,
  filter: controlledFilter,
  onFilterChange,
  query: controlledQuery,
  onQueryChange,
  ticketProject: controlledTicketProject,
  onTicketProjectChange,
  onSeedTask,
  onResumeTicket,
  onCancelTicket,
  showViewTabs = true,
  notices = EMPTY_NOTICES,
  onAckNotification,
  onAckReminders,
  upcomingReminders,
  onCancelTimer,
  onDisownOwnerAction,
  inbox = null,
  onRunInboxAction,
  onOpenInboxTicket,
  onInboxSeen,
  inboxExtra,
  leadName = leadNameNow(),
  fairy,
}: WorkRailProps) {
  const m = useMessages(railMessages);
  const locale = useLocale();
  const railViews = RAIL_VIEWS.map((value) => ({ value, label: m.views[value] }));
  const [localView, setLocalView] = useState<RailView>('tickets');
  const [localFilter, setLocalFilter] = useState<TicketFilter>('all');
  const [localQuery, setLocalQuery] = useState('');
  const [localTicketProject, setLocalTicketProject] = useState<string | null>(null);
  const [viewDirection, setViewDirection] = useState<RailViewDirection>('none');
  const view = controlledView ?? localView;
  const filter = controlledFilter ?? localFilter;
  const query = controlledQuery ?? localQuery;
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const ticketProject = controlledTicketProject === undefined ? localTicketProject : controlledTicketProject;
  // 项目卡片里有归档的项目；它们的工单不算「未归属」，和服务端一致。
  const knownProjectNames = (projectOverviews ?? projects).map((project) => project.name);
  const projectScope: TicketProjectScope | null = ticketProject
    ? { name: ticketProject, knownNames: knownProjectNames }
    : null;
  const ticketProjection = buildTicketRailPresentation(items, { filter, query: deferredQuery, loading, project: projectScope, locale });

  const selectView = (nextView: RailView) => {
    const direction = resolveRailViewDirection(view, nextView);
    if (direction === 'none') return;
    setViewDirection(direction);
    if (controlledView === undefined) setLocalView(nextView);
    onViewChange?.(nextView);
  };

  const selectFilter = (nextFilter: TicketFilter) => {
    if (controlledFilter === undefined) setLocalFilter(nextFilter);
    onFilterChange?.(nextFilter);
  };

  const changeQuery = (nextQuery: string) => {
    if (controlledQuery === undefined) setLocalQuery(nextQuery);
    onQueryChange?.(nextQuery);
  };

  const changeTicketProject = (nextProject: string | null) => {
    if (controlledTicketProject === undefined) setLocalTicketProject(nextProject);
    onTicketProjectChange?.(nextProject);
  };

  const clearFilters = () => {
    selectFilter('all');
    changeQuery('');
    changeTicketProject(null);
  };

  // 点一个项目：工单 tab 只列这个项目的工单，筛选回到「全部」。
  const openProject = (name: string) => {
    changeTicketProject(name);
    selectFilter('all');
    selectView('tickets');
  };

  // 头部的「在执行」和工单 tab、会话底栏是同一个数（ticketTurn）。
  const runningCount = items.filter((ticket) => ticket.turn === 'running').length;

  return (
    <Column testID="work-rail" flex={1} bg="surface">
      <Column px="page-x" pt="page-top" pb="page-section">
        {/* 手机上没有头部：底部导航已经说明了位置（showViewTabs 只在窄屏关掉）。 */}
        {showViewTabs ? (
          <Row testID="work-rail-header" h={36} items="center" gap="side-item" mb="page-section">
            {/* Lead 的形象（方案 C，主题 F-4）：整体状态在这里，忙的时候在想，状态由形象和无障碍标签表达。 */}
            <LeadAvatar
              testID="work-rail-fairy"
              size={32}
              name={leadName}
              state={fairy?.state ?? 'idle'}
              tone={fairy?.tone ?? 'color'}
              source={fairy?.source ?? leadAvatarSource(null, {}, { state: fairy?.state ?? 'idle', tone: fairy?.tone ?? 'color' })}
            />
            <Column gap="text-stack" flex={1} minW={0}>
              <Text size="card-title" weight="extrabold">{leadName}</Text>
              <Text size="secondary" tone="muted" numberOfLines={1}>
                {fairy?.note ?? (runningCount > 0 ? m.runsRunning(runningCount) : m.noRunsRunning)}
              </Text>
            </Column>
            {onOpenSettings ? (
              <IconButton
                testID="open-settings"
                icon="settings"
                label={m.settings}
                variant="ghost"
                size="sm"
                rounded="md"
                iconSize={18}
                iconColor="text-secondary"
                onPress={onOpenSettings}
              />
            ) : null}
          </Row>
        ) : null}
        {showViewTabs ? (
          <Box mb="card-row">
            <SegmentedControl
              options={railViews}
              value={view}
              onChange={selectView}
              optionTestID={(item) => `rail-view-${item}`}
            />
          </Box>
        ) : null}
        {view === 'tickets' ? (
          <Box mb="card-row">
            <TextField
              testID="ticket-search"
              value={query}
              onChangeText={changeQuery}
              placeholder={m.searchPlaceholder}
              variant="filled"
              size="sm"
              returnKeyType="search"
              accessibilityLabel={m.searchLabel}
            />
          </Box>
        ) : null}
        {view === 'tickets' && ticketProject ? (
          <Row mb="card-row">
            <Chip
              testID="ticket-project-clear"
              label={`${projectDisplayName(ticketProject, locale)} ×`}
              selected
              onPress={() => changeTicketProject(null)}
            />
          </Row>
        ) : null}
        {view === 'tickets' ? (
          // 六个筛选在窄栏里放不下：横向滑动，不换行，数字变了这一行的高度也不变（工单 #111）。
          <ScrollArea horizontal flex={0} testID="ticket-filters">
            <Row items="center" gap="chips">
              {ticketRailFilters(locale).map((item) => (
                <Chip
                  key={item.id}
                  testID={`ticket-filter-${item.id}`}
                  label={item.label}
                  count={ticketProjection.filterCounts[item.id]}
                  selected={filter === item.id}
                  onPress={() => selectFilter(item.id)}
                />
              ))}
            </Row>
          </ScrollArea>
        ) : null}
      </Column>
      <SwitchTransition transitionKey={view} direction={viewDirection}>
        <ScrollArea bg="surface-sunken" fillContent>
          <Column flex={1} px="page-x" pt="stacked-card" pb="page-section">
            {view === 'inbox' ? (
              <InboxQueue
                items={items}
                inbox={inbox}
                notices={notices}
                onOpenTicket={(ticketId, noticeIds) => {
                  if (onOpenInboxTicket) onOpenInboxTicket(ticketId, noticeIds);
                  else onSelectTicket(ticketId);
                }}
                onRunAction={onRunInboxAction ?? (() => Promise.resolve())}
                onAckNotification={onAckNotification}
                onAckReminders={onAckReminders}
                upcomingReminders={upcomingReminders}
          onCancelTimer={onCancelTimer}
                onDisownOwnerAction={onDisownOwnerAction}
                onSeen={onInboxSeen}
                leadName={leadName}
              />
            ) : null}
            {view === 'inbox' ? inboxExtra : null}
            {view === 'tickets' ? (
              <TicketList
                items={items}
                selectedTicketId={selectedTicketId}
                onSelect={onSelectTicket}
                grouped
                filter={filter}
                query={deferredQuery}
                loading={loading}
                onCreateTask={onCreateTask}
                onClearFilters={clearFilters}
                onSeedTask={onSeedTask}
                project={projectScope}
                onResumeTicket={onResumeTicket}
                onCancelTicket={onCancelTicket}
              />
            ) : null}
            {view === 'projects' ? (
              <ProjectList overviews={projectOverviews} onSelect={openProject} onSetArchived={onSetProjectArchived} />
            ) : null}
            {view === 'agenda' ? (
              <AgendaTimeline
                timeline={timeline}
                onOpenTicket={(ticketId) => onSelectTicket(String(ticketId))}
                onUpdateMilestone={onUpdateMilestone}
                onUpdateAgendaEntry={onUpdateAgendaEntry}
              />
            ) : null}
          </Column>
        </ScrollArea>
      </SwitchTransition>
    </Column>
  );
}
