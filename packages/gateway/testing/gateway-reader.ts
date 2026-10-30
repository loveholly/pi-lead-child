// 从 gateway 的 HTTP 接口读用户看到的东西：通知和工单投影。用户看到的就是这一跳（spec Testing Decisions）。
// 测试和验收回放共用这里的函数：起一个真实的 paired server，配对一个 companion 客户端，
// 然后发 GET 请求。它们不直接读数据库表。
import { createControlPlaneService } from "../src/control-plane.js";
import { startPairedServer } from "../src/paired-server.js";
import type { Db } from "@pi-lead-child/store";
import { createPairing } from "@pi-lead-child/store";
import type {
  InboxView, MilestoneDto, MilestonePatchRequest, NotificationDto, ProjectOverview, TicketSummary, TimelineResponse,
} from "@pi-lead-child/protocol";

function leadRuntime() {
  return { model: "stub/model", sessionId: "stub-session", busy: false, runningItemIds: [], aish: null };
}

async function readGateway<T>(
  db: Db, scope: string, path: string, method: "GET" | "POST" = "GET", body?: unknown,
): Promise<T> {
  const server = await startPairedServer({
    db,
    controlPlane: createControlPlaneService(db, { runtime: leadRuntime }),
   
    hello: () => leadRuntime(),
    chat: () => "started",
    addClient: () => () => {},
    log: () => {},
  }, { port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const { code } = createPairing(db, { name: "gateway-reader", kind: "companion", scopes: [scope] });
    const redeemed = await fetch(`${base}/v1/paired/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: code }),
    });
    if (redeemed.status !== 201) throw new Error(`pairing failed with HTTP ${redeemed.status}`);
    const { access_token: token } = await redeemed.json() as { access_token: string };
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status !== 200 && response.status !== 201) throw new Error(`${method} ${path} returned HTTP ${response.status}`);
    return await response.json() as T;
  } finally {
    await server.close();
  }
}

export async function readGatewayNotifications(db: Db): Promise<NotificationDto[]> {
  // 三种状态都读：lead 播报过或用户确认过的通知，仍然是同一次故障收到的那一条。
  const body = await readGateway<{ items: NotificationDto[] }>(
    db, "notices", "/v1/notifications?state=pending&state=delivered&state=acked&limit=500",
  );
  return body.items;
}

export async function readGatewayTickets(db: Db): Promise<TicketSummary[]> {
  return (await readGateway<{ items: TicketSummary[] }>(db, "tickets:view", "/v1/tickets")).items;
}

export async function readGatewayInbox(db: Db): Promise<InboxView> {
  return readGateway<InboxView>(db, "tickets:view", "/v1/inbox");
}

/** 记下「你看过收件箱了」（companion 打开收件箱时发的那一次）。 */
export async function markGatewayInboxSeen(db: Db): Promise<string> {
  return (await readGateway<{ seenAt: string }>(db, "notices", "/v1/inbox/seen", "POST")).seenAt;
}

export async function readGatewayProjectsOverview(db: Db): Promise<ProjectOverview[]> {
  return (await readGateway<{ items: ProjectOverview[] }>(db, "tickets:view", "/v1/projects/overview")).items;
}

/** 在项目 tab 上归档一个项目（companion 发的那一次）。 */
export async function archiveGatewayProject(db: Db, projectId: number): Promise<void> {
  await readGateway(db, "tickets:create", `/v1/projects/${projectId}/archive`, "POST");
}

/** 日程（GET /v1/timeline），companion 的日程 tab 读的那一次。 */
export async function readGatewayTimeline(
  db: Db, range: { from: string; to: string; timezone: string },
): Promise<TimelineResponse> {
  const params = new URLSearchParams(range);
  return readGateway<TimelineResponse>(db, "tickets:view", `/v1/timeline?${params}`);
}

/** 在日程里改一个节点（companion 的「改」）。 */
export async function patchGatewayMilestone(db: Db, milestoneId: number, patch: MilestonePatchRequest): Promise<MilestoneDto> {
  return readGateway<MilestoneDto>(db, "tickets:create", `/v1/milestones/${milestoneId}`, "POST", patch);
}
