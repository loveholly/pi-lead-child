import { Box, Column, Row, Skeleton, useBreakpoint } from '@pi-lead-child/components';

// 连接和读取快照期间的骨架屏：和工作台同样的分栏，没有内容。
export function WorkspaceBootShell() {
  const { desktop } = useBreakpoint();
  return (
    <Box testID="workspace-boot-shell" flex={1} bg="canvas" p={desktop ? 16 : 0}>
      <Row
        flex={1}
        overflow="hidden"
        borderColor="border-strong"
        bg="workspace"
        minH={desktop ? 640 : undefined}
        borderWidth={desktop ? 1 : 0}
        rounded={desktop ? '4xl' : 0}
      >
        <Box w={desktop ? 288 : 0} overflow="hidden" borderRightWidth={desktop ? 1 : 0} borderRightColor="border-soft" bg="surface">
          {/* spacing-exempt: 骨架模仿侧栏头部边距 */}
          <Skeleton w={164} h={42} mt={18} ml={18} rounded="xl" />
          {/* spacing-exempt: 骨架模仿侧栏边距 */}
          <Skeleton h={44} mt="page-section" mx={18} bg="workspace" />
        </Box>
        <Column flex={1} minW={0} bg="workspace">
          <Box h={60} borderBottomWidth={1} borderBottomColor="border-soft" bg="surface" />
          <Box flex={1} />
          {/* spacing-exempt: 输入框骨架边距 */}
          <Skeleton h={106} mx={26} mb={20} rounded="3xl" bg="surface" />
        </Column>
      </Row>
    </Box>
  );
}
