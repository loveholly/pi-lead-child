// 数据目录里的两条 Unix socket（权限 0600，只有本机同一个用户能连）。都是 LF 分隔的 JSON 行：
// 客户端写一行命令，服务端回一行 {type:"response", id, success, data | error}。
//
// - plc.sock（daemon）：本机自举和运维。plc 在这里换一个 kind=cli 的网关凭证，之后的客户端动作
//   一律走网关。supervisor 用 status 探活、用 shutdown 停机。聊天、事项动作、授权、重检都不在这里。
// - supervisor.sock（supervisor）：运行时控制：状态、拉起、停止、重启和升级。
import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";
import { BindingDtoSchema } from "./scopes.ts";

const StrictObject = <T extends TProperties>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const RequestId = { id: Type.Optional(Type.String()) };

// 一条桌面通知正文的上限（字符）。daemon 推给 App 之前截到这个长度，App 交回失败的那条时也不能超过它。
export const DESKTOP_NOTIFICATION_BODY_MAX = 4_000;

export const LocalSocketCommandSchema = Type.Union([
  StrictObject({ type: Type.Literal("status"), ...RequestId }),
  // 停机前先排空 Lead（2026-10-16 提醒 #83）：daemon 不再开新的 Lead 回合（新消息存成排队的轮次），
  // 等正在跑的这一轮最多 timeoutMs，到时还没结束就正式中断它，记成「被重启打断」。回答 DaemonDrainResult。
  // supervisor 停 daemon 时先发它，再发 shutdown。shutdown 自己也会排空，只是不能先等着回答。
  StrictObject({
    type: Type.Literal("drain"), ...RequestId,
    timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60_000 })),
  }),
  StrictObject({ type: Type.Literal("shutdown"), ...RequestId }),
  // 签发一个 kind=cli 的 binding，带缺省的 5 个 scope。plc 把它存进数据目录。
  StrictObject({ type: Type.Literal("cli_credential"), ...RequestId, name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }),
  // 签发一个临时 admin token（ADMIN_TOKEN_TTL_MS 内有效）。它只在 daemon 的内存里，只开管理路由。
  // plc 每次执行管理命令（配对、binding、aish 凭证、重检）时换一个，用完就丢，不落盘。
  StrictObject({ type: Type.Literal("admin_token"), ...RequestId }),
  // 把 Lead 的默认模型写进 config.json（plc lead use）。经 daemon 写，daemon 核对 config.json 时才认得出这是它自己写的
  // （2026-10-19 审查：别的进程直接改 config.json 会报警）。回答 { path, models }。改完要重启 daemon 才生效。
  StrictObject({ type: Type.Literal("set_lead_model"), ...RequestId, spec: Type.String({ minLength: 3, maxLength: 200 }) }),
  // Bytezard Lead 的 App 订阅桌面通知（docs/desktop/macos-desktop-design.md 第 8.6 节路径 A）。key 是数据目录里
  // shell-pairing.key 的内容：执行器的沙箱读不到它，所以别的进程订不走通知。回答以后连接保持打开，
  // daemon 每条通知写一行 DesktopNotificationEvent；有订阅时 daemon 不调 osascript。连接断开就是退订。
  StrictObject({
    type: Type.Literal("subscribe_desktop_notifications"), ...RequestId,
    key: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  // 只在订阅了的连接上有效：App 发这一条失败了（Electron 的 failed 事件），daemon 用 osascript 补发。
  StrictObject({
    type: Type.Literal("desktop_notification_failed"), ...RequestId,
    body: Type.String({ maxLength: DESKTOP_NOTIFICATION_BODY_MAX }),
  }),
  // supervisor 发：一次已接受的维护在停机前失败了（例如从 HEAD 重新构建失败）。只带维护的 id：daemon 向 supervisor
  // 核对这次维护确实失败了，用 supervisor 记的原因叫醒 Lead。能连上 plc.sock 的进程写不进自己的话。
  StrictObject({ type: Type.Literal("maintenance_failed"), ...RequestId, maintenanceId: Type.String({ minLength: 1, maxLength: 100 }) }),
]);
export type LocalSocketCommand = Static<typeof LocalSocketCommandSchema>;

// 服务端用它挡住不在契约里的命令：plc.sock 上没有聊天、事项动作、授权和重检。
export function isLocalSocketCommand(value: unknown): value is LocalSocketCommand {
  return Value.Check(LocalSocketCommandSchema, value);
}

// subscribe_desktop_notifications 以后 daemon 推给 App 的一行。title 是用户配置的 Lead 名字。
export const DesktopNotificationEventSchema = StrictObject({
  type: Type.Literal("desktop_notification"),
  title: Type.String({ minLength: 1 }),
  body: Type.String({ maxLength: DESKTOP_NOTIFICATION_BODY_MAX }),
});
export type DesktopNotificationEvent = Static<typeof DesktopNotificationEventSchema>;

export interface LocalSocketResponse<T = unknown> {
  type: "response";
  id?: string;
  success: boolean;
  data?: T;
  error?: string;
  // 机器可读的失败原因。supervisor 拒绝启动 daemon 时：auto_start_refused、maintenance_in_progress。
  code?: string;
}

// drain 的回答。drained：排空时 Lead 已经空着，或者正在跑的那一轮在时限内结束了。
// interrupted：时限到了，daemon 中断了正在跑的那一轮（下一个 daemon 接着处理它）。
export interface DaemonDrainResult {
  drained: boolean;
  interrupted: boolean;
}

// 停机时等 Lead 这一轮的时限。它必须远小于 supervisor 等 daemon 退出的 20 秒，
// 也小于 launchd 停 supervisor 时的 ExitTimeOut（缺省 20 秒）：supervisor 自己还要发 shutdown、等 daemon 退出。
export const LEAD_DRAIN_TIMEOUT_MS = 12_000;

export const CliCredentialResponseSchema = StrictObject({
  accessToken: Type.String({ minLength: 1 }),
  binding: BindingDtoSchema,
  // 客户端该连的网关地址。端口可能随重启变化，客户端每次都按 status 里的 gatewayUrl 连。
  gatewayUrl: Type.String({ minLength: 1 }),
});
export type CliCredentialResponse = Static<typeof CliCredentialResponseSchema>;

export const ADMIN_TOKEN_TTL_MS = 5 * 60_000;

export const AdminTokenResponseSchema = StrictObject({
  accessToken: Type.String({ minLength: 1 }),
  expiresAt: Type.String(),
  gatewayUrl: Type.String({ minLength: 1 }),
});
export type AdminTokenResponse = Static<typeof AdminTokenResponseSchema>;

// 网关在回环之外的那个地址（PLC_GATEWAY_HOST）。开机时地址可能还没就绪，daemon 在后台退避重试。
export const GatewayExposureStatusSchema = StrictObject({
  host: Type.String(),
  port: Type.Integer({ minimum: 0 }),
  state: Type.Union([Type.Literal("listening"), Type.Literal("retrying"), Type.Literal("stopped")]),
  attempts: Type.Integer({ minimum: 0 }),
  lastError: Type.Union([Type.String(), Type.Null()]),
  nextRetryAt: Type.Union([Type.String(), Type.Null()]),
});
export type GatewayExposureStatus = Static<typeof GatewayExposureStatusSchema>;

export const DaemonLocalStatusSchema = StrictObject({
  model: Type.String(),
  busy: Type.Boolean(),
  pid: Type.Integer(),
  clients: Type.Integer({ minimum: 0 }),
  sessionId: Type.String(),
  runningChildren: Type.Array(Type.Integer()),
  runningItemIds: Type.Array(Type.Integer()),
  aish: Type.Union([
    StrictObject({ connected: Type.Boolean(), bot: Type.Union([Type.String(), Type.Null()]) }),
    Type.Null(),
  ]),
  gatewayUrl: Type.String({ minLength: 1 }),
  // 只监听回环时为 null。
  gatewayExposure: Type.Union([GatewayExposureStatusSchema, Type.Null()]),
});
export type DaemonLocalStatus = Static<typeof DaemonLocalStatusSchema>;

export const MaintenanceActionSchema = Type.Union([Type.Literal("restart"), Type.Literal("upgrade")]);
export type MaintenanceAction = Static<typeof MaintenanceActionSchema>;

export const SupervisorCommandSchema = Type.Union([
  StrictObject({ type: Type.Literal("status"), ...RequestId }),
  // auto：客户端发现 daemon 不在时的自动拉起。用户 plc daemon stop 过，或者维护正在进行时，supervisor 拒绝。
  // force：plc daemon start --force。主 checkout 有没提交的代码时也启动（部署闸门的显式绕过，supervisor 记日志）。
  StrictObject({
    type: Type.Literal("ensure_running"), ...RequestId, auto: Type.Optional(Type.Boolean()), force: Type.Optional(Type.Boolean()),
  }),
  StrictObject({ type: Type.Literal("stop_daemon"), ...RequestId }),
  StrictObject({
    type: Type.Literal("request_maintenance"),
    ...RequestId,
    action: MaintenanceActionSchema,
    reason: Type.String(),
    requiredSchemaVersion: Type.Optional(Type.Integer()),
    // 停 daemon 以后、启动新的之前备份数据库。upgrade 总是备份；restart 由请求方决定（Lead 的重启总是要）。
    backup: Type.Optional(Type.Boolean()),
  }),
  StrictObject({ type: Type.Literal("shutdown"), ...RequestId }),
]);
export type SupervisorCommand = Static<typeof SupervisorCommandSchema>;

export function isSupervisorCommand(value: unknown): value is SupervisorCommand {
  return Value.Check(SupervisorCommandSchema, value);
}

export type SupervisorDesiredState = "running" | "stopped";
export type SupervisorPhase =
  | "starting"
  | "running"
  | "stopped"
  | "waiting_for_drain"
  | "building"
  | "backing_up"
  | "restarting"
  | "verifying"
  | "degraded";

export type MaintenanceState =
  | "pending"
  | "waiting_for_drain"
  | "running"
  | "succeeded"
  | "failed"
  // supervisor 在维护途中停了（崩溃、被杀）。下次启动时把留下的 running 记录改成这个。
  | "interrupted";

export interface MaintenanceRequest {
  id: string;
  action: MaintenanceAction;
  reason: string;
  requiredSchemaVersion: number | null;
  requestedAt: string;
  state: MaintenanceState;
  startedAt: string | null;
  completedAt: string | null;
  backupPath: string | null;
  // 这次维护要不要备份数据库。旧版本 supervisor 的记录里没有这一项。
  backup?: boolean;
  error: string | null;
  // 停机前失败的类别。daemon 叫醒 Lead 时只写它，不写 error 里的构建输出（可能引用源码）。
  failureKind?: MaintenanceFailureKind;
}

export type MaintenanceFailureKind = "build_failed" | "build_mismatch" | "backup_failed" | "deploy_refused" | "swap_failed";

/** supervisor 支持重启前备份（request_maintenance 的 backup）。旧版本的 status 里没有它。 */
export const SUPERVISOR_FEATURE_MAINTENANCE_BACKUP = "maintenance_backup";
/** supervisor 在维护入口检查只部署已提交的代码（每个重启请求都经过）。旧版本没有。 */
export const SUPERVISOR_FEATURE_DEPLOY_GATE = "deploy_gate";

export interface SupervisorPersistentState {
  version: 1;
  desiredState: SupervisorDesiredState;
  phase: SupervisorPhase;
  supervisorPid: number | null;
  daemonPid: number | null;
  crashCount: number;
  lastDaemonExit: {
    code: number | null;
    // 进程退出的信号名，例如 SIGTERM。
    signal: string | null;
    at: string;
  } | null;
  maintenance: MaintenanceRequest | null;
  updatedAt: string;
}

export interface SupervisorStatus {
  supervisor: SupervisorPersistentState;
  // 维护此刻是否真的在进行（活着的 supervisor 的内存状态，不是状态文件里的记录）。
  maintenanceActive: boolean;
  daemon: Record<string, unknown> | null;
  schemaVersion: number | null;
  latestSchemaVersion: number;
  executables?: Record<string, string | null>;
  // 这个 supervisor 支持的可选功能，例如 SUPERVISOR_FEATURE_MAINTENANCE_BACKUP。
  features?: string[];
  // 部署闸门现在的判断（supervisor 知道 daemon 从哪个 checkout 启动时才有）。
  // mode 和 release 是发布模式（桌面版，根目录有 release.json）加的；旧 supervisor 不带它们。
  // rebuild：dist 不是干净 HEAD 的构建，维护会先从 HEAD 构建。
  deploy?: {
    ready: boolean;
    reasons: string[];
    mode?: "dev" | "release";
    head: string | null;
    build: { commit: string; dirty: boolean } | null;
    release?: { version: string; arch: string; schemaVersion: number } | null;
    rebuild?: boolean;
  };
}
