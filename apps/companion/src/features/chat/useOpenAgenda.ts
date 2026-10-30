import { isWeb, useBreakpoint } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';

import { useWorkspaceStore } from '../../state/CompanionStateProvider';

// 打开日程（提醒的家）。原生端进日程 tab；web 桌面打开左栏并切到日程；web 手机收起盖在上面的面板（例如工单详情），
// 切到日程页（和底部导航点「日程」一样）。只切 railView 不够：左栏关着、或者面板盖着时用户看不到日程（发布评审 3688968）。
// 不改选中的工单，也不打开工单详情：提醒不是工单。
export function useOpenAgenda(): () => void {
  const { desktop } = useBreakpoint();
  const router = useRouter();
  const setRailView = useWorkspaceStore((state) => state.setRailView);
  const openRail = useWorkspaceStore((state) => state.openRail);
  const closeCompactPanel = useWorkspaceStore((state) => state.closeCompactPanel);
  const setCompactDestination = useWorkspaceStore((state) => state.setCompactDestination);
  return () => {
    if (!isWeb) {
      router.push('/agenda');
      return;
    }
    setRailView('agenda');
    if (desktop) {
      openRail();
      return;
    }
    closeCompactPanel();
    setCompactDestination('agenda');
  };
}
