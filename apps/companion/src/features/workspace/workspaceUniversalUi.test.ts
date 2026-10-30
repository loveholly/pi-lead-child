// @ts-ignore Vitest executes this source-boundary test in Node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

describe('workspace rail and lists', () => {
  it('builds the rail, lists and agenda from shared list rows and controls', () => {
    const ticketList = source('./TicketList.tsx');
    const workRail = source('./WorkRail.tsx');
    const projectList = source('./ProjectList.tsx');
    const agendaTimeline = source('./AgendaTimeline.tsx');

    expect(ticketList).toContain('<ListItem');
    expect(workRail).toContain('<SegmentedControl');
    expect(workRail).toContain('<Chip');
    // 工单 tab 的搜索框（左栏改版阶段 2）。
    expect(workRail).toContain('testID="ticket-search"');
    // 项目 tab 是项目卡片，卡片的内容由 buildProjectCards 算（projectModel.test.ts 直接测它）。
    expect(projectList).toContain('testID="project-list"');
    expect(projectList).toContain('buildProjectCards(overviews)');
    // 日程（阶段 3）：分区、标签、出处和一句话在纯函数 buildTimelineView 里（agendaTimeline.test.tsx 直接测它），
    // 过期和风险由服务端算（/v1/timeline）。
    expect(agendaTimeline).toContain('buildTimelineView(timeline, now, selectedDate)');
    expect(agendaTimeline).toContain('<TextField');
  });

  it('matches the prototype card based grouped ticket rail', () => {
    const ticketList = source('./TicketList.tsx');
    const workRail = source('./WorkRail.tsx');

    // 头部写 Lead 的名字和「在执行」的数；「任务线程模式」对用户没有意义，去掉了。
    expect(workRail).toContain('{leadName}</Text>');
    expect(workRail).not.toContain('Paimon');
    expect(workRail).not.toContain('任务线程模式');
    expect(ticketList).toContain('function TicketRailCard');
    expect(ticketList).toContain('<TicketRailCard');
    expect(ticketList).toContain('numberOfLines={1}');
    // 卡片：圆角 9，下间距 5，高 51；有进度条时高 71。内边距 8/10/8/13，选中时左侧 3px 色条。
    expect(ticketList).toContain('h={hasProgress ? 71 : 51}');
    expect(ticketList).toMatch(/mb="stacked-card"\s+pt="row-y"\s+pr="row-x"\s+pb="row-y"\s+pl="row-x"\s+rounded=\{9\}/);
    expect(ticketList).toContain('{selected ? <Box position="absolute" l={0} t={0} b={0} w={3}');
    // 头像 28×28；进度条高 3，轨道用 border 色（#E8EAEF）。
    expect(ticketList).toMatch(/<Avatar\s+label=\{assigned \? 'π' : '\?'\}\s+size=\{28\}/);
    expect(ticketList).toContain('<ProgressBar value={progressPercent} />');
    expect(ticketList).toContain('ticket.progressPercent');
    expect(ticketList).toContain("const hasProgress = ticket.status === 'active' && progressPercent !== undefined");
    expect(ticketList).toContain('ticket.heartbeat');
    expect(ticketList).toContain("ticket.status === 'review'");
    expect(ticketList).toContain('!ticket.needsAttention');
    expect(ticketList).not.toContain('<StatusBadge');
  });

  it('matches the prototype rail header and group density', () => {
    const ticketList = source('./TicketList.tsx');
    const workRail = source('./WorkRail.tsx');

    // 品牌行高 36；视图页签用 SegmentedControl（md 高 32，选中块带阴影）；筛选用 Chip（sm 高 27，圆角 8）。
    expect(workRail).toContain('<Row testID="work-rail-header" h={36} items="center" gap="side-item" mb="page-section">');
    expect(workRail).toMatch(/<SegmentedControl\s+options=\{RAIL_VIEWS\}/);
    expect(workRail).not.toMatch(/<SegmentedControl[^>]*size="sm"/);
    expect(workRail).not.toMatch(/<Chip[^>]*size="md"/);
    expect(ticketList).toMatch(/testID=\{`ticket-group-\$\{group\.id\}`\}[^]*?h=\{36\}/);
  });

  it('routes first-use starter commands back into the Lead draft', () => {
    const ticketList = source('./TicketList.tsx');
    const connectedRail = source('./ConnectedWorkRail.tsx');

    expect(ticketList).toContain('onSeedTask(command)');
    expect(connectedRail).toContain("setComposerDraft('lead', draft)");
    expect(connectedRail).toContain("setCompactDestination('conversation')");
  });

  it('surfaces durable notification outbox entries with an ack action', () => {
    // 通知卡在收件箱的行动队列里（InboxQueue），只在收件箱出现。
    const inboxQueue = source('./InboxQueue.tsx');
    const connectedRail = source('./ConnectedWorkRail.tsx');
    const hooks = source('../../state/hooks.ts');

    expect(inboxQueue).toContain('testID="notification-outbox"');
    expect(inboxQueue).toContain('onAckNotification?.(notification.id)');
    expect(inboxQueue).toContain('notification-ack-');
    expect(connectedRail).toContain('useNotifications');
    expect(connectedRail).toContain('runtime.ackNotification(id)');
    expect(hooks).toContain('state.notificationIds ?? EMPTY_IDS');
    expect(hooks).toContain('state.notificationsById ?? EMPTY_BY_ID');
  });

  it('surfaces the Lead delegation revoke control in the ticket info', () => {
    const ticketThread = source('../tickets/TicketThread.tsx');
    const connectedThread = source('../tickets/useTicketDetailModel.ts');

    // 工单 12：「撤销托管」放在工单信息的验收方式旁边（spec 4.3）。授权托管由 13 放进交付与验收。
    expect(ticketThread).toContain("testID: 'lead-delegation-revoke'");
    expect(ticketThread).toContain("ticket.acceptancePolicy === 'delegated_to_lead'");
    expect(connectedThread).toContain('runtime.setLeadDelegation(ticketId, granted');
  });

  // 2026-10-16 用户决定：桌面不再默认打开一张工单（原型里默认打开在做的那张）。工单详情只在用户自己打开时出现，
  // 行为见 ticketPanelUserOpen.test.tsx。
  it('does not open a ticket thread by itself on desktop', () => {
    const workbench = source('./Workbench.web.tsx');

    expect(workbench).not.toContain('preferredDesktopTicketId');
  });

  it('uses the shared centered monogram and empty state', () => {
    const ticketList = source('./TicketList.tsx');
    const workRail = source('./WorkRail.tsx');

    // 头部的 π 换成了 Lead 的形象（方案 C，2026-10-28，主题 F-4）：缺省是素材，FairyEye 是隐藏模式（leadAvatarHidden.test.tsx）。
    // EmptyState 在组件库里居中内容（packages/components/test/display.test.tsx）。
    expect(workRail).toMatch(/<LeadAvatar\s+testID="work-rail-fairy"\s+size=\{32\}/);
    expect(workRail).not.toContain('<FairyEye');
    expect(workRail).not.toContain('<Avatar label="π"');
    expect(ticketList).toContain('<EmptyState');
  });
});
