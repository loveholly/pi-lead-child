import { useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';

import { memoryErrorText } from './memoryModel';

// 设置 → 模型的一次改动（操作层的 model_settings）。busy 时同一块的按钮停用（P5.4）；失败时给出能读的原因。
export function useModelAction() {
  const runtime = useCompanionRuntime();
  const [busy, setBusy] = useState(false);
  const run = async (action: string, input: Record<string, unknown>): Promise<{ ok: true; result: any } | { ok: false; error: string }> => {
    setBusy(true);
    try {
      return { ok: true, result: await runtime.modelSettingsAction(action, input) };
    } catch (reason) {
      return { ok: false, error: memoryErrorText(reason) };
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}
