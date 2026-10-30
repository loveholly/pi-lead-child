// supervisor.sock 的消息类型是 plc 和 supervisor 之间的线上契约，定义在 @pi-lead-child/protocol。
// 这里转出，supervisor 包内部和既有调用方照旧从本包引用。
export type {
  MaintenanceAction,
  MaintenanceRequest,
  MaintenanceState,
  SupervisorCommand,
  SupervisorDesiredState,
  SupervisorPersistentState,
  SupervisorPhase,
  SupervisorStatus,
} from "@pi-lead-child/protocol";
