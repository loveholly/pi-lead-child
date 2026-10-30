// plc 的命令。plc 是 daemon 的客户端，和 companion 平级：
//   - 客户端动作（建单、列表、事项和 Run 的动作、授权、委托、重检、配对、aish、聊天）走网关；
//   - 运行时控制（daemon stop/status/restart/upgrade）走 supervisor.sock；
//   - 安装、卸载、首次启动、doctor 和 lead 模型配置运行 daemon 的运维入口；
//   - web 只打印网关地址。
// 依赖从参数注入，测试不需要真的 daemon。
import { Command } from "commander";
import { ControlPlaneClientError, type ControlPlaneClient } from "@pi-lead-child/client";
import {
  KERNEL_RUNTIME_IDS, TICKET_LIST_VIEWS,
  type BindingDto, type DaemonLocalStatus, type KernelRuntimeId, type MaintenanceAction, type SupervisorCommand,
  type TicketListView, type UserItemActionId,
} from "@pi-lead-child/protocol";
import { CliError } from "./daemon-link.js";
import type { StoredCliCredential } from "./credential-file.js";
import { explainClientError } from "./gateway-client.js";
import type { RunOps } from "./ops-entry.js";
import * as render from "./render.js";

export type GatewayClient = Pick<ControlPlaneClient,
  | "createTicket" | "listTickets" | "getTicket" | "getActivities" | "performTicketAction" | "performAttemptAction"
  | "getLeadTrust" | "setLeadTrust" | "getLeadDelegation" | "setLeadDelegation" | "recheckRuntimes"
  | "createPairing" | "listBindings" | "revokeBinding" | "getAishStatus" | "forgetAish" | "getOwnBinding">;

export interface GatewaySession {
  client: GatewayClient;
  gatewayUrl: string;
  credential: StoredCliCredential;
}

export interface CliDeps {
  out(text: string): void;
  err(text: string): void;
  setExitCode(code: number): void;
  // 连上网关：daemon 没在运行就拉起它，第一次用时签发凭证（缺省 scope）。
  gateway(): Promise<GatewaySession>;
  // 管理命令用的客户端：在 plc.sock 上换一个临时 admin token（几分钟后作废，不落盘）。
  admin(): Promise<GatewayClient>;
  // 签发一个新的 plc 凭证，替换数据目录里的那一个。返回旧凭证（如果有）。
  login(): Promise<{ session: GatewaySession; previous: StoredCliCredential | null }>;
  // 用旧凭证自己的 token 问网关它是哪个 binding。token 无效时为 null。
  proveCredential(credential: StoredCliCredential): Promise<BindingDto | null>;
  storedCredential(): { path: string; credential: StoredCliCredential | null };
  chat(session: GatewaySession): Promise<void>;
  runOps: RunOps;
  supervisor: {
    available(): Promise<boolean>;
    request<T>(command: SupervisorCommand, timeoutMs?: number): Promise<T>;
  };
  daemon: {
    // plc.sock 的 status；daemon 没在运行时为 null，不会自动拉起。
    status(): Promise<DaemonLocalStatus | null>;
  };
  renderQr(text: string): Promise<void>;
  webBuilt(): boolean;
  openUrl(url: string): void;
}

const ITEM_ACTIONS: ReadonlyArray<readonly [UserItemActionId, string]> = [
  ["confirm", "确认待办，使其可以开跑（draft → ready）"],
  ["unconfirm", "撤回确认（ready → draft）"],
  ["start", "开始执行（创建 Run）"],
  ["stop", "手动停下，并终止在跑的 Run"],
  ["complete", "验收通过（review → done）"],
  ["rework", "打回返工"],
  ["restore", "把已取消的事项恢复为待办"],
  ["ack", "确认一条提醒（fired → acked）"],
];

function positiveId(value: string, name: string): number {
  const id = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 1) throw new CliError(`${name} must be a positive integer`);
  return id;
}

export function buildProgram(deps: CliDeps): Command {
  const program = new Command().name("plc")
    .description("pi-lead-child 的命令行：daemon 的客户端，以及安装、运行和检查 daemon 的命令");

  // 动作的统一出口：错误打到 stderr，退出码 1。网关错误换成给人看的一句话。
  const run = <A extends unknown[]>(action: (...args: A) => Promise<void> | void) => async (...args: A) => {
    try {
      await action(...args);
    } catch (error) {
      const explained = explainClientError(error);
      deps.err(explained?.message ?? (error instanceof Error ? error.message : String(error)));
      deps.setExitCode(1);
    }
  };
  // 管理命令。临时 admin token 只在 daemon 的内存里：过期或 daemon 重启后作废，所以 401 时换一个再试一次。
  // 这里的 401 和存在文件里的 plc 凭证无关，不提示 plc auth login。
  const admin = async <T>(action: (client: GatewayClient) => Promise<T>): Promise<T> => {
    const unauthorized = (error: unknown) => error instanceof ControlPlaneClientError && error.status === 401;
    try {
      return await action(await deps.admin());
    } catch (error) {
      if (!unauthorized(error)) throw error;
    }
    try {
      return await action(await deps.admin());
    } catch (error) {
      if (!unauthorized(error)) throw error;
      throw new CliError("daemon 拒绝了刚换的临时 admin token（它可能正在重启）。稍后再试。");
    }
  };
  const ops = (args: string[]) => run(async () => {
    const code = await deps.runOps(args);
    if (code !== 0) deps.setExitCode(code);
  });

  program
    .command("create <title>")
    .description("建一条根工单（以你的身份）")
    .requiredOption("--brief <text>", "任务说明")
    .option("--workdir <path>", "child 的工作目录")
    .option("--priority <p>", "urgent|high|normal|low", "normal")
    .option("--project <name>", "所属项目")
    .action(run(async (title: string, opts: { brief: string; workdir?: string; priority: string; project?: string }) => {
      const { client } = await deps.gateway();
      const ticket = await client.createTicket({
        title, brief: opts.brief,
        priority: opts.priority as "urgent" | "high" | "normal" | "low",
        ...(opts.workdir === undefined ? {} : { workdir: opts.workdir }),
        ...(opts.project === undefined ? {} : { project: opts.project }),
      });
      deps.out(`created item #${ticket.id}`);
    }));

  // 给人看的列表，缺省是 tasks 视图：不含提醒、待确认、终态和延后未到期（spec §9）。
  program.command("list")
    .description("列出工单")
    .option("-v, --view <view>", `视图：${TICKET_LIST_VIEWS.join(" | ")}`, "tasks")
    .action(run(async (opts: { view: string }) => {
      if (!(TICKET_LIST_VIEWS as readonly string[]).includes(opts.view)) {
        throw new CliError(`unknown view '${opts.view}' (${TICKET_LIST_VIEWS.join(" | ")})`);
      }
      const { client } = await deps.gateway();
      const tickets = await client.listTickets({ view: opts.view as TicketListView });
      if (!tickets.length) { deps.out(`（${opts.view} 视图为空）`); return; }
      for (const ticket of tickets) deps.out(render.ticketRow(ticket));
    }));

  program.command("show <id>")
    .description("显示一张工单和它的活动流")
    .action(run(async (id: string) => {
      const ticketId = positiveId(id, "id");
      const { client } = await deps.gateway();
      const [detail, activities] = await Promise.all([client.getTicket(ticketId), client.getActivities(ticketId)]);
      deps.out(render.ticketDetail(detail, activities));
    }));

  program.command("chat")
    .description("和常驻 daemon 里的 lead 对话（daemon 不在则自动拉起）。对话也出现在 companion 里")
    .action(run(async () => { await deps.chat(await deps.gateway()); }));

  // 用户控制面动作（spec §6.4/§8）。lead 没有这些边，CLI 和 companion 是仅有的两个入口，
  // 两者都经过网关落到 daemon 进程里：暂停要终止的是 daemon 持有的子进程。
  const itemCmd = program.command("item").description("事项的用户动作（确认/开跑/停下/验收/返工/取消/恢复）");
  for (const [action, description] of ITEM_ACTIONS) {
    itemCmd.command(`${action} <id>`).description(description)
      .action(run(async (id: string) => {
        const { client } = await deps.gateway();
        await client.performTicketAction(positiveId(id, "id"), action);
        deps.out(`item #${id} ${action} 已执行`);
      }));
  }
  itemCmd.command("cancel <id>").description("取消事项，并终止它所有未结束的 Run")
    .option("--reason <text>", "取消理由")
    .action(run(async (id: string, opts: { reason?: string }) => {
      const { client } = await deps.gateway();
      await client.performTicketAction(positiveId(id, "id"), "cancel", opts.reason === undefined ? {} : { reason: opts.reason });
      deps.out(`item #${id} cancel 已执行`);
    }));

  const runCmd = program.command("run").description("执行（Run）的用户动作：暂停 / 恢复 / 停止");
  const runAction = (action: "pause" | "resume" | "stop") => run(async (id: string, opts: { reason?: string } = {}) => {
    const { client } = await deps.gateway();
    await client.performAttemptAction(positiveId(id, "id"), action, opts.reason === undefined ? {} : { reason: opts.reason });
    deps.out(`run #${id} ${action} 已执行`);
  });
  runCmd.command("pause <id>").description("暂停执行：真的终止子进程，工单仍是 active").action(runAction("pause"));
  runCmd.command("resume <id>").description("恢复执行：复用同一 session 重新拉起").action(runAction("resume"));
  runCmd.command("stop <id>").description("停止执行（终态，恢复不了）")
    .option("--reason <text>", "停止理由")
    .action(runAction("stop"));

  // 用户对 lead 的授权（store/lead-grants.ts）。用户说的「我授权你了」进不了账本；
  // 这个命令把它变成一条 lead 改不了、随时可收回的事实。授权变动当场同步到 lead 的工具表。
  const trustCmd = program.command("trust").description("对 lead 的授权（可随时撤销）");
  trustCmd.command("lead")
    .description("授权 / 撤销 / 查看：lead 能不能代你确认待办（draft → ready）")
    .option("--confirm", "授权 lead 代你确认待办")
    .option("--revoke", "撤销授权")
    .option("--note <text>", "备注（记进账本，事后可查）")
    .action(run(async (opts: { confirm?: boolean; revoke?: boolean; note?: string }) => {
      if (opts.confirm && opts.revoke) throw new CliError("--confirm 与 --revoke 只能选一个");
      const { client } = await deps.gateway();
      if (!opts.confirm && !opts.revoke) { deps.out(render.trustStatus(await client.getLeadTrust())); return; }
      deps.out(render.trustUpdate(await client.setLeadTrust(Boolean(opts.confirm),
        opts.confirm && opts.note !== undefined ? { note: opts.note } : {})));
    }));

  // 重检不可用的 runtime（工单 04）。探针由 daemon 执行：它检查的是 daemon 执行时用的 adapter。
  program.command("recheck [runtime]")
    .description(`立即重检不可用的 runtime（${KERNEL_RUNTIME_IDS.join(" | ")}，不写则全部）。重检通过后，先只放行一个挂起的请求`)
    .action(run(async (runtime?: string) => {
      if (runtime !== undefined && !(KERNEL_RUNTIME_IDS as readonly string[]).includes(runtime)) {
        throw new CliError(`unknown runtime '${runtime}' (${KERNEL_RUNTIME_IDS.join(" | ")})`);
      }
      const results = await admin((client) => client.recheckRuntimes(runtime as KernelRuntimeId | undefined));
      deps.out(render.recheckResults(runtime, results));
    }));

  const delegateCmd = program.command("delegate").description("无人值守委托授权（可撤销、可审计）");
  delegateCmd.command("lead <ticket_id>")
    .description("授权 Lead 在指定工单上自动处理技术验收、返工和交付")
    .option("--revoke", "撤销该工单的无人值守委托")
    .option("--max-rework-cycles <n>", "最大自动返工次数", (value) => Number(value))
    .option("--budget-tokens <n>", "委托自动化 token 上限", (value) => Number(value))
    .option("--budget-usd <n>", "委托自动化 USD 上限", (value) => Number(value))
    .option("--until <iso>", "授权有效期 ISO 时间")
    .option("--scope <text>", "授权范围说明")
    .option("--require-continuation", "要求该工单已有结构化 continuation，否则拒绝授权")
    .option("--required-capability-id <id>", "要求指定 capability 已实现、部署并加载", (value) => Number(value))
    .option("--reason <text>", "撤销理由")
    .action(run(async (ticketIdText: string, opts: {
      revoke?: boolean; maxReworkCycles?: number; budgetTokens?: number; budgetUsd?: number; until?: string;
      scope?: string; requireContinuation?: boolean; requiredCapabilityId?: number; reason?: string;
    }) => {
      const ticketId = positiveId(ticketIdText, "ticket_id");
      const { client } = await deps.gateway();
      if (opts.revoke) {
        const result = await client.setLeadDelegation(ticketId, false, { reason: opts.reason ?? "revoked by user" }) as { revoked?: number };
        deps.out(result.revoked
          ? `已撤销工单 #${ticketId} 的无人值守委托（${result.revoked} 条）`
          : `工单 #${ticketId} 没有生效的无人值守委托`);
        return;
      }
      let granted: { policy: { id: number; max_rework_cycles: number }; preflight: { status: string; warnings: unknown[] } };
      try {
        granted = await client.setLeadDelegation(ticketId, true, {
          ...(opts.scope === undefined ? {} : { scope: opts.scope }),
          ...(opts.maxReworkCycles === undefined ? {} : { maxReworkCycles: opts.maxReworkCycles }),
          ...(opts.budgetTokens === undefined ? {} : { budgetLimitTokens: opts.budgetTokens }),
          ...(opts.budgetUsd === undefined ? {} : { budgetLimitUsd: opts.budgetUsd }),
          ...(opts.until === undefined ? {} : { effectiveUntil: new Date(opts.until).toISOString() }),
          ...(opts.requireContinuation ? { requireContinuation: true } : {}),
          ...(opts.requiredCapabilityId === undefined ? {} : { requiredCapabilityId: opts.requiredCapabilityId }),
        }) as typeof granted;
      } catch (error) {
        const blockers = (error as { status?: number; body?: { preflight?: { blockers?: unknown } } }).body?.preflight?.blockers;
        if ((error as { status?: number }).status === 409 && Array.isArray(blockers)) {
          throw new CliError(`无法接受无人值守委托：${blockers.join("；")}`);
        }
        throw error;
      }
      const active = (await client.getLeadDelegation(ticketId)).active as { id?: number } | null;
      deps.out([
        `已授权 Lead 无人值守处理工单 #${ticketId}（delegation policy #${granted.policy.id}，max_rework_cycles=${granted.policy.max_rework_cycles}）`,
        `预检：${granted.preflight.status}${granted.preflight.warnings.length ? `，警告=${granted.preflight.warnings.length}` : ""}`,
        `当前生效：${active?.id ?? "-"}`,
      ].join("\n"));
    }));

  // 配对管理要 admin 权限：每次在 plc.sock 上换一个临时 admin token。配对出去的设备没有 admin。
  const pairCmd = program.command("pair").description("配对管理：给 companion 等客户端发配对码，查看和撤销 binding");
  pairCmd.command("new")
    .requiredOption("--name <name>", "设备/客户端名称")
    .option("--kind <kind>", "desktop|companion|cli", "companion")
    .option("--endpoint <ws-url>", "局域网 WebSocket 地址，例如 ws://192.168.1.10:47130")
    .action(run(async (opts: { name: string; kind: string; endpoint?: string }) => {
      if (!["desktop", "companion", "cli"].includes(opts.kind)) throw new CliError("kind must be desktop, companion, or cli");
      const pairing = await admin((client) => client.createPairing({
        name: opts.name, kind: opts.kind as "desktop" | "companion" | "cli",
        ...(opts.endpoint === undefined ? {} : { endpoint: opts.endpoint }),
      }));
      if (pairing.uri) {
        deps.out(`扫描二维码连接 ${opts.name}（15 分钟内有效，至 ${pairing.expiresAt}）`);
        await deps.renderQr(pairing.uri);
        deps.out("");
      }
      deps.out(render.pairingCode(opts.name, pairing));
    }));
  pairCmd.command("list").action(run(async () => {
    for (const binding of await admin((client) => client.listBindings())) deps.out(render.bindingRow(binding));
  }));
  pairCmd.command("revoke <id>").action(run(async (id: string) => {
    const bindingId = positiveId(id, "id");
    const binding = await admin((client) => client.revokeBinding(bindingId));
    deps.out(`binding #${binding.id} revoked`);
  }));

  // aish（Slack 网关）的上游凭证，要 admin 权限。token 只从环境变量 PLC_AISH_TOKEN 进 daemon，
  // 这里故意不提供 --token：命令行参数会留在 shell 历史里。
  const aishCmd = program.command("aish")
    .description("aish（Slack 网关）凭证：查看状态，删除已保存的凭证")
    .addHelpText("after", [
      "",
      "更新 token：",
      "  1. 在数据目录的 config.json 的 env 段设置 PLC_AISH_TOKEN，",
      '     例如 {"env": {"PLC_AISH_TOKEN": {"value": "<新 token>"}}}。手动启动 daemon 时，也可以在启动环境里设置。',
      '  2. 运行 plc daemon restart --reason "update aish token"。daemon 启动时保存新 token，并清除旧 token 的失败标记。',
      "  3. 运行 plc aish status，确认没有鉴权失败标记。",
      "  daemon 保存新 token 之后，可以从 config.json 删掉这一项：daemon 用账本里的凭证自动重连。",
      "删除凭证：运行 plc aish forget --yes。",
      "这些命令不接受 token 参数，因为命令行参数会留在 shell 历史里。",
    ].join("\n"));
  aishCmd.command("status")
    .description("显示是否保存了 aish 凭证、URL 和鉴权失败标记（不显示 token）")
    .action(run(async () => {
      deps.out(render.aishStatus(await admin((client) => client.getAishStatus())));
    }));
  aishCmd.command("forget")
    .description("删除已保存的 aish 凭证和鉴权失败标记（需要 --yes 确认）")
    .option("--yes", "确认删除")
    .action(run(async (opts: { yes?: boolean }) => {
      if (!opts.yes) throw new CliError("这个命令删除已保存的 aish 凭证。确认删除时，加上 --yes 再运行：plc aish forget --yes");
      deps.out(render.aishForgotten(await admin((client) => client.forgetAish())));
    }));

  // plc 自己的网关凭证（数据目录里的 cli-credential.json，0600）。不打印 token。
  const authCmd = program.command("auth").description("plc 的网关凭证：第一次需要时自动签发");
  authCmd.command("status").description("显示 plc 凭证对应的 binding（不显示 token）")
    .action(run(() => {
      const { path, credential } = deps.storedCredential();
      if (!credential) {
        deps.out(`还没有 plc 凭证（${path}）。第一次运行需要网关的命令时会自动签发，也可以运行 plc auth login。`);
        return;
      }
      const { binding } = credential;
      deps.out([
        `binding #${binding.id}（kind=${binding.kind}，${binding.name}），签发于 ${credential.issuedAt}`,
        `scopes: ${binding.scopes.join(", ")}`,
        `文件: ${path}`,
      ].join("\n"));
    }));
  authCmd.command("login").description("在 plc.sock 上签发一个新的 plc 凭证，替换旧的，并撤销旧的 binding")
    .action(run(async () => {
      const { session, previous } = await deps.login();
      deps.out(`已签发新的 plc 凭证：binding #${session.credential.binding.id}（kind=cli）`);
      if (!previous || previous.binding.id === session.credential.binding.id) return;
      // 账本重置之后 binding 编号会复用：文件里记的编号可能已经是别的设备。只有旧 token 自己证明
      // 它就是那个 kind=cli 的 binding 时才撤销。
      const skipped = `旧凭证 binding #${previous.binding.id} 没有撤销：它的 token 证明不了自己还是那个 kind=cli 的 binding`
        + "（账本可能重置过）。需要时运行 plc pair list 查看。";
      const proof = await deps.proveCredential(previous);
      if (!proof || proof.id !== previous.binding.id || proof.kind !== "cli") { deps.out(skipped); return; }
      try {
        await admin((client) => client.revokeBinding(proof.id));
        deps.out(`已撤销旧凭证 binding #${proof.id}`);
      } catch {
        deps.out(skipped);
      }
    }));

  const daemonCmd = program.command("daemon").description("管理常驻 daemon（coordinatord）和它的 supervisor");
  daemonCmd.command("start")
    .description("后台拉起 supervisor 和 daemon。主 checkout 有没提交的代码、或者 dist 不是从干净的 commit 构建的，"
      + "部署闸门拒绝启动")
    .option("--force", "越过部署闸门，启动现在的 dist（supervisor 日志里记一笔）")
    .action((opts: { force?: boolean }) => ops(["start", ...(opts.force ? ["--force"] : [])])());
  daemonCmd.command("stop").description("停止 daemon，之后不自动启动（supervisor 保持运行）").action(run(async () => {
    if (await deps.supervisor.available()) {
      await deps.supervisor.request({ type: "stop_daemon" }, 35_000);
      deps.out("daemon 已停止，Supervisor 保持运行");
      return;
    }
    // 没有 supervisor：运维入口停 daemon，并记下"用户停的"，之后的自动拉起不会把它拉起来。
    const code = await deps.runOps(["stop"]);
    if (code !== 0) deps.setExitCode(code);
  }));
  daemonCmd.command("status").description("supervisor 和 daemon 的状态（launchd 状态见 plc doctor）").action(run(async () => {
    if (await deps.supervisor.available()) {
      deps.out(JSON.stringify(await deps.supervisor.request({ type: "status" }), null, 2));
      return;
    }
    deps.out("supervisor: not running");
    const status = await deps.daemon.status();
    deps.out(status ? JSON.stringify(status, null, 2) : "daemon 未运行");
  }));
  const maintenance = (action: MaintenanceAction) => run(async (opts: { reason: string; schema?: string }) => {
    if (!(await deps.supervisor.available())) {
      const code = await deps.runOps(["start"]);
      if (code !== 0) throw new CliError("supervisor 启动失败，无法安排维护。运行 plc doctor 检查。");
    }
    const request = await deps.supervisor.request({
      type: "request_maintenance", action, reason: opts.reason,
      ...(opts.schema === undefined ? {} : { requiredSchemaVersion: Number(opts.schema) }),
    });
    deps.out(JSON.stringify(request, null, 2));
  });
  daemonCmd.command("restart")
    .requiredOption("--reason <text>", "重启原因")
    .action(maintenance("restart"));
  daemonCmd.command("upgrade")
    .requiredOption("--reason <text>", "升级原因")
    .option("--schema <version>", "要求的最低 schema version")
    .action(maintenance("upgrade"));
  daemonCmd.command("install").description("安装 launchd 常驻 Supervisor（开机自启+托管 daemon）").action(ops(["install"]));
  daemonCmd.command("uninstall").description("卸载 launchd 常驻").action(ops(["uninstall"]));
  daemonCmd.command("ledger-guard <action>")
    .description("账本的写入守卫：status 查看；uninstall 卸掉（先停 daemon，只回滚代码之前用）")
    .action((action: string) => ops(["ledger-guard", action])());

  program.command("doctor").description("只读诊断：只读打开账本，不执行迁移，不修改账本和配置").action(ops(["doctor"]));

  program.command("web")
    .description("打印 daemon 网关提供的 companion web UI 地址")
    .option("--open", "同时用默认浏览器打开")
    .action(run(async (opts: { open?: boolean }) => {
      const { gatewayUrl } = await deps.gateway();
      if (!deps.webBuilt()) deps.err("dist/web 未构建：先运行 npm run build:web");
      const url = `${gatewayUrl}/`;
      deps.out(url);
      if (opts.open) deps.openUrl(url);
    }));

  const leadCmd = program.command("lead").description("Lead 模型配置（provider/model，写入 config.json）");
  leadCmd.command("model").description("显示当前 Lead 模型与已配置 provider").action(ops(["lead-model"]));
  leadCmd.command("use <provider/model>").description("把 Lead 默认模型写入 config.json（改完需重启 daemon）")
    .action((spec: string) => ops(["lead-use", spec])());

  return program;
}
