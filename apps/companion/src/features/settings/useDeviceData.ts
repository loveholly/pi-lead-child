import type { AdminBinding, BindingDto } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';

import { isForbidden, reasonText } from './deviceModel';

export type OwnBindingState = {
  // 先用配对时保存的那一份，GET /v1/paired/me 回来后换成 daemon 现在的。
  binding: BindingDto | null;
  error: string | null;
};

// 这台设备的 binding（GET /v1/paired/me）。没有配对时不请求。
export function useOwnBinding(paired: boolean): OwnBindingState {
  const runtime = useCompanionRuntime();
  const [state, setState] = useState<OwnBindingState>(() => ({ binding: runtime.currentBinding(), error: null }));
  useEffect(() => {
    if (!paired) {
      setState({ binding: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState((current) => ({ binding: current.binding ?? runtime.currentBinding(), error: null }));
    runtime.getOwnBinding(controller.signal).then(
      (binding) => { if (!controller.signal.aborted) setState({ binding, error: null }); },
      (reason: unknown) => {
        if (!controller.signal.aborted) setState((current) => ({ binding: current.binding, error: reasonText(reason) }));
      },
    );
    return () => controller.abort();
  }, [paired, runtime]);
  return state;
}

export type BindingListState =
  | { state: 'loading' }
  | { state: 'ready'; items: AdminBinding[] }
  // 网关回 403：这个凭证没有 admin scope。普通的 companion 凭证都是这样。
  | { state: 'forbidden' }
  | { state: 'error'; error: string };

// 全部 binding（GET /v1/admin/bindings）。没有配对时不请求。
export function useBindingList(paired: boolean): BindingListState & { reload: () => void } {
  const runtime = useCompanionRuntime();
  const [state, setState] = useState<BindingListState>({ state: 'loading' });
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!paired) return undefined;
    const controller = new AbortController();
    runtime.listBindings(controller.signal).then(
      (items) => { if (!controller.signal.aborted) setState({ state: 'ready', items }); },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setState(isForbidden(reason) ? { state: 'forbidden' } : { state: 'error', error: reasonText(reason) });
      },
    );
    return () => controller.abort();
  }, [generation, paired, runtime]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { ...state, reload };
}
