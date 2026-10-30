import { useCallback, useSyncExternalStore } from 'react';

import { platformSectionMemory } from '@/data/platformSectionMemory';

import { DETAIL_SECTIONS, type DetailSectionKind, type RememberedSections } from './ticketDetailSections';

// 你在这台设备上手动展开或折叠过的块（工单详情 spec 4.0）：按块的种类记，所有工单共用一份，不进后端。
// 第一次用到时从本地读一次；之后每次改都写回去。读失败、内容不对时当作没记过。
let remembered: RememberedSections = {};
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function parse(text: string | null): RememberedSections {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return {};
    const entries = Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [DetailSectionKind, boolean] =>
        (DETAIL_SECTIONS as readonly string[]).includes(entry[0]) && typeof entry[1] === 'boolean');
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  void platformSectionMemory.load().then((text) => {
    // 读回来之前你已经点过的块，以你点的为准。
    remembered = { ...parse(text), ...remembered };
    emit();
  }).catch(() => {});
}

function subscribe(listener: () => void) {
  ensureLoaded();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function snapshot() {
  return remembered;
}

export function useRememberedSections(): [RememberedSections, (kind: DetailSectionKind, collapsed: boolean) => void] {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  const remember = useCallback((kind: DetailSectionKind, collapsed: boolean) => {
    remembered = { ...remembered, [kind]: collapsed };
    emit();
    void platformSectionMemory.save(JSON.stringify(remembered)).catch(() => {});
  }, []);
  return [value, remember];
}

/** 只给测试用：清掉内存里的记录，下次用到时重新从本地读。 */
export function resetRememberedSectionsForTesting() {
  remembered = {};
  loaded = false;
  emit();
}
