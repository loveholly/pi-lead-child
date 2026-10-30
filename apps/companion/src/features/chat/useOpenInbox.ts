import { isWeb, useBreakpoint } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';

import { useWorkspaceStore } from '../../state/CompanionStateProvider';

// 打开「待你」（收件箱：审批、决定、要你处理的事）。和 useOpenAgenda 同一个做法：原生端回到首页，
// web 桌面打开左栏并切到收件箱，web 手机收起盖在上面的面板，切到收件箱。会话里的 UserAction 卡（选择、审批）用它。
export function useOpenInbox(): () => void {
  const { desktop } = useBreakpoint();
  const router = useRouter();
  const setRailView = useWorkspaceStore((state) => state.setRailView);
  const openRail = useWorkspaceStore((state) => state.openRail);
  const closeCompactPanel = useWorkspaceStore((state) => state.closeCompactPanel);
  const setCompactDestination = useWorkspaceStore((state) => state.setCompactDestination);
  return () => {
    if (!isWeb) {
      router.push('/');
      return;
    }
    setRailView('inbox');
    if (desktop) {
      openRail();
      return;
    }
    closeCompactPanel();
    setCompactDestination('inbox');
  };
}
