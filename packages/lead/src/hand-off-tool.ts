// hand_off 和 resume_unit（lead-scheduler spec H4、H10，P2）。
//
// hand_off(note?)：建单、写说明、派出合成一次调用（用户 2026-11-09：「非常赞同」）。交接包由系统附上（scheduler/handoffs.ts），
// Lead 只写一句话。三个入口（开头就交、中途交、被迫交）用同一个工具，派出永远是 Lead 自己这一次调用：系统不替它派出。
// 建的是轻子 agent 的工单（create_task 的 light=true：自己的目录、不开 PR、不要验收），开跑走工单操作 start，
// 和 spawn_child、页面的「开始执行」是同一个操作、同样的检查和账本。目标：10 秒以内出确认（H8）。
//
// resume_unit(id, action)：处理一个挂起的单元（H10）。剩下不超过 2–3 步就 resume 接着做（就地预算从现在重新算），
// 不需要了就 drop。剩下更多时用 hand_off(suspended=id)。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createCoordinator, setAutoPullRequest, warmRepositoryIdentity, warmRunWorkspaceFacts, warmWorkdirFacts } from "@pi-lead-child/engine";
import { getItem, itemUpdatedEvent, markLightTask, publishGatewayEvents, recordItemHandoff, type Db } from "@pi-lead-child/store";
import { firstLine } from "./overflow.js";
import { clip, committedWrites, type HandoffPackage } from "./scheduler/handoff-package.js";
import { validHandoffId, type LeadHandoffs } from "./scheduler/handoffs.js";

/** daemon 给 Lead 的交接服务（LeadDeps.handoff）。 */
export interface LeadHandoffDeps {
  handoffs: LeadHandoffs;
  // 现在是被迫交的交接窗口（红线停下了这一轮）。
  forced: () => boolean;
  // hand_off 成功了：告诉调度器（handoff.made）。
  made: (pkg: HandoffPackage, ticketId: number) => void;
  // resume_unit 接着做：就地预算从现在重新算（budget.restart）。
  resumed?: (pkg: HandoffPackage) => void;
  now?: () => number;
}

export interface HandOffToolHelpers {
  db: Db;
  dataDir: string;
  // 轻子 agent 自己的目录（tools.ts 的 lightTaskDir）。
  lightTaskDir: (dataDir: string) => string;
  // 开始执行（工单操作 start），和 spawn_child 同一个入口。返回工单操作的说明。
  startTicket: (ticketId: number, reason: string) => Promise<string | null>;
}

function text(t: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: t }], details };
}

export function createHandOffTools(deps: { handoff?: LeadHandoffDeps }, helpers: HandOffToolHelpers): ToolDefinition<any>[] {
  const service = deps.handoff;
  if (!service) return [];
  const { db, dataDir } = helpers;
  const now = service.now ?? Date.now;
  return [
    defineTool({
      name: "hand_off",
      label: "Hand Off",
      description:
        "把这件事交给后台的轻子 agent，一次调用：系统建单、附上交接包（目标和原话、你做过的步骤和结果、已经提交和状态未知的写操作、"
        + "碰过的对象、回复去向）、派出。你不用写任务说明，note 写一句话就够：已经知道什么、还剩什么、为什么交。"
        + "什么时候用：第一步就判断做不完就地预算（2 分 30 秒）时马上交；做了几步发现比预估大时中途交；系统停下这一轮请你交接时交。"
        + "交出去以后用一句话告诉对方：交给了后台 agent、大约 3–5 分钟有结果。结果回来时系统叫你，进度卡上会先显示结果，你再写一条回复转告。"
        + "suspended：交一个挂起的单元（当前局面里列着，交接包现成）。要改代码、要交付验收的活用 create_task，不用它。",
      parameters: Type.Object({
        note: Type.Optional(Type.String({ maxLength: 2000, description: "一句话：已经知道什么、还剩什么、为什么交。可以不给" })),
        suspended: Type.Optional(Type.String({ maxLength: 60, description: "交一个挂起的单元时给它的编号（hof_ 开头）" })),
        title: Type.Optional(Type.String({ maxLength: 120, description: "工单标题；不给时用原话的第一句" })),
      }),
      execute: async (_id, params: { note?: string; suspended?: string; title?: string }) => {
        const started = now();
        if (params.suspended !== undefined && !validHandoffId(params.suspended)) {
          throw new Error(`${params.suspended} 不是交接包的编号（hof_ 开头）。当前局面里列着挂起的单元。`);
        }
        const forced = service.forced();
        const { pkg, files } = service.handoffs.prepare({
          note: params.note ?? null, forced, ...(params.suspended ? { suspendedId: params.suspended } : {}),
        });
        const { brief, files: stepFiles } = service.handoffs.brief(pkg, files);
        const title = clip(params.title?.trim() || `交接：${firstLine(pkg.goal.text) || "没做完的事"}`, 120);
        // 轻子 agent 自己的目录：长结果的全文放在它的 handoff/ 下，说明里写文件名（H3）。
        const workdir = helpers.lightTaskDir(dataDir);
        for (const file of stepFiles) {
          const path = join(workdir, file.path);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, file.text, { mode: 0o600 });
        }
        // 建单的事务里要认项目（仓库根目录、origin）：git 的事实先异步查好，事务里只读缓存（create_task 也这样做，P0）。
        await Promise.all([warmRepositoryIdentity(workdir), warmWorkdirFacts(workdir)]);
        const coordinator = createCoordinator({ db });
        const ticketId = db.transaction((): number => {
          const created = coordinator.createRootItem({
            title, brief, workdir, createdBy: "lead", verificationPolicy: "lead_static",
          });
          setAutoPullRequest(db, created, false, { actor: "lead", reason: "交接给轻子 agent，不改代码，不开 PR" });
          markLightTask(db, created, "lead");
          recordItemHandoff(db, created, {
            packageId: pkg.id, unitId: pkg.unitId, entry: pkg.entry, lane: pkg.goal.lane, turnId: pkg.turnId,
            external: pkg.external, steps: pkg.steps.length, committed: committedWrites(pkg).length,
          });
          return created;
        }).immediate();
        publishGatewayEvents(db, [itemUpdatedEvent(ticketId)]);
        // 开跑前的工作区判定要的 git 事实先异步查好（spawn_child 也这样做）。轻子 agent 的目录不在 git 里，很快。
        const ticket = getItem(db, ticketId);
        if (ticket) await warmRunWorkspaceFacts(db, ticket, { role: "executor", purpose: ticket.purpose ?? "execution" });
        const startNote = await helpers.startTicket(ticketId, `Lead 交接（hand_off，${pkg.entry}）`);
        const ms = now() - started;
        service.handoffs.handedOff(pkg, files, { ticketId, ms });
        service.made(pkg, ticketId);
        const committed = committedWrites(pkg).length;
        return text([
          `交给了后台 agent：task #${ticketId}（轻子 agent，${startNote ?? "已开始执行"}）。`,
          `交接包 ${pkg.id}：${pkg.steps.length} 次工具调用，已经提交的写操作 ${committed} 个，用了 ${Math.round(ms / 100) / 10} 秒。`,
          "现在用一句话告诉对方：交给了后台 agent、大约 3–5 分钟有结果，可以接着说别的。不要再做这件事的内容：它归子 agent 了。"
            + "结果回来时系统会叫你，你再写一条回复转告。",
        ].join("\n"), { ticketId, packageId: pkg.id, entry: pkg.entry, ms });
      },
    }),
    defineTool({
      name: "resume_unit",
      label: "Resume Unit",
      description:
        "处理一个挂起的单元（被打断的工作，当前局面里列着）。剩下不超过 2–3 步：action=resume 接着做，结果里有它的交接包，"
        + "就地预算从现在重新算；已经不需要了：action=drop。剩下更多时不用它，用 hand_off(suspended=id) 交给子 agent。",
      parameters: Type.Object({
        id: Type.String({ maxLength: 60, description: "挂起的单元的编号（hof_ 开头）" }),
        action: Type.Union([Type.Literal("resume"), Type.Literal("drop")]),
        reason: Type.Optional(Type.String({ maxLength: 500 })),
      }),
      execute: async (_id, params: { id: string; action: "resume" | "drop"; reason?: string }) => {
        const { pkg, text: body } = service.handoffs.resolve(params.id, params.action, params.reason ?? null);
        if (params.action === "resume") service.resumed?.(pkg);
        return text(body, { packageId: pkg.id, action: params.action });
      },
    }),
  ];
}
