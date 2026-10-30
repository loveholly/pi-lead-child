// @ts-ignore Vitest executes this source-boundary test in Node.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function source(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8');
}

// 这些视图用哪个组件库，由 src/uiBoundary.test.ts 统一检查。这里检查工单详情的接线、testID 和原型尺寸。
describe('ticket detail components', () => {
  it('uses list rows, text fields and tabs from the components package', () => {
    const thread = source('./TicketThread.tsx');
    const checkpoints = source('./CheckpointFeed.tsx');
    const artifacts = source('./ArtifactList.tsx');
    const intervention = source('./InterventionPanel.tsx');

    // 页签在「证据与记录」里（方案 D）：验收、进展、Run、生命周期、产物。
    const records = source('./TicketRecords.tsx');
    expect.soft(thread).not.toContain('<SegmentedControl');
    expect.soft(records).toContain('<SegmentedControl');
    expect.soft(records).toContain('testID="ticket-records-tabs"');
    expect.soft(checkpoints).toContain('<ListItem');
    expect.soft(artifacts).toContain('<ListItem');
    expect.soft(intervention).toContain('<TextField');
  });

  it('renders lifecycle, attempts, empty execution and grouped structured relations', () => {
    const connected = source('./useTicketDetailModel.ts');
    const history = source('./TicketHistorySections.tsx');
    const presentation = source('./ticketHistory.ts');

    const records = source('./TicketRecords.tsx');
    // 生命周期、执行尝试和运行日志在「完整记录」里（工单 12：工单详情的关系那一块自己画）。
    expect.soft(records).toMatch(/sections=\{\['attempts'\]\}/);
    expect.soft(records).toMatch(/sections=\{\['lifecycle'\]\}/);
    expect.soft(records).toContain('title="运行日志"');
    expect.soft(history).toContain('ticket-history-retry');
    expect.soft(history).toContain('历史读取失败');
    expect.soft(connected).toContain('useTicketExecution(ticketId)');
    expect.soft(connected).toContain('useTicketDetail(ticketId)');
    expect.soft(connected).toContain('const logAttemptIds = useMemo(() => attempts.map((attempt) => attempt.id), [attempts])');
    expect.soft(connected).toContain('useAttemptLogsByAttempt(logAttemptIds)');
    expect.soft(connected).toContain('buildTicketLogPresentation(logsByAttemptId[attempt.id] ?? [])');
    expect.soft(records).toContain('<RunLogGroups runs={logRuns} />');
    expect.soft(records).toContain('logRuns.length > 1');
    expect.soft(history).toContain('生命周期');
    expect.soft(history).toContain('执行尝试');
    expect.soft(history).toContain('尚未执行');
    expect.soft(history).toContain('工单关系');
    expect.soft(history).toContain('ticket-relation-create-toggle');
    expect.soft(history).toContain('ticket-relation-create-submit');
    expect.soft(history).toContain('ticket-relation-revoke-submit');
    expect.soft(history).toContain("type: 'depends_on'");
    expect.soft(history).toContain("type: 'implements'");
    expect.soft(history).toContain("type: 'duplicates'");
    expect.soft(history).toContain("type: 'supersedes'");
    expect.soft(history).toContain("type: 'relates_to'");
    expect.soft(history).toContain('高影响关系会改变调度、canonical 或有效事项判断');
    // 关联工单走工单操作 link（工单 03），和 Lead 的 ticket_action 是同一个函数。
    expect.soft(connected).toContain('runtime.runTicketAction(ticketId, action, request)');
    expect.soft(presentation).toContain('关系账本');
    expect.soft(presentation).toContain('已撤销');
    expect.soft(history).toContain('展开失败详情');
  });

  it('does not wrap approval controls in extra button roles', () => {
    const intervention = source('./InterventionPanel.tsx');

    expect.soft(intervention).toContain('<Button');
    expect.soft(intervention).toContain('testID={`intervention-action-${action.id}`}');
    expect.soft(intervention).not.toContain('accessibilityRole="button"');
    expect.soft(intervention).not.toContain('role="button"');
  });

  it('keeps artifact downloads and log expansion wired', () => {
    const artifacts = source('./ArtifactList.tsx');
    const logs = source('./LogTimeline.tsx');

    expect.soft(artifacts).toMatch(/leading=\{\(\s*<Box w=\{36\} h=\{36\}/);
    expect.soft(artifacts).toContain("artifact.availability === 'available'");
    expect.soft(artifacts).toContain("state?.state === 'downloading'");
    expect.soft(artifacts).toContain("state?.state === 'error'");
    expect.soft(logs).toContain('bg="border-soft"');
    expect.soft(logs).toContain('ticket-log-toggle-');
    expect.soft(logs).toContain('log.expandLabel');
    // 展开的日志详情按内容定高，超过 420 后在内部滚动。
    expect.soft(logs).toContain('<ScrollArea flex={0} maxH={420} nested>');
  });

  it('keeps checkpoint rows free of the old string leading and trailing slots', () => {
    const checkpoints = source('./CheckpointFeed.tsx');
    const artifacts = source('./ArtifactList.tsx');

    expect.soft(checkpoints).not.toContain("leading={checkpoint.source === 'system_derived' ? 'S' : 'π'}");
    expect.soft(checkpoints).not.toContain('trailing={localTime(checkpoint.createdAt)}');
    expect.soft(artifacts).not.toContain('trailing={label}');
  });

  // 工单 12：工单详情只用组件库的组件拼（spec 5.12），按钮能不能点只看操作清单（spec 5.11）。
  it('composes the ticket detail from the components package and the action list', () => {
    const thread = source('./TicketThread.tsx');
    const model = source('./useTicketDetailModel.ts');

    for (const component of ['<DetailHeader', '<Section', '<RecordRow', '<Checklist', '<ActionBar', '<Steps', '<Stats', '<Timeline', '<FactList']) {
      expect.soft(thread).toContain(component);
    }
    // 不再按 protocol 的矩阵和工作区的 availableActions 摆按钮：那是和 Lead 的 list_ticket_actions 不同的另一套判断。
    expect.soft(thread).not.toContain('availableActions');
    expect.soft(thread).not.toContain('userItemActionsFor');
    expect.soft(thread).not.toContain('buildTicketActionPresentation');
    expect.soft(model).toContain('useTicketActions(ticketId)');
    // 旧接口只留给还不在清单里的 4 个操作（legacyTicketActions.ts），只在 runLegacyOperation 里调一次。
    expect.soft(model.match(/runtime\.performTicketAction\(/g)?.length).toBe(1);
    expect.soft(model).toMatch(/const runLegacyOperation = async[\s\S]*?runtime\.performTicketAction\(/);
    expect.soft(thread).not.toContain('ticketDecisionActions');
    // 页面文件里不另写样式：间距只用语义 token，字号只用语义字号。
    expect.soft(thread).not.toMatch(/\b(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap)=\{\d/);
    expect.soft(thread).not.toMatch(/size="\d/);
    expect.soft(thread).not.toMatch(/leading=\{/);
    // 去掉了「这张工单」这一层标题。
    expect.soft(thread).not.toContain('这张工单"');
  });

  it('pins the header above the sections and the action bar with the chat dock below them', () => {
    const thread = source('./TicketThread.tsx');

    // 头部在滚动区外；各块在滚动区里；底部操作栏和工单对话坞在滚动区下面（第四轮画板）。
    expect.soft(thread).toMatch(
      /\{header\}[\s\S]*?<DockedLayout[\s\S]*?<TicketChatDock[\s\S]*?bar=\{actionBar\}[\s\S]*?\{recordsInline \? \([\s\S]*?<TicketRecords[\s\S]*?<ScrollArea testID="ticket-thread-scroll"[\s\S]*?<\/ScrollArea>\s*\)\}\s*<\/DockedLayout>/,
    );
    expect.soft(thread).toContain('const showTicketComposer = showComposer ?? true');
    expect.soft(source('./TicketRecords.tsx')).not.toContain('nested');
  });

  it('keeps proof status compact and never reclassifies a failure as an environment limit', () => {
    const pow = source('./PowPanel.tsx');
    const evidence = source('./ticketEvidence.ts');
    const thread = source('./TicketThread.tsx');

    expect.soft(pow).not.toContain('<ListItem');
    expect.soft(pow).not.toContain('trailing=');
    expect.soft(pow).toMatch(/<Row\s+minH=\{48\}/);
    expect.soft(pow).toMatch(/<Box w=\{20\} h=\{20\}/);
    expect.soft(pow).not.toContain("label: '能力覆盖'");
    expect.soft(pow).not.toContain("label: '发现缺口'");
    expect.soft(pow).not.toContain("label: '耗时'");
    expect.soft(pow).toContain('buildEvidencePresentation(pow, outcome)');
    expect.soft(pow).toContain('testID="pow-history"');
    // F7：不再用正则把 agent 的借口改判成"环境限制"。
    expect.soft(pow).not.toContain('EPERM');
    expect.soft(evidence).not.toContain('EPERM|');
    expect.soft(evidence).not.toContain('环境限制');
    expect.soft(evidence).toContain('项待补证据');
    expect.soft(pow).not.toContain('项待你处理');
    // 工具调用次数对验收没有帮助，挪到日志页签的标题里。
    expect.soft(pow).not.toContain('>工具调用</Text>');
    expect.soft(source('./TicketRecords.tsx')).toContain('次工具调用');
  });

  it('matches the prototype artifact cards and 22px timelines', () => {
    const artifacts = source('./ArtifactList.tsx');
    const logs = source('./LogTimeline.tsx');
    const timeline = source('./TimelineRow.tsx');

    expect.soft(artifacts).toContain('<Column testID="artifact-list" gap="stacked-card">');
    // Card 的缺省圆角是 xl（12）。产物卡片不加底部分隔线。
    expect.soft(artifacts).toMatch(/<Card\s+key=\{artifact\.id\}/);
    expect.soft(artifacts).not.toMatch(/<Card[^>]*\brounded=/);
    expect.soft(artifacts).not.toContain('borderBottomWidth');

    for (const component of [logs, timeline]) {
      expect.soft(component).toMatch(/<Column w=\{22\} items="center">\s*<Box\s+w=\{22\}\s+h=\{22\}/);
      expect.soft(component).toMatch(/<Box flex=\{1\} w=\{2\} mt=\{4\} bg="border-soft" \/>/);
      expect.soft(component).toContain('<Badge');
    }
    expect.soft(logs).toContain('<Box minW={42}>');
  });

  it('keeps checkpoint history flat and dense', () => {
    const checkpoints = source('./CheckpointFeed.tsx');

    // F17：时间跨天时带日期。24 小时制和日期写法由 timeLabels.test.ts 保证。
    expect.soft(checkpoints).toContain('timeLabel(checkpoint.createdAt)');
    expect.soft(checkpoints).toMatch(/<Column\s+key=\{checkpoint\.id\}\s+pb="stacked-card"\s+borderBottomWidth=\{1\}/);
    expect.soft(checkpoints).not.toMatch(/<Column\s+key=\{checkpoint\.id\}[^>]*\b(?:rounded|boxShadow|bg)=/);
    expect.soft(checkpoints).not.toContain('checkpointCard');
    // F14：只有当前的阻塞才画红条。
    expect.soft(checkpoints).toContain("checkpoint.kind === 'blocked' && !checkpoint.historical");
  });

  it('expands the selected ticket group so an open cancelled ticket remains discoverable', () => {
    const ticketList = source('../workspace/TicketList.tsx');
    expect(ticketList).toContain('const selectedGroup = groupForTicket(selected)');
    expect(ticketList).toContain('next.delete(selectedGroup)');
  });
});
