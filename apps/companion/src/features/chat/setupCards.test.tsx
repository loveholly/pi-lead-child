// @vitest-environment jsdom
// 首次启动引导的两种系统卡（2026-10-30，.scratch/onboarding/spec.md，画布 A2、A4）：
//   · 准备清单：7 项，没配的带「去设置」，全部配好以后收成一行；
//   · 建议卡：标题、配了有什么用、「去设置」，「⋯」里「以后再说」「不用再提」；处理过以后收成一行；
//   · 两种卡按位置插进会话，推送和快照按版本换上。
import {
  SETUP_ITEM_KEYS, type SetupChecklistCard, type SetupHintCard, type SetupItemKey, type LeadActivityView,
} from '@pi-lead-child/protocol';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderUI } from '../../../test/render';
import {
  applyLeadActivityPush, applyLeadActivitySnapshot, EMPTY_LEAD_ACTIVITY, setupChecklistCard, setupHintCards,
} from '../../state/control-plane/leadActivity';
import type { MessageEntity } from '../../state/types';
import { buildLeadTimeline } from './LeadConversation';
import { SetupChecklistCardView, SetupHintCardView, setupHintTitle } from './SetupCards';

vi.mock('expo-crypto', () => ({ getRandomBytesAsync: vi.fn(), digest: vi.fn(), CryptoDigestAlgorithm: {} }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

function checklist(ready: SetupItemKey[], version = 1): SetupChecklistCard {
  return {
    key: 'setup:checklist', entityKey: 'setup:checklist', entityVersion: version,
    at: '2026-10-30T09:20:00.000Z', updatedAt: '2026-10-30T09:20:00.000Z',
    items: SETUP_ITEM_KEYS.map((key) => ({ key, ready: ready.includes(key), detail: ready.includes(key) ? `${key} 好了` : null })),
  };
}

function hint(state: SetupHintCard['state'], version = 1): SetupHintCard {
  const target = { type: 'setup_hint', id: '1' };
  return {
    key: 'setup_hint:1', entityKey: 'setup_hint:1', entityVersion: version, at: '2026-10-30T14:05:30.000Z', updatedAt: '2026-10-30T14:05:30.000Z',
    hintId: 1, item: 'jira', state,
    actions: state === 'open' ? [{ target, action: 'snooze', label: '以后再说' }, { target, action: 'dismiss', label: '不用再提' }] : [],
  };
}

describe('the checklist card', () => {
  it('lists the seven items, with a way to each one that is missing', () => {
    const onOpen = vi.fn();
    renderUI(<SetupChecklistCardView card={checklist(['brain', 'github'])} leadName="Paimon" onOpen={onOpen} />);
    expect(screen.getByTestId('setup-checklist-count').textContent).toBe('2/7');
    expect(screen.getByTestId('setup-row-brain').textContent).toContain('brain 好了');
    expect(screen.queryByTestId('setup-open-brain')).toBeNull();
    // 文字里的 {lead} 换成用户给 Lead 起的名字。
    expect(screen.getByTestId('setup-row-memory').textContent).toContain('没配时 Paimon 只能按关键词回想');
    fireEvent.click(screen.getByTestId('setup-open-jira'));
    expect(onOpen).toHaveBeenCalledWith('jira');
  });

  it('folds into one line once everything is set up', () => {
    renderUI(<SetupChecklistCardView card={checklist([...SETUP_ITEM_KEYS])} leadName="Paimon" onOpen={() => {}} />);
    expect(screen.getByTestId('setup-checklist-done').textContent).toBe('准备好了：7 项关键设置都配好了');
    expect(screen.queryByTestId('setup-checklist-count')).toBeNull();
  });
});

describe('the hint card', () => {
  it('suggests one item with a way there', () => {
    const onOpen = vi.fn();
    renderUI(<SetupHintCardView card={hint('open')} leadName="Paimon" onOpen={onOpen} onAction={() => {}} />);
    expect(screen.getByTestId('setup-hint-title').textContent).toBe('建议连上 Jira');
    expect(screen.getByTestId('setup-hint-1').textContent).toContain('连上以后，Paimon 能查工单');
    fireEvent.click(screen.getByTestId('setup-hint-1-open'));
    expect(onOpen).toHaveBeenCalledWith('jira');
    expect(setupHintTitle('memory')).toBe('建议给记忆接上 embedding');
  });

  it('becomes one line after 以后再说, 不用再提, or once the item is set up', () => {
    const first = renderUI(<SetupHintCardView card={hint('snoozed', 2)} leadName="Paimon" onOpen={() => {}} onAction={() => {}} />);
    expect(screen.getByTestId('setup-hint-line').textContent).toBe('好，「Jira」7 天内不再提');
    expect(screen.queryByTestId('setup-hint-1-open')).toBeNull();
    first.unmount();
    const second = renderUI(<SetupHintCardView card={hint('dismissed', 3)} leadName="Paimon" onOpen={() => {}} onAction={() => {}} />);
    expect(screen.getByTestId('setup-hint-line').textContent).toBe('好，以后不再提「Jira」');
    second.unmount();
    renderUI(<SetupHintCardView card={hint('ready', 4)} leadName="Paimon" onOpen={() => {}} onAction={() => {}} />);
    expect(screen.getByTestId('setup-hint-line').textContent).toBe('「Jira」配好了');
  });
});

describe('the setup cards in the conversation', () => {
  const message = (id: string, at: string): MessageEntity => ({
    id, sessionId: 's', turnId: id, ticketId: null, role: 'assistant', state: 'completed', failure: null,
    clientCommandId: null, source: 'snapshot', createdAt: at, updatedAt: at,
  });

  it('places the checklist and the hint by their time', () => {
    const timeline = buildLeadTimeline(
      [message('a1', '2026-10-30T09:10:00.000Z'), message('a2', '2026-10-30T14:05:00.000Z'), message('a3', '2026-10-30T15:00:00.000Z')],
      [], [], { setupChecklist: checklist(['brain']), setupHints: [hint('open')] },
    );
    expect(timeline.map((item) => item.kind)).toEqual(['message', 'setup-checklist', 'message', 'setup-hint', 'message']);
  });

  it('applies snapshots and pushes by version', () => {
    const view = (setup: SetupChecklistCard | null, hints: SetupHintCard[]): LeadActivityView => ({ cards: [], interrupts: [], watermark: 0, setup, setupHints: hints });
    let state = applyLeadActivitySnapshot(EMPTY_LEAD_ACTIVITY, view(checklist(['brain'], 5), [hint('open', 5)]));
    expect(setupChecklistCard(state)?.items.filter((item) => item.ready)).toHaveLength(1);
    // 推送来的新版本换上；更旧的快照不盖掉它。
    state = applyLeadActivityPush(state, { setup: checklist(['brain', 'memory'], 9), setupHint: hint('snoozed', 9) });
    state = applyLeadActivitySnapshot(state, view(checklist(['brain'], 6), [hint('open', 6)]));
    expect(setupChecklistCard(state)?.items.filter((item) => item.ready)).toHaveLength(2);
    expect(setupHintCards(state).map((card) => card.state)).toEqual(['snoozed']);
    // 旧 daemon 的快照没有这两项：手上的不动。
    const legacy = applyLeadActivitySnapshot(state, { cards: [], interrupts: [], watermark: 0 });
    expect(setupHintCards(legacy)).toHaveLength(1);
  });
});
