import { Box, Button, Column, ConfirmBar, OptionPills, Row, Text, TextField, type DataTone } from '@pi-lead-child/components';
import {
  resolveDatetimePreset, ticketNeedsUser, type TicketSummary, type UiActionButtonTarget, type UiActionView, type UiBinding,
} from '@pi-lead-child/protocol';
import { useCallback, useContext, useEffect, useState } from 'react';

import { useCompanionRuntime } from '../../state/CompanionStateProvider';
import { useConversationItemDetail, useTicketActions, useTicketSummary } from '../../state/hooks';
import { FormContext } from './Disclosure';

// 收起和展开、参数状态在 Disclosure.tsx（不依赖运行时，系统卡也用）。这里照旧导出，原来的引用不用改。
export { DisclosureView, SurfaceFormProvider, usePendingValue, type ActionTargets, type DisclosureProps } from './Disclosure';
import { ticketSummaryToTicket } from '../workspace/model';

// genui v3 积木 3–6（2026-10-27，.scratch/genui-catalog-v3/spec.md）：状态绑定、收起和展开、卡片上的按钮、参数输入。
// 按钮做的是操作层里登记过的操作：能不能按、为什么不能，都由服务端同一个函数判断（工单操作读 /v1/tickets/:id/actions，
// 别的对象读 /v1/actions/:type/:id），和 Lead 的 list_ticket_actions、list_actions 是同一份。用户按下时 actor 是用户本人。

// ——— 状态绑定 ———

// 工单的状态到色调：所有卡片同一种说法（Lead 不写映射）。等你的是琥珀色，在进行或排着的是蓝色，完成是绿色，已结束是灰色。
export function stageTone(summary: TicketSummary): DataTone {
  if (ticketNeedsUser(summary)) return 'warning';
  switch (summary.stage) {
    case 'done':
    case 'acked':
      return 'success';
    case 'cancelled':
    case 'draft':
      return 'neutral';
    case 'blocked':
    case 'review':
    case 'fired':
      return 'warning';
    default:
      return 'info';
  }
}

// 每 30 秒刷新一次「现在」：剩余时间跟着走，不用每秒重画。
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (value: number) => String(value).padStart(2, '0');

/** 一个时刻的短说法：六天以内写「周五 14:00」，再远写「11-03 14:00」。 */
export function shortTimeWords(at: Date, now: number = Date.now()): string {
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return Math.abs(at.getTime() - now) < 6 * 86_400_000 ? `周${WEEKDAYS[at.getDay()]} ${clock}` : `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock}`;
}

/** 剩余时间：「还有 3 天 1 小时」「还有 25 分钟」「已过 2 小时」。 */
export function remainingWords(at: Date, now: number): string {
  const diff = at.getTime() - now;
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const span = days > 0 ? `${days} 天${hours ? ` ${hours} 小时` : ''}` : hours > 0 ? `${hours} 小时${rest ? ` ${rest} 分钟` : ''}` : `${Math.max(rest, 1)} 分钟`;
  return diff >= 0 ? `还有 ${span}` : `已过 ${span}`;
}

function timeWords(at: Date, format: NonNullable<UiBinding['format']>, now: number): string {
  if (format === 'clock') return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  if (format === 'date') return `周${WEEKDAYS[at.getDay()]} ${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return remainingWords(at, now);
}

export type BoundValue = {
  text: string | null; tone: DataTone | null; ended: boolean; at: Date | null;
  // 浮层里选了、还没按下的新值（Field 填给一个改这张工单的按钮）。卡片据此预览改动：旧的划掉，新的用强调色。
  pending: Date | null; pendingText: string | null;
};

/** 一个绑定现在的文字和色调。还没读到时 text 和 tone 是 null，调用方显示快照或占位。 */
export function useBinding(bind: UiBinding | undefined): BoundValue {
  const ticketId = bind?.ticket ?? 0;
  const listed = useTicketSummary(ticketId);
  // 提醒的时刻只在 TicketDetail 里：绑定 remindAt 时总要读它；只绑状态时，工单列表里没有才读。
  const { detail } = useConversationItemDetail(ticketId, Boolean(bind) && (bind?.field === 'remindAt' || !listed));
  const summary = listed ?? detail?.ticket ?? null;
  const live = bind?.field === 'remindAt' && (bind.format ?? 'remaining') === 'remaining';
  const now = useNow(live);
  const form = useContext(FormContext);
  const pendingIso = bind ? form.pending(bind.ticket, bind.field) : null;
  const pending = pendingIso ? new Date(pendingIso) : null;
  if (!bind || !summary) return { text: null, tone: null, ended: false, at: null, pending: null, pendingText: null };
  const ended = summary.stage === 'acked' || summary.stage === 'cancelled' || summary.stage === 'done';
  const tone = stageTone(summary);
  if (bind.field === 'stage') return { text: ticketSummaryToTicket(summary).statusLabel, tone, ended, at: null, pending: null, pendingText: null };
  const at = detail?.remindAt ? new Date(detail.remindAt) : null;
  if (!at || Number.isNaN(at.getTime())) return { text: null, tone, ended, at: null, pending: null, pendingText: null };
  // 结束了的提醒不再倒数：写它原来的时刻。
  const format = ended && (bind.format ?? 'remaining') === 'remaining' ? 'date' : bind.format ?? 'remaining';
  const changed = pending && !Number.isNaN(pending.getTime()) && pending.getTime() !== at.getTime() ? pending : null;
  return { text: timeWords(at, format, now), tone, ended, at, pending: changed, pendingText: changed ? timeWords(changed, format, now) : null };
}

// ——— 参数和按钮 ———

// 自由输入的时刻：「10-30 14:00」或「2026-10-30 14:00」，按本地时区。看不懂时为 null。
export function parseFreeDatetime(text: string, now: Date = new Date()): string | null {
  const match = /^\s*(?:(\d{4})-)?(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return null;
  const [, year, month, day, hours, minutes] = match;
  const at = new Date(year ? Number(year) : now.getFullYear(), Number(month) - 1, Number(day), Number(hours), Number(minutes));
  if (Number.isNaN(at.getTime()) || Number(hours) > 23) return null;
  return at.toISOString();
}

export type FieldProps = {
  id: string;
  for: string;
  param: string;
  kind: 'datetime' | 'choice';
  label?: string;
  presets: Array<{ label: string; value: string }>;
  freeInput?: boolean;
  /** 卡片自己会预览这个改动（有绑定这张工单这个字段的图块或文字）：不再在选项下面另写一行。 */
  previewedByCard?: boolean;
};

const FREE = '__free__';

// 参数输入：一排常用选项，加一个自由输入。datetime 选中以后在下面写出换算好的时刻，用户知道按下按钮会改到哪一刻。
export function FieldView({ id, for: actionId, param, kind, label, presets, freeInput, previewedByCard = false }: FieldProps) {
  const form = useContext(FormContext);
  const raw = form.values[actionId]?.[param] ?? null;
  const [freeMode, setFreeMode] = useState(false);
  const [free, setFree] = useState('');
  const selected = freeMode ? FREE : presets.some((preset) => preset.value === raw) ? raw : null;
  const options = freeInput ? [...presets, { label: '自己填', value: FREE }] : presets;
  const resolved = kind === 'datetime' && raw ? resolveDatetimePreset(raw) : null;
  return (
    <Column testID={`surface-field-${id}`} gap="text-stack">
      {label ? <Text size="label" tone="secondary">{label}</Text> : null}
      <OptionPills
        testID={`surface-field-${id}-option`}
        label={label ?? param}
        options={options}
        selected={selected}
        onSelect={(value) => {
          setFreeMode(value === FREE);
          if (value !== FREE) form.set(actionId, param, value);
        }}
      />
      {freeMode ? (
        <TextField
          testID={`surface-field-${id}-free`}
          value={free}
          placeholder={kind === 'datetime' ? '10-30 14:00' : '写一个值'}
          size="sm"
          onChangeText={(text) => {
            setFree(text);
            const value = kind === 'datetime' ? parseFreeDatetime(text) : text.trim();
            if (value) form.set(actionId, param, value);
          }}
        />
      ) : null}
      {resolved && !previewedByCard ? (
        <Text testID={`surface-field-${id}-preview`} size="meta" tone="accent">{`改到 ${timeWords(new Date(resolved), 'date', Date.now())}`}</Text>
      ) : null}
    </Column>
  );
}

export type ActionProps = {
  id: string;
  target: UiActionButtonTarget;
  action: string;
  input?: Record<string, unknown>;
  label?: string;
  role: 'primary' | 'default' | 'quiet';
  partial?: boolean;
  // 以下两项只给系统卡（对象组件）用，不在组件目录里：Lead 写不了确认的文案（P8.3）。
  /** 确认行左边那一句后果，例如「取消后，周四 14:00 不再提醒你。」。 */
  confirmText?: string;
  /** 参数选了一个时刻以后的按钮文字，{value} 换成那个时刻（例如「改到{value}」→「改到周五 14:00」）。 */
  labelWithValue?: string;
};

type Availability = { label: string; available: boolean; reason: string | null; confirm: string | null; loaded: boolean };

// 按钮现在能不能按：工单操作用工单详情同一份清单；别的对象按需读 /v1/actions/:type/:id。
function useAvailability(target: UiActionButtonTarget, action: string): Availability & { reload: () => void } {
  const runtime = useCompanionRuntime();
  const ticketActions = useTicketActions(target.type === 'ticket' ? target.id : 0);
  const [views, setViews] = useState<UiActionView[] | null>(null);
  const [epoch, setEpoch] = useState(0);
  const key = `${target.type}:${target.id}`;
  useEffect(() => {
    const type: string = target.type;
    if (type === 'ticket') return undefined;
    let live = true;
    runtime.listUiActions(type, String(target.id as string | number)).then((list) => { if (live) setViews(list); }, () => { if (live) setViews([]); });
    return () => { live = false; };
  }, [key, epoch, runtime, target.type, target.id]);
  const reload = useCallback(() => setEpoch((value) => value + 1), []);
  if (target.type === 'ticket') {
    const view = ticketActions.actions.find((entry) => entry.id === action);
    const loaded = ticketActions.resource?.state === 'ready' || ticketActions.actions.length > 0;
    return {
      label: view?.label ?? action, available: Boolean(view?.available), reason: view?.reason ?? (loaded ? '现在不能做这个操作' : null),
      confirm: view?.irreversible ? `${view.label}以后收不回。` : null, loaded, reload,
    };
  }
  const view = views?.find((entry) => entry.id === action);
  return {
    label: view?.label ?? action, available: Boolean(view?.available), reason: view?.reason ?? (views ? '现在不能做这个操作' : null),
    confirm: view?.confirm ?? (view?.irreversible ? `${view.label}以后收不回。` : null), loaded: views !== null, reload,
  };
}

const ROLE = {
  primary: { variant: 'solid', tone: 'accent' },
  default: { variant: 'outline', tone: 'neutral' },
  quiet: { variant: 'ghost', tone: 'neutral' },
} as const;

// 一个按钮按下以后做什么：能不能按、要不要先确认、执行、出错。按钮自己和操作组的确认行共用。
function useActionRunner({ id, target, action, input, label, confirmText, labelWithValue }: ActionProps) {
  const runtime = useCompanionRuntime();
  const form = useContext(FormContext);
  const availability = useAvailability(target, action);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filled = form.values[id] ?? {};
  // datetime 选项按下时才换算成时刻：卡片画了很久以后，「1 小时后」也是从现在算。
  const merged = { ...input, ...Object.fromEntries(Object.entries(filled).map(([param, value]) => [param, resolveDatetimePreset(value) ?? value])) };
  const run = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const type: string = target.type;
      if (type === 'ticket') await runtime.runTicketAction(Number(target.id), action as never, { input: merged });
      else await runtime.performUiAction(type, String(target.id as string | number), action, { input: merged });
      availability.reload();
      form.done();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      availability.reload();
      return false;
    } finally {
      setBusy(false);
    }
  };
  const picked = Object.values(filled).map((value) => resolveDatetimePreset(value) ?? null).find(Boolean);
  return {
    availability, busy, error, run,
    text: labelWithValue && picked ? labelWithValue.replace('{value}', shortTimeWords(new Date(picked))) : label ?? availability.label,
    needsConfirm: confirmText !== undefined || availability.confirm !== null || action === 'cancel',
    confirmText: confirmText ?? availability.confirm,
    danger: action === 'cancel',
  };
}

// 卡片上的按钮。不能按时变灰并写上原因，不消失（布局不变）。要就地确认的操作（取消、不可逆）：
// 在操作组里时交给操作组换成一整行确认（onConfirmRequest）；单独一个按钮时自己换成确认条。
export function ActionButton(props: ActionProps & { onConfirmRequest?: () => void }) {
  const { id, role, partial = false, onConfirmRequest } = props;
  const runner = useActionRunner(props);
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <ConfirmBar
        testID={`surface-action-${id}-confirm`}
        title={`${runner.text}？`}
        {...(runner.confirmText ? { note: runner.confirmText } : {})}
        confirmLabel={`确认${runner.text}`}
        cancelLabel="算了"
        tone={runner.danger ? 'danger' : 'accent'}
        busy={runner.busy}
        onConfirm={() => void runner.run().then((ok) => { if (ok) setConfirming(false); })}
        onCancel={() => setConfirming(false)}
      />
    );
  }
  const disabled = partial || runner.busy || !runner.availability.available;
  return (
    <Column gap="text-stack" items="flex-end">
      <Button
        testID={`surface-action-${id}`}
        label={runner.text}
        size="sm"
        variant={ROLE[role].variant}
        tone={ROLE[role].tone}
        disabled={disabled}
        onPress={() => (runner.needsConfirm ? (onConfirmRequest ? onConfirmRequest() : setConfirming(true)) : void runner.run())}
      />
      {runner.error ? <Text testID={`surface-action-${id}-error`} size="meta" tone="danger-dark">{runner.error}</Text>
        : !partial && runner.availability.loaded && !runner.availability.available && runner.availability.reason
          ? <Text testID={`surface-action-${id}-reason`} size="meta" tone="secondary">{runner.availability.reason}</Text>
          : null}
    </Column>
  );
}

// 操作组的确认行：整排按钮换成一行，左边一句后果，右边「算了」和确认（视觉稿提醒卡的「确认取消」）。
function ConfirmRow({ action, onCancel }: { action: ActionProps; onCancel: () => void }) {
  const runner = useActionRunner(action);
  return (
    <Column testID={`surface-action-${action.id}-confirm`} gap="text-stack">
      <Row items="center" gap="actions" justify="flex-end" flexWrap="wrap">
        <Text flex={1} minW={0} size="secondary" tone="strong">{runner.confirmText ?? `${runner.text}？`}</Text>
        <Button label="算了" size="sm" variant="ghost" tone="neutral" onPress={onCancel} testID={`surface-action-${action.id}-confirm-cancel`} />
        <Button
          label={`确认${runner.text}`}
          size="sm"
          variant="solid"
          tone={runner.danger ? 'danger' : 'accent'}
          disabled={runner.busy}
          onPress={() => void runner.run().then((ok) => { if (ok) onCancel(); })}
          testID={`surface-action-${action.id}-confirm-ok`}
        />
      </Row>
      {runner.error ? <Text size="meta" tone="danger-dark">{runner.error}</Text> : null}
    </Column>
  );
}

// 一排按钮（操作组）：靠右排；要确认的那个按下以后，整排换成一行确认，不只换掉那一个按钮。
export function ActionGroup({ actions, partial = false }: { actions: ActionProps[]; partial?: boolean }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const pending = actions.find((action) => action.id === confirming);
  if (pending) {
    return (
      <Box borderTopWidth={1} borderTopColor="border-soft" pt="card-row">
        <ConfirmRow action={pending} onCancel={() => setConfirming(null)} />
      </Box>
    );
  }
  // 操作栏上方一条细线（清爽主题 C-6）。
  return (
    <Row gap="actions" justify="flex-end" items="flex-start" flexWrap="wrap" borderTopWidth={1} borderTopColor="border-soft" pt="card-row">
      {actions.map((action) => (
        <ActionButton key={action.id} {...action} partial={partial} onConfirmRequest={() => setConfirming(action.id)} />
      ))}
    </Row>
  );
}

