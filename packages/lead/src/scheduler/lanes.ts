// Lead 调度器的车道（lead-scheduler spec D1、D2）。对应 React Scheduler 的优先级：数字越小越优先。
//
// 两个数字的意思不同：
//   · 首次可见回应的时限：输入到达以后，多久之内要让对方看到回应。P1 只用它做记录（/v1/lead/scheduler、events），
//     过了时限提级是以后的事（spec D1「防饿死」）。
//   · 就地预算：Lead 为一件事就地工作最多多久，所有车道一样（用户 2026-11-09：2 分 30 秒），见 core.ts 的红线。
//
// 车道由谁定（D2）：
//   · 按来源定，是确定的规则：用户本人开的一轮是 L0；系统事件按种类定 L2 或 L3；整理笔记这类维护工作是 L4。
//   · 外部的人的消息：现在没有逐条的紧急度，按 L1 算（D2：判断不了时按 L1，宁可多回一句，也不漏掉一个在等的人）。
export type Lane = 0 | 1 | 2 | 3 | 4;

export interface LaneSpec {
  lane: Lane;
  // 日志和接口里的名字：L0…L4。
  name: string;
  // 放什么（给人看的说明）。
  what: string;
  // 首次可见回应的时限（毫秒）。L4 不限。
  firstResponseMs: number | null;
}

export const LANES: Readonly<Record<Lane, LaneSpec>> = {
  0: { lane: 0, name: "L0", what: "user", firstResponseMs: 10_000 },
  1: { lane: 1, name: "L1", what: "someone waiting", firstResponseMs: 2 * 60_000 },
  2: { lane: 2, name: "L2", what: "work", firstResponseMs: 5 * 60_000 },
  3: { lane: 3, name: "L3", what: "background", firstResponseMs: 30 * 60_000 },
  4: { lane: 4, name: "L4", what: "idle", firstResponseMs: null },
};

export function laneName(lane: Lane): string {
  return LANES[lane].name;
}

/** 一个输入的种类：用户本人的消息、外部的人的消息、系统事件（D12 第 1 条的「来源」）。 */
export type InputKind = "user" | "external" | "system";

/**
 * 一个输入的车道，以及车道是怎么定的（D2、D12 第 1 条）。how：source 是按来源定；external_default 是外部的人的消息，
 * 现在没有逐条的紧急度，按 L1 算。level 是系统事件的级别（tell、interrupt 要 Lead 处理，是 L2；别的是 L3）。
 */
export function inputLane(input: { kind: InputKind; level?: string | null }): { lane: Lane; how: "source" | "external_default" } {
  if (input.kind === "user") return { lane: 0, how: "source" };
  if (input.kind === "external") return { lane: 1, how: "external_default" };
  return { lane: input.level === "tell" || input.level === "interrupt" ? 2 : 3, how: "source" };
}

/** 一个单元由什么开的。user：用户本人的消息；aish：外部通道直接开的一轮；system：daemon 叫醒 Lead 的一轮。 */
export type UnitSource = "user" | "aish" | "system";

/**
 * 单元的车道（D2，按来源定）。system 是系统回合的来源（protocol 的 SYSTEM_TURN_ORIGINS，例如 system:digest）。
 * externalMessage：交给这一轮的事里有外部的人的消息原文（例如 Slack 私信），这时是有人在等的 L1。
 */
export function unitLane(input: { source: UnitSource; system?: string | null; externalMessage?: boolean }): Lane {
  if (input.source === "user") return 0;
  if (input.source === "aish" || input.externalMessage) return 1;
  switch (input.system) {
    // 要 Lead 处理的事（CI 失败、工单卡住、审批、决定）、到期的提醒、要马上播报的通知：L2。
    case "system:blocker":
    case "system:reminder":
    case "system:notification":
      return 2;
    // 整理笔记是维护工作（spec D8）：L4。
    case "system:precipitate":
      return 4;
    // 按批的摘要、心跳巡检和别的后台事：L3。
    default:
      return 3;
  }
}

/**
 * 一个在等的输入按首次可见回应的时限算了多久（spec D1；P1 报告的实施记录，2026-11-10 定下）。
 * L1（外部的人）不能抢占 L0：用户的单元在跑的时间不算。从到达和最近一次用户的单元结束里晚的那个时刻算起；
 * 用户的单元正在跑，就算到它开始的时刻为止。别的车道从到达时算（waitedMs）。
 */
export function laneClockMs(input: {
  lane: Lane; waitedMs: number; now: number;
  userUnitOpenedAt: number | null; userUnitEndedAt: number | null;
}): number {
  if (input.lane !== 1) return input.waitedMs;
  const arrivedAt = input.now - input.waitedMs;
  const from = Math.max(arrivedAt, input.userUnitEndedAt ?? arrivedAt);
  const to = input.userUnitOpenedAt ?? input.now;
  return Math.max(0, to - from);
}
