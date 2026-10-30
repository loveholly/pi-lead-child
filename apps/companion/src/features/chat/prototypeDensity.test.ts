// @ts-ignore Vitest executes source-boundary checks in Node.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatFiles = [
  'ToolCallRow.tsx',
  'CheckpointCard.tsx',
  'InterventionCard.tsx',
  'MessageComposer.tsx',
  'MessagePartView.tsx',
  'TicketExecutionCard.tsx',
  'EmbeddedTicketCard.tsx',
  'LeadConversation.tsx',
] as const;

function source(file: (typeof chatFiles)[number]): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
}

// 返回 marker 之后第一个 JSX 元素的开始标签，用来检查这个元素的布局属性。
function openingTagAfter(fileSource: string, marker: string): string {
  const start = fileSource.indexOf(marker);
  expect(start, `missing ${marker}`).toBeGreaterThanOrEqual(0);
  const match = fileSource.slice(start + marker.length).match(/<[A-Z][\w.]*\b[^]*?>/);
  expect(match, `no element after ${marker}`).not.toBeNull();
  return match?.[0] ?? '';
}

const SURFACE_PROPS = /\b(?:bg|rounded|boxShadow|borderWidth)=/;

describe('chat prototype density', () => {
  it('builds chat text and interactions from the shared components package', () => {
    for (const file of chatFiles) {
      expect(source(file), `${file} must use the components package`).toContain("from '@pi-lead-child/components'");
    }
    expect(source('MessageComposer.tsx')).toMatch(/import\s*\{[^}]*\bChatInput\b[^}]*\bIconButton\b[^}]*\}\s*from\s*'@pi-lead-child\/components'/s);
    expect(source('ToolCallRow.tsx')).toContain('<Pressable');
  });

  // 2026-10-15 用户决定（方案 A）：会话里的工单卡要紧凑，不再列这一轮的操作（英文工具名）。
  // 操作已经在消息头的工具摘要里，完整记录在工单线程里。
  it('keeps the ticket card in the conversation compact, without an operation list', () => {
    const operation = source('ToolCallRow.tsx');
    const execution = source('TicketExecutionCard.tsx');
    const embedded = source('EmbeddedTicketCard.tsx');

    expect(openingTagAfter(operation, 'return (')).not.toMatch(SURFACE_PROPS);
    expect(execution).toContain('<EmbeddedTicketCard');
    expect(execution).not.toContain('<OperationList');
    expect(execution).not.toContain('<ToolCallRow');
    expect(operation).toMatch(/<Pressable[^>]*\bh=\{38\}/s);
    expect(embedded).not.toContain('ticket.project');
    expect(embedded).not.toContain('点右侧');
    expect(embedded).toMatch(/\{children \? <Column py=\{2\}/);
    expect(execution).not.toMatch(/operation(Card|Container)|nestedCard/i);
  });

  it('uses animated icon-only execution status indicators', () => {
    const operation = source('ToolCallRow.tsx');
    const embedded = source('EmbeddedTicketCard.tsx');

    expect(embedded).not.toContain('>心跳</');
    expect(embedded).toMatch(/<Dot[^>]*\bpulse\b[^>]*testID="ticket-heartbeat-pulse"/);

    expect(operation).not.toContain('{hasDetails ? `${toolStateLabel[state]}');
    expect(operation).toContain('<Spinner testID={`tool-spinner-${tool}`}');
  });

  // 2026-10-21 用户要求：块和块之间从 20（手机 16）改成 14，用语义间距 conversation-block，手机和桌面一样。
  it('matches the conversation widths, turn grouping, and the conversation-block rhythm', () => {
    const conversation = source('LeadConversation.tsx');

    expect(conversation).toContain('<ConversationColumn gap="conversation-block">');
    expect(conversation).toContain('<Column grow={1} gap="conversation-block"');
    expect(conversation).not.toContain('gap={compact ? 16 : 20}');
    // 你的消息最宽是内容列的 70%；Lead 一侧占满内容列（ConversationColumn，2026-10-16）。
    expect(conversation).toContain("maxW: '70%'");
    expect(conversation).toContain('<ConversationColumn');
    expect(conversation).toContain(": { w: '100%' } as const)}");
    expect(conversation).toContain('cardIds={item.cardIds}');
    expect(conversation).not.toContain('onOpenThread');
    expect(conversation).not.toContain('threadButton');
  });

  // 方案 C（2026-10-28，主题 11.14）：输入框上方那一行「执行中 · 需要处理 + 工单标签」去掉了，执行中 N 挪到顶栏；
  // 要你处理的事在左栏的收件箱里。行为见 conversationTopBar.test.tsx。
  it('keeps diagnostic evidence and the running count in the top bar', () => {
    const conversation = source('LeadConversation.tsx');
    const intervention = source('InterventionCard.tsx');

    expect(conversation).toContain('buildLeadFooterItems');
    expect(conversation).toContain('const runningFooterCount = hydrated ? footerItems.filter((item) => item.tone === \'running\').length : 0');
    expect(conversation).toContain('testID="lead-running-count"');
    expect(conversation).not.toContain('attentionFooterCount');
    expect(intervention).toContain('buildInterventionEvidence');
    expect(intervention).toContain('<CheckpointEvidence');
  });

  // 2026-10-25 用户要求（参考 Kimi）：一张白色圆角卡片，浅色描边加轻微阴影；上面是文字，下面一行工具栏：
  // 左边「+」选图片，右边模型名和圆形的发送按钮。原来没有接功能的语音按钮去掉了。
  it('lays the composer out as one card: text above, a toolbar with +, the model and a round send button below', () => {
    const composer = source('MessageComposer.tsx');

    expect(composer).toMatch(/<Column\s+testID="composer"[^>]*rounded="4xl"[^>]*borderWidth=\{1\}[^>]*boxShadow=/s);
    expect(composer).toMatch(/<IconButton\s+testID="composer-attach"\s+icon="plus"\s+label="添加图片"/s);
    expect(composer).not.toContain('icon="mic"');
    expect(composer).toMatch(/testID="send-message"[^]*?rounded="full"/);
    // 模型名和推理强度由 LeadModelPicker 画（点开换模型），输入框只给它留位置。
    expect(composer).toContain('{modelControl}');
    // 工单对话坞的输入框：文字和发送按钮在一行，也是白底描边。
    expect(composer).toMatch(/if \(minimal\) \{[^]*?<Row\s+testID="composer"[^>]*borderWidth=\{1\}/);
  });

  it('keeps the typed draft local while the user is typing', () => {
    const composer = source('MessageComposer.tsx');

    expect(composer).not.toContain('useEffect');
    expect(composer).not.toContain('useWorkspaceStore');
    expect(composer).toContain('useCompanionRuntime');
    expect(composer).toContain("useState(() => workspace.getState().composerDraftByContext[contextKey] ?? '')");
    expect(composer).toContain('onBlur={() => workspace.getState().setComposerDraft(contextKey, text)}');
    expect(composer).toContain('onSend(text.trim(), images.map(');
  });

  // 会话栏是白底：进展通知铺一层浅底，但不加边框和阴影，比待处理的介入卡片轻一档。
  it('renders checkpoints as borderless tinted notices and reserves cards for pending interventions', () => {
    const checkpoint = source('CheckpointCard.tsx');
    const intervention = source('InterventionCard.tsx');
    const conversation = source('LeadConversation.tsx');

    const checkpointRoot = openingTagAfter(checkpoint, 'const model = buildCheckpointCardViewModel(checkpoint, currentTicket);');
    expect(checkpointRoot).toContain('bg="surface-subtle"');
    expect(checkpointRoot).not.toMatch(/\b(?:boxShadow|borderWidth)=/);
    expect(intervention).toContain('if (model && !model.pending)');
    // 2026-10-27 按画布重画：已解决的请求收成一行结束行（P9.4），点开在浮层里看回答；
    // 待处理的卡是白底细边框，不用整片色底和左边的色条（主题 C-18）。
    expect(intervention).toContain('<EndLine');
    expect(intervention).not.toMatch(/<Card tone="(?:danger|success)"/);
    expect(intervention).not.toMatch(/borderLeftWidth=/);
    expect(intervention).toMatch(/<Box w=\{70\} shrink=\{0\}>/);
    expect(intervention).toMatch(/<Box flex=\{1\} minW=\{0\}>\s*<Text size="code" mono tone="secondary">\{fact.value\}/);
    expect(conversation).toContain('<InterventionConversationCard card={card} compact={compact} />');
  });

  it('uses semantic flat rows for non-actionable message parts', () => {
    const messageParts = source('MessagePartView.tsx');

    expect(messageParts).toContain('function InfoRow');
    expect(messageParts).not.toContain('function InfoCard');
    expect(messageParts).toContain('<ListItem');
  });
});
