// @pi-lead-child/client 的公开 API：daemon 配对网关的 TypeScript 客户端。
// web 应用用它连接网关；daemon 的集成测试用它验证真实网关。它只依赖线上契约 @pi-lead-child/protocol。
export * from './controlPlaneClient.ts';
export * from './chatOutbox.ts';
export * from './credentialStore.ts';
export * from './loopbackAutoPair.ts';
