import type { LoopbackInvitation } from '@pi-lead-child/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';

import { invitationErrorText, isNotFound } from './phonePairingModel';

// 隔多久问一次网关：手机兑换了邀请没有。
export const INVITATION_POLL_MS = 2_000;

export type PhoneInvitationState =
  | { phase: 'idle' }
  | { phase: 'creating'; name: string }
  | { phase: 'showing'; name: string; invitation: LoopbackInvitation; remainingMs: number }
  | { phase: 'expired'; name: string; invitation: LoopbackInvitation }
  | { phase: 'paired'; name: string }
  | { phase: 'failed'; name: string; error: string };

// 一份手机配对邀请的整个过程：生成、显示时倒计时、轮询兑换、过期、已配对。
// 邀请（uri 和 qr）只放在这个组件的状态里，不进 store。onPaired：手机兑换了邀请。
// 页面不再显示一份邀请时（关闭、重新生成、组件卸载），就请网关作废它，不等它 15 分钟后自己过期。
// 作废失败不影响页面：邀请到时间也会过期。关闭浏览器标签页时组件不卸载，那份邀请等它自己过期。
export function usePhoneInvitation(onPaired?: () => void): {
  state: PhoneInvitationState;
  create: (name: string, endpoint?: string) => void;
  reset: () => void;
} {
  const runtime = useCompanionRuntime();
  const [state, setState] = useState<PhoneInvitationState>({ phase: 'idle' });
  // 每次生成、关闭和卸载都加一。生成的结果回来时编号已经变了，说明页面不要它了。
  const generation = useRef(0);
  // 页面正在显示（或者显示为已过期）的那份邀请。兑换以后清空：兑换过的邀请不作废。
  const shown = useRef<number | null>(null);
  const pairedCallback = useRef(onPaired);
  pairedCallback.current = onPaired;

  const cancelQuietly = useCallback((pairingId: number) => {
    void runtime.cancelLoopbackInvitation(pairingId).catch(() => {});
  }, [runtime]);

  const cancelShown = useCallback(() => {
    const pairingId = shown.current;
    shown.current = null;
    if (pairingId !== null) cancelQuietly(pairingId);
  }, [cancelQuietly]);

  // 生成请求不跟着关闭中止：请求可能已经到了网关，邀请已经生成。迟到的结果拿回编号，马上作废。
  const create = useCallback((name: string, endpoint?: string) => {
    cancelShown();
    const ticket = ++generation.current;
    setState({ phase: 'creating', name });
    runtime.createLoopbackInvitation({ name, ...(endpoint ? { endpoint } : {}) }).then(
      (invitation) => {
        if (ticket !== generation.current) {
          cancelQuietly(invitation.pairingId);
          return;
        }
        shown.current = invitation.pairingId;
        setState({ phase: 'showing', name, invitation, remainingMs: Date.parse(invitation.expiresAt) - Date.now() });
      },
      (reason: unknown) => {
        if (ticket === generation.current) setState({ phase: 'failed', name, error: invitationErrorText(reason) });
      },
    );
  }, [cancelQuietly, cancelShown, runtime]);

  const reset = useCallback(() => {
    generation.current += 1;
    cancelShown();
    setState({ phase: 'idle' });
  }, [cancelShown]);

  useEffect(() => () => {
    generation.current += 1;
    cancelShown();
  }, [cancelShown]);

  const showing = state.phase === 'showing' ? state.invitation : null;
  const pairingId = showing?.pairingId ?? null;
  const expiresAt = showing ? Date.parse(showing.expiresAt) : null;

  // 只改这一份邀请的状态：重新生成以后，旧邀请迟到的结果不算。
  const settle = useCallback((id: number, next: 'expired' | 'paired') => {
    if (next === 'paired' && shown.current === id) shown.current = null;
    setState((current) => {
      if (current.phase !== 'showing' || current.invitation.pairingId !== id) return current;
      return next === 'paired'
        ? { phase: 'paired', name: current.name }
        : { phase: 'expired', name: current.name, invitation: current.invitation };
    });
    if (next === 'paired') pairedCallback.current?.();
  }, []);

  // 倒计时：每秒更新一次剩下的时间，到 0 就过期。
  useEffect(() => {
    if (pairingId === null || expiresAt === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const remainingMs = expiresAt - Date.now();
      if (remainingMs <= 0) {
        settle(pairingId, 'expired');
        return;
      }
      setState((current) => (current.phase === 'showing' && current.invitation.pairingId === pairingId
        ? { ...current, remainingMs }
        : current));
      timer = setTimeout(tick, Math.min(1_000, remainingMs));
    };
    timer = setTimeout(tick, Math.min(1_000, Math.max(0, expiresAt - Date.now())));
    return () => { if (timer) clearTimeout(timer); };
  }, [expiresAt, pairingId, settle]);

  // 轮询兑换。网关说过期、作废，或者不认识这份邀请（daemon 换了数据目录）时，按过期处理。
  // 别的失败（例如网络断了一下）不改状态，下一轮再问。
  useEffect(() => {
    if (pairingId === null) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      runtime.getLoopbackInvitationStatus(pairingId, controller.signal).then(
        (status) => {
          if (controller.signal.aborted) return;
          if (status.state === 'redeemed') settle(pairingId, 'paired');
          else if (status.state !== 'pending') settle(pairingId, 'expired');
          else timer = setTimeout(check, INVITATION_POLL_MS);
        },
        (reason: unknown) => {
          if (controller.signal.aborted) return;
          if (isNotFound(reason)) settle(pairingId, 'expired');
          else timer = setTimeout(check, INVITATION_POLL_MS);
        },
      );
    };
    timer = setTimeout(check, INVITATION_POLL_MS);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [pairingId, runtime, settle]);

  return { state, create, reset };
}
