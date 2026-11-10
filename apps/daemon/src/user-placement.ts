// 用户的消息放在哪里：规则在 Lead 调度器里（lead 的 scheduler/placement.ts，lead-scheduler spec P1）。这里只转出去，
// 让 daemon 和它的测试照旧从这里引用。
export { userMessagePlacement, type UserMessagePlacement } from "@pi-lead-child/lead";
