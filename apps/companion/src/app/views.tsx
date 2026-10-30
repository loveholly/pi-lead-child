import { Screen } from '@pi-lead-child/components';
import { useRouter } from 'expo-router';

import { ViewsPanel } from '@/features/views/ViewsPanel';

// 原生上的视图面板（2026-10-30，patterns P16.3）：自己的一页，左上角返回。网页上在工作台的右侧（Workbench.web.tsx）。
export default function ViewsScreen() {
  const router = useRouter();
  return (
    <Screen edges={['top', 'bottom']}>
      <ViewsPanel standalone onClose={() => router.back()} />
    </Screen>
  );
}
