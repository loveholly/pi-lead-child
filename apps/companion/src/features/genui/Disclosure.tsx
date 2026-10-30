import { AnchoredPanel, Box, Pressable } from '@pi-lead-child/components';
import { resolveDatetimePreset } from '@pi-lead-child/protocol';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// 收起和展开（genui v3 积木 4）和一张卡里的参数状态（积木 6 的 Field 填的值）。
// 不依赖 App 的状态和运行时：系统卡（提醒、Slack、child 来信）和 genui 都用它。

// 一张卡里 Field 填的值：按钮的节点 id → 参数 → 值。datetime 存选项的原始写法，按下时才换算成时刻。
type SurfaceForm = {
  values: Record<string, Record<string, string>>;
  set: (actionId: string, param: string, value: string) => void;
  // 这张工单的这个字段在浮层里选了、还没按下的新值（ISO）。没有时为 null。
  pending: (ticket: number, field: string) => string | null;
  // 做完一个操作以后收起浮层（Disclosure 交进来）。
  done: () => void;
};
export const FormContext = createContext<SurfaceForm>({ values: {}, set: () => {}, pending: () => null, done: () => {} });

/** 卡片里的按钮改的是哪张工单：工单操作、提醒这类按编号的对象。按钮的节点 id → 工单编号。 */
export type ActionTargets = Record<string, number>;

/** 浮层里选了、还没按下的新值（ISO）：系统卡自己预览改动时用。 */
export function usePendingValue(ticket: number, field: string): string | null {
  return useContext(FormContext).pending(ticket, field);
}

export function SurfaceFormProvider({ children, onDone, targets = {} }: { children: ReactNode; onDone?: () => void; targets?: ActionTargets }) {
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const set = useCallback((actionId: string, param: string, value: string) => {
    setValues((current) => ({ ...current, [actionId]: { ...current[actionId], [param]: value } }));
  }, []);
  const pending = useCallback((ticket: number, field: string) => {
    for (const [actionId, params] of Object.entries(values)) {
      if (targets[actionId] !== ticket || params[field] === undefined) continue;
      return resolveDatetimePreset(params[field]!) ?? (Number.isNaN(Date.parse(params[field]!)) ? null : params[field]!);
    }
    return null;
  }, [values, targets]);
  const form = useMemo(() => ({ values, set, pending, done: onDone ?? (() => {}) }), [values, set, pending, onDone]);
  return <FormContext.Provider value={form}>{children}</FormContext.Provider>;
}

// ——— 收起和展开 ———

export type DisclosureProps = {
  id: string;
  label: string;
  summary: ReactNode;
  /** 浮层里的全部内容（头和细节一起排，例如前导栏延伸到整个浮层的票根）。 */
  panel: ReactNode;
  partial: boolean;
  /** 卡片已经结束（绑定的工单已确认、已取消）：不再打开。 */
  ended?: boolean;
  /** 浮层里的按钮改的是哪张工单（浮层里的预览用）。 */
  targets?: ActionTargets;
  /** 外部控制开关（例如「改一下再发」从收起态直接打开浮层）。不给时自己管。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

// 收起态留在会话里，点一下从原位置撑开成浮层（AnchoredPanel）：会话列表不变高。
// 收起方式：点外面、按 Esc 或返回键、做完一个操作（用户 2026-10-26 定：不要「收起」按钮）。流式中途不能打开。
export function DisclosureView({ id, label, summary, panel, partial, ended = false, targets, open: controlled, onOpenChange }: DisclosureProps) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = useCallback((next: boolean) => { if (controlled === undefined) setOwn(next); onOpenChange?.(next); }, [controlled, onOpenChange]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const canOpen = !partial && !ended;
  return (
    <AnchoredPanel
      testID={`surface-disclosure-${id}`}
      open={open}
      onClose={close}
      label={label}
      header={(
        <SurfaceFormProvider onDone={close} {...(targets ? { targets } : {})}>
          <Box testID={`surface-disclosure-${id}-detail`}>{panel}</Box>
        </SurfaceFormProvider>
      )}
    >
      {/* 打不开时（已结束、流式中途）画成普通内容，不画成一个变灰的按钮：结束的卡照样清楚（画布：已确认的提醒标题不变淡）。 */}
      {canOpen ? (
        <Pressable
          testID={`surface-disclosure-${id}-summary`}
          aria-label={label}
          aria-expanded={open}
          feedback="highlight"
          onPress={() => setOpen(true)}
        >
          {summary}
        </Pressable>
      ) : (
        <Box testID={`surface-disclosure-${id}-summary`}>{summary}</Box>
      )}
    </AnchoredPanel>
  );
}
