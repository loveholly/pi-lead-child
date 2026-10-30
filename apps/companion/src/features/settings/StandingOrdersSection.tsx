import { Badge, Button, Card, Column, Icon, Pressable, Row, Text } from '@pi-lead-child/components';
import type {
  StandingOrderDetailResponse, StandingOrderDto, StandingOrderListResponse, StandingOrderProposalDto,
} from '@pi-lead-child/protocol';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { useCompanionRuntime } from '@/state/CompanionStateProvider';
import { useConnectionPhase, useLeadName } from '@/state/hooks';

import { StandingOrderProposalView } from './StandingOrderProposal';
import {
  authorLabel, compactJson, executionSubtitle, levelLabel, orderReasonText, orderSubtitle, proposalOutcome, proposalTitle,
  shortTime, standingOrderErrorText, standingOrdersRollbackNote, withLeadName,
} from './standingOrderModel';

// 设置 → Lead 的名字 → 常设指令（工单 10）。最上面是等你批准的提议，然后是全部指令。
// 点开一条：现在的内容、版本历史（每一版可以回滚）、最近的执行记录（分诊依据指向它的事件）。
// 契约：packages/protocol/src/standing-orders-wire.ts。页面自己保存读到的数据，改完用响应替换。
// 系统写的标题和说明里的「Lead」换成 Lead 的名字（withLeadName）；Lead 或用户写的说明原样显示。
// 连上 daemon（phase 是 ready）以后才读：刚打开页面时设备可能还在配对或者重连。重新连上时再读一次。
export function StandingOrdersSection() {
  const runtime = useCompanionRuntime();
  const ready = useConnectionPhase() === 'ready';
  const [list, setList] = useState<StandingOrderListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => runtime.standingOrders(signal).then(
    (next) => {
      if (signal?.aborted) return;
      setList(next);
      setError(null);
    },
    (reason: unknown) => { if (!signal?.aborted) setError(standingOrderErrorText(reason)); },
  ), [runtime]);

  useEffect(() => {
    if (!ready) return undefined;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, ready]);

  if (!list) {
    return error
      ? <Text testID="standing-orders-error" size="body" tone="danger-dark">{`读不到常设指令：${error}`}</Text>
      : <Text testID="standing-orders-loading" size="body" tone="muted">正在读取常设指令…</Text>;
  }
  const pending = list.proposals.filter((proposal) => proposal.state === 'pending');
  return (
    <Column testID="standing-orders-section" gap="page-section">
      {pending.map((proposal) => (
        <Card key={proposal.approvalId} tone="warning" rounded="xl" p="page-card">
          <StandingOrderProposalView proposal={proposal} onChange={() => void load()} />
        </Card>
      ))}
      <Column gap="group-label">
        <Text size="eyebrow" weight="bold" tone="secondary">{`全部指令（${list.items.length}）`}</Text>
        <Card rounded="xl" overflow="hidden">
          {list.items.map((order, index) => (
            <OrderRow
              key={order.id}
              order={order}
              first={index === 0}
              open={openId === order.id}
              onToggle={() => setOpenId(openId === order.id ? null : order.id)}
              onChanged={() => void load()}
            />
          ))}
        </Card>
      </Column>
      {error ? <Text testID="standing-orders-refresh-error" size="secondary" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}

function OrderRow({ order, first, open, onToggle, onChanged }: {
  order: StandingOrderDto;
  first: boolean;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const leadName = useLeadName();
  return (
    <Column borderTopWidth={first ? 0 : 1} borderTopColor="border-soft">
      <Pressable
        testID={`standing-order-row-${order.id}`}
        feedback="highlight"
        onPress={onToggle}
        flexDirection="row"
        items="center"
        gap="side-item"
        px="row-x"
        py="row-y"
      >
        <Column flex={1} minW={0} gap="text-stack">
          <Text size="card-title" weight="semibold">{withLeadName(order.title, leadName)}</Text>
          <Text size="secondary" tone="muted" numberOfLines={1}>{orderSubtitle(order, leadName)}</Text>
        </Column>
        {order.status === 'disabled' ? <Badge label="停用" tone="muted" size="sm" /> : null}
        {order.author !== 'system'
          ? <Badge label={`${authorLabel(order.author, leadName)}${order.version === 1 ? '新增' : '改过'}`} tone="accent" size="sm" />
          : null}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color="text-ghost" />
      </Pressable>
      {open ? <OrderDetail id={order.id} onChanged={onChanged} /> : null}
    </Column>
  );
}

function OrderDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const runtime = useCompanionRuntime();
  const leadName = useLeadName();
  const [detail, setDetail] = useState<StandingOrderDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    runtime.standingOrder(id, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setDetail(next); },
      (reason: unknown) => { if (!controller.signal.aborted) setError(standingOrderErrorText(reason)); },
    );
    return () => controller.abort();
  }, [id, runtime]);

  const rollback = (version: number) => {
    setSubmitting(true);
    setError(null);
    runtime.rollbackStandingOrder(id, version)
      .then((next) => {
        setDetail(next);
        setConfirming(null);
        onChanged();
      }, (reason: unknown) => setError(standingOrderErrorText(reason)))
      .finally(() => setSubmitting(false));
  };

  if (!detail) {
    return (
      <Column px="card-row" pb="card-row">
        {error
          ? <Text testID={`standing-order-detail-error-${id}`} size="body" tone="danger-dark">{error}</Text>
          : <Text size="body" tone="muted">正在读取…</Text>}
      </Column>
    );
  }
  const { order } = detail;
  const versions = [...detail.versions].reverse();
  const resolved = detail.proposals.filter((proposal) => proposal.state !== 'pending');
  return (
    <Column testID={`standing-order-detail-${id}`} px="row-x" pb="card-section" gap="page-section">
      <Text size="secondary" tone="secondary">{orderReasonText(order, leadName)}</Text>
      <Column gap="card-row">
        <Fact label="条件" value={compactJson(order.condition)} />
        <Fact label="动作" value={compactJson(order.action)} />
        {order.limits !== null ? <Fact label="上限" value={compactJson(order.limits)} /> : null}
        {order.escalateTo ? <Fact label="到时限升到" value={`${order.escalateTo}（${levelLabel(order.escalateTo)}）`} /> : null}
      </Column>

      <Block title="版本历史" hint={standingOrdersRollbackNote(leadName)}>
        {versions.map((version) => (
          <Column key={version.version} testID={`standing-order-version-${id}-${version.version}`} gap="text-stack">
            <Row items="center" gap="inline-item" flexWrap="wrap">
              <Text size="label" weight="bold">{`v${version.version}`}</Text>
              <Text flex={1} size="meta" tone="muted">
                {[`${authorLabel(version.author, leadName)}写的`, version.approvedBy ? `批准：${version.approvedBy}` : null,
                  version.createdAt ? shortTime(version.createdAt) : null, version.status === 'disabled' ? '停用' : null]
                  .filter(Boolean).join(' · ')}
              </Text>
              {version.version === order.version ? <Badge label="现在" tone="success" size="sm" /> : (
                <Button
                  testID={`standing-order-rollback-${id}-${version.version}`}
                  label="回滚到这一版"
                  size="sm"
                  variant="outline"
                  tone="neutral"
                  disabled={submitting}
                  onPress={() => setConfirming(version.version)}
                />
              )}
            </Row>
            <Text size="secondary" tone="secondary">{orderReasonText(version, leadName)}</Text>
            {confirming === version.version ? (
              <Row testID={`standing-order-rollback-confirm-${id}`} items="center" gap="actions" flexWrap="wrap">
                <Text flex={1} size="body" weight="semibold">{`写一个新版本 v${order.version + 1}，内容和 v${version.version} 一样？`}</Text>
                <Button testID={`standing-order-rollback-yes-${id}`} label="回滚" size="sm" disabled={submitting} onPress={() => rollback(version.version)} />
                <Button label="取消" size="sm" variant="outline" tone="neutral" disabled={submitting} onPress={() => setConfirming(null)} />
              </Row>
            ) : null}
          </Column>
        ))}
      </Block>

      <Block title="最近的执行记录" hint="事件日志里按这条指令处理的事件，新的在前。">
        {detail.executions.length ? detail.executions.map((execution) => (
          <Row key={execution.seq} testID={`standing-order-execution-${execution.seq}`} items="flex-start" gap="inline-item">
            {levelLabel(execution.level) ? <Badge label={levelLabel(execution.level)!} tone="neutral" size="sm" /> : null}
            <Column flex={1} minW={0} gap="text-stack">
              <Text size="body" numberOfLines={2}>{execution.summary}</Text>
              <Text size="meta" tone="muted" numberOfLines={1}>{executionSubtitle(execution)}</Text>
            </Column>
          </Row>
        )) : <Text testID={`standing-order-no-executions-${id}`} size="body" tone="muted">最近还没有事件按它处理。</Text>}
      </Block>

      {resolved.length ? (
        <Block title={`${leadName} 的提议`}>
          {resolved.map((proposal) => <ResolvedProposal key={proposal.approvalId} proposal={proposal} leadName={leadName} />)}
        </Block>
      ) : null}
      {error ? <Text testID={`standing-order-detail-error-${id}`} size="secondary" tone="danger-dark">{error}</Text> : null}
    </Column>
  );
}

function ResolvedProposal({ proposal, leadName }: { proposal: StandingOrderProposalDto; leadName: string }) {
  const outcome = proposalOutcome(proposal);
  return (
    <Column gap="text-stack">
      <Text size="card-title" weight="semibold">{`${proposalTitle(proposal, leadName)} · ${shortTime(proposal.requestedAt)}`}</Text>
      {outcome ? <Text size="secondary" tone={outcome.tone}>{outcome.label}</Text> : null}
    </Column>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Row gap="inline-item" items="flex-start">
      <Text w={72} size="label" weight="semibold" tone="secondary">{label}</Text>
      <Text flex={1} minW={0} mono size="code" tone="secondary">{value}</Text>
    </Row>
  );
}

function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Column gap="group-label">
      <Column gap="text-stack">
        <Text size="eyebrow" weight="bold" tone="secondary">{title}</Text>
        {hint ? <Text size="note" tone="muted">{hint}</Text> : null}
      </Column>
      {children}
    </Column>
  );
}
