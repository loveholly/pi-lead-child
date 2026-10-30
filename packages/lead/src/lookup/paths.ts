// 路径检查挪到了连接中心（packages/connections 的 repo-paths.ts）：代查和连接中心的本地读取用同一份。
export {
  deniedSegment, isDeniedName, readScopedFile, resolveScopedPath, SEARCH_SKIPPED_DIRS, type ScopedFileRead, type ScopedPath,
} from "@pi-lead-child/connections";
