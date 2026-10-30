import { Annotation, AnnotationConfirm, Column, GroupList, SystemLine, Text } from '@pi-lead-child/components';
import { isOnBehalfOwnerActionSource, ownerActionClientLabel, type OwnerActionDto } from '@pi-lead-child/protocol';
import { useEffect, useState } from 'react';

import { useCompanionRuntime } from '../../state/CompanionStateProvider';
import { useLeadName } from '../../state/hooks';

// 会话里的一张主人操作卡（工单 15 第一步）。daemon 在有人用 CLI 凭证、回环网页或临时 admin 建的配对
// 做了高风险操作时贴这张卡（轮次的来源是 system:owner-action），文字是推送的标题和正文。
// 「不是我」：网关撤销这次操作（能撤销的），并作废发出它的凭证。先在卡上再确认一次。
// 卡打开时读一次这次操作现在的样子：别的设备上已经点过「不是我」时，直接显示结果，不再给按钮。
// Lead 在对话里代你做的（source.client 是 lead，工单 03 审查 M5）：按钮是「撤销」，只撤销这次操作，不作废凭证。
// 2026-10-27 按画布「代你操作」改成两个模式（主题 11.6、11.9）：
//   Lead 代你做的：注脚。右对齐一行「Fairy 据此…」，深色文字按钮「撤销」，点开用细竖线引出来自、撤销后、不是你三行；
//     点「撤销」原地换成一句确认；撤销以后原句划掉，后面跟「✓ 12:45 已撤销」。
//   别的凭证做的：居中的系统信息行，只有钥匙图标和「不是我」是红色；点了原地换成确认。
//   只记录的（扫码配对的手机做的）、这个客户端自己做的：居中一行记录，没有按钮。

const REVERT_WORDS: Record<string, string> = {
  reverted: '已撤销',
  executed: '已经执行，无法撤回',
  not_revertible: '没有撤销',
  unchanged: '不用撤销',
};

function cardWords(onBehalf: boolean) {
  return onBehalf
    ? { action: '撤销', confirm: '确认撤销', question: '撤销这次操作（能撤销的部分）。不作废凭证，这台设备照常能用。', keep: '凭证照常能用。' }
    : { action: '不是我', confirm: '确认不是我', question: '撤销这次操作（能撤销的部分），并作废发出它的凭证。用这个凭证的设备或程序之后都会被拒绝。', keep: '' };
}

export function ownerActionOutcome(view: OwnerActionDto): { headline: string; detail: string } | null {
  if (!view.disowned) return null;
  const { revert, credential } = view.disowned;
  const revoked = credential.revoked ? '凭证已作废' : '凭证没有作废';
  const action = cardWords(isOnBehalfOwnerActionSource(view.source)).action;
  return {
    headline: `已处理「${action}」：${REVERT_WORDS[revert.status] ?? revert.status} · ${revoked}`,
    detail: [revert.message, credential.message].filter(Boolean).join(' '),
  };
}

// 这个客户端自己的凭证做的主人操作（用户刚在这里点的）：会话里只有一行不起眼的记录，没有醒目的卡和「不是我」。
// 推送照常发到手机、Slack 和桌面：冒用者用的是它自己的凭证，不是这个客户端的凭证。
export function ownOwnerActionLine(text: string): string {
  return `你刚刚${text.split('\n')[0]!.trim()}`;
}

// 一行，左对齐，太长时截断（2026-10-28 改版稿第 1 组）：全文和时间在点开的浮层里。
export function OwnOwnerActionNote({ text, time }: { text: string; time: string }) {
  return <SystemLine testID="owner-action-own" icon="device" text={ownOwnerActionLine(text)} time={time} details={ownerActionDetails([{ key: 'one', text, time }])} />;
}

// 你在这个客户端上连着做的几件事（改版稿第 1 组）：合成一行「你刚刚…，还有 N 件」，点开一件一行。
export function OwnOwnerActionGroup({ items }: { items: ReadonlyArray<{ eventId: string; text: string; time: string }> }) {
  if (items.length === 1) return <OwnOwnerActionNote text={items[0]!.text} time={items[0]!.time} />;
  const first = items[0]!;
  const last = items.at(-1)!;
  return (
    <SystemLine
      testID="owner-action-own-group"
      icon="device"
      text={`${ownOwnerActionLine(first.text)}，还有 ${items.length - 1} 件`}
      time={first.time === last.time ? first.time : `${first.time}–${last.time}`}
      details={ownerActionDetails(items.map((item) => ({ key: item.eventId, text: item.text, time: item.time })))}
    />
  );
}

// 浮层里的明细：一件一行，时间在前；每件写全文（标题以外的几行也写上）。
function ownerActionDetails(items: ReadonlyArray<{ key: string; text: string; time: string }>) {
  return (
    <GroupList
      entries={items.map((item) => ({
        key: item.key,
        time: item.time,
        content: <Text size="note" tone="secondary">{item.text.split('\n').map((line) => line.trim()).filter(Boolean).join('\n')}</Text>,
      }))}
    />
  );
}

const clock = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

export function OwnerActionCard({ eventId, text, time }: { eventId: string; text: string; time: string }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [view, setView] = useState<OwnerActionDto | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    runtime.getOwnerAction(eventId).then(
      (next) => { if (!cancelled) setView(next); },
      () => { /* 读不到时照常显示文字和按钮：点下去的回答会带上现在的样子 */ },
    );
    return () => { cancelled = true; };
  }, [eventId, runtime]);

  const title = text.split('\n')[0]!.trim();
  const summary = view?.summary || title;
  const outcome = view ? ownerActionOutcome(view) : null;
  const onBehalf = view ? isOnBehalfOwnerActionSource(view.source) : false;
  // 只记录的操作（来自扫码配对的手机）没有「不是我」。还没读到时先给按钮。
  const disownable = view ? view.disownable : true;
  const words = cardWords(onBehalf);

  const disown = async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await runtime.disownOwnerAction(eventId));
      setConfirming(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const press = { label: words.action, onPress: () => { setError(null); setConfirming(true); }, testID: `owner-action-card-disown-${eventId}` };
  const confirm = confirming && !outcome ? (
    <AnnotationConfirm
      centered={!onBehalf}
      tone={onBehalf ? 'neutral' : 'danger'}
      // 代做的确认和注脚一样一行高：只问一句，撤销后会怎样写在展开的「撤销后」那一行。
      question={onBehalf ? `撤销「${summary}」？${words.keep}` : words.question}
      confirmLabel={words.confirm}
      cancelLabel={onBehalf ? '算了' : '取消'}
      busy={busy}
      onConfirm={() => void disown()}
      onCancel={() => setConfirming(false)}
      confirmTestID={`owner-action-card-confirm-${eventId}`}
    />
  ) : null;

  let line;
  if (confirm) {
    line = confirm;
  } else if (onBehalf && view) {
    line = (
      <Annotation
        text={`${leadName} 据此${summary}`}
        done={outcome && view.disowned ? `${clock(view.disowned.at)} ${REVERT_WORDS[view.disowned.revert.status] ?? view.disowned.revert.status}` : null}
        {...(disownable && !outcome ? { action: press } : {})}
        details={[
          { label: '来自', value: `${view.credential.name} · 凭证 #${view.credential.bindingId}` },
          // 撤回以后：结果和原因放在浮层里，注脚还是一行，会话列表不变高。
          outcome
            ? { label: '结果', value: <Text testID={`owner-action-outcome-${eventId}`} size="meta">{[outcome.headline, outcome.detail].filter(Boolean).join(' ')}</Text> }
            : { label: '撤销后', value: view.undo.note || '能撤回的部分回到原来的样子，凭证照常能用' },
          { label: '不是你', value: '到「设置 → 已配对设备」移除那台设备' },
        ]}
      />
    );
  } else if (view && !disownable && !outcome) {
    line = <SystemLine icon="device" text={`你在 ${view.source.deviceName} 上${summary}`} time={time} details={ownerActionDetails([{ key: eventId, text, time }])} />;
  } else {
    const who = view ? `${ownerActionClientLabel(view.source.client, leadName)} 凭证 #${view.credential.bindingId}` : null;
    line = (
      <SystemLine
        icon="key"
        iconTone={outcome ? 'secondary' : 'danger'}
        lead={who}
        struck={Boolean(outcome)}
        separator={outcome ? ' · ' : ' '}
        text={outcome ? outcome.headline : `${view ? `在 ${clock(view.performedAt)} ` : ''}${summary}`}
        {...(disownable && !outcome ? { action: { ...press, tone: 'danger' as const } } : {})}
      />
    );
  }

  return (
    <Column testID={`owner-action-card-${eventId}`} w="100%" gap="text-stack" items={onBehalf ? 'flex-end' : 'stretch'}>
      {line}
      {outcome && !onBehalf ? (
        // 「不是我」的结果和原因（撤回了什么、凭证作废了没有）：小字跟在系统信息行下面。
        <Text testID={`owner-action-outcome-${eventId}`} size="meta" tone="secondary">{outcome.detail}</Text>
      ) : null}
      {error ? <Text size="meta" weight="semibold" tone="danger-dark">{`「${words.action}」没有完成：${error}`}</Text> : null}
    </Column>
  );
}

// 一句话促成的几件事（画布「代你操作」状态 5）：合成一行注脚「Fairy 据此做了 3 件事：…」，行尾「逐件看」。
// 点开在浮层里一件一行，每一件照常有自己的「撤销」。只有一件时就是普通的注脚。
export function OwnerActionGroupCard({ items }: { items: ReadonlyArray<{ eventId: string; text: string; time: string }> }) {
  const leadName = useLeadName();
  if (items.length === 1) return <OwnerActionCard eventId={items[0]!.eventId} text={items[0]!.text} time={items[0]!.time} />;
  const titles = items.map((item) => item.text.split('\n')[0]!.trim());
  return (
    <Column testID="owner-action-group" w="100%" items="flex-end">
      <Annotation
        text={`${leadName} 据此做了 ${items.length} 件事：${titles.join('、')}`}
        strong={`${items.length} 件事`}
        toggleLabel="逐件看"
        details={items.map((item) => ({
          label: item.time,
          mono: true,
          value: <OwnerActionCard eventId={item.eventId} text={item.text} time={item.time} />,
        }))}
      />
    </Column>
  );
}
