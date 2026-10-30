// 工具守卫（landing.md 第 3 节 C2）：连接中心按工具名和参数的一层检查，对所有调用方生效（Lead、执行 agent、核查 agent、
// daemon 自己发 review）。动作的规矩写在这里，不写在某一个通道或某一种任务里：
// 「approve 以前检查都通过、评论都 resolve、不是 draft、批准的就是看过的提交」是 GitHub 批准这个动作自己的检查。
//
// 一个守卫管一个连接（按连接的 key），可以做四件事：
//   - facts：从参数里认出调用的对象，给清单检查用（例如 GitHub 搜索词里 repo: 后面的 owner 和 repo）。
//   - check：调用以前检查，返回拒绝的原因。可以读同一个连接的只读工具（例如读 PR 的状态）。
//   - observe：只读调用成功以后，把读到的内容记进这个 Run 的读取记录（出处核实用）。
//   - describe：写操作做完以后的一句话、对象和链接（动作层的记账和交回的结果用）。
// 守卫的检查不看清单：清单说「谁能做」，守卫说「这个动作什么时候能做」。
import { redactKnownValues, redactSecretText, secretEnvValues } from "@pi-lead-child/protocol";
import type { ConnectionRole } from "@pi-lead-child/protocol";
import type { RunReadLedger } from "./run-reads.js";

export interface ToolCallContext {
  // 连接的 key。
  key: string;
  tool: string;
  args: Readonly<Record<string, unknown>>;
  readOnly: boolean;
  role: ConnectionRole;
  // 带清单的 Run 调用时是它的编号和读取记录；别的调用方（Lead、daemon）是 null。
  runId: number | null;
  ledger: RunReadLedger | null;
  // 读同一个连接的一个只读工具（守卫自己查状态用）。不经过清单，不记进 Run 的读取记录。
  read(tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  signal?: AbortSignal;
}

export interface ToolCallResult {
  text: string;
  isError: boolean;
}

export interface WriteDescription {
  // 一句话：做了什么，例如「在 Acme/x#101 上提交了 review（APPROVE）」。
  summary: string;
  // 对象，例如 Acme/x#101。
  target: string | null;
  // 外部服务里能看到这次写入的地址。
  url: string | null;
  // 别人看不看得到（例如没提交的 pending review 看不到）。看得到的写操作记成主人操作，推给你，能撤销。
  visible: boolean;
}

export interface ToolGuard {
  // 管哪个连接（key）。
  connection: string;
  facts?(tool: string, args: Readonly<Record<string, unknown>>): Record<string, unknown>;
  check?(context: ToolCallContext): Promise<string | null>;
  observe?(context: ToolCallContext, result: ToolCallResult): void;
  describe?(context: ToolCallContext, result: ToolCallResult): WriteDescription;
  // 审计里记的调用对象（读写都记）。
  target?(tool: string, args: Readonly<Record<string, unknown>>): string | null;
}

/**
 * 硬性底线之一（landing.md 第 5 节）：写操作的参数里有像凭据或令牌的文字时拒绝，清单放不开。
 * 规则和工具事件脱敏用的同一套（protocol 的 redactSecretText），另外认 daemon 进程环境里的密钥原值。
 */
export function credentialProblem(args: Readonly<Record<string, unknown>>, env: Record<string, string | undefined> = process.env): string | null {
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    return "参数不能序列化";
  }
  if (redactSecretText(text) !== text) return "写操作的参数里有像凭据或令牌的文字，不能发出去";
  if (redactKnownValues(text, secretEnvValues(env)) !== text) return "写操作的参数里有助手自己的密钥，不能发出去";
  return null;
}
