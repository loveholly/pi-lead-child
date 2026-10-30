// 工单 #66 的真实活动流和 Run（2026-10-15 从实例只读取出，只保留界面用到的字段）。
// runFacts、经过等视图模型的回归测试共用这一份。时间是数据库里的 UTC。
import type { ActivityDto } from '@pi-lead-child/protocol';

import type { AttemptEntity } from '@/state/types';

export type FixtureAttempt = Pick<
  AttemptEntity,
  'id' | 'role' | 'purpose' | 'state' | 'exitCode' | 'runtime' | 'model' | 'startedAt' | 'endedAt'
>;
export type FixtureActivity = Pick<ActivityDto, 'id' | 'actor' | 'kind' | 'attemptId' | 'payload' | 'createdAt'>;

function run(
  id: number,
  role: FixtureAttempt['role'],
  purpose: NonNullable<FixtureAttempt['purpose']>,
  state: FixtureAttempt['state'],
  exitCode: number | null,
  runtime: NonNullable<FixtureAttempt['runtime']>,
  startedAt: string,
  endedAt: string | null,
): FixtureAttempt {
  return {
    id, role, purpose, state, exitCode, runtime,
    model: runtime === 'codex' ? 'gpt-5.5' : null,
    startedAt: `${startedAt.replace(' ', 'T')}.000Z`,
    endedAt: endedAt ? `${endedAt.replace(' ', 'T')}.000Z` : null,
  };
}

export const TICKET_66_CREATED = { at: '2026-08-17T06:11:15.000Z', by: 'user' as const };

export const TICKET_66_ATTEMPTS: FixtureAttempt[] = [
  run(42, 'executor', 'execution', 'settled', 0, 'codex', '2026-08-17 10:41:54', '2026-08-17 11:02:24'),
  run(43, 'reviewer', 'review', 'settled', 0, 'codex', '2026-08-17 11:20:26', '2026-08-17 11:27:54'),
  run(44, 'executor', 'execution', 'crashed', null, 'codex', '2026-08-19 09:41:46', '2026-08-19 09:42:01'),
  run(45, 'executor', 'execution', 'stopped', null, 'codex', '2026-08-21 08:10:37', '2026-08-21 08:25:14'),
  run(46, 'executor', 'execution', 'crashed', 1, 'claude', '2026-08-21 08:26:36', '2026-08-21 08:26:40'),
  run(47, 'executor', 'execution', 'crashed', 1, 'claude', '2026-08-21 08:59:12', '2026-08-21 08:59:15'),
  run(48, 'executor', 'execution', 'settled', 0, 'claude', '2026-08-21 09:12:06', '2026-08-21 09:17:54'),
  run(49, 'executor', 'execution', 'settled', 0, 'claude', '2026-08-21 10:27:45', '2026-08-21 10:48:04'),
  run(50, 'executor', 'conversation', 'settled', 0, 'claude', '2026-08-21 10:49:24', '2026-08-21 10:50:07'),
  run(51, 'executor', 'conversation', 'settled', 0, 'claude', '2026-08-21 10:51:53', '2026-08-21 10:57:31'),
  run(71, 'executor', 'conversation', 'crashed', 1, 'claude', '2026-10-13 11:07:38', '2026-10-13 11:07:42'),
  run(72, 'executor', 'conversation', 'settled', 0, 'claude', '2026-10-14 09:57:07', '2026-10-14 09:58:43'),
  run(73, 'reviewer', 'review', 'crashed', null, 'codex', '2026-10-14 10:10:54', '2026-10-14 16:41:11'),
  run(74, 'reviewer', 'review', 'starting', null, 'codex', '2026-10-14 16:42:12', null),
];

const REVIEW_43_REPORT = '独立核查 FAIL。关键证据：1) `npm test` 全量根测试 exit 1，154 files passed、1 failed；'
  + '失败为 `test/checkpoint-control-plane-e2e.test.ts > persists resources and repairs crash/startup state exactly once across real daemon restarts`，line 783。'
  + '2) 当前 PLC_DB 中 `outcome_snapshots` 对 item_id=66 无行。';

function act(
  id: number,
  attemptId: number | null,
  actor: FixtureActivity['actor'],
  kind: FixtureActivity['kind'],
  createdAt: string,
  payload: Record<string, unknown>,
): FixtureActivity {
  return { id, attemptId, actor, kind, createdAt: `${createdAt.replace(' ', 'T')}.000Z`, payload };
}

export const TICKET_66_ACTIVITIES: FixtureActivity[] = [
  act(367, null, 'user', 'decision', '2026-08-17 06:11:16', { decision: 'link_ticket_relation', relationType: 'implements', targetTicketId: 45 }),
  act(420, null, 'system', 'decision', '2026-08-17 10:00:51', { decision: 'relation_execution_gate_migrated' }),
  act(422, null, 'system', 'transition', '2026-08-17 10:41:54', { from: 'ready', to: 'active', reason: 'spawn_child' }),
  act(424, null, 'user', 'decision', '2026-08-17 10:41:54', { decision: '开始执行' }),
  act(429, 42, 'child', 'transition', '2026-08-17 11:01:46', { from: 'active', to: 'review', reason: 'Implementation complete; independent review requested' }),
  act(435, 43, 'system', 'decision', '2026-08-17 11:27:37', { decision: 'review_verdict_waiting_user', verdict: 'fail', reason: 'Rework policy is ask_user; user decision is required.', reviewerRunId: 43, reviewerReport: REVIEW_43_REPORT }),
  act(437, null, 'lead', 'decision', '2026-08-17 11:28:08', { decision: '独立验收不通过，等待用户决定返工' }),
  act(462, null, 'user', 'decision', '2026-08-19 09:41:45', { decision: 'delegation_preflight_accepted', policyId: 1 }),
  act(463, null, 'user', 'transition', '2026-08-19 09:41:45', { from: 'review', to: 'active', reason: '用户授权 Lead 自动返工并启动本次修复' }),
  act(464, null, 'system', 'decision', '2026-08-19 09:41:45', { decision: 'dispatch_requested', role: 'executor', purpose: 'execution' }),
  act(465, null, 'user', 'decision', '2026-08-19 09:41:45', { decision: 'rework_dispatch_requested', reviewerRunId: 43, reviewerVerdict: 'fail', reviewerReport: REVIEW_43_REPORT }),
  act(468, 44, 'system', 'crash', '2026-08-19 09:42:01', { exitCode: null, reason: 'Selected model is at capacity. Please try a different model.', errorCode: 'codex_error' }),
  act(469, 44, 'system', 'transition', '2026-08-19 09:42:01', { from: 'active', to: 'blocked', reason: 'Selected model is at capacity. Please try a different model.' }),
  act(470, 44, 'system', 'notification', '2026-08-19 09:42:01', { kind: 'blocked', title: 'Run crashed' }),
  act(472, null, 'system', 'transition', '2026-08-21 08:10:37', { from: 'blocked', to: 'active', reason: 'retry run' }),
  act(474, null, 'user', 'decision', '2026-08-21 08:10:37', { decision: '开始执行' }),
  act(477, 45, 'user', 'decision', '2026-08-21 08:25:14', { decision: '停止执行', reason: '用户要求将工单 #66 的执行 agent 切换到 Claude Code' }),
  act(479, null, 'user', 'decision', '2026-08-21 08:26:36', { decision: 'ticket_runtime_switched', fromRuntime: 'codex', toRuntime: 'claude', previousRunId: 45 }),
  act(481, null, 'user', 'decision', '2026-08-21 08:26:36', { decision: '开始执行' }),
  act(483, 46, 'system', 'crash', '2026-08-21 08:26:40', { exitCode: 1, reason: 'Failed to authenticate: OAuth session expired and could not be refreshed', errorCode: 'claude_success' }),
  act(484, 46, 'system', 'transition', '2026-08-21 08:26:40', { from: 'active', to: 'blocked', reason: 'Failed to authenticate: OAuth session expired and could not be refreshed' }),
  act(487, null, 'system', 'transition', '2026-08-21 08:59:12', { from: 'blocked', to: 'active', reason: 'retry run' }),
  act(489, null, 'user', 'decision', '2026-08-21 08:59:12', { decision: '开始执行' }),
  act(491, 47, 'system', 'crash', '2026-08-21 08:59:15', { exitCode: 1, reason: 'Failed to authenticate: OAuth session expired and could not be refreshed', errorCode: 'claude_success' }),
  act(492, 47, 'system', 'transition', '2026-08-21 08:59:15', { from: 'active', to: 'blocked', reason: 'Failed to authenticate: OAuth session expired and could not be refreshed' }),
  act(493, 47, 'system', 'decision', '2026-08-21 08:59:15', { decision: 'runtime_failure_classified', category: 'authentication', recoverable: true }),
  act(496, null, 'system', 'transition', '2026-08-21 09:12:06', { from: 'blocked', to: 'active', reason: 'retry run' }),
  act(498, null, 'user', 'decision', '2026-08-21 09:12:06', { decision: '开始执行' }),
  act(500, 48, 'system', 'transition', '2026-08-21 09:17:54', { from: 'active', to: 'blocked', reason: 'run ended without terminal handoff' }),
  act(501, 48, 'system', 'notification', '2026-08-21 09:17:54', { kind: 'blocked', title: '运行结束，交接失败' }),
  act(503, null, 'system', 'transition', '2026-08-21 10:27:45', { from: 'blocked', to: 'active', reason: 'retry run' }),
  act(505, null, 'user', 'decision', '2026-08-21 10:27:45', { decision: '开始执行' }),
  act(507, 49, 'system', 'transition', '2026-08-21 10:48:04', { from: 'active', to: 'review', reason: 'recovered outcome snapshot from successful runtime output' }),
  act(715, null, 'system', 'decision', '2026-10-13 10:59:29', { decision: 'rework_grant_attributed' }),
  act(716, null, 'system', 'decision', '2026-10-13 10:59:29', { decision: 'spurious_outcome_record_removed', runId: 48 }),
  act(723, 71, 'system', 'crash', '2026-10-13 11:07:42', { exitCode: 1, reason: 'No conversation found with session ID: 20fd5938-01a7-42ce-b4b4-bb1a98831c80', errorCode: 'claude_error_during_execution' }),
  act(724, 71, 'system', 'decision', '2026-10-13 11:07:42', { decision: 'runtime_failure_classified', category: 'unknown' }),
  act(725, 71, 'system', 'notification', '2026-10-13 11:07:42', { kind: 'blocked', title: 'Run crashed' }),
  act(731, 72, 'system', 'decision', '2026-10-14 09:57:33', { decision: 'runtime_session_expired', runtime: 'claude' }),
  act(733, null, 'system', 'decision', '2026-10-14 10:10:53', { decision: 'dispatch_requested', reviewDeliveryRunId: 49, role: 'reviewer', purpose: 'review' }),
  act(734, null, 'user', 'decision', '2026-10-14 10:10:53', { decision: 'review_requested_by_user', dispatchRequestId: 4, deliveryRunId: 49 }),
  act(737, 73, 'system', 'crash', '2026-10-14 16:41:11', { exitCode: null, reason: 'The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account.', errorCode: 'codex_error', failureCode: 'model_unsupported' }),
  act(738, 73, 'system', 'decision', '2026-10-14 16:41:11', { decision: 'runtime_failure_classified', category: 'model_unsupported', code: 'model_unsupported' }),
  act(741, 73, 'system', 'notification', '2026-10-14 16:41:11', { kind: 'blocked', title: 'Codex 不支持该模型' }),
  act(742, null, 'system', 'decision', '2026-10-14 16:41:11', { decision: 'dispatch_suspended_by_runtime_health', runtime: 'codex', model: 'gpt-5.5' }),
  act(745, 74, 'system', 'attempt_start', '2026-10-14 16:42:12', { runtime: 'codex', model: 'gpt-5.5' }),
];
