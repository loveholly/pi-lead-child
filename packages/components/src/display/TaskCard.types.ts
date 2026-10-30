import type { ReactNode } from 'react';

// 任务卡：一轮助手回复的工作步骤，仿 Slack 的 agent 任务卡。web 和原生用同一份 props。
//
// 收起时只有一行：
// - thinking：模型在生成，没有工具在跑。转圈和 "Thinking"。
// - working：有工具在跑。转圈、工具名和缩写后的参数，例如 query_tickets · stage=review。
// - done：这一轮结束了。对勾和摘要，例如 10 个工具 · 12 秒。
// - failed：这一轮失败了。错误图标和摘要。
// 展开后是一条时间线：每一步是一次工具调用或工具之间说的话。连续调用同一个工具合成一步（query_tickets ×6），
// 这一步再展开是各次调用；一次调用展开是完整的参数和结果。
export type TaskCardStatus = 'thinking' | 'working' | 'done' | 'failed';

// stopped：这一轮已经结束，这次调用却没有报告结束（没有完成，也说不上失败）。
export type TaskStepState = 'running' | 'done' | 'failed' | 'stopped';

// 工具之间说的话（例如「我先去查一下。」）。
export type TaskCardNote = {
  kind: 'note';
  id: string;
  text: string;
};

// 一次工具调用。args 和 result 是展示文本，通常是 JSON；卡片负责缩写和格式化。
// 传进来之前必须已经脱敏（protocol 的 projectToolDisplay）：卡片原样显示，不再自己判断密钥。
export type TaskCardTool = {
  kind: 'tool';
  id: string;
  name: string;
  state: TaskStepState;
  args: string | null;
  result: string | null;
  error: string | null;
  // 上游已经截断了参数或结果。
  truncated?: boolean;
};

export type TaskCardStep = TaskCardNote | TaskCardTool;

export type TaskCardProps = {
  status: TaskCardStatus;
  steps: readonly TaskCardStep[];
  // 这些步骤用了多久（毫秒）。done 和 failed 的摘要里显示。
  durationMs?: number | null;
  // 卡片是否展开。给了就由调用方保存（例如页面上的状态），不给时卡片自己记。
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  // 展开的步骤：一次调用的 id，或一组调用的 id（group:<第一次调用的 id>）。不给时卡片自己记。
  expandedStepIds?: readonly string[];
  onStepExpandedChange?: (stepId: string, expanded: boolean) => void;
  // card：独立的一张卡（默认）。inline：并进消息头，写成灰色小字，leading 是它前面的发送者和时间；
  // 展开的时间线排在消息头下面（2026-10-15 方案 A）。
  variant?: 'card' | 'inline';
  leading?: string;
  // inline 时排在 leading 前面的标记，例如消息头的 Fairy（主题 F-5）。给了它，在跑时摘要前面不再画小转圈：
  // 标记自己表示还在跑（Fairy 的呼吸）。
  leadingMark?: ReactNode;
  testID?: string;
};
