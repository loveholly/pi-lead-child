import type { SupervisorPersistentState } from "./protocol.js";

// 客户端自动拉起 daemon 之前的检查（ensure_running 带 auto 时）。返回拒绝的原因，可以拉起时返回 null。
// - 用户 plc daemon stop 过的 daemon 不自动拉起；
// - 维护（备份、升级、重启）正在进行时不插手。只看活着的 supervisor 的状态（maintenanceActive），
//   不看状态文件里的维护记录：supervisor 在维护途中死掉时，那条记录会一直停在 running。
export function autoStartRefusal(state: SupervisorPersistentState, maintenanceActive: boolean): string | null {
  if (state.desiredState === "stopped") {
    return "daemon 是用 plc daemon stop 停下的，不会自动启动。要启动，运行 plc daemon start。";
  }
  return explicitStartRefusal(maintenanceActive, state);
}

// 显式启动（plc daemon start）也不能在维护进行时插手：升级会先备份账本，这时拉起 daemon 会和备份抢。
export function explicitStartRefusal(maintenanceActive: boolean, state?: SupervisorPersistentState): string | null {
  if (!maintenanceActive) return null;
  const action = state?.maintenance?.action === "upgrade" ? "升级" : "维护";
  return `daemon 正在${action}（阶段 ${state?.phase ?? "maintenance"}），完成后 supervisor 会自己拉起 daemon。请等它完成。`;
}
